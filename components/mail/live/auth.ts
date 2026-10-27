// Cognito sign-in for the mail app (Mac Tidar Cloud's user pool). SRP only: the password is
// never sent to a server, which is what lets the browser also derive the mailbox key from it.
import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sessionStorage } from "aws-amplify/utils";
import { liveConfig } from "./config";

let configured = false;
export function configureAuth() {
  if (configured) return;
  Amplify.configure({ Auth: { Cognito: { userPoolId: liveConfig.userPoolId, userPoolClientId: liveConfig.clientId, loginWith: { email: true } } } });
  // Tokens live only for this tab; closing it signs out.
  cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);
  configured = true;
}

export { confirmResetPassword, confirmSignIn, fetchAuthSession, resetPassword, signIn, signOut } from "aws-amplify/auth";
