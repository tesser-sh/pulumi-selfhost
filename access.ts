import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

type Statement = Record<string, unknown>;

export function boxSsh(t: { region: string; accountId: pulumi.Input<string>; orgId: string }): pulumi.Output<Statement[]> {
  return pulumi.output(t.accountId).apply((accountId): Statement[] => [
    {
      Sid: 'SshToOrgBoxes',
      Effect: 'Allow',
      Action: 'ssm:StartSession',
      Resource: `arn:aws:ec2:${t.region}:${accountId}:instance/*`,
      Condition: { StringEquals: { 'ssm:resourceTag/tesser:org': t.orgId } },
    },
    {
      Sid: 'SshDocuments',
      Effect: 'Allow',
      Action: 'ssm:StartSession',
      Resource: [
        `arn:aws:ssm:${t.region}::document/AWS-StartSSHSession`,
        `arn:aws:ssm:${t.region}::document/AWS-StartPortForwardingSession`,
      ],
    },
    {
      Sid: 'OpenOwnDataChannel',
      Effect: 'Allow',
      Action: 'ssmmessages:OpenDataChannel',
      Resource: `arn:aws:ssm:${t.region}:${accountId}:session/\${aws:userid}-*`,
    },
    {
      Sid: 'ManageOwnSessions',
      Effect: 'Allow',
      Action: ['ssm:TerminateSession', 'ssm:ResumeSession'],
      Resource: '*',
      Condition: { StringLike: { 'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}*' } },
    },
  ]);
}

export function policyJson(statements: pulumi.Input<Statement[]>) {
  return pulumi.jsonStringify({ Version: '2012-10-17', Statement: statements });
}

export function oidcAccess(
  name: string,
  o: {
    issuerUrl: string;
    audience: string;
    subjects?: string[];
    subjectLike?: string[];
    providerArn?: pulumi.Input<string>;
    statements?: pulumi.Input<Statement[]>;
    extraStatements?: Statement[];
  },
  base: { provider: aws.Provider; statements: pulumi.Output<Statement[]> }
): pulumi.Output<string> {
  if (o.subjects === undefined && o.subjectLike === undefined) throw new Error(`${name}: set subjects or subjectLike`);
  const provider = base.provider;
  const statements = pulumi
    .all([o.statements ?? base.statements, o.extraStatements ?? []])
    .apply(([own, extra]) => [...own, ...extra]);
  const host = o.issuerUrl.replace(/^https:\/\//, '');
  const providerArn =
    o.providerArn ??
    new aws.iam.OpenIdConnectProvider(name, { url: o.issuerUrl, clientIdLists: [o.audience] }, { provider }).arn;
  const role = new aws.iam.Role(
    name,
    {
      name: `tesser-${name}`,
      maxSessionDuration: 3600,
      assumeRolePolicy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Federated: providerArn },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                [`${host}:aud`]: o.audience,
                ...(o.subjects === undefined ? {} : { [`${host}:sub`]: o.subjects }),
              },
              ...(o.subjectLike === undefined ? {} : { StringLike: { [`${host}:sub`]: o.subjectLike } }),
            },
          },
        ],
      }),
    },
    { provider }
  );
  const policy = new aws.iam.Policy(
    `${name}-access`,
    { name: `tesser-${name}-access`, policy: policyJson(statements) },
    { provider }
  );
  new aws.iam.RolePolicyAttachment(name, { role: role.name, policyArn: policy.arn }, { provider });
  return role.arn;
}
