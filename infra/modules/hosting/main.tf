# Static hosting for mail.mactidar.com (Next.js static export) on Amplify Hosting.
# Amplify Hosting isn't available in af-south-1, so this module uses the eu-west-1 provider
# (Mac Tidar Cloud is hosted there too). Deploys are uploads of the built `out/` folder
# (scripts/deploy-web.sh), so no Git connection or token is needed.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "domain" { type = string }
variable "api_url" { type = string }
variable "cognito_region" { type = string }
variable "mail_bucket" { type = string }
variable "mail_bucket_region" { type = string }

locals {
  csp = join("; ", [
    "default-src 'self'",
    # Next.js static export inlines its bootstrap scripts; openpgp's Argon2 needs WebAssembly.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ${var.api_url} https://cognito-idp.${var.cognito_region}.amazonaws.com https://${var.mail_bucket}.s3.${var.mail_bucket_region}.amazonaws.com",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ])
}

resource "aws_amplify_app" "mail" {
  name     = "mactidar-mail-web"
  platform = "WEB"

  custom_rule {
    source = "/<*>"
    target = "/404.html"
    status = "404-200"
  }

  custom_headers = yamlencode({
    customHeaders = [{
      pattern = "**"
      headers = [
        { key = "Content-Security-Policy", value = local.csp },
        { key = "Strict-Transport-Security", value = "max-age=31536000; includeSubDomains" },
        { key = "X-Content-Type-Options", value = "nosniff" },
        { key = "X-Frame-Options", value = "DENY" },
        { key = "Referrer-Policy", value = "no-referrer" },
        { key = "Permissions-Policy", value = "camera=(), microphone=(), geolocation=(), payment=()" },
        { key = "Cross-Origin-Opener-Policy", value = "same-origin" },
      ]
    }]
  })
}

resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.mail.id
  branch_name = "main"
  stage       = "PRODUCTION"
}

resource "aws_amplify_domain_association" "mail" {
  app_id                = aws_amplify_app.mail.id
  domain_name           = var.domain
  wait_for_verification = false

  sub_domain {
    branch_name = aws_amplify_branch.main.branch_name
    prefix      = ""
  }
}

output "app_id" { value = aws_amplify_app.mail.id }
output "branch" { value = aws_amplify_branch.main.branch_name }
output "default_url" { value = "https://main.${aws_amplify_app.mail.default_domain}" }
output "certificate_verification_record" { value = aws_amplify_domain_association.mail.certificate_verification_dns_record }
output "domain_records" { value = [for s in aws_amplify_domain_association.mail.sub_domain : s.dns_record] }
