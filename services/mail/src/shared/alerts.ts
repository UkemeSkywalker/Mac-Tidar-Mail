// Security alert emails, sent to an account's backup email when something about how it signs in
// changes. Plain text with no links, so a real alert never looks like the phishing it warns about.
// Never logs the recipient or the IP address.
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";

export type SecurityEvent =
  | "totp-on" | "totp-off" | "email-mfa-on" | "email-mfa-off"
  | "password-reset" | "signed-out-everywhere" | "mfa-reset";

export interface AlertContext { address: string; at: Date; ip?: string; device?: string }

const WHAT: Record<SecurityEvent, [subject: string, line: string]> = {
  "totp-on": ["Authenticator app turned on", "Two-step verification with an authenticator app was turned on. Signing in now needs a code from that app."],
  "totp-off": ["Authenticator app turned off", "Two-step verification with an authenticator app was turned off."],
  "email-mfa-on": ["Email sign-in codes turned on", "Two-step verification with email codes was turned on. Signing in can now need a code sent to this email."],
  "email-mfa-off": ["Email sign-in codes turned off", "Two-step verification with email codes was turned off."],
  "password-reset": ["Your password was reset", "The password for your account was reset using a code sent to this email."],
  "signed-out-everywhere": ["Signed out of all devices", "Your account was signed out of every device, including the one that asked."],
  "mfa-reset": ["Two-step verification was reset", "Mac Tidar support turned off two-step verification for your account after a request for help signing in."],
};

/** Short, readable browser name from a User-Agent ("Chrome on macOS"), or undefined. */
export function deviceName(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : undefined;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : undefined;
  return browser && os ? `${browser} on ${os}` : browser ?? os;
}

export function alertEmail(event: SecurityEvent, ctx: AlertContext): { subject: string; text: string } {
  const [subject, line] = WHAT[event];
  const when = ctx.at.toUTCString().replace("GMT", "UTC");
  const from = [ctx.device, ctx.ip && `IP address ${ctx.ip}`].filter(Boolean).join(", ");
  return {
    subject: `Security alert: ${subject}`,
    text: [
      `Hello,`,
      ``,
      `${line}`,
      ``,
      `Account: ${ctx.address}`,
      `When: ${when}`,
      ...(from ? [`From: ${from}`] : []),
      ``,
      `If this was you, there's nothing to do.`,
      ``,
      `If it wasn't you, go to mail.mactidar.com yourself (don't use links in emails), reset your password, then open Settings, Security and choose "Sign out of all devices".`,
      ``,
      `Mac Tidar Mail`,
      `You're getting this because this is the backup email for ${ctx.address}.`,
    ].join("\n"),
  };
}

export type SendAlert = (to: string, event: SecurityEvent, ctx: AlertContext) => Promise<void>;

/** Sends through SES from no-reply@<domain>. Failures are logged and swallowed: an alert must never undo the change it reports. */
export function sesAlerts(ses: SESv2Client, domain: string): SendAlert {
  return async (to, event, ctx) => {
    if (!to) return;
    const { subject, text } = alertEmail(event, ctx);
    try {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: `Mac Tidar Mail <no-reply@${domain}>`,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } } },
      }));
      console.log(JSON.stringify({ event: "security-alert-sent", kind: event }));
    } catch (e) {
      console.error(JSON.stringify({ event: "security-alert-failed", kind: event, name: (e as Error).name }));
    }
  };
}
