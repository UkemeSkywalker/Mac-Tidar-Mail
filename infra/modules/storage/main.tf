# Mail blob store.
#   raw/  transient inbound mail, already KMS-encrypted by SES; deleted by the inbound Lambda
#         after processing, and expired after 3 days as a safety net.
#   msg/  OpenPGP-encrypted message parts.   att/  OpenPGP-encrypted attachments.
# Content is ciphertext before it ever reaches S3, so bucket-level SSE-S3 is an extra layer.

variable "bucket_name" { type = string }
variable "account_id" { type = string }
variable "region" { type = string }
variable "receipt_rule_set_name" { type = string }
variable "app_origins" { type = list(string) }

resource "aws_s3_bucket" "mail" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_ownership_controls" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "mail" {
  bucket                  = aws_s3_bucket.mail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "mail" {
  bucket = aws_s3_bucket.mail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id

  rule {
    id     = "expire-unprocessed-raw-mail"
    status = "Enabled"
    filter {
      prefix = "raw/"
    }
    expiration {
      days = 3
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = var.app_origins
    allowed_headers = ["content-type", "content-length", "x-amz-*"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "mail" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.mail.arn, "${aws_s3_bucket.mail.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "AllowSESToStoreInboundMail"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mail.arn}/raw/*"]
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
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ses:${var.region}:${var.account_id}:receipt-rule-set/${var.receipt_rule_set_name}:receipt-rule/*"]
    }
  }
}

resource "aws_s3_bucket_policy" "mail" {
  bucket     = aws_s3_bucket.mail.id
  policy     = data.aws_iam_policy_document.mail.json
  depends_on = [aws_s3_bucket_public_access_block.mail]
}

output "bucket_name" { value = aws_s3_bucket.mail.bucket }
output "bucket_arn" { value = aws_s3_bucket.mail.arn }
