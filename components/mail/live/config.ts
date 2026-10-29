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

export const liveEnabled = !!(liveConfig.apiUrl && liveConfig.userPoolId && liveConfig.clientId);
