// Mail user pool Lambda.
// - Pre-sign-up trigger: refuses sign-ups whose address is malformed, reserved or taken, or whose
//   profile fails validation. Cognito then emails the code to the backup address.
// - Invites for customer domains (AdminCreateUser): only for a person their domain's owner added,
//   on an active domain. The custom-message trigger writes the invite email.
// - Daily schedule: deletes accounts left unconfirmed for over a day, so nobody can hold an
//   address by starting a sign-up and never finishing it.
// Never logs names, emails or other profile fields.
import { AdminDeleteUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { CustomMessageTriggerEvent, PreSignUpTriggerEvent } from "aws-lambda";
import { parseAddress, parseLocalPart, reservationKey, validateBusinessProfile, validateProfile, type Reservation } from "../shared/accounts";
import { mailboxPk, META_SK } from "../shared/table";
import { renderEmail, type EmailBrand, type EmailContent } from "../shared/email";
import { CLAIM_PREFIX, domainKey, MAX_CLAIMS_PER_DOMAIN, parseDomain, PENDING_DOMAIN_DAYS, personKey, signupKey, type DomainItem, type SignupItem } from "../shared/domains";

export interface AuthConfig { table: string; signupDomain: string; localDomains: string[]; /** Where published company logos are served (CloudFront). */ brandUrl?: string }
export interface AuthDeps { ddb: DynamoDBDocumentClient; cognito: CognitoIdentityProviderClient; config: AuthConfig; now?: () => Date }

// The pool ID comes in the scheduled event: the pool names this function, so the function
// can't also name the pool in its environment.
type CleanupEvent = { task: "cleanup-unconfirmed"; userPoolId: string };
const UNCONFIRMED_TTL_MS = 24 * 3600_000;

export function createHandler({ ddb, cognito, config, now = () => new Date() }: AuthDeps) {
  async function preSignUp(event: PreSignUpTriggerEvent) {
    if (event.triggerSource === "PreSignUp_ExternalProvider") throw new Error("Sign in with your Mac Tidar address");
    const username = event.userName;
    if (username !== username.trim().toLowerCase()) throw new Error("Addresses must be lowercase");
    if (event.triggerSource === "PreSignUp_AdminCreateUser") return invited(event);
    if (username.split("@")[1] !== config.signupDomain) return business(event);
    const { address, reserved } = parseAddress(username, config.signupDomain);
    const profile = validateProfile(event.request.userAttributes, config.localDomains, now());

    const [{ Item: res }, { Item: meta }] = await Promise.all([
      ddb.send(new GetCommand({ TableName: config.table, Key: reservationKey(address) })),
      ddb.send(new GetCommand({ TableName: config.table, Key: { pk: mailboxPk(address), sk: META_SK } })),
    ]);
    const reservation = res as Reservation | undefined;
    const reservedForThisEmail = !!reservation && reservation.expiresAt * 1000 > now().getTime() && reservation.backupEmail === profile.email;
    if (!reservedForThisEmail) {
      if (meta || reservation) throw new Error("That address is taken. Please choose another.");
      if (reserved) throw new Error("That address is reserved. Please choose another.");
    }
    console.log(JSON.stringify({ event: "pre-sign-up-ok", reserved: reservedForThisEmail }));
    return event;
  }

  /**
   * A Business sign-up: the address is on the company's own domain, which they connect right after.
   * Several people may sign up on a domain that isn't verified yet; whoever proves control of its
   * DNS first gets it, and the others' accounts are removed (see the API's claims).
   */
  async function business(event: PreSignUpTriggerEvent) {
    const username = event.userName, at = username.lastIndexOf("@");
    const domain = username.slice(at + 1);
    let local: string;
    try {
      local = parseLocalPart(username.slice(0, at));
      if (parseDomain(domain, config.localDomains) !== domain) throw new Error();
    } catch { throw new Error("Use an address on your company's domain, like you@yourcompany.com."); }
    const address = `${local}@${domain}`;
    const [{ Item: d }, { Item: meta }, claimCount] = await Promise.all([
      ddb.send(new GetCommand({ TableName: config.table, Key: domainKey(domain) })),
      ddb.send(new GetCommand({ TableName: config.table, Key: { pk: mailboxPk(address), sk: META_SK } })),
      ddb.send(new QueryCommand({ TableName: config.table, KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", ExpressionAttributeValues: { ":p": domainKey(domain).pk, ":c": CLAIM_PREFIX }, Select: "COUNT" })),
    ]);
    if (d) throw new Error(`${(d as DomainItem).displayName} already uses Mac Tidar Mail. Ask whoever manages it for an address.`);
    if (meta) throw new Error("That address is taken. Please choose another.");
    validateBusinessProfile(event.request.userAttributes, [domain, ...config.localDomains]);
    if ((claimCount?.Count ?? 0) >= MAX_CLAIMS_PER_DOMAIN) throw new Error("Too many people are setting up that domain right now. Try again in a few days.");
    const at2 = now();
    const signup: SignupItem = { ...signupKey(domain, address), type: "signup", address, createdAt: at2.toISOString(), expiresAt: Math.floor(at2.getTime() / 1000) + (PENDING_DOMAIN_DAYS + 4) * 86400 };
    await ddb.send(new PutCommand({ TableName: config.table, Item: signup }));
    console.log(JSON.stringify({ event: "pre-sign-up-business-ok" }));
    return event;
  }

  /** An account the API creates for someone a domain owner added. Nothing else may create one. */
  async function invited(event: PreSignUpTriggerEvent) {
    const address = event.userName, domain = address.split("@")[1] ?? "";
    const [{ Item: d }, { Item: person }, { Item: meta }] = await Promise.all([
      ddb.send(new GetCommand({ TableName: config.table, Key: domainKey(domain) })),
      ddb.send(new GetCommand({ TableName: config.table, Key: personKey(domain, address) })),
      ddb.send(new GetCommand({ TableName: config.table, Key: { pk: mailboxPk(address), sk: META_SK } })),
    ]);
    if ((d as DomainItem | undefined)?.status !== "active" || !person || meta) throw new Error("This address can't be created.");
    console.log(JSON.stringify({ event: "pre-sign-up-invite-ok" }));
    return event;
  }

  /**
   * Every email Cognito sends (sign-up and reset codes, team invites), in the same branded layout as
   * our other emails. Addresses on a verified company domain get that company's name and logo.
   */
  async function customMessage(event: CustomMessageTriggerEvent) {
    const { codeParameter, usernameParameter } = event.request;
    const domain = event.userName.split("@")[1] ?? "";
    let d: DomainItem | undefined;
    // A lookup failure just means a plain Mac Tidar-branded email; the code must still go out.
    if (domain && domain !== config.signupDomain) try { d = (await ddb.send(new GetCommand({ TableName: config.table, Key: domainKey(domain) })))?.Item as DomainItem | undefined; } catch { d = undefined; }
    const company = d && d.status !== "pending" ? d : undefined;
    // A logo only from our own CDN, with a key we generated (logos/<domain>/<hex>.<ext>).
    const logo = company && config.brandUrl && company.logoKey && /^logos\/[a-z0-9.-]+\/[0-9a-f]{24}\.(png|jpg|webp)$/.test(company.logoKey) ? `${config.brandUrl}/${company.logoKey}` : undefined;
    const brand: EmailBrand = company ? { name: company.displayName, tagline: "on Mac Tidar Mail", logo } : { name: "Mac Tidar Mail", tagline: "End-to-end encrypted email", logo: `https://mail.${config.signupDomain}/brand/mark-email.png` };
    const signIn = `Open **mail.${config.signupDomain}** yourself to sign in.`;
    let subject: string, content: EmailContent;
    switch (event.triggerSource) {
      case "CustomMessage_AdminCreateUser": {
        const name = company?.displayName ?? domain;
        subject = `You’ve been added to ${name}’s email`;
        content = {
          preview: `${name} has given you an email address on Mac Tidar Mail.`, title: `Your ${name} email is ready`,
          body: [`**${name}** has given you an email address on Mac Tidar Mail. Sign in within 3 days with this temporary password, then choose your own.`],
          facts: [["Your address", usernameParameter ?? "{username}"]], code: codeParameter,
          after: [`${signIn} Only you will know your new password: your mail is encrypted with a key made from it, so nobody else can read it, not ${name} and not Mac Tidar.`,
            "This email is your backup address. It's only used to reset your password; you can't sign in with it. If you weren't expecting this, you can ignore it."],
        };
        break;
      }
      case "CustomMessage_SignUp": case "CustomMessage_ResendCode":
        subject = "Your Mac Tidar Mail code";
        content = { preview: "Your verification code is inside.", title: "Confirm your email", body: ["Enter this code to finish creating your account:"], code: codeParameter,
          after: ["It's valid for 24 hours. If you didn't ask for it, you can ignore this email."] };
        break;
      case "CustomMessage_ForgotPassword":
        subject = "Reset your Mac Tidar Mail password";
        content = { preview: "Your password reset code is inside.", title: "Reset your password", body: [`Enter this code to choose a new password for **${event.userName}**:`], code: codeParameter,
          after: ["Your mail is never lost: new mail works straight away, and older mail can be opened again with your recovery file or a signed-in device.", "If you didn't ask for this, you can ignore it; your password hasn't changed."] };
        break;
      case "CustomMessage_UpdateUserAttribute": case "CustomMessage_VerifyUserAttribute":
        subject = "Confirm your new backup email";
        content = { preview: "Your verification code is inside.", title: "Confirm your backup email", body: ["Enter this code to confirm this as the backup email for your Mac Tidar Mail account:"], code: codeParameter,
          after: ["If you didn't ask for this, you can ignore it."] };
        break;
      default:
        return event; // other triggers keep the pool's own templates
    }
    event.response.emailSubject = subject;
    event.response.emailMessage = renderEmail(brand, content).html;
    return event;
  }

  async function cleanupUnconfirmed(userPoolId: string) {
    const cutoff = now().getTime() - UNCONFIRMED_TTL_MS;
    let token: string | undefined, deleted = 0;
    do {
      const page = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: 'cognito:user_status = "UNCONFIRMED"', Limit: 60, PaginationToken: token }));
      for (const u of page.Users ?? []) {
        if (u.Username && u.UserCreateDate && u.UserCreateDate.getTime() < cutoff) {
          await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: u.Username }));
          deleted++;
        }
      }
      token = page.PaginationToken;
    } while (token);
    console.log(JSON.stringify({ event: "unconfirmed-cleanup", deleted }));
    return { deleted };
  }

  return async (event: PreSignUpTriggerEvent | CustomMessageTriggerEvent | CleanupEvent) => {
    if ("task" in event) {
      if (event.task === "cleanup-unconfirmed") return cleanupUnconfirmed(event.userPoolId);
      throw new Error("Unknown task");
    }
    if (event.triggerSource?.startsWith("PreSignUp_")) return preSignUp(event as PreSignUpTriggerEvent);
    if (event.triggerSource?.startsWith("CustomMessage_")) return customMessage(event as CustomMessageTriggerEvent);
    return event; // other triggers aren't configured; pass through unchanged
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: PreSignUpTriggerEvent | CustomMessageTriggerEvent | CleanupEvent) => {
  cached ??= createHandler({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: new CognitoIdentityProviderClient({}),
    config: {
      table: env("MAIL_TABLE"),
      signupDomain: env("SIGNUP_DOMAIN").trim().toLowerCase(),
      localDomains: env("LOCAL_MAIL_DOMAINS").split(",").map(d => d.trim().toLowerCase()),
      brandUrl: process.env.BRAND_URL?.replace(/\/$/, "") || undefined,
    },
  });
  return cached(event);
};
