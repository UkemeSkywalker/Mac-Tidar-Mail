# Two customer-managed keys:
# - raw_mail: SES encrypts every inbound message with it before writing to S3 (client-side),
#   so raw mail is never stored readable. Only the inbound Lambda will be granted Decrypt.
# - data: at-rest encryption for the mail table and event topics (defence in depth; message
#   content itself is already OpenPGP ciphertext encrypted in the browser / on arrival).

variable "account_id" { type = string }
variable "region" { type = string }

data "aws_iam_policy_document" "raw_mail" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowSESToEncryptInboundMail"
    actions   = ["kms:GenerateDataKey*", "kms:Encrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:aws:ses:rule-name"
      values   = ["false"]
    }
    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:aws:ses:message-id"
      values   = ["false"]
    }
  }
}

resource "aws_kms_key" "raw_mail" {
  description             = "Mac Tidar Mail: SES client-side encryption of raw inbound mail"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.raw_mail.json
}

resource "aws_kms_alias" "raw_mail" {
  name          = "alias/mactidar-mail-raw"
  target_key_id = aws_kms_key.raw_mail.key_id
}

data "aws_iam_policy_document" "data" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowServicesToPublishEncryptedEvents"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com", "cloudwatch.amazonaws.com", "budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "Mac Tidar Mail: at-rest encryption for the mail table and topics"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.data.json
}

resource "aws_kms_alias" "data" {
  name          = "alias/mactidar-mail-data"
  target_key_id = aws_kms_key.data.key_id
}

output "raw_mail_key_arn" { value = aws_kms_key.raw_mail.arn }
output "data_key_arn" { value = aws_kms_key.data.arn }
