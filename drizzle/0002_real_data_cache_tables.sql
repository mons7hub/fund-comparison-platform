DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE kv_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
