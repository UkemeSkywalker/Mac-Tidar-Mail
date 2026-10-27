import { describe, expect, it } from "vitest";
import { isRiskyFile, misleadingName } from "../../../../components/mail/live/trust";

describe("sender display names", () => {
  it("hides names that carry a different address or claim to be Mac Tidar from outside", () => {
    expect(misleadingName("support@paypal.com", "x@evil.com")).toBe(true);
    expect(misleadingName("PayPal <service@paypal.com>", "x@evil.com")).toBe(true);
    expect(misleadingName("Mac Tidar Security", "alerts@gmail.com")).toBe(true);
    expect(misleadingName("MacTidar Support", "help@mactidar.com.evil.io")).toBe(true);
  });
  it("keeps ordinary names", () => {
    expect(misleadingName("Elena Rossi", "elena@gmail.com")).toBe(false);
    expect(misleadingName("elena@gmail.com", "Elena@Gmail.com")).toBe(false);
    expect(misleadingName("Mac Tidar Support", "support@mactidar.com")).toBe(false);
    expect(misleadingName("Ukeme", "ukeme@beta.mactidar.com")).toBe(false);
  });
});

describe("risky attachments", () => {
  it("flags files that run code", () => {
    for (const n of ["invoice.exe", "Setup.MSI", "run.js", "page.html", "disk.iso", "budget.xlsm ", "logo.svg"]) expect(isRiskyFile(n)).toBe(true);
    for (const n of ["notes.txt", "report.pdf", "photo.jpg", "archive.zip", "budget.xlsx"]) expect(isRiskyFile(n)).toBe(false);
  });
});
