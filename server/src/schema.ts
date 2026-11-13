import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Server-side cache for Eastmoney (天天基金) public data payloads.
// key: e.g. "fund_index", "manager_index", "rank:all:1nzf", "fund:005827"
// payload: JSON string of the parsed payload; updated_at: epoch ms.
export const kvCache = sqliteTable("kv_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Manager public views (interviews / speeches / signed articles) collected
// from mainstream financial media by the weekly research task. Only real,
// source-linked items are stored; quote is a verbatim excerpt or null.
export const managerViews = sqliteTable("manager_views", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  managerId: text("manager_id").notNull(),
  managerName: text("manager_name").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  url: text("url").notNull(),
  publishedDate: text("published_date").notNull(),
  summary: text("summary").notNull(),
  quote: text("quote"),
  collectedAt: integer("collected_at").notNull(),
});

// Outlook / strategy excerpts taken from a fund's official periodic reports
// (quarterly / semi-annual / annual), with the source section name and the
// official report URL. Written only when the report text was actually read.
export const managerStatements = sqliteTable("manager_statements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  managerId: text("manager_id").notNull(),
  fundCode: text("fund_code").notNull(),
  fundName: text("fund_name").notNull(),
  kind: text("kind").notNull(),
  periodLabel: text("period_label").notNull(),
  publishedDate: text("published_date").notNull(),
  excerpt: text("excerpt").notNull(),
  section: text("section").notNull(),
  sourceUrl: text("source_url").notNull(),
  collectedAt: integer("collected_at").notNull(),
});

// Per-manager enrichment coverage ledger for the full-market rollout.
// views_status / statements_status: pending (not yet researched) |
// searched_none (researched, honestly nothing collectable) | has_views /
// has_excerpt (content stored). batch_attempted_at records when the daily
// coverage batch last included this manager, so batches never repeat work.
export const managerCoverage = sqliteTable("manager_coverage", {
  managerId: text("manager_id").primaryKey(),
  managerName: text("manager_name").notNull(),
  viewsStatus: text("views_status").notNull().default("pending"),
  statementsStatus: text("statements_status").notNull().default("pending"),
  batchAttemptedAt: integer("batch_attempted_at"),
  updatedAt: integer("updated_at").notNull(),
});

// Shared factor-theme news pool: news is collected once per impact theme
// (semiconductors, Fed, gov-bond yields, ...) and mapped onto every fund
// whose factor profile includes that theme, instead of researching each
// of the ~28k funds individually.
export const themeNews = sqliteTable("theme_news", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  theme: text("theme").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  url: text("url").notNull(),
  publishedDate: text("published_date").notNull(),
  collectedAt: integer("collected_at").notNull(),
});

// News items matched to a fund's real impact factors (holdings / category),
// each with a one-line relevance note for this specific fund.
export const fundNews = sqliteTable("fund_news", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fundCode: text("fund_code").notNull(),
  title: text("title").notNull(),
  source: text("source").notNull(),
  url: text("url").notNull(),
  publishedDate: text("published_date").notNull(),
  relation: text("relation").notNull(),
  collectedAt: integer("collected_at").notNull(),
});
