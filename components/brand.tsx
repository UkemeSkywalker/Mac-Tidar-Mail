/* eslint-disable @next/next/no-img-element -- static export serves images unoptimized */

// The green ribbon M on its own reads on every skin, light or dark; pair it with live text.
export function BrandMark({ className = "" }: { className?: string }) {
  return <img src="/brand/mark.webp" alt="Mac Tidar Mail" width={188} height={128} className={`w-auto shrink-0 ${className}`} />;
}

// The full horizontal logo has navy lettering, so only use it on light backgrounds.
export function BrandLogo({ className = "" }: { className?: string }) {
  return <img src="/brand/logo.webp" alt="Mac Tidar Mail" width={525} height={144} className={`w-auto ${className}`} />;
}
