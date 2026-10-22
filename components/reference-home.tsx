"use client";

import { useEffect } from "react";

export function ReferenceHome({ markup }: { markup: string }) {
  useEffect(() => {
    const mobileMenuButton = document.getElementById("mobileMenuBtn");
    const mobileMenu = document.getElementById("mobileMenu");

    const toggleMenu = () => {
      if (!mobileMenuButton || !mobileMenu) return;
      const isHidden = mobileMenu.classList.toggle("hidden");
      mobileMenuButton.setAttribute("aria-expanded", String(!isHidden));
    };

    const closeMenu = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest("a")) return;
      mobileMenu?.classList.add("hidden");
      mobileMenuButton?.setAttribute("aria-expanded", "false");
    };

    const handleKeyboardCta = (event: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName;
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || activeTag === "INPUT" || activeTag === "TEXTAREA") return;
      document.querySelector<HTMLAnchorElement>('a[href="#get-started"]')?.click();
    };

    mobileMenuButton?.addEventListener("click", toggleMenu);
    mobileMenu?.addEventListener("click", closeMenu);
    document.addEventListener("keydown", handleKeyboardCta);
    return () => {
      mobileMenuButton?.removeEventListener("click", toggleMenu);
      mobileMenu?.removeEventListener("click", closeMenu);
      document.removeEventListener("keydown", handleKeyboardCta);
    };
  }, []);

  return <div className="reference-home bg-linen text-stone-800 antialiased font-sans selection:bg-mint selection:text-forest-night" dangerouslySetInnerHTML={{ __html: markup }} />;
}
