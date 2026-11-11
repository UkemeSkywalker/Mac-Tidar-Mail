# Mac Tidar Mail on companies' own web addresses (mail.<their domain>).
#
# One CloudFront multi-tenant distribution in front of the web app (Amplify). Each company that
# turns this on becomes a distribution tenant, created at runtime by the API. They add one CNAME,
# `mail` → this connection group's routing endpoint, and CloudFront gets and renews the HTTPS
# certificate for mail.<domain> itself. Same static site; the app reads the company from the host.

variable "app_origin_host" {
  description = "The web app's own host behind CloudFront (the Amplify branch domain)."
  type        = string
}

resource "aws_cloudfront_connection_group" "customers" {
  name         = "mactidar-mail-customer-web"
  enabled      = true
  ipv6_enabled = true
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled" # Amplify already caches; this edge only routes
}

data "aws_cloudfront_origin_request_policy" "all_but_host" {
  # Amplify routes by Host, so it must see its own name, not mail.<company>.
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_multitenant_distribution" "customers" {
  comment      = "Mac Tidar Mail on companies' own web addresses"
  enabled      = true
  http_version = "http2and3"

  origin {
    id          = "app"
    domain_name = var.app_origin_host
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = "app"
    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_but_host.id
    compress                 = true
    allowed_methods {
      items          = ["GET", "HEAD", "OPTIONS"]
      cached_methods = ["GET", "HEAD"]
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  # Tenants differ only by domain and certificate; no per-tenant parameters.
  tenant_config {}
}

output "distribution_id" { value = aws_cloudfront_multitenant_distribution.customers.id }
output "distribution_arn" { value = aws_cloudfront_multitenant_distribution.customers.arn }
output "connection_group_id" { value = aws_cloudfront_connection_group.customers.id }
output "connection_group_arn" { value = aws_cloudfront_connection_group.customers.arn }
output "routing_endpoint" { value = aws_cloudfront_connection_group.customers.routing_endpoint }
