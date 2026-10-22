import { Geist, Inter } from "next/font/google";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export default function MailLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className={`${geist.variable} ${inter.variable}`}>{children}</div>;
}
