import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Argon2 + Curve25519 work is real CPU; keep generous headroom on slow CI.
    testTimeout: 60_000,
  },
});
