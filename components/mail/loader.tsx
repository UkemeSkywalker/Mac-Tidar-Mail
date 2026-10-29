"use client";

import dynamic from "next/dynamic";
import { BrandMark } from "../brand";

// The mail app lives entirely in the browser (localStorage, relative dates), so skip server rendering.
const MailApp = dynamic(() => import("./mail-app"), {
  ssr: false,
  loading: () => <div className="min-h-dvh flex flex-col items-center justify-center gap-4 text-sm text-stone-500"><BrandMark className="h-12 animate-pulse" />Opening Mac Tidar Mail…</div>,
});

export function MailLoader() {
  return <MailApp />;
}
