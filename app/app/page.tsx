"use client";

import { useEffect } from "react";

export default function MailDemoRedirect() {
  useEffect(() => {
    // Explicit index.html: `next dev` doesn't serve directory indexes from public/, static hosts do.
    window.location.replace(`/app-demo/index.html${window.location.search}`);
  }, []);

  return <main className="redirect"><p>Opening Mac Tidar Mail demo…</p></main>;
}
