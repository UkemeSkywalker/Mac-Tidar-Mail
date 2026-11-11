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
import { CLAIM_PREFIX, domainKey, MAX_CLAIMS_PER_DOMAIN, parseDomain, PENDING_DOMAIN_DAYS, personKey, signupKey, type DomainItem, type SignupItem } from "../shared/domains";

export interface AuthConfig { table: string; signupDomain: string; localDomains: string[] }
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

  /** The invite email for someone added to a customer domain. Other messages use the pool's templates. */
  async function customMessage(event: CustomMessageTriggerEvent) {
    if (event.triggerSource !== "CustomMessage_AdminCreateUser") return event;
    const domain = event.userName.split("@")[1] ?? "";
    const { Item } = await ddb.send(new GetCommand({ TableName: config.table, Key: domainKey(domain) }));
    // The message is sent as HTML: escape the owner-chosen name (validation already refuses < and >).
    const name = ((Item as DomainItem | undefined)?.displayName ?? domain).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const { codeParameter, usernameParameter } = event.request;
    event.response.emailSubject = `You’ve been added to ${(Item as DomainItem | undefined)?.displayName ?? domain}’s email`;
    event.response.emailMessage = [
      `Hello,`, ``,
      `${name} has given you an email address on Mac Tidar Mail:`, ``,
      `Your address: ${usernameParameter}`,
      `Temporary password: ${codeParameter}`, ``,
      `Sign in at mail.${config.signupDomain} within 3 days, then choose your own password. Only you will know it: your mail is encrypted with a key made from it, so nobody else can read your mail, not ${name} and not Mac Tidar.`, ``,
      `This email is your backup address. It's only used to reset your password; you can't sign in with it.`, ``,
      `If you weren't expecting this, you can ignore it.`, ``,
      `Mac Tidar Mail`,
    ].join("<br>");
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
    },
  });
  return cached(event);
};
