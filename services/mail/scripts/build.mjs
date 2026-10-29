// Bundles each Lambda into dist/<name>/index.js for Terraform to zip.
import { build } from "esbuild";

const lambdas = { inbound: "src/inbound/handler.ts", api: "src/api/handler.ts", "ses-events": "src/ses-events/handler.ts", push: "src/push/handler.ts", auth: "src/auth/handler.ts" };

for (const [name, entry] of Object.entries(lambdas)) {
  await build({
    entryPoints: [entry],
    // ESM output: some dependencies call createRequire(import.meta.url), which is undefined in CJS bundles.
    outfile: `dist/${name}/index.mjs`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    minify: true,
    sourcemap: "linked",
    legalComments: "none",
    logLevel: "warning",
  });
  // Smoke test: the bundle must load and export a handler, exactly as Lambda will import it.
  const mod = await import(new URL(`../dist/${name}/index.mjs`, import.meta.url).href);
  if (typeof mod.handler !== "function") throw new Error(`dist/${name}/index.mjs does not export a handler`);
  console.log(`built dist/${name}/index.mjs (load check passed)`);
}
