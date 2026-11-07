# Customer web addresses (mail.<their domain>, stage 3 of "bring your own domain").
# One multi-tenant CloudFront distribution sits in front of the same Amplify site as
# mail.mactidar.com, so security headers (CSP, HSTS…) still come from one place. The API adds a
# distribution tenant per connected domain at runtime, each with a CloudFront-managed certificate
# that's issued once the customer's mail.<domain> CNAME points at the connection group below.

variable "origin_domain" {
  description = "The Amplify app's own hostname (main.<id>.amplifyapp.com)."
  type        = string
}

data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_origin_request_policy" "all_but_host" { name = "Managed-AllViewerExceptHostHeader" }

resource "aws_cloudfront_connection_group" "tenants" {
  name         = "mactidar-mail-tenants"
  enabled      = true
  ipv6_enabled = true
}

resource "aws_cloudfront_multitenant_distribution" "tenants" {
  comment      = "Mac Tidar Mail on customer domains"
  enabled      = true
  http_version = "http2and3"

  origin {
    id          = "amplify"
    domain_name = var.origin_domain
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Pages aren't cached here (Amplify has its own CDN and a deploy must show at once);
  # Next.js's hashed build files never change, so those are.
  default_cache_behavior {
    target_origin_id         = "amplify"
    viewer_protocol_policy   = "redirect-to-https"
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_but_host.id
    allowed_methods {
      items          = ["GET", "HEAD"]
      cached_methods = ["GET", "HEAD"]
    }
  }

  cache_behavior {
    path_pattern             = "/_next/static/*"
    target_origin_id         = "amplify"
    viewer_protocol_policy   = "redirect-to-https"
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_but_host.id
    allowed_methods {
      items          = ["GET", "HEAD"]
      cached_methods = ["GET", "HEAD"]
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  # No per-tenant settings: every customer site is the same app.
  tenant_config {}

  # Tenants bring their own (CloudFront-managed) certificates.
  viewer_certificate { cloudfront_default_certificate = true }
}

output "distribution_id" { value = aws_cloudfront_multitenant_distribution.tenants.id }
output "distribution_arn" { value = aws_cloudfront_multitenant_distribution.tenants.arn }
output "connection_group_id" { value = aws_cloudfront_connection_group.tenants.id }
output "connection_group_arn" { value = aws_cloudfront_connection_group.tenants.arn }
output "routing_endpoint" {
  description = "What customers point mail.<their domain> at (CNAME)."
  value       = aws_cloudfront_connection_group.tenants.routing_endpoint
}
