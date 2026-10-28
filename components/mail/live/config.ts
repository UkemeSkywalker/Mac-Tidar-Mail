// Public build-time configuration. Live mode is on only when the mail API URL is set;
// otherwise /app shows a "not configured" note.
export const liveConfig = {
  region: process.env.NEXT_PUBLIC_AWS_REGION ?? "af-south-1",
  userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "",
  apiUrl: (process.env.NEXT_PUBLIC_MAIL_API ?? "").replace(/\/$/, ""),
  wsUrl: process.env.NEXT_PUBLIC_MAIL_WS ?? "",
};

export const liveEnabled = !!(liveConfig.apiUrl && liveConfig.userPoolId && liveConfig.clientId);
