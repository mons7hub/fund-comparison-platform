// Client-side compatibility layer (standalone replacement for
// @hatch/space-sdk/client).
//
// Provides the three things the app imports:
//   - createActionClient<T>(): a typed proxy; api.someAction(args) POSTs
//     { action, args } to ./actions and resolves with the handler's return
//     value. Errors are thrown as Error with the server's message.
//   - spaceQueryClient: a shared react-query QueryClient.
//   - SafeAreaTopScrim: renders a safe-area-inset-top spacer with the given
//     background colour (on desktop browsers this is 0px tall).

import { QueryClient } from "@tanstack/react-query";
import type { CSSProperties } from "react";

export const spaceQueryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
});

export type ApiRequest<T, K extends keyof T> =
  T[K] extends (args: infer A) => Promise<unknown> ? A
  : T[K] extends { __request?: infer R } ? R
  : never;

export type ApiResponse<T, K extends keyof T> =
  T[K] extends (args: never) => Promise<infer R> ? R
  : T[K] extends { __response?: infer R } ? R
  : never;

type ActionClient<T> = {
  [K in keyof T]: (args: ApiRequest<T, K>) => Promise<ApiResponse<T, K>>;
};

export function createActionClient<
  T extends Record<string, { __request?: unknown; __response?: unknown }>,
>(): ActionClient<T> {
  const proxy = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return async (args: unknown) => {
          const res = await fetch("./actions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: prop, args: args ?? {} }),
          });
          const data: unknown = await res.json().catch(() => null);
          if (!res.ok) {
            const msg =
              data && typeof data === "object" && "error" in data
                ? String((data as { error: unknown }).error)
                : `action ${String(prop)} failed: HTTP ${res.status}`;
            throw new Error(msg);
          }
          return data;
        };
      },
    },
  );
  return proxy as ActionClient<T>;
}

export function SafeAreaTopScrim({
  backgroundColor,
}: {
  backgroundColor?: string;
}) {
  const style: CSSProperties = {
    height: "env(safe-area-inset-top)",
    backgroundColor,
  };
  return <div aria-hidden="true" style={style} />;
}
