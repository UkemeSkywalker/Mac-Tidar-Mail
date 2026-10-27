import { describe, expect, it } from "vitest";
import { categorize, decide } from "../../src/inbound/policy";
import { threadId, threadRoot } from "../../src/inbound/thread";

const ok = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" };
const local = ["mactidar.com"];

describe("decide", () => {
  it("delivers clean mail to the inbox", () => expect(decide(ok, "a@gmail.com", local)).toEqual({ action: "store", folder: "inbox" }));
  it("drops viruses", () => expect(decide({ ...ok, virus: "FAIL" }, "a@gmail.com", local)).toEqual({ action: "drop", reason: "virus" }));
  it("routes spam and DMARC failures to Spam", () => {
    expect(decide({ ...ok, spam: "FAIL" }, "a@gmail.com", local)).toEqual({ action: "store", folder: "spam" });
    expect(decide({ ...ok, dmarc: "FAIL" }, "a@gmail.com", local)).toEqual({ action: "store", folder: "spam" });
  });
  it("drops outside mail pretending to be from our domains", () => {
    expect(decide({ ...ok, dmarc: "FAIL" }, "ceo@mactidar.com", local)).toEqual({ action: "drop", reason: "spoofed-local-sender" });
    expect(decide({ ...ok, dmarc: "GRAY" }, "x@beta.mactidar.com", local)).toEqual({ action: "drop", reason: "spoofed-local-sender" });
    expect(decide(ok, "ceo@mactidar.com", local)).toEqual({ action: "store", folder: "inbox" });
  });
  it("does not treat look-alike domains as local", () => expect(decide({ ...ok, dmarc: "GRAY" }, "a@evilmactidar.com", local)).toEqual({ action: "store", folder: "inbox" }));
});

describe("categorize", () => {
  it("uses list headers for newsletters", () => expect(categorize(new Map([["list-unsubscribe", "<x>"]]), "news@x.com")).toBe("newsletters"));
  it("uses automation headers and sender for updates", () => {
    expect(categorize(new Map([["auto-submitted", "auto-generated"]]), "a@x.com")).toBe("updates");
    expect(categorize(new Map(), "noreply@github.com")).toBe("updates");
  });
  it("defaults to primary", () => expect(categorize(new Map([["auto-submitted", "no"]]), "elena@x.com")).toBe("primary"));
});

describe("threads", () => {
  it("roots at the first reference, then In-Reply-To, then Message-ID", () => {
    expect(threadRoot("<c@x>", "<b@x>", ["<a@x>", "<b@x>"])).toBe("a@x");
    expect(threadRoot("<c@x>", "<B@X>")).toBe("b@x");
    expect(threadRoot("<c@x>")).toBe("c@x");
  });
  it("is stable per mailbox and differs across mailboxes", () => {
    expect(threadId("Ukeme@beta.mactidar.com", "a@x", "1")).toBe(threadId("ukeme@beta.mactidar.com", "a@x", "2"));
    expect(threadId("ukeme@beta.mactidar.com", "a@x", "1")).not.toBe(threadId("john@beta.mactidar.com", "a@x", "1"));
    expect(threadId("u@m.com", undefined, "1")).not.toBe(threadId("u@m.com", undefined, "2"));
  });
});
