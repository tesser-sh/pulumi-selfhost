export function cloudRoleName(orgId: string): string {
  return `tesser-${orgId}`.slice(0, 64);
}

export function cloudBoxRoleName(orgId: string): string {
  return `tesser-${orgId}-box`.slice(0, 64);
}

export const RETAGGED_KEYS = ["tesser:org", "tesser:pool", "tesser:class", "tesser:service", "tesser:sha"];

type Statement = { Sid: string; Effect: "Allow"; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> };
export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: Statement[];
}

export interface TrustPolicyDocument {
  Version: "2012-10-17";
  Statement: { Sid: string; Effect: "Allow"; Principal: { Federated: string }; Action: string; Condition: Record<string, Record<string, string>> }[];
}

export function trustPolicy(issuerHost: string, accountId: string, orgId: string): TrustPolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TesserOrg",
        Effect: "Allow",
        Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/${issuerHost}` },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: { StringEquals: { [`${issuerHost}:aud`]: "sts.amazonaws.com", [`${issuerHost}:sub`]: `org:${orgId}` } },
      },
    ],
  };
}

export interface PermissionsTarget {
  region: string;
  accountId: string;
  orgId: string;
  boxRole: string;
  image: { id: string } | { owner: string };
  subnetId?: string;
  securityGroupId?: string;
}

export function permissionsPolicy(t: PermissionsTarget): PolicyDocument {
  if ("owner" in t.image && !/^\d{12}$/.test(t.image.owner)) throw new Error(`tesser's image owner must be a 12-digit AWS account id, not "${t.image.owner}"`);
  const ec2 = (resource: string) => `arn:aws:ec2:${t.region}:${t.accountId}:${resource}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Describe",
        Effect: "Allow",
        Action: ["ec2:DescribeInstances", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeRouteTables", "ec2:DescribeVolumes", "ec2:DescribeVolumesModifications", "servicequotas:GetServiceQuota", "iam:GetOutboundWebIdentityFederationInfo"],
        Resource: "*",
      },
      {
        Sid: "LaunchOrgInstances",
        Effect: "Allow",
        Action: "ec2:RunInstances",
        Resource: ec2("instance/*"),
        Condition: { StringEquals: { "aws:RequestTag/tesser:org": t.orgId } },
      },
      "id" in t.image
        ? { Sid: "LaunchImage", Effect: "Allow", Action: "ec2:RunInstances", Resource: `arn:aws:ec2:${t.region}::image/${t.image.id}` }
        : {
            Sid: "LaunchImage",
            Effect: "Allow",
            Action: "ec2:RunInstances",
            Resource: `arn:aws:ec2:${t.region}::image/*`,
            Condition: { StringEquals: { "ec2:Owner": t.image.owner } },
          },
      {
        Sid: "LaunchInto",
        Effect: "Allow",
        Action: "ec2:RunInstances",
        Resource: [
          ec2(`subnet/${t.subnetId ?? "*"}`),
          ec2(`security-group/${t.securityGroupId ?? "*"}`),
          ec2("network-interface/*"),
          ec2("volume/*"),
        ],
      },
      {
        Sid: "TagAtLaunch",
        Effect: "Allow",
        Action: "ec2:CreateTags",
        Resource: [ec2("instance/*"), ec2("volume/*")],
        Condition: { StringEquals: { "ec2:CreateAction": "RunInstances" } },
      },
      {
        Sid: "RaiseOrgRootThroughput",
        Effect: "Allow",
        Action: "ec2:ModifyVolume",
        Resource: ec2("volume/*"),
        Condition: { StringEquals: { "aws:ResourceTag/tesser:org": t.orgId } },
      },
      {
        Sid: "ManageOrgInstances",
        Effect: "Allow",
        Action: ["ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances", "ec2:TerminateInstances"],
        Resource: ec2("instance/*"),
        Condition: { StringEquals: { "aws:ResourceTag/tesser:org": t.orgId } },
      },
      {
        Sid: "RetagOrgInstances",
        Effect: "Allow",
        Action: "ec2:CreateTags",
        Resource: ec2("instance/*"),
        Condition: { StringEquals: { "aws:ResourceTag/tesser:org": t.orgId }, "ForAllValues:StringEquals": { "aws:TagKeys": RETAGGED_KEYS } },
      },
      {
        Sid: "PassBoxRole",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: `arn:aws:iam::${t.accountId}:role/${t.boxRole}`,
        Condition: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      },
    ],
  };
}

export const BOX_IDENTITY_TTL_S = 300;

export function boxIdentityPolicy(cellUrl: string): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BoxIdentity",
        Effect: "Allow",
        Action: "sts:GetWebIdentityToken",
        Resource: "*",
        Condition: {
          "ForAllValues:StringEquals": { "sts:IdentityTokenAudience": cellUrl },
          NumericLessThanEquals: { "sts:DurationSeconds": String(BOX_IDENTITY_TTL_S) },
        },
      },
    ],
  };
}

export function parameterStorePolicies(t: { region: string; accountId: string; orgId: string }): { control: PolicyDocument; box: PolicyDocument } {
  const resource = `arn:aws:ssm:${t.region}:${t.accountId}:parameter/tesser/${t.orgId}/*`;
  const doc = (sid: string, actions: string[]): PolicyDocument => ({ Version: "2012-10-17", Statement: [{ Sid: sid, Effect: "Allow", Action: actions, Resource: resource }] });
  return { control: doc("WriteOrgEnv", ["ssm:PutParameter", "ssm:DeleteParameters"]), box: doc("ReadOrgEnv", ["ssm:GetParametersByPath"]) };
}

export function snapshotsBoxPolicy(t: { bucket: string; orgId: string; region: string; kmsKey: string | null }): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "OrgSnapshots", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: `arn:aws:s3:::${t.bucket}/${t.orgId}/*` },
      { Sid: "ListOrgSnapshots", Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${t.bucket}`, Condition: { StringLike: { "s3:prefix": `${t.orgId}/*` } } },
      ...(t.kmsKey === null
        ? []
        : [
            {
              Sid: "OrgSnapshotsKey",
              Effect: "Allow" as const,
              Action: ["kms:GenerateDataKey", "kms:Decrypt"],
              Resource: t.kmsKey,
              Condition: { StringEquals: { "kms:ViaService": `s3.${t.region}.amazonaws.com` } },
            },
          ]),
    ],
  };
}

export function snapshotsControlPolicy(t: { bucket: string }): PolicyDocument {
  const bucket = `arn:aws:s3:::${t.bucket}`;
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "ListBucket", Effect: "Allow", Action: "s3:ListBucket", Resource: bucket },
      { Sid: "DeleteObjects", Effect: "Allow", Action: "s3:DeleteObject", Resource: `${bucket}/*` },
      { Sid: "ReadBucketRecovery", Effect: "Allow", Action: ["s3:GetBucketVersioning", "s3:GetLifecycleConfiguration"], Resource: bucket },
    ],
  };
}

export const SNAPSHOTS_NONCURRENT_DAYS = 2;

export function fleetControlPolicy(t: { region: string; accountId: string; orgId: string; hostRoleArn: string; imageOwner: string | null }): PolicyDocument {
  const ec2 = (resource: string) => `arn:aws:ec2:${t.region}:${t.accountId}:${resource}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CreateLandingVolumes",
        Effect: "Allow",
        Action: "ec2:CreateVolume",
        Resource: ec2("volume/*"),
        Condition: { StringEquals: { "aws:RequestTag/tesser:org": t.orgId } },
      },
      {
        Sid: "TagLandingVolumes",
        Effect: "Allow",
        Action: "ec2:CreateTags",
        Resource: ec2("volume/*"),
        Condition: { StringEquals: { "ec2:CreateAction": "CreateVolume" } },
      },

      {
        Sid: "AttachMoveVolumes",
        Effect: "Allow",
        Action: ["ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume"],
        Resource: ec2("volume/*"),
        Condition: { StringEquals: { "aws:ResourceTag/tesser:org": t.orgId }, Null: { "aws:ResourceTag/tesser:move": "false" } },
      },
      {
        Sid: "AttachToOrgInstances",
        Effect: "Allow",
        Action: ["ec2:AttachVolume", "ec2:DetachVolume"],
        Resource: ec2("instance/*"),
        Condition: { StringEquals: { "aws:ResourceTag/tesser:org": t.orgId } },
      },
      ...(t.imageOwner === null
        ? []
        : [{ Sid: "LaunchFleetHostImage", Effect: "Allow" as const, Action: "ec2:RunInstances", Resource: `arn:aws:ec2:${t.region}::image/*`, Condition: { StringEquals: { "ec2:Owner": t.imageOwner } } }]),
      {
        Sid: "PassFleetHostRole",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: t.hostRoleArn,
        Condition: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      },
    ],
  };
}

export function fleetHostPolicy(t: { cellUrl: string; bucket: string; region: string; kmsKey: string | null; accountId: string; boxRole: string }): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      ...boxIdentityPolicy(t.cellUrl).Statement.map((s) => ({ ...s, Sid: "HostIdentity" })),
      { Sid: "BoxRole", Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"], Resource: `arn:aws:iam::${t.accountId}:role/${t.boxRole}` },
      { Sid: "SleepingBoxes", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"], Resource: `arn:aws:s3:::${t.bucket}/vms/*` },
      { Sid: "ListSleepingBoxes", Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${t.bucket}`, Condition: { StringLike: { "s3:prefix": "vms/*" } } },
      ...(t.kmsKey === null
        ? []
        : [{ Sid: "SleepingBoxesKey", Effect: "Allow" as const, Action: ["kms:GenerateDataKey", "kms:Decrypt"], Resource: t.kmsKey, Condition: { StringEquals: { "kms:ViaService": `s3.${t.region}.amazonaws.com` } } }]),
    ],
  };
}

export interface RoleTrustDocument {
  Version: "2012-10-17";
  Statement: { Sid: string; Effect: "Allow"; Principal: { Service: string } | { AWS: string }; Action: "sts:AssumeRole" | ("sts:AssumeRole" | "sts:TagSession")[] }[];
}

export function fleetBoxTrustPolicy(hostRoleArn: string): RoleTrustDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "Boxes", Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
      { Sid: "FleetHosts", Effect: "Allow", Principal: { AWS: hostRoleArn }, Action: ["sts:AssumeRole", "sts:TagSession"] },
    ],
  };
}

export interface BucketPolicyDocument {
  Version: "2012-10-17";
  Statement: { Sid: string; Effect: "Deny"; Principal: "*"; Action: string; Resource: string[]; Condition: Record<string, Record<string, string>> }[];
}

export function snapshotsBucketPolicy(bucket: string): BucketPolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TlsOnly",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  };
}
