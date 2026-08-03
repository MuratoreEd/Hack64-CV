/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// The corpus runs separately from `npm test`: probing one dense real pool takes
// tens of seconds, and the unit suite has to stay fast enough to run constantly.
export default defineConfig({
  test: {
    environment: "node",
    include: ["corpus/**/*.test.ts"],
    // A 12k-surface level is ~35 s per probe today (R4 aims below 20 s).
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
