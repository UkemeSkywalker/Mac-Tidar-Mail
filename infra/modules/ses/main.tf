# Sending identity and reputation plumbing for @mactidar.com.
# Inbound receipt rules are added in Phase 3 together with the inbound Lambda.

variable "root_domain" { type = string }
variable "region" { type = string }
variable "account_id" { type = string }
variable "kms_key_arn" { type = string }

locals {
  mail_from_domain = "bounce.${var.root_domain}"
}

resource "aws_sns_topic" "ses_events" {
  name              = "mactidar-mail-ses-events"
  kms_master_key_id = var.kms_key_arn
}

data "aws_iam_policy_document" "ses_events" {
  statement {
    sid       = "AllowSESToPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ses_events.arn]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "ses_events" {
  arn    = aws_sns_topic.ses_events.arn
  policy = data.aws_iam_policy_document.ses_events.json
}

resource "aws_sesv2_configuration_set" "mail" {
  configuration_set_name = "mactidar-mail"

  delivery_options {
    # Refuse to hand mail to receiving servers that can't do TLS.
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.mail.configuration_set_name
  event_destination_name = "sns-events"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"]
    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.ses_events]
}

resource "aws_sesv2_email_identity" "root" {
  email_identity         = var.root_domain
  configuration_set_name = aws_sesv2_configuration_set.mail.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "root" {
  email_identity         = aws_sesv2_email_identity.root.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

output "configuration_set_name" { value = aws_sesv2_configuration_set.mail.configuration_set_name }
output "ses_events_topic_arn" { value = aws_sns_topic.ses_events.arn }
output "identity_arn" { value = aws_sesv2_email_identity.root.arn }

output "dns_records" {
  description = "Records to add at Namecheap for sending authentication. None of these change where mail is delivered."
  value = concat(
    [for t in aws_sesv2_email_identity.root.dkim_signing_attributes[0].tokens : {
      purpose = "DKIM"
      type    = "CNAME"
      host    = "${t}._domainkey"
      value   = "${t}.dkim.${var.region}.amazonses.com"
    }],
    [
      {
        purpose = "MAIL FROM (bounce handling)"
        type    = "MX"
        host    = "bounce"
        value   = "10 feedback-smtp.${var.region}.amazonses.com"
      },
      {
        purpose = "MAIL FROM SPF"
        type    = "TXT"
        host    = "bounce"
        value   = "v=spf1 include:amazonses.com ~all"
      },
    ]
  )
}
