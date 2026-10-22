import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mac Tidar Mail — Email that feels effortless.",
  description: "A better space to connect, communicate, and get things done.",
  openGraph: {
    title: "Mac Tidar Mail — Email that feels effortless.",
    description: "A better space to connect, communicate, and get things done.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
