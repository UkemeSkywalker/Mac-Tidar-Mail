import type { Metadata } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
// Self-hosted icon font: no requests to Google from the site or the mail app.
import "material-symbols/outlined.css";
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
      <body>{children}</body>
    </html>
  );
}
