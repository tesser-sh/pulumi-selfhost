import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import {
  boxIdentityPolicy,
  cloudActuatorRoleName,
  fleetControlPolicy,
  parameterStorePolicies,
  permissionsPolicy,
  snapshotsControlPolicy,
  type PolicyDocument,
} from './tesser-policy';

const DIGEST_PINNED = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const PRIVATE_ECR = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([^@:]+)@/;
const CONTAINER = 'actuator';
const STOP_TIMEOUT_S = 120;
const TASKS = 2;

export type ImageSource = { id: string } | { owner: string };

export interface ActuatorLimits {
  maxInstances: number;
  mutationsPerMinute: number;
  launchesPerHour: number;
}

export interface ActuatorArgs {
  orgId: string;
  image: pulumi.Input<string>;
  cellUrl?: string;
  subnetIds: pulumi.Input<pulumi.Input<string>[]>;
  assignPublicIp: boolean;
  vpcId: pulumi.Input<string>;
  clusterArn?: pulumi.Input<string>;
  box: {
    subnetId: pulumi.Input<string>;
    securityGroupId: pulumi.Input<string>;
    image: ImageSource;
    role: string;
    instanceProfile: string;
  };
  fleet: { imageOwner: string; hostRoleArn: pulumi.Input<string>; instanceProfileArn: pulumi.Input<string> } | null;
  snapshotsBucket: pulumi.Input<string> | null;
  parameterStore: boolean;
  tags: Record<string, string>;
  tagKeys: string[];
  limits: ActuatorLimits;
  enableFederation: boolean;
  logRetentionDays?: number;
}

const ecsTasksTrust = ([account, region]: [string, string]) =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:ecs:${region}:${account}:*` },
        },
      },
    ],
  });

function actuatorIdentityPolicy(cellUrl: string): PolicyDocument {
  const [identity] = boxIdentityPolicy(cellUrl).Statement;
  return {
    Version: '2012-10-17',
    Statement: [{ ...identity, Sid: 'ActuatorIdentity', Condition: { ...identity.Condition, StringEquals: { 'sts:SigningAlgorithm': 'RS256' } } }],
  };
}

export function createActuator(name: string, args: ActuatorArgs, provider: aws.Provider) {
  const cellUrl = args.cellUrl ?? 'https://api.tesser.sh';
  const account = aws.getCallerIdentityOutput({}, { provider }).accountId;
  const region = aws.getRegionOutput({}, { provider }).region;
  const image = pulumi.output(args.image).apply((i) => {
    if (!DIGEST_PINNED.test(i)) throw new Error(`the actuator image must be pinned by digest (<registry>/actuator@sha256:<64 hex>), not "${i}"`);
    return i;
  });
  const roleName = cloudActuatorRoleName(args.orgId);
  const trust = pulumi.all([account, region]).apply(ecsTasksTrust);

  const federation = args.enableFederation ? [new aws.iam.OutboundWebIdentityFederation(name, {}, { provider, retainOnDelete: true })] : [];

  const log = new aws.cloudwatch.LogGroup(
    name,
    { name: `/tesser/actuator/${args.orgId}`, retentionInDays: args.logRetentionDays ?? 365 },
    { provider }
  );

  const role = new aws.iam.Role(
    name,
    { name: roleName, description: `tesser's actuator for ${args.orgId}`, assumeRolePolicy: trust },
    { provider }
  );
  const policy = (suffix: string, doc: pulumi.Input<object>) =>
    new aws.iam.RolePolicy(`${name}-${suffix}`, { name: suffix, role: role.id, policy: pulumi.jsonStringify(doc) }, { provider });
  const box = pulumi.output(args.box);
  const fleet = args.fleet;
  const policies = [
    policy(
      'boxes',
      pulumi.all([account, region, box]).apply(([a, r, b]) =>
        permissionsPolicy({
          region: r,
          accountId: a,
          orgId: args.orgId,
          boxRole: b.role,
          image: b.image,
          tagKeys: [...new Set([...args.tagKeys, ...Object.keys(args.tags)])],
          subnetId: b.subnetId,
          securityGroupId: b.securityGroupId,
        })
      )
    ),
    policy('identity', actuatorIdentityPolicy(cellUrl)),
    policy('audit-log', {
      Version: '2012-10-17',
      Statement: [{ Sid: 'AuditLogIsNotMine', Effect: 'Deny', Action: 'logs:*', Resource: [log.arn, pulumi.interpolate`${log.arn}:*`] }],
    }),
    ...(fleet === null
      ? []
      : [
          policy(
            'fleet',
            pulumi.all([account, region, fleet.hostRoleArn]).apply(([a, r, hostRoleArn]) =>
              fleetControlPolicy({ region: r, accountId: a, orgId: args.orgId, hostRoleArn, imageOwner: fleet.imageOwner })
            )
          ),
        ]),
    ...(args.snapshotsBucket === null
      ? []
      : [policy('snapshots', pulumi.output(args.snapshotsBucket).apply((bucket) => snapshotsControlPolicy({ bucket, orgId: args.orgId })))]),
    ...(args.parameterStore
      ? [policy('env', pulumi.all([account, region]).apply(([a, r]) => parameterStorePolicies({ region: r, accountId: a, orgId: args.orgId }).control))]
      : []),
  ];

  const execution = new aws.iam.Role(
    `${name}-execution`,
    { name: `${roleName}-exec`.slice(0, 64), assumeRolePolicy: trust },
    { provider }
  );
  new aws.iam.RolePolicy(
    `${name}-execution`,
    {
      name: 'pull-and-log',
      role: execution.id,
      policy: pulumi.jsonStringify(
        pulumi.all([image, log.arn]).apply(([i, logArn]) => {
          const ecr = PRIVATE_ECR.exec(i);
          return {
            Version: '2012-10-17',
            Statement: [
              { Sid: 'WriteAuditLog', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `${logArn}:log-stream:*` },
              ...(ecr === null
                ? []
                : [
                    { Sid: 'RegistryLogin', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
                    {
                      Sid: 'PullImage',
                      Effect: 'Allow',
                      Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
                      Resource: `arn:aws:ecr:${ecr[2]}:${ecr[1]}:repository/${ecr[3]}`,
                    },
                  ]),
            ],
          };
        })
      ),
    },
    { provider }
  );

  const sg = new aws.ec2.SecurityGroup(
    name,
    { vpcId: args.vpcId, description: `tesser actuator of ${args.orgId}: no inbound, https out`, tags: { Name: 'tesser-actuator', 'tesser:org': args.orgId } },
    { provider }
  );
  new aws.vpc.SecurityGroupEgressRule(
    `${name}-https`,
    { securityGroupId: sg.id, ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIpv4: '0.0.0.0/0', description: 'cells, AWS APIs, registry' },
    { provider }
  );

  const clusterArn = args.clusterArn === undefined ? new aws.ecs.Cluster(name, { name: roleName }, { provider }).arn : pulumi.output(args.clusterArn);

  const fleetConfig = fleet === null ? null : pulumi.output(fleet.instanceProfileArn).apply((instanceProfileArn) => ({ image: { owner: fleet.imageOwner }, instanceProfileArn }));
  const config = pulumi
    .all([account, region, args.vpcId, box, fleetConfig, args.snapshotsBucket])
    .apply(([accountId, r, vpcId, b, fleetSeat, bucket]) =>
      JSON.stringify({
        kind: 'selfHost',
        cellUrl,
        accountId,
        region: r,
        vpcId,
        subnetIds: [b.subnetId],
        securityGroupId: b.securityGroupId,
        box: { image: b.image, instanceProfile: b.instanceProfile },
        fleet: fleetSeat,
        limits: args.limits,
        orgId: args.orgId,
        tags: args.tags,
        snapshots: bucket === null ? null : { bucket },
        parameterStore: args.parameterStore,
      })
    );

  const task = new aws.ecs.TaskDefinition(
    name,
    {
      family: roleName,
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      cpu: '256',
      memory: '512',
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      taskRoleArn: role.arn,
      executionRoleArn: execution.arn,
      containerDefinitions: pulumi.jsonStringify([
        {
          name: CONTAINER,
          image,
          essential: true,
          readonlyRootFilesystem: true,
          stopTimeout: STOP_TIMEOUT_S,
          environment: [
            { name: 'ACTUATOR_CONFIG', value: config },
            { name: 'AWS_REGION', value: region },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: { 'awslogs-group': log.name, 'awslogs-region': region, 'awslogs-stream-prefix': CONTAINER, mode: 'blocking' },
          },
        },
      ]),
    },
    { provider }
  );

  const service = new aws.ecs.Service(
    name,
    {
      name: CONTAINER,
      cluster: clusterArn,
      taskDefinition: task.arn,
      desiredCount: TASKS,
      launchType: 'FARGATE',
      platformVersion: 'LATEST',
      deploymentMinimumHealthyPercent: 100,
      deploymentMaximumPercent: 200,
      deploymentCircuitBreaker: { enable: true, rollback: true },
      availabilityZoneRebalancing: 'ENABLED',
      networkConfiguration: { subnets: args.subnetIds, securityGroups: [sg.id], assignPublicIp: args.assignPublicIp },
      enableExecuteCommand: false,
      propagateTags: 'SERVICE',
      waitForSteadyState: true,
    },
    { provider, dependsOn: [...policies, ...federation] }
  );

  return { roleArn: role.arn, logGroupName: log.name };
}
