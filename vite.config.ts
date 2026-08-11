import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    // No chunk splitting: the whole app is a few tens of kilobytes, and one
    // request beats a waterfall at this size.
    rollupOptions: { output: { manualChunks: undefined } },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
