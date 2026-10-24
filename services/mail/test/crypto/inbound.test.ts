import { describe, expect, it } from "vitest";
import {
  decryptAttachment,
  decryptMessageBody,
  decryptMessageHeader,
  encryptInboundMessage,
  generateMailboxKey,
} from "../../src/crypto";
import { containsPlaintext } from "../helpers";

const parsed = {
  subject: "Your invoice #4411 from Acme",
  from: { name: "Acme Billing", address: "billing@acme.example" },
  text: "Hi Ukeme,\n\n   Your invoice   for October is attached.  Total due: $129.00.\n",
  html: "<p>Hi Ukeme,</p><p>Your invoice for October is attached. Total due: $129.00.</p>",
  attachments: [
    {
      filename: "invoice-4411.pdf",
      contentType: "application/pdf",
      content: new TextEncoder().encode("%PDF-1.7 invoice body Total due"),
    },
    { filename: "logo.png", contentType: "image/png", content: new Uint8Array([137, 80, 78, 71]), contentId: "logo@acme", inline: true },
  ],
};

describe("encryptInboundMessage", () => {
  it("produces ciphertext blobs that only the recipient can open", async () => {
    const ukeme = await generateMailboxKey("ukeme@mactidar.com");
    const out = await encryptInboundMessage(parsed, ukeme.publicKey);

    expect(Object.keys(out).sort()).toEqual(["attachments", "body", "header"]);
    expect(out.attachments).toHaveLength(2);

    const h = await decryptMessageHeader(out.header, { decryptionKeys: [ukeme.privateKey] });
    expect(h.header.subject).toBe(parsed.subject);
    expect(h.header.fromName).toBe("Acme Billing");
    expect(h.header.preview).toBe("Hi Ukeme, Your invoice for October is attached. Total due: $129.00.");
    expect(h.header.attachments).toEqual([
      { filename: "invoice-4411.pdf", contentType: "application/pdf", size: parsed.attachments[0]!.content.length },
      { filename: "logo.png", contentType: "image/png", size: 4, contentId: "logo@acme", inline: true },
    ]);

    const b = await decryptMessageBody(out.body, { decryptionKeys: [ukeme.privateKey] });
    expect(b.body.text).toBe(parsed.text);
    expect(b.body.html).toBe(parsed.html);

    const a0 = await decryptAttachment(out.attachments[0]!, { decryptionKeys: [ukeme.privateKey] });
    expect(new TextDecoder().decode(a0.data)).toBe("%PDF-1.7 invoice body Total due");
  });

  it("accepts an already-parsed public key object", async () => {
    const ukeme = await generateMailboxKey("ukeme@mactidar.com");
    const out = await encryptInboundMessage({ subject: "hi", text: "x" }, ukeme.privateKey.toPublic());
    const h = await decryptMessageHeader(out.header, { decryptionKeys: [ukeme.privateKey] });
    expect(h.header).toEqual({ subject: "hi", preview: "x", fromName: "", attachments: [] });
  });

  it("builds the preview from HTML when there is no text part", async () => {
    const ukeme = await generateMailboxKey("ukeme@mactidar.com");
    const out = await encryptInboundMessage(
      { subject: "s", html: "<style>p{}</style><p>Hello&nbsp;<b>there</b> &amp; welcome</p><script>x()</script>" },
      ukeme.publicKey,
    );
    const h = await decryptMessageHeader(out.header, { decryptionKeys: [ukeme.privateKey] });
    expect(h.header.preview).toBe("Hello there & welcome");
  });

  it("caps the preview length", async () => {
    const ukeme = await generateMailboxKey("ukeme@mactidar.com");
    const out = await encryptInboundMessage({ text: "word ".repeat(200) }, ukeme.publicKey);
    const h = await decryptMessageHeader(out.header, { decryptionKeys: [ukeme.privateKey] });
    expect(h.header.preview.length).toBeLessThanOrEqual(160);
  });

  it("refuses a private key or garbage as the recipient key", async () => {
    const ukeme = await generateMailboxKey("ukeme@mactidar.com");
    await expect(encryptInboundMessage(parsed, ukeme.privateKey)).rejects.toThrow(/public key/);
    await expect(encryptInboundMessage(parsed, "not a key")).rejects.toThrow();
  });

  it("contains no readable subject, body, sender name or attachment data", async () => {
    const ukeme = await generateMailboxKey("ukeme@mactidar.com");
    const out = await encryptInboundMessage(parsed, ukeme.publicKey);
    const blobs: (string | Uint8Array)[] = [out.header, out.body, ...out.attachments];
    for (const blob of blobs) {
      for (const secret of ["invoice", "Acme", "Ukeme", "129.00", "PDF-1.7", "logo.png", "application/pdf"]) {
        expect(containsPlaintext(blob, secret), `${secret} leaked`).toBe(false);
      }
    }
  });
});
