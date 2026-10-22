"use client";

import { useEffect } from "react";

export default function MailDemoRedirect() {
  useEffect(() => {
    window.location.replace(`/app-demo/${window.location.search}`);
  }, []);

  return <main className="redirect"><p>Opening Mac Tidar Mail demo…</p></main>;
}
