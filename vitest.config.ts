import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests mock HTTP responses; they must never be written to the user's real cache.
    env: { CACHE_PATH: ":memory:" },
  },
});
