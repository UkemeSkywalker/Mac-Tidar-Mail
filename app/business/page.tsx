import type { Metadata } from "next";
import { BusinessApp } from "../../components/business/business-app";

export const metadata: Metadata = {
  title: "Business — Mac Tidar Mail",
  description: "End-to-end encrypted email on your own domain, with your company’s name and logo.",
};

export default function BusinessPage() {
  return <BusinessApp />;
}
