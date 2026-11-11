# Company logos for customer domains ("Business").
#   uploads/<domain>/<sub>/…  what owners upload (browser → S3 presigned POST). Private: a domain
#                             that isn't verified yet can't show anyone a logo. Expired after 7 days.
#   logos/<domain>/…          a verified domain's published logo, served publicly through
#                             CloudFront (and nothing else in the bucket is).

variable "bucket_name" { type = string }
variable "app_origins" { type = list(string) }

resource "aws_s3_bucket" "brand" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_ownership_controls" "brand" {
  bucket = aws_s3_bucket.brand.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "brand" {
  bucket                  = aws_s3_bucket.brand.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "brand" {
  bucket = aws_s3_bucket.brand.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "brand" {
  bucket = aws_s3_bucket.brand.id
  rule {
    id     = "expire-unconfirmed-uploads"
    status = "Enabled"
    filter {
      prefix = "uploads/"
    }
    expiration {
      days = 7
    }
  }
}

# The setup page uploads straight from the browser, and previews a pending logo with a signed URL.
resource "aws_s3_bucket_cors_configuration" "brand" {
  bucket = aws_s3_bucket.brand.id
  cors_rule {
    allowed_methods = ["POST", "GET"]
    allowed_origins = var.app_origins
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_cloudfront_origin_access_control" "brand" {
  name                              = var.bucket_name
  description                       = "Company logos for Mac Tidar Mail"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Images only: nothing served here can run script, be framed, or be sniffed as another type.
resource "aws_cloudfront_response_headers_policy" "brand" {
  name = "mactidar-mail-brand"
  security_headers_config {
    content_type_options {
      override = true
    }
    content_security_policy {
      content_security_policy = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
      override                = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
  custom_headers_config {
    items {
      header   = "Cross-Origin-Resource-Policy"
      value    = "cross-origin"
      override = true
    }
  }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "brand" {
  enabled         = true
  comment         = "Mac Tidar Mail company logos"
  price_class     = "PriceClass_All" # af-south-1 visitors are best served from African edges
  is_ipv6_enabled = true
  http_version    = "http2and3"

  origin {
    origin_id                = "brand"
    domain_name              = aws_s3_bucket.brand.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.brand.id
  }

  default_cache_behavior {
    target_origin_id           = "brand"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = false
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.brand.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# CloudFront may read published logos only; uploads stay private.
data "aws_iam_policy_document" "brand" {
  statement {
    sid       = "CloudFrontReadsPublishedLogos"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.brand.arn}/logos/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.brand.arn]
    }
  }
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.brand.arn, "${aws_s3_bucket.brand.arn}/*"]
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
}

resource "aws_s3_bucket_policy" "brand" {
  bucket     = aws_s3_bucket.brand.id
  policy     = data.aws_iam_policy_document.brand.json
  depends_on = [aws_s3_bucket_public_access_block.brand]
}

output "bucket_name" { value = aws_s3_bucket.brand.bucket }
output "bucket_arn" { value = aws_s3_bucket.brand.arn }
output "bucket_regional_domain" { value = aws_s3_bucket.brand.bucket_regional_domain_name }
output "url" { value = "https://${aws_cloudfront_distribution.brand.domain_name}" }
