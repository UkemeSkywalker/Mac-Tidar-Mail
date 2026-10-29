#!/usr/bin/env bash
# Builds the site and deploys it to mail.mactidar.com (Amplify Hosting, eu-west-1).
#   scripts/deploy-web.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=eu-west-1
read -r APP_ID BRANCH < <(terraform -chdir=infra output -json web_hosting | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["app_id"], d["branch"])')

echo "› Building…"
npm run build >/dev/null
git checkout -q -- next-env.d.ts 2>/dev/null || true
grep -rqs "execute-api.af-south-1.amazonaws.com" out/_next/static || { echo "Build is missing the mail API config (.env.production)"; exit 1; }
# .env.local overrides .env.production at build time; make sure the build uses Terraform's current sign-in client.
CLIENT_ID=$(terraform -chdir=infra output -json mail_app_config | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["NEXT_PUBLIC_COGNITO_CLIENT_ID"])')
grep -rqs "$CLIENT_ID" out/_next/static || { echo "Build doesn't use the current Cognito client ($CLIENT_ID). Check .env.local and .env.production."; exit 1; }

ZIP="$(mktemp -d)/site.zip"
(cd out && zip -qr "$ZIP" .)
echo "› Uploading $(du -h "$ZIP" | cut -f1)…"
read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" --query '[jobId, zipUploadUrl]' --output text)
curl -sSf -X PUT -H "Content-Type: application/zip" --upload-file "$ZIP" "$UPLOAD_URL" >/dev/null
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" --region "$REGION" >/dev/null

echo "› Deploying (job $JOB_ID)…"
while :; do
  STATUS=$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" --region "$REGION" --query 'job.summary.status' --output text)
  case "$STATUS" in
    SUCCEED) echo "✓ Live: https://mail.mactidar.com (also https://$BRANCH.$APP_ID.amplifyapp.com)"; break ;;
    FAILED|CANCELLED) echo "✗ Deployment $STATUS"; exit 1 ;;
    *) sleep 5 ;;
  esac
done
rm -f "$ZIP"
