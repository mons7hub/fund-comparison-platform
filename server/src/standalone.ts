// Standalone server entrypoint.
//
// Replaces the Muse Spaces runtime for local / self-hosted use:
//   - SQLite database (data/app.db) via bun:sqlite + Drizzle; the SQL
//     migrations in drizzle/ are applied once, in filename order.
//   - POST /actions dispatches { action, args } to the handlers exported
//     from ./actions, after validating args against each action's zod
//     request schema.
//   - Everything else serves the built client from client/dist with an SPA
//     fallback to index.html.
//
// The local user is the deployment's owner, so ctx.viewer.isOwner is true.
// ctx.agent.spawnTask is a Muse platform capability and does not exist
// standalone: it returns { ok: false }, which the research actions already
// treat as "task not spawned" (cached / curated content still works; live
// agent research simply does not run).
//
// Usage: bun run server/src/standalone.ts   (PORT env, default 3000)

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Actions } from "./actions";
import * as schema from "./schema";
import type { ActionDef, Ctx } from "@fund-platform/sdk";

const ROOT = join(import.meta.dir, "..", "..");
const DIST = join(ROOT, "client", "dist");
const PORT = Number(process.env.PORT ?? 3000);

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

mkdirSync(join(ROOT, "data"), { recursive: true });
const sqlite = new Database(join(ROOT, "data", "app.db"));
sqlite.exec("PRAGMA journal_mode = WAL;");

sqlite.exec(
  "CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
);
const applied = new Set(
  (sqlite.query("SELECT name FROM __migrations").all() as { name: string }[]).map(
    (r) => r.name,
  ),
);
for (const file of readdirSync(join(ROOT, "drizzle"))
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(ROOT, "drizzle", file), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
  sqlite.exec(sql);
  sqlite
    .query("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)")
    .run(file, Date.now());
  console.log(`[standalone] applied migration ${file}`);
}

const db = drizzle(sqlite, { schema });

const ctx: Ctx = {
  db: (() => db) as Ctx["db"],
  viewer: { isOwner: true },
  agent: {
    spawnTask: async () => ({ ok: false }),
  },
};

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

const actions = Actions as unknown as Record<string, ActionDef>;

async function handleAction(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { action?: string; args?: unknown };
    const def = body.action ? actions[body.action] : undefined;
    if (!def) {
      return Response.json(
        { error: `unknown action: ${String(body.action)}` },
        { status: 404 },
      );
    }
    const args = def.request.parse(body.args ?? {});
    const result = await def.handler(ctx, args);
    return Response.json(result ?? null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[standalone] action error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/actions" && req.method === "POST") {
      return handleAction(req);
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(join(DIST, rel));
    if (await file.exists()) return new Response(file);
    const index = Bun.file(join(DIST, "index.html"));
    if (await index.exists()) {
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(
      "Client not built yet. Run: bun run build\n",
      { status: 503 },
    );
  },
});

console.log(
  `[standalone] 基金对比平台 listening on http://localhost:${server.port}`,
);
