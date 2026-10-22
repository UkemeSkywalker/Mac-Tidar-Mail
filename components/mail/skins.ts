import type { SkinKey } from "../skin-store";

// Mail versions of the six site skins. Colour tokens live in app/globals.css (.mail-skin-*).
export const MAIL_SKINS: { key: SkinKey; name: string; note: string; dark?: boolean; swatch: [string, string, string] }[] = [
  { key: "forest", name: "Botanical Forest", note: "Forest & mint", swatch: ["#216b4d", "#8ce2b5", "#153e2d"] },
  { key: "botanical", name: "Botanical Clay", note: "Clay & sage", swatch: ["#216b4d", "#c25e34", "#f7f6f0"] },
  { key: "cobalt", name: "Mac Tidar Indigo", note: "Classic studio", swatch: ["#4f46e5", "#e1e0ff", "#f8f9ff"] },
  { key: "cyber", name: "Cyber Obsidian", note: "Electric amber", dark: true, swatch: ["#f59e0b", "#0d1117", "#080b11"] },
  { key: "amber", name: "Warm Espresso", note: "Amber & espresso", swatch: ["#a55e1d", "#ffd28b", "#24150c"] },
  { key: "editorial", name: "Warm Modern", note: "Rose editorial", swatch: ["#9a5149", "#f3c6b9", "#fcf8f5"] },
];
