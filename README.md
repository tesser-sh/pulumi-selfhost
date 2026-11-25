# pulumi-selfhost

The Pulumi stack a tesser self-host customer deploys into their own AWS account. This repo is the only copy of the self-host setup; `tesser cloud check` dry-runs its IAM at connect.

One region: a VPC with a private box subnet in every zone that has fleet hosts (`ZONES` in `index.ts`), one NAT and an S3 endpoint; the box security group (self only: TCP 14650-14655, TCP 22000-23999, UDP 51820); box and fleet host roles; the snapshots bucket; `tesser-member-access` for Session Manager ssh. Optional: `parameterStore`, and CI/cloud-agent roles via `oidcAccess`.

Every stack runs tesser's actuator: one Fargate ARM64 task that dials out to tesser and makes its AWS calls as `tesser-actuator`, which can't touch its audit log `/tesser/actuator`. The image is pinned by digest in `index.ts`; its source is [tesser-sh/actuator](https://github.com/tesser-sh/actuator), and `gh attestation verify oci://public.ecr.aws/tesser/actuator@<digest> -R tesser-sh/actuator` checks the image was built from it.

```sh
pulumi config set tesser:orgId <org id> && pulumi config set aws:region <region> && pulumi up
# then run the `connect` output (tesser cloud connect ...)
```

An org that is already connected adds only the actuator part of `index.ts`, then runs `tesser cloud connect --actuator tesser-actuator`. Every other setting stays. Leave out `--account`: it swaps in the default role name, which connect refuses while the fleet holds boxes.

## Testing ground

Deploys to `rohan-admin-devacc` (016370843728, us-west-2) as the selfhost staging org `org_b4e0cd03ff75`. PRs get a `pulumi preview --diff` comment, main runs `pulumi up`. State and KMS are in that account (`bootstrap/bootstrap.sh`), no Pulumi Cloud.
