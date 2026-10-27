// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "../../../../components/mail/live/sanitize";

const clean = (html: string, inline: Record<string, string> = {}) => sanitizeEmailHtml(html, inline);

describe("HTML email sanitizer", () => {
  it("removes scripts, event handlers and javascript: links", () => {
    const { html } = clean(`<p onclick="steal()">Hi</p><script>steal()</script><img src=x onerror="steal()"><a href="javascript:steal()">x</a><a href="  JaVaScRiPt:steal()">y</a>`);
    expect(html).not.toMatch(/script|onclick|onerror|javascript/i);
    expect(html).toContain("Hi");
  });
  it("removes frames, forms, plugins, SVG, base and meta refresh", () => {
    const { html } = clean(`<iframe src="https://x"></iframe><form action="https://x"><input name=p></form><object data=x></object><embed src=x><svg onload=alert(1)><script>1</script></svg><base href="https://evil"><meta http-equiv="refresh" content="0;url=https://evil">ok`);
    expect(html).not.toMatch(/iframe|form|input|object|embed|svg|base|meta|evil/i);
    expect(html).toContain("ok");
  });
  it("blocks remote images and tracking backgrounds, and counts them", () => {
    const r = clean(`<img src="https://tracker.example/p.gif"><img src="//t.example/x"><table><tr><td background="https://t.example/b.png">c</td></tr></table><div style="background:url(https://t.example/c.png)">x</div>`);
    expect(r.html).not.toMatch(/tracker|t\.example/);
    expect(r.blockedImages).toBe(4);
  });
  it("shows decrypted inline images and small embedded images", () => {
    const r = clean(`<img src="cid:logo123"><img src="data:image/png;base64,iVBORw0KGgo=">`, { logo123: "blob:https://mail.mactidar.com/abc" });
    expect(r.html).toContain('src="blob:https://mail.mactidar.com/abc"');
    expect(r.html).toContain("data:image/png;base64");
    expect(r.blockedImages).toBe(0);
  });
  it("opens links in a new tab without a referrer", () => {
    const { html } = clean(`<a href="https://mactidar.com">site</a><a href="mailto:a@b.com">mail</a>`);
    expect(html).toMatch(/<a href="https:\/\/mactidar\.com" target="_blank" rel="noopener noreferrer">/);
    expect(html).toMatch(/href="mailto:a@b\.com" target="_blank"/);
  });
});

describe("fail-closed", () => {
  it("escapes everything if DOMPurify can't run", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("dompurify", () => ({ default: () => ({ isSupported: false }) }));
    const { sanitizeEmailHtml: fresh } = await import("../../../../components/mail/live/sanitize");
    const r = fresh(`<img src=x onerror=alert(1)>`, {});
    expect(r.html).toBe("<pre>&lt;img src=x onerror=alert(1)&gt;</pre>");
    vi.doUnmock("dompurify");
  });
});
