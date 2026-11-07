// Public build-time configuration. Live mode is on only when the mail API URL is set;
// otherwise /app shows a "not configured" note.
export const liveConfig = {
  region: process.env.NEXT_PUBLIC_AWS_REGION ?? "af-south-1",
  userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "",
  apiUrl: (process.env.NEXT_PUBLIC_MAIL_API ?? "").replace(/\/$/, ""),
  wsUrl: process.env.NEXT_PUBLIC_MAIL_WS ?? "",
};

/** True when this browser holds a Mail sign-in (checked without loading the sign-in library). */
export function hasStoredSignIn(): boolean {
  const key = `CognitoIdentityServiceProvider.${liveConfig.clientId}.LastAuthUser`;
  try { return !!(localStorage.getItem(key) || sessionStorage.getItem(key)); } catch { return false; }
}

// Our own hosts; anything else is a customer's mail.<their domain>, served by the same app.
const OWN_HOSTS = /^(?:mail\.mactidar\.com|localhost|127\.0\.0\.1)$|\.amplifyapp\.com$/;

/** The customer web address this page is on (mail.yourcompany.com), or null on our own. */
export function customHost(): string | null {
  if (typeof location === "undefined") return null;
  return OWN_HOSTS.test(location.hostname) ? null : location.hostname.toLowerCase();
}

export const liveEnabled = !!(liveConfig.apiUrl && liveConfig.userPoolId && liveConfig.clientId);
