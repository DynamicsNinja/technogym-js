import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    clean: true,
    sourcemap: true,
    define: { __MCP_VERSION__: JSON.stringify(version) },
    // Inline technogym-js (resolved to ../src through tsconfig `paths`): the server is released in
    // lockstep with the library and must never run against a different version of it.
    noExternal: [/^technogym-js/],
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    // The hosted server (mcp/Dockerfile): everything inlined, so the runtime image needs no
    // node_modules. Node 22 for node:sqlite (esbuild leaves node: imports external).
    entry: { http: "src/http/main.ts" },
    outDir: "dist-http",
    format: ["esm"],
    target: "node22",
    platform: "node",
    clean: true,
    sourcemap: false,
    define: { __MCP_VERSION__: JSON.stringify(version) },
    noExternal: [/.*/],
    outExtension: () => ({ js: ".mjs" }),
    // CommonJS dependencies (express) call require(); give the ESM bundle one.
    banner: { js: "import { createRequire as __tgCreateRequire } from 'node:module'; const require = __tgCreateRequire(import.meta.url);" },
    esbuildOptions(options) {
      options.legalComments = "eof";
    },
  },
]);
