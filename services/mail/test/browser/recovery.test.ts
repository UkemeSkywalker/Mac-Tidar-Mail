import { describe, expect, it } from "vitest";
import {
  InvalidRecoveryCodeError,
  buildRecoveryFile,
  generateRecoveryCode,
  normalizeRecoveryCode,
  parseRecoveryInput,
} from "../../../../components/mail/crypto";

describe("recovery code", () => {
  it("is 256 bits of Crockford base32 in groups of four", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it("normalizes case, spacing and look-alike characters", () => {
    const code = generateRecoveryCode();
    const messy = ` ${code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l")} `;
    expect(normalizeRecoveryCode(messy)).toBe(code);
  });

  it("rejects codes of the wrong length or alphabet", () => {
    expect(() => normalizeRecoveryCode("ABCD-EFGH")).toThrow(InvalidRecoveryCodeError);
    expect(() => normalizeRecoveryCode(generateRecoveryCode().replace(/^./, "U"))).toThrow(InvalidRecoveryCodeError);
  });
});

describe("recovery file", () => {
  it("round-trips address, fingerprint and code", () => {
    const code = generateRecoveryCode();
    const file = buildRecoveryFile({ address: "ukeme@mactidar.com", code, fingerprint: "ab".repeat(20) });
    expect(file).toContain("Mac Tidar Mail recovery file");
    expect(file).toContain("ukeme@mactidar.com");
    expect(parseRecoveryInput(file)).toEqual({ code, address: "ukeme@mactidar.com", fingerprint: "ab".repeat(20) });
  });

  it("accepts a bare phrase", () => {
    const code = generateRecoveryCode();
    expect(parseRecoveryInput(code)).toEqual({ code });
  });

  it("rejects a corrupted file", () => {
    const file = buildRecoveryFile({ address: "a@mactidar.com", code: generateRecoveryCode(), fingerprint: "ab".repeat(20) });
    expect(() => parseRecoveryInput(file.replace('"code"', '"cod"'))).toThrow(InvalidRecoveryCodeError);
  });
});
