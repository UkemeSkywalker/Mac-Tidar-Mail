// HTML email sanitizer (see safe-html.tsx for how the result is displayed).
import DOMPurify from "dompurify";

export function sanitizeEmailHtml(html: string, inlineImages: Record<string, string>): { html: string; blockedImages: number } {
  let blockedImages = 0;
  const purify = DOMPurify();
  // DOMPurify returns input unchanged when it can't run; never let that through.
  if (!purify.isSupported) {
    const escaped = html.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    return { html: `<pre>${escaped}</pre>`, blockedImages: 0 };
  }
  // Decide about images and backgrounds before DOMPurify validates attributes, and only
  // insert our own blob: URLs afterwards (DOMPurify would otherwise reject the scheme).
  const inline = new WeakMap<Element, string>();
  const remote = /url\s*\(\s*['"]?\s*(https?:)?\/\//i;
  purify.addHook("beforeSanitizeAttributes", node => {
    if (!(node instanceof Element)) return;
    if (node.nodeName === "IMG" && node.hasAttribute("src")) {
      const src = (node.getAttribute("src") ?? "").trim();
      const cid = /^cid:(.+)$/i.exec(src)?.[1]?.replace(/^<|>$/g, "");
      if (cid && inlineImages[cid]) inline.set(node, inlineImages[cid]!);
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
        if (!(cid && inlineImages[cid])) blockedImages++;
        node.removeAttribute("src");
      }
    }
    if (node.hasAttribute("background")) { blockedImages++; node.removeAttribute("background"); }
    if (remote.test(node.getAttribute("style") ?? "")) { blockedImages++; node.removeAttribute("style"); }
  });
  purify.addHook("afterSanitizeAttributes", node => {
    if (node instanceof Element && inline.has(node)) node.setAttribute("src", inline.get(node)!);
    if (node.nodeName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
      else node.removeAttribute("href");
    }
  });
  const clean = purify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "form", "input", "button", "textarea", "select", "option", "link", "meta", "base", "svg", "math", "video", "audio", "source", "track", "portal"],
    FORBID_ATTR: ["srcset", "action", "formaction", "ping", "poster"],
    ALLOW_DATA_ATTR: false,
  });
  return { html: clean, blockedImages };
}
