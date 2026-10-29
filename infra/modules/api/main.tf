# Mail API: HTTP API + Cognito JWT authorizer → api Lambda. The Lambda only ever handles
# ciphertext; it can touch the mail table and the msg/ + att/ prefixes, nothing else.

variable "region" { type = string }
variable "user_pool_id" { type = string }
variable "user_pool_arn" { type = string }
variable "client_id" { type = string }
variable "app_origins" { type = list(string) }
variable "bucket_name" { type = string }
variable "bucket_arn" { type = string }
variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "data_key_arn" { type = string }
variable "alerts_topic_arn" { type = string }
variable "lambda_source_dir" { type = string }
variable "ws_endpoint" { type = string }
variable "ws_manage_arn" { type = string }
variable "events_source_dir" { type = string }
variable "account_id" { type = string }
variable "local_domains" { type = list(string) }
variable "ses_identity_arn" { type = string }
variable "ses_configuration_set" { type = string }
variable "ses_events_topic_arn" { type = string }
variable "signup_domain" { type = string }

locals {
  function_name = "mactidar-mail-api"
  routes = [
    "GET /v1/mailboxes",
    "POST /v1/mailboxes",
    "PUT /v1/mailboxes/{address}/keys",
    "GET /v1/mailboxes/{address}/messages",
    "PATCH /v1/mailboxes/{address}/messages",
    "POST /v1/mailboxes/{address}/messages/delete",
    "GET /v1/mailboxes/{address}/content",
    "GET /v1/mailboxes/{address}/settings",
    "PUT /v1/mailboxes/{address}/settings",
    "GET /v1/keys",
    "POST /v1/mailboxes/{address}/send",
    "GET /v1/mailboxes/{address}/drafts",
    "PUT /v1/mailboxes/{address}/drafts/{id}",
    "DELETE /v1/mailboxes/{address}/drafts/{id}",
    "POST /v1/sessions",
    "GET /v1/sessions/{id}/key",
    "DELETE /v1/sessions/{id}",
    "DELETE /v1/sessions",
  ]
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/api.zip"
  excludes    = ["index.mjs.map"]
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${local.function_name}"
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

resource "aws_iam_role" "api" {
  name               = local.function_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
  statement {
    sid       = "MailboxTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [var.table_arn, "${var.table_arn}/index/*"]
  }
  statement {
    sid       = "TableEncryptionKeyViaDynamoDB"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "CiphertextObjects"
    actions   = ["s3:GetObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${var.bucket_arn}/msg/*", "${var.bucket_arn}/att/*"]
  }
  statement {
    sid     = "SendAsMacTidarAddressesOnly"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = concat(
      [var.ses_identity_arn, "arn:aws:ses:${var.region}:${var.account_id}:configuration-set/${var.ses_configuration_set}"],
      [for d in var.local_domains : "arn:aws:ses:${var.region}:${var.account_id}:identity/${d}"],
    )
    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = [for d in var.local_domains : "*@${d}"]
    }
  }
  statement {
    sid       = "PushNewMailSignal"
    actions   = ["execute-api:ManageConnections"]
    resources = [var.ws_manage_arn]
  }
  statement {
    sid       = "ReadMailAccountForMailboxClaim"
    actions   = ["cognito-idp:AdminGetUser"]
    resources = [var.user_pool_arn]
  }
  statement {
    sid       = "WriteSentCiphertext"
    actions   = ["s3:PutObject"]
    resources = ["${var.bucket_arn}/msg/*", "${var.bucket_arn}/att/*"]
  }
  statement {
    sid       = "ListCiphertextVersions"
    actions   = ["s3:ListBucketVersions"]
    resources = [var.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["msg/*", "att/*"]
    }
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_lambda_function" "api" {
  function_name    = local.function_name
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 1024
  timeout          = 30

  environment {
    variables = {
      MAIL_BUCKET                         = var.bucket_name
      MAIL_TABLE                          = var.table_name
      SES_CONFIGURATION_SET               = var.ses_configuration_set
      LOCAL_MAIL_DOMAINS                  = join(",", var.local_domains)
      SIGNUP_DOMAIN                       = var.signup_domain
      MAIL_USER_POOL_ID                   = var.user_pool_id
      WS_ENDPOINT                         = var.ws_endpoint
      NODE_OPTIONS                        = "--enable-source-maps"
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api]
}

resource "aws_apigatewayv2_api" "mail" {
  name          = "mactidar-mail"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.app_origins
    allow_methods = ["GET", "PUT", "PATCH", "POST", "DELETE"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.mail.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${var.user_pool_id}"
    audience = [var.client_id]
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.mail.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "routes" {
  for_each           = toset(local.routes)
  api_id             = aws_apigatewayv2_api.mail.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.mail.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 40
    throttling_rate_limit  = 20
  }

  # Opening a new mailbox gets a much lower limit than the rest of the API.
  route_settings {
    route_key              = "POST /v1/mailboxes"
    throttling_burst_limit = 5
    throttling_rate_limit  = 2
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId = "$context.requestId", route = "$context.routeKey", status = "$context.status",
      latencyMs = "$context.responseLatency", authError = "$context.authorizer.error", ip = "$context.identity.sourceIp"
    })
  }
  # Route-level throttles need the routes to exist first.
  depends_on = [aws_apigatewayv2_route.routes]
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.mail.execution_arn}/*/*"
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.function_name}-errors"
  alarm_description   = "The mail API Lambda is throwing errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
}

output "api_url" { value = aws_apigatewayv2_stage.default.invoke_url }

# ── Delivery events: SES → SNS → this Lambda → Sent copy's delivery status ──────────────────
data "archive_file" "events" {
  type        = "zip"
  source_dir  = var.events_source_dir
  output_path = "${path.root}/.build/ses-events.zip"
  excludes    = ["index.mjs.map"]
}

resource "aws_cloudwatch_log_group" "events" {
  name              = "/aws/lambda/mactidar-mail-ses-events"
  retention_in_days = 14
}

resource "aws_iam_role" "events" {
  name               = "mactidar-mail-ses-events"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "events" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.events.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [var.table_arn]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "events" {
  name   = "ses-events"
  role   = aws_iam_role.events.id
  policy = data.aws_iam_policy_document.events.json
}

resource "aws_lambda_function" "events" {
  function_name    = "mactidar-mail-ses-events"
  role             = aws_iam_role.events.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.events.output_path
  source_code_hash = data.archive_file.events.output_base64sha256
  memory_size      = 256
  timeout          = 15
  environment {
    variables = { MAIL_TABLE = var.table_name, NODE_OPTIONS = "--enable-source-maps" }
  }
  depends_on = [aws_cloudwatch_log_group.events, aws_iam_role_policy.events]
}

resource "aws_lambda_permission" "sns" {
  statement_id  = "AllowSesEventsTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.events.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = var.ses_events_topic_arn
}

resource "aws_sns_topic_subscription" "events" {
  topic_arn = var.ses_events_topic_arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.events.arn
}
