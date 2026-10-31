import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: /^technogym-js$/, replacement: fileURLToPath(new URL("../src/index.ts", import.meta.url)) }],
  },
  define: { __MCP_VERSION__: JSON.stringify("0.0.0-test") },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
