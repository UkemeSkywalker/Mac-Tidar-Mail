import { describe, expect, it } from "vitest";
import { companyDomainFromHost } from "../../../../components/mail/live/host";

describe("company web address detection", () => {
  it("reads the company from mail.<domain>", () => {
    expect(companyDomainFromHost("mail.zetca.pro")).toBe("zetca.pro");
    expect(companyDomainFromHost("MAIL.Acme.co.uk")).toBe("acme.co.uk");
  });
  it("ignores our own hosts and anything that isn't mail.<domain>", () => {
    for (const h of ["mail.mactidar.com", "main.d2h2862c068n9v.amplifyapp.com", "localhost", "127.0.0.1", "zetca.pro", "www.zetca.pro", "mail.", "mail.x"]) expect(companyDomainFromHost(h), h).toBeNull();
  });
});
