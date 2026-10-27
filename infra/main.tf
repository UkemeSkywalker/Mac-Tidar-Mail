locals {
  account_id            = data.aws_caller_identity.current.account_id
  receipt_rule_set_name = "mactidar-mail"
}

module "kms" {
  source     = "./modules/kms"
  account_id = local.account_id
  region     = var.region
}

module "storage" {
  source                = "./modules/storage"
  bucket_name           = "mactidar-mail-${local.account_id}"
  account_id            = local.account_id
  region                = var.region
  receipt_rule_set_name = local.receipt_rule_set_name
  app_origins           = var.app_origins
}

module "table" {
  source      = "./modules/table"
  table_name  = "mactidar-mail"
  kms_key_arn = module.kms.data_key_arn
}

module "ses" {
  source      = "./modules/ses"
  root_domain = var.root_domain
  region      = var.region
  account_id  = local.account_id
  kms_key_arn = module.kms.data_key_arn
}

module "auth_client" {
  source       = "./modules/auth_client"
  user_pool_id = var.cognito_user_pool_id
}

module "monitoring" {
  source             = "./modules/monitoring"
  account_id         = local.account_id
  alert_email        = var.alert_email
  monthly_budget_usd = var.monthly_budget_usd
  kms_key_arn        = module.kms.data_key_arn
}

module "inbound" {
  source                = "./modules/inbound"
  account_id            = local.account_id
  region                = var.region
  receipt_rule_set_name = local.receipt_rule_set_name
  receiving_domains     = var.receiving_domains
  local_domains         = [var.root_domain]
  bucket_name           = module.storage.bucket_name
  bucket_arn            = module.storage.bucket_arn
  table_name            = module.table.table_name
  table_arn             = module.table.table_arn
  raw_mail_key_arn      = module.kms.raw_mail_key_arn
  data_key_arn          = module.kms.data_key_arn
  alerts_topic_arn      = module.monitoring.alerts_topic_arn
  lambda_source_dir     = "${path.root}/../services/mail/dist/inbound"
}

module "api" {
  source                = "./modules/api"
  region                = var.region
  user_pool_id          = var.cognito_user_pool_id
  client_id             = module.auth_client.client_id
  app_origins           = var.app_origins
  bucket_name           = module.storage.bucket_name
  bucket_arn            = module.storage.bucket_arn
  table_name            = module.table.table_name
  table_arn             = module.table.table_arn
  data_key_arn          = module.kms.data_key_arn
  alerts_topic_arn      = module.monitoring.alerts_topic_arn
  lambda_source_dir     = "${path.root}/../services/mail/dist/api"
  events_source_dir     = "${path.root}/../services/mail/dist/ses-events"
  account_id            = local.account_id
  local_domains         = var.receiving_domains
  ses_identity_arn      = module.ses.identity_arn
  ses_configuration_set = module.ses.configuration_set_name
  ses_events_topic_arn  = module.ses.ses_events_topic_arn
}

module "hosting" {
  source             = "./modules/hosting"
  providers          = { aws = aws.eu }
  domain             = "mail.${var.root_domain}"
  api_url            = trimsuffix(module.api.api_url, "/")
  cognito_region     = var.region
  mail_bucket        = module.storage.bucket_name
  mail_bucket_region = var.region
}
