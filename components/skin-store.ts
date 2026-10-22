import { useSyncExternalStore } from "react";

// One skin choice shared by the homepage and the mail app (same localStorage key).
export const SKIN_KEYS = ["forest", "botanical", "cobalt", "amber", "cyber", "editorial"] as const;
export type SkinKey = (typeof SKIN_KEYS)[number];

const SKIN_STORE = "mtm-skin"; const skinListeners = new Set<() => void>(); let memorySkin: SkinKey = "forest";
const isSkin = (v: unknown): v is SkinKey => SKIN_KEYS.includes(v as SkinKey);
export function readSkin(): SkinKey { try { const v = localStorage.getItem(SKIN_STORE); return isSkin(v) ? v : memorySkin; } catch { return memorySkin; } }
export function saveSkin(key: SkinKey) { memorySkin = key; try { localStorage.setItem(SKIN_STORE, key); } catch {} skinListeners.forEach(cb => cb()); }
function subscribeSkin(cb: () => void) { skinListeners.add(cb); window.addEventListener("storage", cb); return () => { skinListeners.delete(cb); window.removeEventListener("storage", cb); }; }

export function useSkin(): SkinKey { return useSyncExternalStore(subscribeSkin, readSkin, () => "forest"); }
