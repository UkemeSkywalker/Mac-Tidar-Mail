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
