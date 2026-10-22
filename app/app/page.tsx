import type { Metadata } from "next";
import { MailLoader } from "../../components/mail/loader";

export const metadata: Metadata = {
  title: "Inbox — Mac Tidar Mail",
  description: "Mac Tidar Mail web app — an interactive demo with local mail data.",
};

export default function MailPage() {
  return <MailLoader />;
}
