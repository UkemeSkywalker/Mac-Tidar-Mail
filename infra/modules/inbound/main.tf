# Receiving: SES (TLS required, spam + virus scan) → S3 raw/ (client-side KMS encrypted by SES)
# → inbound Lambda → OpenPGP ciphertext in S3 msg/ + att/ and the mailbox table.

variable "account_id" { type = string }
variable "region" { type = string }
variable "receipt_rule_set_name" { type = string }
variable "receiving_domains" { type = list(string) }
variable "local_domains" { type = list(string) }
variable "bucket_name" { type = string }
variable "bucket_arn" { type = string }
variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "raw_mail_key_arn" { type = string }
variable "data_key_arn" { type = string }
variable "alerts_topic_arn" { type = string }
variable "lambda_source_dir" { type = string }

locals {
  function_name = "mactidar-mail-inbound"
  rule_name     = "inbound"
  rule_arn      = "arn:aws:ses:${var.region}:${var.account_id}:receipt-rule-set/${var.receipt_rule_set_name}:receipt-rule/${local.rule_name}"
}

data "archive_file" "inbound" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/inbound.zip"
  excludes    = ["index.mjs.map"]
}

resource "aws_cloudwatch_log_group" "inbound" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 14
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.function_name}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
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

resource "aws_iam_role" "inbound" {
  name               = local.function_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "inbound" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.inbound.arn}:*"]
  }
  statement {
    sid       = "ReadAndDeleteRawMail"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${var.bucket_arn}/raw/*"]
  }
  statement {
    sid       = "WriteCiphertext"
    actions   = ["s3:PutObject"]
    resources = ["${var.bucket_arn}/msg/*", "${var.bucket_arn}/att/*"]
  }
  statement {
    sid       = "DecryptSesEnvelopesOnly"
    actions   = ["kms:Decrypt"]
    resources = [var.raw_mail_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:ses:source-account"
      values   = [var.account_id]
    }
  }
  statement {
    sid       = "MailboxTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [var.table_arn]
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
    sid       = "DeadLetter"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "inbound" {
  name   = "inbound"
  role   = aws_iam_role.inbound.id
  policy = data.aws_iam_policy_document.inbound.json
}

resource "aws_lambda_function" "inbound" {
  function_name    = local.function_name
  role             = aws_iam_role.inbound.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.inbound.output_path
  source_code_hash = data.archive_file.inbound.output_base64sha256
  memory_size      = 1024
  timeout          = 120

  environment {
    variables = {
      MAIL_BUCKET                         = var.bucket_name
      MAIL_TABLE                          = var.table_name
      RAW_PREFIX                          = "raw/"
      RAW_KMS_KEY_ARN                     = var.raw_mail_key_arn
      RECEIVING_DOMAINS                   = join(",", var.receiving_domains)
      LOCAL_DOMAINS                       = join(",", var.local_domains)
      NODE_OPTIONS                        = "--enable-source-maps"
      AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    }
  }

  depends_on = [aws_cloudwatch_log_group.inbound, aws_iam_role_policy.inbound]
}

resource "aws_lambda_function_event_invoke_config" "inbound" {
  function_name                = aws_lambda_function.inbound.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 21600
  destination_config {
    on_failure {
      destination = aws_sqs_queue.dlq.arn
    }
  }
}

resource "aws_lambda_permission" "ses" {
  statement_id   = "AllowSESInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.inbound.function_name
  principal      = "ses.amazonaws.com"
  source_account = var.account_id
  source_arn     = local.rule_arn
}

resource "aws_ses_receipt_rule_set" "mail" {
  rule_set_name = var.receipt_rule_set_name
}

resource "aws_ses_receipt_rule" "inbound" {
  name          = local.rule_name
  rule_set_name = aws_ses_receipt_rule_set.mail.rule_set_name
  recipients    = var.receiving_domains
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = var.bucket_name
    object_key_prefix = "raw/"
    kms_key_arn       = var.raw_mail_key_arn
  }

  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.inbound.arn
    invocation_type = "Event"
  }

  depends_on = [aws_lambda_permission.ses]
}

resource "aws_ses_active_receipt_rule_set" "mail" {
  rule_set_name = aws_ses_receipt_rule_set.mail.rule_set_name
  depends_on    = [aws_ses_receipt_rule.inbound]
}

resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${local.function_name}-failed-mail"
  alarm_description   = "Inbound mail failed processing after retries; it is waiting in the dead-letter queue (raw copy kept up to 3 days)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.function_name}-errors"
  alarm_description   = "The inbound mail Lambda is throwing errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.inbound.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
}

output "function_name" { value = aws_lambda_function.inbound.function_name }
output "dlq_url" { value = aws_sqs_queue.dlq.url }
