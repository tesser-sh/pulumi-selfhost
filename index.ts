import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { boxSsh, oidcAccess, policyJson } from './access';
import { createNetwork } from './network';
import {
  boxIdentityPolicy,
  fleetControlPolicy,
  fleetBoxTrustPolicy,
  fleetHostPolicy,
  cloudBoxRoleName,
  cloudRoleName,
  parameterStorePolicies,
  permissionsPolicy,
  snapshotsBoxPolicy,
  snapshotsBucketPolicy,
  trustPolicy,
} from './tesser-policy';

const ISSUER_HOST = 'api.tesser.sh';
const MESH_PORT = 14650;
const LAST_MOVE_PORT = 14655;
const HOST_MESH_PORTS = { from: 22000, to: 23999 };
const WG_PORT = 51820;
const ZONES: Record<string, string> = { 'us-east-1': 'use1-az1', 'us-west-2': 'usw2-az1' };

const cfg = new pulumi.Config();
const orgId = cfg.require('orgId');
const imageOwner = cfg.get('imageOwner') ?? '131798513069';
const parameterStore = cfg.getBoolean('parameterStore') ?? false;
const region = aws.config.requireRegion();

const provider = new aws.Provider(
  'tesser',
  {
    region: region as aws.Region,
    allowedAccountIds: cfg.getObject<string[]>('allowedAccountIds'),
    defaultTags: { tags: cfg.getObject<Record<string, string>>('extraTags') ?? {} },
  },
  { aliases: [{ name: 'devboxes-provider' }] }
);
const accountId = aws.getCallerIdentityOutput({}, { provider }).accountId;

const { vpcId, subnetId: subnet } = createNetwork(
  {
    orgId,
    region,
    cidr: cfg.get('cidr') ?? '10.73.0.0/16',
    azId: cfg.get('azId') ?? ZONES[region] ?? `${region}-az1`,
  },
  provider
);

const sg = new aws.ec2.SecurityGroup(
  'tesser',
  { vpcId, description: `tesser boxes of ${orgId}`, tags: { Name: 'tesser-boxes', 'tesser:org': orgId } },
  { provider }
);
new aws.vpc.SecurityGroupIngressRule(
  'tesser-mesh',
  {
    securityGroupId: sg.id,
    referencedSecurityGroupId: sg.id,
    ipProtocol: 'tcp',
    fromPort: MESH_PORT,
    toPort: LAST_MOVE_PORT,
    description: 'mesh, door and moves',
  },
  { provider }
);
new aws.vpc.SecurityGroupIngressRule(
  'tesser-host-mesh',
  {
    securityGroupId: sg.id,
    referencedSecurityGroupId: sg.id,
    ipProtocol: 'tcp',
    fromPort: HOST_MESH_PORTS.from,
    toPort: HOST_MESH_PORTS.to,
    description: 'fleet microvm mesh ports',
  },
  { provider }
);
new aws.vpc.SecurityGroupIngressRule(
  'tesser-wireguard',
  {
    securityGroupId: sg.id,
    referencedSecurityGroupId: sg.id,
    ipProtocol: 'udp',
    fromPort: WG_PORT,
    toPort: WG_PORT,
    description: 'fleet hosts',
  },
  { provider }
);
new aws.vpc.SecurityGroupEgressRule(
  'tesser-out',
  { securityGroupId: sg.id, ipProtocol: '-1', cidrIpv4: '0.0.0.0/0' },
  { provider }
);

const snapshots = new aws.s3.Bucket(
  'tesser-snapshots',
  { bucket: `tesser-snapshots-${orgId.replace('_', '-')}`, forceDestroy: false },
  { provider }
);
new aws.s3.BucketPublicAccessBlock(
  'tesser-snapshots',
  {
    bucket: snapshots.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  },
  { provider }
);
new aws.s3.BucketServerSideEncryptionConfiguration(
  'tesser-snapshots',
  { bucket: snapshots.id, rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }] },
  { provider }
);
new aws.s3.BucketPolicy(
  'tesser-snapshots',
  { bucket: snapshots.id, policy: snapshots.bucket.apply((b) => JSON.stringify(snapshotsBucketPolicy(b))) },
  { provider }
);

const oidc = new aws.iam.OpenIdConnectProvider(
  'tesser',
  { url: `https://${ISSUER_HOST}`, clientIdLists: ['sts.amazonaws.com'] },
  { provider, aliases: [{ name: 'tesser-oidc' }] }
);

const hostRole = new aws.iam.Role(
  'tesser-host',
  {
    name: `tesser-${orgId}-host`,
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    }),
  },
  { provider }
);
const boxRoleName = cloudBoxRoleName(orgId);
const boxRole = new aws.iam.Role(
  'tesser-box',
  {
    name: boxRoleName,
    assumeRolePolicy: hostRole.arn.apply((arn) => JSON.stringify(fleetBoxTrustPolicy(arn))),
  },
  { provider }
);
new aws.iam.RolePolicyAttachment(
  'tesser-box-ssm',
  { role: boxRole.name, policyArn: aws.iam.ManagedPolicy.AmazonSSMManagedInstanceCore },
  { provider }
);
new aws.iam.RolePolicy(
  'tesser-box-identity',
  { role: boxRole.id, policy: JSON.stringify(boxIdentityPolicy(`https://${ISSUER_HOST}`)) },
  { provider }
);
new aws.iam.RolePolicy(
  'tesser-box-snapshots',
  {
    role: boxRole.id,
    policy: snapshots.bucket.apply((bucket) =>
      JSON.stringify(snapshotsBoxPolicy({ bucket, orgId, region, kmsKey: null }))
    ),
  },
  { provider }
);
const boxProfile = new aws.iam.InstanceProfile(
  'tesser-box',
  { name: boxRoleName, role: boxRole.name },
  { provider }
);

const role = new aws.iam.Role(
  'tesser',
  {
    name: cloudRoleName(orgId),
    assumeRolePolicy: accountId.apply((a) => JSON.stringify(trustPolicy(ISSUER_HOST, a, orgId))),
  },
  { provider, dependsOn: [oidc] }
);
new aws.iam.RolePolicy(
  'tesser-boxes',
  {
    role: role.id,
    policy: pulumi.all([accountId, subnet, sg.id]).apply(([a, subnetId, group]) =>
      JSON.stringify(
        permissionsPolicy({
          region,
          accountId: a,
          orgId,
          boxRole: boxRoleName,
          image: { owner: imageOwner },
          subnetId,
          securityGroupId: group,
        })
      )
    ),
  },
  { provider }
);

new aws.iam.RolePolicyAttachment(
  'tesser-host-ssm',
  { role: hostRole.name, policyArn: aws.iam.ManagedPolicy.AmazonSSMManagedInstanceCore },
  { provider }
);
new aws.iam.RolePolicy(
  'tesser-host',
  {
    role: hostRole.id,
    policy: pulumi.all([snapshots.bucket, accountId]).apply(([bucket, a]) =>
      JSON.stringify(fleetHostPolicy({ cellUrl: `https://${ISSUER_HOST}`, bucket, region, kmsKey: null, accountId: a, boxRole: boxRoleName }))
    ),
  },
  { provider }
);
new aws.iam.InstanceProfile('tesser-host', { name: hostRole.name, role: hostRole.name }, { provider });
new aws.iam.RolePolicy(
  'tesser-fleet',
  {
    role: role.id,
    policy: pulumi.all([accountId, hostRole.arn]).apply(([a, hostRoleArn]) =>
      JSON.stringify(fleetControlPolicy({ region, accountId: a, orgId, hostRoleArn, imageOwner }))
    ),
  },
  { provider }
);

if (parameterStore) {
  const env = accountId.apply((a) => parameterStorePolicies({ region, accountId: a, orgId }));
  new aws.iam.RolePolicy('tesser-env', { role: role.id, policy: env.apply((p) => JSON.stringify(p.control)) }, { provider });
  new aws.iam.RolePolicy('tesser-box-env', { role: boxRole.id, policy: env.apply((p) => JSON.stringify(p.box)) }, { provider });
}

const ssh = boxSsh({ region, accountId, orgId });
const memberAccess = new aws.iam.Policy(
  'tesser-member-access',
  { name: 'tesser-member-access', description: `ssh to ${orgId}'s tesser boxes`, policy: policyJson(ssh) },
  { provider }
);

// tesser-sh's repos use GitHub's immutable subjects (repo:<owner>@<id>/<repo>@<id>:...); most orgs use repo:<owner>/<repo>:...
const github = cfg.getObject<{ subjects: string[]; providerArn?: string }>('githubActions');
const githubActionsRoleArn =
  github &&
  oidcAccess(
    'github-actions',
    {
      issuerUrl: 'https://token.actions.githubusercontent.com',
      audience: 'sts.amazonaws.com',
      subjects: github.subjects,
      providerArn: github.providerArn,
    },
    { provider, statements: ssh }
  );

const agent = cfg.getObject<{ issuerUrl: string; audience: string; subjectLike: string[] }>('cloudAgent');
const cloudAgentRoleArn = agent && oidcAccess('cloud-agent', agent, { provider, statements: ssh });

export const roleArn = role.arn;
export const subnetId = subnet;
export const securityGroupId = sg.id;
export const instanceProfile = boxProfile.name;
export const snapshotsBucket = snapshots.bucket;
export const memberAccessPolicyArn = memberAccess.arn;
export const hostRoleArn = hostRole.arn;
export const accessRoleArns = { githubActions: githubActionsRoleArn, cloudAgent: cloudAgentRoleArn };
export const connect = pulumi.interpolate`tesser cloud connect --account ${accountId} --region ${region} --private --snapshots-bucket ${snapshots.bucket} --fleet ${hostRole.arn} --fleet-box-role ${boxRoleName}${parameterStore ? ' --env parameter-store' : ''}`;
