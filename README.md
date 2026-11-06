# customer-iac

The Pulumi stack a tesser self-host customer deploys into their own AWS account. It started from Mintlify's stack. `tesser-policy.ts` is a copy of tesser's template (`protocol/src/cloud.ts`), so IAM matches what `tesser cloud check` expects.

It creates, in one region:

- a VPC (`cidr`, default `10.73.0.0/16`) with one private box subnet in `azId` (default: the zone tesser picks for the region), a NAT, and an S3 gateway endpoint;
- the boxes' security group: TCP 14650 from itself, all outbound, nothing else inbound;
- the `api.tesser.sh` OIDC provider and tesser's role `tesser-<org id>`, trusted only by that org;
- the boxes' role and instance profile `tesser-<org id>-box`;
- the snapshots bucket `tesser-snapshots-<org id>`: public access blocked, SSE-S3, TLS only;
- with `parameterStore: true`, write-only env access for tesser and read access for boxes under `/tesser/<org id>/`;
- `tesser-member-access`, a managed policy that lets a human ssh to the org's boxes over Session Manager. Attach it to your Identity Center permission set (or IAM group);
- optional CI and cloud-agent roles through `oidcAccess` (`githubActions`, `cloudAgent` config; nothing set, no roles). Each gets its own `tesser-<name>-access` policy: box ssh limited to `tesser:org=<org id>` instances, 1 h sessions. To add another, copy one of the two `oidcAccess(...)` calls in `index.ts` with its issuer, audience and subjects.

Deploy: set `tesser:orgId` and `aws:region`, `pulumi up`, then run the `connect` output:

```sh
tesser cloud connect --account <account id> --region <region> --private --snapshots-bucket tesser-snapshots-<org id> [--env parameter-store]
```

The account holds one `api.tesser.sh` provider; a second org in the same account drops it and looks the existing one up.

## Testing ground

This repo deploys to `rohan-admin-devacc` (016370843728, us-west-2) as org `org_00000000c1ac`, a placeholder: devacc already holds the devcloud org's `tesser-org_96008eb02e58` roles.

- PR: `pulumi preview --diff` as `customer-iac-preview` (read-only), posted as a PR comment.
- push to main: `pulumi up` as `customer-iac-deploy`.
- state `s3://tesser-customer-iac-state-016370843728`, secrets KMS `alias/customer-iac-pulumi`, no Pulumi Cloud.
- `bootstrap/bootstrap.sh` makes the state bucket, key, GitHub OIDC provider and both roles: `AWS_PROFILE=rohan-admin-devacc bootstrap/bootstrap.sh`. tesser-sh uses GitHub's immutable OIDC subjects, so its trust does too.
- local: `AWS_PROFILE=rohan-admin-devacc AWS_REGION=us-west-2 pulumi preview`.
