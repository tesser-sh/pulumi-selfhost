# pulumi-selfhost

The Pulumi stack a tesser self-host customer deploys into their own AWS account. IAM in `tesser-policy.ts` is a copy of `protocol/src/cloud.ts`, which `tesser cloud check` checks against.

One region: a VPC with one private box subnet, NAT and an S3 endpoint; the box security group (TCP 14650 from itself only); tesser's role `tesser-<org id>`, trusted only by that org; the box role; the snapshots bucket; `tesser-member-access` for Session Manager ssh. Optional: `parameterStore`, and CI/cloud-agent roles via `oidcAccess`.

```sh
pulumi config set tesser:orgId <org id> && pulumi config set aws:region <region> && pulumi up
# then run the `connect` output (tesser cloud connect ...)
```

## Testing ground

Deploys to `rohan-admin-devacc` (016370843728, us-west-2) as placeholder org `org_00000000c1ac`. PRs get a `pulumi preview --diff` comment, main runs `pulumi up`. State and KMS are in that account (`bootstrap/bootstrap.sh`), no Pulumi Cloud.
