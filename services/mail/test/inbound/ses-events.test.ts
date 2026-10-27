import { describe, expect, it } from "vitest";
import { statusFor } from "../../src/ses-events/handler";

describe("SES delivery events", () => {
  it("maps event types to a Sent copy's delivery status", () => {
    expect(statusFor({ eventType: "Delivery" })).toBe("delivered");
    expect(statusFor({ eventType: "Bounce", bounce: { bounceType: "Permanent" } })).toBe("bounced");
    expect(statusFor({ eventType: "Bounce", bounce: { bounceType: "Transient" } })).toBe("delayed");
    expect(statusFor({ eventType: "Complaint" })).toBe("complained");
    expect(statusFor({ eventType: "Reject" })).toBe("rejected");
    expect(statusFor({ eventType: "Open" })).toBeNull();
  });
});
