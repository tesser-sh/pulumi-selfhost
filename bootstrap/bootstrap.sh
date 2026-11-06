#!/usr/bin/env bash
set -euo pipefail

ACCOUNT=016370843728
REGION=us-west-2
SUB=repo:tesser-sh@319273144/pulumi-selfhost@1448597755
BUCKET=tesser-customer-iac-state-$ACCOUNT
KEY_ALIAS=alias/customer-iac-pulumi
GITHUB=token.actions.githubusercontent.com
TAG_KEY=tesser:customer-iac
TAGS="Key=$TAG_KEY,Value=1"

aws() { command "${AWS:-aws}" --region "$REGION" "$@"; }

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "not in $ACCOUNT" >&2; exit 1; }

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=$TAG_KEY,Value=1}]"

KEY_ARN=$(aws kms describe-key --key-id "$KEY_ALIAS" --query KeyMetadata.Arn --output text 2>/dev/null || true)
if [ -z "$KEY_ARN" ]; then
  KEY_ARN=$(aws kms create-key --description "customer-iac Pulumi secrets" --tags "TagKey=$TAG_KEY,TagValue=1" --query KeyMetadata.Arn --output text)
  aws kms create-alias --alias-name "$KEY_ALIAS" --target-key-id "$KEY_ARN"
fi

PROVIDER_ARN=arn:aws:iam::$ACCOUNT:oidc-provider/$GITHUB
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider --url "https://$GITHUB" --client-id-list sts.amazonaws.com --tags "$TAGS" >/dev/null
fi

trust() {
  cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"$PROVIDER_ARN"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"$GITHUB:aud":"sts.amazonaws.com","$GITHUB:sub":"$1"}}}]}
EOF
}

role() {
  local name=$1 sub=$2
  if aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$name" --policy-document "$(trust "$sub")"
  else
    aws iam create-role --role-name "$name" --assume-role-policy-document "$(trust "$sub")" --tags "$TAGS" >/dev/null
  fi
}

role customer-iac-preview "$SUB:pull_request"
aws iam attach-role-policy --role-name customer-iac-preview --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
aws iam put-role-policy --role-name customer-iac-preview --policy-name state --policy-document "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
  {"Sid":"StateRead","Effect":"Allow","Action":["s3:ListBucket","s3:GetObject"],"Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"]},
  {"Sid":"StateLock","Effect":"Allow","Action":["s3:PutObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::$BUCKET/.pulumi/locks/*"},
  {"Sid":"Secrets","Effect":"Allow","Action":["kms:Decrypt","kms:DescribeKey"],"Resource":"$KEY_ARN"}
]}
EOF
)"

role customer-iac-deploy "$SUB:ref:refs/heads/main"
aws iam attach-role-policy --role-name customer-iac-deploy --policy-arn arn:aws:iam::aws:policy/PowerUserAccess
aws iam put-role-policy --role-name customer-iac-deploy --policy-name iam --policy-document "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
  {"Sid":"ReadIam","Effect":"Allow","Action":["iam:Get*","iam:List*"],"Resource":"*"},
  {"Sid":"ManageDevboxIam","Effect":"Allow","Action":"iam:*","Resource":[
    "arn:aws:iam::$ACCOUNT:role/tesser-*",
    "arn:aws:iam::$ACCOUNT:instance-profile/tesser-*",
    "arn:aws:iam::$ACCOUNT:policy/tesser-*",
    "arn:aws:iam::$ACCOUNT:oidc-provider/*"
  ]}
]}
EOF
)"

echo "state:   s3://$BUCKET?region=$REGION"
echo "secrets: awskms://$KEY_ALIAS?region=$REGION"
echo "preview: arn:aws:iam::$ACCOUNT:role/customer-iac-preview"
echo "deploy:  arn:aws:iam::$ACCOUNT:role/customer-iac-deploy"
