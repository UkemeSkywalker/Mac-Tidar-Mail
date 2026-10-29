// Two-step verification helpers shared by sign-in (gate.tsx) and Settings → Security.

export type MfaMethod = "TOTP" | "EMAIL";

/** What the sign-in screen does next for an Amplify `signIn`/`confirmSignIn` step. */
export type SignInNext =
  | { do: "done" }
  | { do: "totp"; canEmail: boolean }
  | { do: "emailCode"; destination?: string }
  | { do: "choose"; pick: MfaMethod; canEmail: boolean }
  | { do: "newPassword" } | { do: "confirmSignup" } | { do: "reset" } | { do: "unsupported" };

interface StepLike { signInStep: string; allowedMFATypes?: string[]; codeDeliveryDetails?: { destination?: string } }

/**
 * Maps a sign-in step to the next screen. With both methods on, Cognito asks which to use:
 * we pick the authenticator app unless `want` is EMAIL (the "send a code instead" link).
 * `emailOn` remembers, across the choose step, that email is available as a fallback.
 */
export function nextForStep(step: StepLike, want: MfaMethod = "TOTP", emailOn = false): SignInNext {
  switch (step.signInStep) {
    case "DONE": return { do: "done" };
    case "CONFIRM_SIGN_IN_WITH_TOTP_CODE": return { do: "totp", canEmail: emailOn };
    case "CONFIRM_SIGN_IN_WITH_EMAIL_CODE": return { do: "emailCode", destination: step.codeDeliveryDetails?.destination };
    case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION": {
      const allowed = step.allowedMFATypes ?? [];
      const canEmail = allowed.includes("EMAIL");
      const pick: MfaMethod = want === "EMAIL" && canEmail ? "EMAIL" : allowed.includes("TOTP") ? "TOTP" : "EMAIL";
      return { do: "choose", pick, canEmail };
    }
    case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED": return { do: "newPassword" };
    case "CONFIRM_SIGN_UP": return { do: "confirmSignup" };
    case "RESET_PASSWORD": return { do: "reset" };
    default: return { do: "unsupported" };
  }
}

/** Rejects anything that isn't a 6-digit code before it reaches Cognito. */
export const cleanCode = (raw: string) => {
  const code = raw.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code.");
  return code;
};
