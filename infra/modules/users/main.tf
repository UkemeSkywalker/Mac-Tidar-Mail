# Mac Tidar Mail's own user pool. The username IS the @mactidar.com address and is the only way
# to sign in: the pool has no email or phone alias, so the backup email can't be used to log in.
# Cognito sends sign-up and password-reset codes to that backup email (the `email` attribute).
# SRP sign-in only: the password never reaches our servers, which is what lets the browser also
# lock the mailbox key with it.

variable "region" { type = string }
variable "account_id" { type = string }
variable "root_domain" { type = string }
variable "local_domains" { type = list(string) }
variable "ses_identity_arn" { type = string }
variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "data_key_arn" { type = string }
variable "alerts_topic_arn" { type = string }
variable "lambda_source_dir" { type = string }

locals {
  function_name = "mactidar-mail-auth"
  # Fields the sign-up form sends. Validated by the pre-sign-up Lambda, not by the pool schema.
  profile_attributes = ["email", "given_name", "middle_name", "family_name", "birthdate", "phone_number", "gender", "custom:country"]
}

# Lets Cognito send its codes from no-reply@<root_domain> through our SES identity.
resource "aws_sesv2_email_identity_policy" "cognito" {
  email_identity = var.root_domain
  policy_name    = "cognito-mail-users"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CognitoSendsAccountCodes"
      Effect    = "Allow"
      Principal = { Service = "cognito-idp.amazonaws.com" }
      Action    = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource  = var.ses_identity_arn
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
}

resource "aws_cognito_user_pool" "mail" {
  name                = "mactidar-mail-users"
  deletion_protection = "ACTIVE"
  # Two-step verification is optional: each user turns on an authenticator app and/or email codes.
  mfa_configuration = "OPTIONAL"
  software_token_mfa_configuration { enabled = true }
  email_mfa_configuration {
    subject = "Your Mac Tidar Mail sign-in code"
    message = "Your Mac Tidar Mail sign-in code is {####}. If you didn't just try to sign in, change your password."
  }

  username_configuration { case_sensitive = false }
  auto_verified_attributes = ["email"]

  # A changed backup email only takes effect once its code is confirmed.
  user_attribute_update_settings { attributes_require_verification_before_update = ["email"] }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config { allow_admin_create_user_only = false }

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
    password_history_size            = 0
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = var.ses_identity_arn
    from_email_address    = "Mac Tidar Mail <no-reply@${var.root_domain}>"
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Mac Tidar Mail code"
    email_message        = "Your Mac Tidar Mail verification code is {####}. If you didn't ask for it, you can ignore this email."
  }

  schema {
    name                     = "country"
    attribute_data_type      = "String"
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 2
      max_length = 2
    }
  }

  lambda_config {
    pre_sign_up       = aws_lambda_function.auth.arn
    post_confirmation = aws_lambda_function.auth.arn # security alert after a password reset
  }

  depends_on = [aws_sesv2_email_identity_policy.cognito]

  lifecycle { prevent_destroy = true }
}

resource "aws_cognito_user_pool_client" "mail_web" {
  name         = "mactidar-mail-web"
  user_pool_id = aws_cognito_user_pool.mail.id

  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  supported_identity_providers  = ["COGNITO"]

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30 # matches "keep me signed in"
  auth_session_validity  = 5

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  read_attributes  = concat(local.profile_attributes, ["email_verified"])
  write_attributes = local.profile_attributes
}

# ── Pre-sign-up check + daily clean-up of unfinished sign-ups ──────────────────────────────
data "archive_file" "auth" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/auth.zip"
  excludes    = ["index.mjs.map"]
}

resource "aws_cloudwatch_log_group" "auth" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "auth" {
  name               = local.function_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "auth" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.auth.arn}:*"]
  }
  statement {
    sid       = "ReadReservationsAndMailboxes"
    actions   = ["dynamodb:GetItem"]
    resources = [var.table_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.data_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "SendSecurityAlerts"
    actions   = ["ses:SendEmail"]
    resources = [var.ses_identity_arn]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = ["no-reply@${var.root_domain}"]
    }
  }
  statement {
    sid       = "DeleteUnfinishedSignUps"
    actions   = ["cognito-idp:ListUsers", "cognito-idp:AdminDeleteUser"]
    resources = [aws_cognito_user_pool.mail.arn]
  }
}

resource "aws_iam_role_policy" "auth" {
  name   = "auth"
  role   = aws_iam_role.auth.id
  policy = data.aws_iam_policy_document.auth.json
}

resource "aws_lambda_function" "auth" {
  function_name    = local.function_name
  role             = aws_iam_role.auth.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.auth.output_path
  source_code_hash = data.archive_file.auth.output_base64sha256
  memory_size      = 256
  timeout          = 5 # Cognito waits at most 5 seconds for a trigger

  environment {
    variables = {
      MAIL_TABLE                          = var.table_name
      SIGNUP_DOMAIN                       = var.root_domain
      LOCAL_MAIL_DOMAINS                  = join(",", var.local_domains)
      NODE_OPTIONS                        = "--enable-source-maps"
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  depends_on = [aws_cloudwatch_log_group.auth]
}

resource "aws_lambda_permission" "cognito" {
  statement_id  = "AllowCognitoPreSignUp"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.mail.arn
}

resource "aws_cloudwatch_event_rule" "cleanup" {
  name                = "${local.function_name}-cleanup"
  description         = "Delete Mail accounts left unconfirmed for over a day."
  schedule_expression = "rate(1 day)"
}

resource "aws_cloudwatch_event_target" "cleanup" {
  rule  = aws_cloudwatch_event_rule.cleanup.name
  arn   = aws_lambda_function.auth.arn
  input = jsonencode({ task = "cleanup-unconfirmed", userPoolId = aws_cognito_user_pool.mail.id })
}

resource "aws_lambda_permission" "cleanup" {
  statement_id  = "AllowDailyCleanup"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cleanup.arn
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.function_name}-errors"
  alarm_description   = "Many Mail sign-up Lambda failures. Each refused sign-up counts as one, so a few are normal."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.auth.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
}

output "user_pool_id" { value = aws_cognito_user_pool.mail.id }
output "user_pool_arn" { value = aws_cognito_user_pool.mail.arn }
output "client_id" { value = aws_cognito_user_pool_client.mail_web.id }
