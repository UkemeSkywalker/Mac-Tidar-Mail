// Bundles each Lambda into dist/<name>/index.js for Terraform to zip.
import { build } from "esbuild";

const lambdas = { inbound: "src/inbound/handler.ts" };

for (const [name, entry] of Object.entries(lambdas)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}/index.js`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: true,
    sourcemap: "linked",
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`built dist/${name}/index.js`);
}
