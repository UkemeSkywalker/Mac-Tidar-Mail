# Push: a WebSocket API that lets the server tell open browser tabs "new mail arrived".
# Messages carry no content; the browser fetches and decrypts mail itself.

variable "region" { type = string }
variable "user_pool_id" { type = string }
variable "client_id" { type = string }
variable "table_name" { type = string }
variable "table_arn" { type = string }
variable "data_key_arn" { type = string }
variable "lambda_source_dir" { type = string }

locals { function_name = "mactidar-mail-push" }

data "archive_file" "push" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/push.zip"
  excludes    = ["index.mjs.map"]
}

resource "aws_cloudwatch_log_group" "push" {
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

resource "aws_iam_role" "push" {
  name               = local.function_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "push" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.push.arn}:*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
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

resource "aws_iam_role_policy" "push" {
  name   = "push"
  role   = aws_iam_role.push.id
  policy = data.aws_iam_policy_document.push.json
}

resource "aws_lambda_function" "push" {
  function_name    = local.function_name
  role             = aws_iam_role.push.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.push.output_path
  source_code_hash = data.archive_file.push.output_base64sha256
  memory_size      = 256
  timeout          = 10
  environment {
    variables = {
      MAIL_TABLE           = var.table_name
      COGNITO_USER_POOL_ID = var.user_pool_id
      COGNITO_CLIENT_ID    = var.client_id
      NODE_OPTIONS         = "--enable-source-maps"
    }
  }
  depends_on = [aws_cloudwatch_log_group.push, aws_iam_role_policy.push]
}

resource "aws_apigatewayv2_api" "ws" {
  name                       = "mactidar-mail-push"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_integration" "push" {
  api_id           = aws_apigatewayv2_api.ws.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.push.invoke_arn
}

resource "aws_apigatewayv2_route" "routes" {
  for_each  = toset(["$connect", "$disconnect", "$default"])
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.push.id}"
}

resource "aws_apigatewayv2_stage" "live" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "live"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
}

resource "aws_lambda_permission" "ws" {
  statement_id  = "AllowWebSocketInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.push.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

output "ws_url" { value = aws_apigatewayv2_stage.live.invoke_url }
output "management_endpoint" { value = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${var.region}.amazonaws.com/${aws_apigatewayv2_stage.live.name}" }
output "manage_connections_arn" { value = "${aws_apigatewayv2_api.ws.execution_arn}/${aws_apigatewayv2_stage.live.name}/POST/@connections/*" }
