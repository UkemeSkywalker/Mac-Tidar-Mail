output "dns_records_to_add_at_namecheap" {
  description = "Sending-authentication records. Safe to add now: they do not change where mail is delivered."
  value       = module.ses.dns_records
}

output "inbound_mx_records_phase_3" {
  description = "Add these only in Phase 3, once the inbound rule and Lambda exist."
  value = [for d in var.receiving_domains : {
    purpose = "Inbound mail for ${d}"
    type    = "MX"
    host    = trimsuffix(trimsuffix(d, var.root_domain), ".") == "" ? "@" : trimsuffix(trimsuffix(d, var.root_domain), ".")
    value   = "10 inbound-smtp.${var.region}.amazonaws.com"
  }]
}

output "mail_app_config" {
  description = "Public values for the web app's environment (none are secrets)."
  value = {
    NEXT_PUBLIC_AWS_REGION           = var.region
    NEXT_PUBLIC_COGNITO_USER_POOL_ID = module.users.user_pool_id
    NEXT_PUBLIC_COGNITO_CLIENT_ID    = module.users.client_id
    NEXT_PUBLIC_MAIL_API             = trimsuffix(module.api.api_url, "/")
    NEXT_PUBLIC_MAIL_WS              = module.push.ws_url
  }
}

output "mail_bucket" { value = module.storage.bucket_name }
output "mail_table" { value = module.table.table_name }
output "ses_configuration_set" { value = module.ses.configuration_set_name }
output "raw_mail_kms_key_arn" { value = module.kms.raw_mail_key_arn }

output "web_hosting" {
  value = {
    app_id      = module.hosting.app_id
    branch      = module.hosting.branch
    default_url = module.hosting.default_url
  }
}

output "web_dns_records_to_add_at_namecheap" {
  description = "Certificate validation + mail.mactidar.com → Amplify. Raw strings from Amplify: '<host> <TYPE> <value>'."
  value       = concat([module.hosting.certificate_verification_record], module.hosting.domain_records)
}
