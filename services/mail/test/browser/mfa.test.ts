import { describe, expect, it } from "vitest";
import { cleanCode, nextForStep } from "../../../../components/mail/live/mfa";

describe("sign-in steps", () => {
  it("maps each step to its screen", () => {
    expect(nextForStep({ signInStep: "DONE" })).toEqual({ do: "done" });
    expect(nextForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" })).toEqual({ do: "totp", canEmail: false });
    expect(nextForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_EMAIL_CODE", codeDeliveryDetails: { destination: "b***@g***" } })).toEqual({ do: "emailCode", destination: "b***@g***" });
    expect(nextForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED" })).toEqual({ do: "newPassword" });
    expect(nextForStep({ signInStep: "CONFIRM_SIGN_UP" })).toEqual({ do: "confirmSignup" });
    expect(nextForStep({ signInStep: "RESET_PASSWORD" })).toEqual({ do: "reset" });
    expect(nextForStep({ signInStep: "CONTINUE_SIGN_IN_WITH_TOTP_SETUP" })).toEqual({ do: "unsupported" });
  });
  it("picks the authenticator app when both methods are on, unless email is asked for", () => {
    const both = { signInStep: "CONTINUE_SIGN_IN_WITH_MFA_SELECTION", allowedMFATypes: ["TOTP", "EMAIL"] };
    expect(nextForStep(both)).toEqual({ do: "choose", pick: "TOTP", canEmail: true });
    expect(nextForStep(both, "EMAIL")).toEqual({ do: "choose", pick: "EMAIL", canEmail: true });
    expect(nextForStep({ ...both, allowedMFATypes: ["TOTP"] }, "EMAIL")).toEqual({ do: "choose", pick: "TOTP", canEmail: false });
    // After choosing the app, the code screen still offers email.
    expect(nextForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" }, "TOTP", true)).toEqual({ do: "totp", canEmail: true });
  });
  it("only accepts 6-digit codes", () => {
    expect(cleanCode(" 123 456 ")).toBe("123456");
    for (const bad of ["12345", "1234567", "abcdef", ""]) expect(() => cleanCode(bad)).toThrow("Enter the 6-digit code.");
  });
});
