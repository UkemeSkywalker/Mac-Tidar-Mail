import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReferenceHome } from "../components/reference-home";

function getReferenceMarkup() {
  const source = readFileSync(join(process.cwd(), "designs/mac_tidar_mail_organic_bento_edition/code.html"), "utf8");
  const body = source.match(/<body[^>]*>([\s\S]*?)<script data-purpose="interactions">/)?.[1];
  if (!body) throw new Error("Unable to extract the approved homepage reference markup.");

  const localImages = ["/assets/reference-hero.jpg", "/assets/reference-collaboration.jpg"];
  let imageIndex = 0;
  return body.replace(/https:\/\/lh3\.googleusercontent\.com\/aida\/[^\"]+/g, () => localImages[imageIndex++] ?? localImages.at(-1)!);
}

export default function Home() {
  return <ReferenceHome markup={getReferenceMarkup()} />;
}
