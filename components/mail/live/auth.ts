// Cognito sign-in for the mail app (Mail's own user pool, where the username is the
// @mactidar.com address and the email is only a backup for codes). SRP only: the password is
// never sent to a server, which is what lets the browser also derive the mailbox key from it.
import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { liveConfig } from "./config";

// "Keep me signed in": tokens and the session ID live in localStorage and survive closing the
// browser. Otherwise they live in sessionStorage: refresh and Back work, closing the tab ends it.
const KEEP_FLAG = "mtmail-keep";
const TOKEN_PREFIX = "CognitoIdentityServiceProvider.";

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }
export const keepSignedIn = () => safe(() => localStorage.getItem(KEEP_FLAG) !== "0", false);
const store = (): Storage => (keepSignedIn() ? localStorage : sessionStorage);

/** Choose where this sign-in is kept; call before signing in. Clears leftovers from the other place. */
export function setKeepSignedIn(keep: boolean) {
  safe(() => {
    localStorage.setItem(KEEP_FLAG, keep ? "1" : "0");
    const other = keep ? sessionStorage : localStorage;
    for (const k of Object.keys(other)) if (k.startsWith(TOKEN_PREFIX) || k.startsWith(SESSION_PREFIX)) other.removeItem(k);
  }, undefined);
}

const SESSION_PREFIX = "mtmail-session:";
/** The ID of this browser's server-side session for a mailbox (our half of the reopen key is there). */
export const sessionRef = {
  get: (address: string) => safe(() => store().getItem(SESSION_PREFIX + address), null),
  set: (address: string, id: string) => safe(() => store().setItem(SESSION_PREFIX + address, id), undefined),
  clear: (address: string) => safe(() => { localStorage.removeItem(SESSION_PREFIX + address); sessionStorage.removeItem(SESSION_PREFIX + address); }, undefined),
};

let configured = false;
export function configureAuth() {
  if (configured) return;
  Amplify.configure({ Auth: { Cognito: { userPoolId: liveConfig.userPoolId, userPoolClientId: liveConfig.clientId, loginWith: { username: true } } } });
  cognitoUserPoolsTokenProvider.setKeyValueStorage({
    setItem: async (k, v) => store().setItem(k, v),
    getItem: async k => store().getItem(k),
    removeItem: async k => store().removeItem(k),
    clear: async () => { for (const k of Object.keys(store())) if (k.startsWith(TOKEN_PREFIX)) store().removeItem(k); },
  });
  configured = true;
}

export { confirmResetPassword, confirmSignIn, confirmSignUp, fetchAuthSession, getCurrentUser, resendSignUpCode, resetPassword, setUpTOTP, signIn, signOut, signUp, verifyTOTPSetup } from "aws-amplify/auth";
