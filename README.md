# pulumi-selfhost

The Pulumi stack a tesser self-host customer deploys into their own AWS account. IAM in `tesser-policy.ts` is a copy of `protocol/src/cloud.ts`, which `tesser cloud check` checks against.

One region: a VPC with one private box subnet, NAT and an S3 endpoint; the box security group (self only: TCP 14650-14655, TCP 22000-23999, UDP 51820); tesser's role `tesser-<org id>`, trusted only by that org; box and fleet host roles; the snapshots bucket; `tesser-member-access` for Session Manager ssh. Optional: `parameterStore`, and CI/cloud-agent roles via `oidcAccess`.

Every stack runs tesser's actuator (`actuator.ts`, image pinned there by digest): two Fargate ARM64 tasks that dial out to tesser and run its AWS calls as `tesser-<org id>-actuator`, which has the same policy as `tesser-<org id>` and can't touch its audit log `/tesser/actuator/<org id>`. It needs IAM outbound identity federation on the account: `pulumi config set tesser:enableFederation true` turns it on (and leaves it on when the component is removed), or once by hand with `aws iam enable-outbound-web-identity-federation`.

```sh
pulumi config set tesser:orgId <org id> && pulumi config set aws:region <region> && pulumi up
# then run the `connect` output (tesser cloud connect ...)
```

## Testing ground

Deploys to `rohan-admin-devacc` (016370843728, us-west-2) as the selfhost staging org `org_b4e0cd03ff75`. PRs get a `pulumi preview --diff` comment, main runs `pulumi up`. State and KMS are in that account (`bootstrap/bootstrap.sh`), no Pulumi Cloud.
