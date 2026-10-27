"use client";

// Displays an HTML email safely:
// 1. DOMPurify removes scripts, event handlers, forms, frames, plugins and SVG.
// 2. Remote images (tracking pixels) are dropped; senders can't tell when mail is opened.
//    The page CSP (inherited by the frame) blocks remote loads as a second layer.
// 3. The result renders in a sandboxed iframe without allow-scripts, so even a sanitizer
//    bypass can't run code. allow-same-origin only lets us measure the content height.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui";
import { sanitizeEmailHtml } from "./sanitize";

const FRAME_STYLE = `<style>html,body{margin:0;padding:0;background:#fff;color:#1f2328;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#1a5fb4}pre{white-space:pre-wrap}</style>`;

export function SafeHtml({ html, inlineImages }: { html: string; inlineImages: Record<string, string> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const { html: clean, blockedImages } = useMemo(() => sanitizeEmailHtml(html, inlineImages), [html, inlineImages]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const body = el.contentDocument?.body;
      if (!body) return;
      setHeight(Math.min(Math.max(body.scrollHeight + 8, 60), 20_000));
      observer?.disconnect();
      observer = new ResizeObserver(() => setHeight(Math.min(Math.max(body.scrollHeight + 8, 60), 20_000)));
      observer.observe(body);
    };
    el.addEventListener("load", measure);
    return () => { el.removeEventListener("load", measure); observer?.disconnect(); };
  }, [clean]);

  return (
    <div className="space-y-2">
      {blockedImages > 0 && (
        <p className="flex items-center gap-2 t-label-md text-m-muted px-3 py-2 rounded-m-lg bg-m-low">
          <Icon name="hide_image" className="text-[16px]" />Remote images were blocked so the sender can’t tell when you open this email.
        </p>
      )}
      <iframe
        ref={frame}
        title="Email content"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={`<!doctype html><html><head><meta charset="utf-8">${FRAME_STYLE}</head><body>${clean}</body></html>`}
        className="w-full rounded-m-lg border border-m-line/60 bg-white"
        style={{ height }}
      />
    </div>
  );
}
