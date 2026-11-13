// Server-side compatibility layer (standalone replacement for @hatch/space-sdk).
//
// The application code was written against the Muse Spaces runtime, whose
// server SDK provides:
//   - defineAction({ description, request, response, handler })
//   - a per-call Ctx: ctx.db(schema) -> Drizzle instance,
//     ctx.viewer?.isOwner, ctx.agent.spawnTask(message, opts) -> { ok }
//   - z (re-exported zod)
//
// This module implements the same surface for a plain Bun process. The
// standalone server (server/src/standalone.ts) builds the Ctx and dispatches
// POST /actions requests to the handlers defined in server/src/actions.ts.

import { z } from "zod";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export { z };

export interface Ctx {
  /** Returns the Drizzle database instance bound to the app schema. */
  db<S extends Record<string, unknown> = Record<string, never>>(
  ): BunSQLiteDatabase<S>;
  /** Viewer classification. Standalone is a single-user deployment, so the
   *  local user is the owner (see standalone.ts). Only isOwner is read. */
  viewer?: { isOwner?: boolean };
  /** Agent task spawning is a Muse platform capability. It does not exist
   *  standalone; the implementation in standalone.ts returns { ok: false },
   *  which the research actions already handle as "not spawned". */
  agent: {
    spawnTask(
      message: string,
      opts?: { expectsAction?: string; dedupeKey?: string },
    ): Promise<{ ok: boolean }>;
  };
}

export interface ActionDef<Req = any, Res = any> {
  description?: string;
  request: z.ZodTypeAny;
  response: z.ZodTypeAny;
  handler: (ctx: Ctx, args: Req) => Promise<Res>;
  /** Phantom type carriers so the client can infer request/response types. */
  __request?: Req;
  __response?: Res;
}

export function defineAction<RQ extends z.ZodTypeAny, RS extends z.ZodTypeAny>(def: {
  description?: string;
  request: RQ;
  response: RS;
  handler: (ctx: Ctx, args: z.infer<RQ>) => Promise<z.infer<RS>>;
}): ActionDef<z.infer<RQ>, z.infer<RS>> {
  return def as unknown as ActionDef<z.infer<RQ>, z.infer<RS>>;
}

export type ActionsModule = Record<string, ActionDef>;
