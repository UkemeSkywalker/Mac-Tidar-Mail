import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mac Tidar Mail — Organic Speed & Human Connection",
  description: "Meet email that feels refreshingly simple. Built for speed, deep focus, and elegant teamwork across the Mac Tidar Suite.",
  openGraph: {
    title: "Mac Tidar Mail — Organic Speed & Human Connection",
    description: "Meet email that feels refreshingly simple. Built for speed, deep focus, and elegant teamwork across the Mac Tidar Suite.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="scroll-smooth"><head><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/><link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/></head><body>{children}</body></html>;
}
