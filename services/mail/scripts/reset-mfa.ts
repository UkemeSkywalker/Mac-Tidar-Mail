// Owner-only: turns off two-step verification for an account that has lost its authenticator app
// and has no email codes. Only run this after confirming who is asking some other way (not by
// replying to an email). Mail stays encrypted: this changes how the account signs in, nothing else.
// The account's backup email gets a security alert.
//   npx tsx scripts/reset-mfa.ts --address someone@mactidar.com
import { AdminGetUserCommand, AdminSetUserMFAPreferenceCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { normalizeAddress } from "../src/crypto";
import { sesAlerts } from "../src/shared/alerts";
import { args, REGION } from "./_aws";

const POOL = process.env.MAIL_USER_POOL_ID ?? "af-south-1_8iVktR1fi";
const address = normalizeAddress(args(["address"], ["address"]).address!);
const cognito = new CognitoIdentityProviderClient({ region: REGION });

const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: address }));
if (!u.UserMFASettingList?.length) { console.log(`${address} has no two-step verification on; nothing to do`); process.exit(0); }
await cognito.send(new AdminSetUserMFAPreferenceCommand({
  UserPoolId: POOL, Username: address,
  SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false }, EmailMfaSettings: { Enabled: false, PreferredMfa: false },
}));
const attr = (n: string) => u.UserAttributes?.find(a => a.Name === n)?.Value;
if (attr("email") && attr("email_verified") === "true") await sesAlerts(new SESv2Client({ region: REGION }), address.split("@")[1]!)(attr("email")!, "mfa-reset", { address, at: new Date() });
console.log(`Two-step verification is off for ${address}; its backup email was told`);
