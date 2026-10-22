import type { Metadata } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"], variable: "--font-jakarta" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-jetbrains" });

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
  return (
    <html lang="en" className={`${jakarta.variable} ${jetbrains.variable}`}>
      <head>
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- icon font used across the homepage */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
