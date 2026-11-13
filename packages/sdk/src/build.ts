// Build helper (standalone replacement for @hatch/space-sdk/build).
//
// Bundles the client exactly like the platform did, using Bun's bundler with
// the Tailwind plugin: entrypoint is client/index.html (which loads
// src/main.tsx), output goes to client/dist in production mode.

import tailwindPlugin from "bun-plugin-tailwind";
import { join } from "node:path";

export async function buildClient(): Promise<void> {
  // build.mjs is invoked from the repository root, so cwd is the root.
  // (import.meta.dir cannot be used here: this package is linked into
  // node_modules, so module-relative paths would resolve there instead.)
  const root = process.cwd();
  const result = await Bun.build({
    entrypoints: [join(root, "client", "index.html")],
    outdir: join(root, "client", "dist"),
    target: "browser",
    minify: true,
    sourcemap: "external",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [tailwindPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("client build failed");
  }
}
