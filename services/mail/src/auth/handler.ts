// Mail user pool Lambda.
// - Pre-sign-up trigger: refuses sign-ups whose address is malformed, reserved or taken, or whose
//   profile fails validation. Cognito then emails the code to the backup address.
// - Daily schedule: deletes accounts left unconfirmed for over a day, so nobody can hold an
//   address by starting a sign-up and never finishing it.
// Never logs names, emails or other profile fields.
import { AdminDeleteUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { PreSignUpTriggerEvent } from "aws-lambda";
import { parseAddress, reservationKey, validateProfile, type Reservation } from "../shared/accounts";
import { mailboxPk, META_SK } from "../shared/table";

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

  return async (event: PreSignUpTriggerEvent | CleanupEvent) => {
    if ("task" in event) {
      if (event.task === "cleanup-unconfirmed") return cleanupUnconfirmed(event.userPoolId);
      throw new Error("Unknown task");
    }
    if (event.triggerSource?.startsWith("PreSignUp_")) return preSignUp(event);
    return event; // other triggers aren't configured; pass through unchanged
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: PreSignUpTriggerEvent | CleanupEvent) => {
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
