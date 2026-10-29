# Mac Tidar Mail infrastructure

Terraform for the mail backend. Everything lives in **af-south-1** (SES production access, SES inbound and the Mail user pool are all there) in account `831981619011`.

State is stored in the existing `mactidar-tfstate-831981619011` bucket under `mactidar-mail/terraform.tfstate` — separate from Mac Tidar Cloud's state.

## Run

```bash
cp terraform.tfvars.example terraform.tfvars   # set alert_email
terraform init
terraform plan -out=mail.tfplan
terraform apply mail.tfplan
terraform output dns_records_to_add_at_namecheap
```

## What it manages

| Module | Resources |
|---|---|
| `kms` | `alias/mactidar-mail-raw` (SES encrypts inbound mail with it before storing), `alias/mactidar-mail-data` (table/topic encryption) |
| `storage` | `mactidar-mail-<account>` bucket: private, TLS-only, versioned; `raw/` expires after 3 days |
| `table` | `mactidar-mail` DynamoDB table with folder (`gsi1`) and thread (`gsi2`) indexes, PITR, deletion protection |
| `ses` | `mactidar.com` sending identity (2048-bit DKIM), MAIL FROM `bounce.mactidar.com`, `mactidar-mail` configuration set (TLS required, bounce/complaint suppression, events → SNS) |
| `users` | Mail's own Cognito user pool: the @mactidar.com address is the username (the only sign-in name); the email attribute is the backup address for codes. Pre-sign-up Lambda + daily clean-up of unfinished sign-ups. |
| `monitoring` | alerts topic + email, `mactidar-mail-monthly` budget, account CloudTrail |

## Manual steps

- **DNS (Namecheap):** add the records from `terraform output dns_records_to_add_at_namecheap`. They only authenticate sending; mail delivery for `mactidar.com` is unchanged until the MX cutover.
- **Alerts:** confirm the subscription email AWS sends to `alert_email`.
- **Budget:** activate `Project` as a cost allocation tag (Billing → Cost allocation tags) so the budget can see spend.
