"use client";

import dynamic from "next/dynamic";

// The mail app lives entirely in the browser (localStorage, relative dates), so skip server rendering.
const MailApp = dynamic(() => import("./mail-app"), {
  ssr: false,
  loading: () => <div className="min-h-dvh grid place-items-center text-sm text-stone-500">Opening Mac Tidar Mail…</div>,
});

export function MailLoader() {
  return <MailApp />;
}
