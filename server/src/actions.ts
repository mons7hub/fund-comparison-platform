// Server actions: all fund data comes from Eastmoney (天天基金) public
// endpoints, fetched and parsed server-side, cached in SQLite (kv_cache).
// No number is fabricated: fields that cannot be fetched or parsed are
// returned as null and rendered as 「暂无数据」 by the client.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchText(url: string, referer: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// viewer classification (guest access)
// ---------------------------------------------------------------------------
// Read actions serve public Eastmoney data from the shared cache and stay
// usable by signed-out guests of a public share. Actions that spawn agent
// research tasks (paid browser operations) or write researched content back
// into the owner's curated tables are owner-only: they require
// ctx.viewer?.isOwner === true (owner's browser, owner's agent, or an owner
// schedule — schedules and agent delegations act as the owner). Only
// isOwner is ever read from the viewer; no identity fields are used.

function isOwnerViewer(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

const OWNER_ONLY_MSG =
  "shared_artifact_vm_capability_unavailable: 该操作仅限所有者（共享页面不可用）";

// ---------------------------------------------------------------------------
// cache helpers
// ---------------------------------------------------------------------------

async function cacheRead(ctx: Ctx, key: string) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.kvCache)
    .where(eq(schema.kvCache.key, key))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { payload: row.payload, updatedAt: row.updatedAt };
}

async function cacheWrite(ctx: Ctx, key: string, payload: string) {
  const db = ctx.db<typeof schema>();
  await db
    .insert(schema.kvCache)
    .values({ key, payload, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: schema.kvCache.key,
      set: { payload, updatedAt: Date.now() },
    });
}

async function cachedJson<T>(
  ctx: Ctx,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  force = false,
): Promise<{ data: T; updatedAt: number }> {
  if (!force) {
    const hit = await cacheRead(ctx, key);
    if (hit && Date.now() - hit.updatedAt < ttlMs) {
      try {
        return { data: JSON.parse(hit.payload) as T, updatedAt: hit.updatedAt };
      } catch {
        // fall through and reload
      }
    }
  }
  const data = await loader();
  await cacheWrite(ctx, key, JSON.stringify(data));
  return { data, updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// fund index (fundcode_search.js, ~28k funds)
// ---------------------------------------------------------------------------

interface FundIdx {
  code: string;
  abbr: string;
  name: string;
  type: string;
  pinyin: string;
}

async function loadFundIndex(ctx: Ctx, force = false) {
  return cachedJson<FundIdx[]>(ctx, "fund_index", 24 * 3600 * 1000, async () => {
    const text = await fetchText(
      "https://fund.eastmoney.com/js/fundcode_search.js",
      "https://fund.eastmoney.com/",
    );
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) throw new Error("fund index parse failed");
    const raw = JSON.parse(text.slice(start, end + 1)) as string[][];
    return raw
      .filter((r) => r && r[0] && r[2])
      .map((r) => ({
        code: r[0] ?? "",
        abbr: r[1] ?? "",
        name: r[2] ?? "",
        type: r[3] ?? "",
        pinyin: r[4] ?? "",
      }));
  }, force);
}

// ---------------------------------------------------------------------------
// manager index (FundDataPortfolio_Interface, all managers, paginated)
// ---------------------------------------------------------------------------

interface MgrIdx {
  id: string;
  name: string;
  company: string;
  fundCodes: string[];
  fundNames: string[];
  tenureDays: number;
  bestReturn: string;
  repCode: string;
  repName: string;
  scale: string;
  repReturn: string;
}

const MGR_ROW_RE =
  /\["(\d+)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"\]/g;

async function loadManagerIndex(ctx: Ctx, force = false) {
  return cachedJson<MgrIdx[]>(ctx, "manager_index", 24 * 3600 * 1000, async () => {
    const pageUrl = (pi: number) =>
      `https://fund.eastmoney.com/Data/FundDataPortfolio_Interface.aspx?dt=14&mc=returnjson&ft=all&pn=500&pi=${pi}&sc=abbname&st=asc`;
    const first = await fetchText(pageUrl(1), "https://fund.eastmoney.com/manager/");
    const pagesMatch = first.match(/pages:(\d+)/);
    const pages = Math.min(20, Math.max(1, Number(pagesMatch?.[1] ?? 1)));
    const texts = [first];
    for (let pi = 2; pi <= pages; pi++) {
      texts.push(await fetchText(pageUrl(pi), "https://fund.eastmoney.com/manager/"));
    }
    const out: MgrIdx[] = [];
    const seen = new Set<string>();
    for (const t of texts) {
      for (const m of t.matchAll(MGR_ROW_RE)) {
        const id = m[1] ?? "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          name: m[2] ?? "",
          company: m[4] ?? "",
          fundCodes: (m[5] ?? "").split(",").filter(Boolean),
          fundNames: (m[6] ?? "").split(",").filter(Boolean),
          tenureDays: num(m[7]) ?? 0,
          bestReturn: m[8] ?? "",
          repCode: m[9] ?? "",
          repName: m[10] ?? "",
          scale: m[11] ?? "",
          repReturn: m[12] ?? "",
        });
      }
    }
    if (out.length === 0) throw new Error("manager index parse failed");
    return out;
  }, force);
}

// fund code -> manager (from manager index current funds)
function fundManagerMap(managers: MgrIdx[]) {
  const map = new Map<string, { id: string; name: string }>();
  for (const mg of managers) {
    for (const code of mg.fundCodes) {
      if (!map.has(code)) map.set(code, { id: mg.id, name: mg.name });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// rankings (rankhandler.aspx)
// ---------------------------------------------------------------------------

interface RankRow {
  code: string;
  name: string;
  date: string;
  nav: number | null;
  accNav: number | null;
  day: number | null;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y2: number | null;
  y3: number | null;
  ytd: number | null;
  since: number | null;
  inception: string;
  fee: string;
}

interface RankPayload {
  rows: RankRow[];
  total: number;
  counts: Record<string, number | null>;
}

async function loadRanking(
  ctx: Ctx,
  ft: string,
  sc: string,
  pn: number,
  force = false,
) {
  return cachedJson<RankPayload>(
    ctx,
    `rank:${ft}:${sc}:${pn}`,
    6 * 3600 * 1000,
    async () => {
      const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&sc=${sc}&st=desc&sd=&ed=&pi=1&pn=${pn}&dx=1`;
      const text = await fetchText(url, "https://fund.eastmoney.com/data/fundranking.html");
      const datasMatch = text.match(/datas:\[(.*?)\],allRecords/s);
      if (!datasMatch) throw new Error("rank parse failed");
      const items = [...(datasMatch[1] ?? "").matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? "");
      const rows: RankRow[] = items.map((item) => {
        const f = item.split(",");
        return {
          code: f[0] ?? "",
          name: f[1] ?? "",
          date: f[3] ?? "",
          nav: num(f[4]),
          accNav: num(f[5]),
          day: num(f[6]),
          w1: num(f[7]),
          m1: num(f[8]),
          m3: num(f[9]),
          m6: num(f[10]),
          y1: num(f[11]),
          y2: num(f[12]),
          y3: num(f[13]),
          ytd: num(f[14]),
          since: num(f[15]),
          inception: f[16] ?? "",
          fee: f[21] ?? f[20] ?? "",
        };
      }).filter((r) => r.code);
      const totalMatch = text.match(/allRecords:(\d+)/);
      const countOf = (k: string) => {
        const mm = text.match(new RegExp(`${k}:(\\d+)`));
        return mm ? Number(mm[1]) : null;
      };
      return {
        rows,
        total: totalMatch ? Number(totalMatch[1]) : rows.length,
        counts: {
          all: totalMatch ? Number(totalMatch[1]) : null,
          gp: countOf("gp_count"),
          hh: countOf("hh_count"),
          zq: countOf("zq_count"),
          zs: countOf("zs_count"),
          qdii: countOf("qdii_count"),
          fof: countOf("fof_count"),
        },
      };
    },
    force,
  );
}

// ---------------------------------------------------------------------------
// fund detail (pingzhongdata + F10 holdings + suggest base info)
// ---------------------------------------------------------------------------

function extractBalanced(src: string, varName: string): string | null {
  const marker = `var ${varName}`;
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  const eq = src.indexOf("=", idx);
  if (eq < 0) return null;
  let i = eq + 1;
  while (i < src.length && /\s/.test(src[i] ?? "")) i++;
  const open = src[i];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j] ?? "";
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}

function strVar(src: string, name: string): string | null {
  const m = src.match(new RegExp(`var ${name}\\s*=\\s*"([^"]*)"`));
  return m ? (m[1] ?? null) : null;
}

interface MgrPower {
  id: string;
  name: string;
  star: number | null;
  workTime: string | null;
  fundSize: string | null;
  pic: string | null;
  powerAvg: number | null;
  powerCats: string[];
  powerData: number[];
  profitCats: string[];
  profitData: number[];
}

interface Holding {
  code: string;
  name: string;
  weight: number | null;
  // Eastmoney market prefix from the F10 quote link ("1" SH, "0" SZ,
  // "116" HK, "105"/"106" US), null when unknown (e.g. bond holdings)
  market: string | null;
  // Eastmoney per-stock industry classification (f127), null when the
  // quote endpoint returned none
  industry: string | null;
}

interface PeriodReturns {
  day: number | null;
  d3: number | null;
  w1: number | null;
  m1: number | null;
}

interface FundDetail {
  code: string;
  name: string;
  type: string | null;
  company: string | null;
  rate: number | null;
  sourceRate: number | null;
  syl1m: number | null;
  syl3m: number | null;
  syl6m: number | null;
  syl1y: number | null;
  maxDrawdown: number | null;
  volatility: number | null;
  stockPosition: number | null;
  scaleYi: number | null;
  scaleDate: string | null;
  latestNav: number | null;
  latestNavDate: string | null;
  trend: { x: number; y: number }[];
  holdings: Holding[];
  holdingsDate: string | null;
  holdingsKind: "stock" | "bond";
  concentration: number | null;
  periodReturns: PeriodReturns;
  managers: MgrPower[];
}

// Stage returns from an NAV series (accumulated NAV preferred: it is
// dividend-adjusted, so a payout day does not fake a drop). day = latest vs
// previous NAV day; d3 = latest vs 3 NAV days earlier; w1 / m1 = latest vs
// the last NAV point at or before 7 / 30 calendar days earlier.
function computePeriodReturns(pts: { x: number; y: number }[]): PeriodReturns {
  const none: PeriodReturns = { day: null, d3: null, w1: null, m1: null };
  if (pts.length < 2) return none;
  const last = pts[pts.length - 1];
  if (!last || last.y <= 0) return none;
  const retVs = (p: { x: number; y: number } | undefined): number | null =>
    p && p.y > 0 ? Math.round(((last.y / p.y) - 1) * 10000) / 100 : null;
  const atOrBefore = (t: number) => {
    let found: { x: number; y: number } | undefined;
    for (const p of pts) {
      if (p.x <= t) found = p;
      else break;
    }
    return found === last ? undefined : found;
  };
  return {
    day: retVs(pts[pts.length - 2]),
    d3: retVs(pts[pts.length - 4]),
    w1: retVs(atOrBefore(last.x - 7 * 24 * 3600 * 1000)),
    m1: retVs(atOrBefore(last.x - 30 * 24 * 3600 * 1000)),
  };
}

// Eastmoney market prefix (secid) for a holding: from the F10 quote link
// when captured, otherwise derived from the code shape.
function holdingSecid(h: { code: string; market: string | null }): string | null {
  if (h.market) return `${h.market}.${h.code}`;
  const c = h.code;
  if (/^\d{6}$/.test(c)) return `${/^[69]/.test(c) ? "1" : "0"}.${c}`;
  if (/^\d{5}$/.test(c)) return `116.${c}`;
  return null;
}

// Per-stock industry classification from the Eastmoney quote endpoint
// (f127). Verified live for A-shares, HK and US listings. Null on failure.
async function fetchStockIndustry(h: {
  code: string;
  market: string | null;
}): Promise<string | null> {
  const secid = holdingSecid(h);
  if (!secid) return null;
  try {
    const txt = await fetchText(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f127`,
      "https://quote.eastmoney.com/",
    );
    const parsed = JSON.parse(txt) as { data?: { f127?: unknown } };
    const v = parsed.data?.f127;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function navStats(trend: { x: number; y: number }[]) {
  let maxDD = 0;
  let peak = -Infinity;
  for (const p of trend) {
    if (p.y > peak) peak = p.y;
    if (peak > 0) {
      const dd = ((peak - p.y) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }
  // annualized volatility from daily returns over the last ~1 year of points
  const tail = trend.slice(-260);
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1]?.y ?? 0;
    const cur = tail[i]?.y ?? 0;
    if (prev > 0) rets.push(cur / prev - 1);
  }
  let vol: number | null = null;
  if (rets.length > 20) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance =
      rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
    vol = Math.sqrt(variance) * Math.sqrt(250) * 100;
  }
  return {
    maxDrawdown: trend.length > 1 ? Math.round(maxDD * 100) / 100 : null,
    volatility: vol != null ? Math.round(vol * 100) / 100 : null,
  };
}

async function loadFundDetail(ctx: Ctx, code: string, force = false) {
  return cachedJson<FundDetail>(ctx, `fund:v3:${code}`, 12 * 3600 * 1000, async () => {
    const src = await fetchText(
      `https://fund.eastmoney.com/pingzhongdata/${code}.js`,
      "https://fund.eastmoney.com/",
    );
    const name = strVar(src, "fS_name") ?? code;

    // net worth trend
    let trend: { x: number; y: number }[] = [];
    const trendRaw = extractBalanced(src, "Data_netWorthTrend");
    if (trendRaw) {
      try {
        const arr = JSON.parse(trendRaw) as { x: number; y: number }[];
        trend = arr
          .filter((p) => typeof p.x === "number" && typeof p.y === "number")
          .map((p) => ({ x: p.x, y: p.y }));
      } catch {
        trend = [];
      }
    }
    const stats = navStats(trend);

    // stage returns （昨日/近3日/近1周/近1月） from the accumulated-NAV
    // series in the same payload; unit-NAV series as fallback
    let periodReturns: PeriodReturns = { day: null, d3: null, w1: null, m1: null };
    let acPts: { x: number; y: number }[] = [];
    const acRawInDetail = extractBalanced(src, "Data_ACWorthTrend");
    if (acRawInDetail) {
      try {
        const arr = JSON.parse(acRawInDetail) as [number, number][];
        acPts = arr
          .filter(
            (p) =>
              Array.isArray(p) &&
              typeof p[0] === "number" &&
              typeof p[1] === "number" &&
              (p[1] ?? 0) > 0,
          )
          .map((p) => ({ x: p[0] ?? 0, y: p[1] ?? 0 }))
          .sort((a, b) => a.x - b.x);
      } catch {
        acPts = [];
      }
    }
    periodReturns =
      acPts.length >= 2 ? computePeriodReturns(acPts) : computePeriodReturns(trend);

    const lastPoint = trend[trend.length - 1];
    // NAV timestamps are China-time midnights: render the CST date, the
    // same convention as the K-line, so header and chart dates agree
    const latestNavDate = lastPoint ? cstDateStr(lastPoint.x) : null;
    // downsample trend for transport (keep <= 420 points, always keep last)
    let trendOut = trend;
    if (trend.length > 420) {
      const step = Math.ceil(trend.length / 420);
      trendOut = trend.filter((_, i) => i % step === 0);
      const lp = trend[trend.length - 1];
      if (lp && trendOut[trendOut.length - 1] !== lp) trendOut.push(lp);
    }

    // stock position (latest)
    let stockPosition: number | null = null;
    const posRaw = extractBalanced(src, "Data_fundSharesPositions");
    if (posRaw) {
      try {
        const arr = JSON.parse(posRaw) as [number, number][];
        const lastPos = arr[arr.length - 1];
        stockPosition = lastPos ? num(lastPos[1]) : null;
      } catch {
        stockPosition = null;
      }
    }

    // scale (latest point of Data_fluctuationScale)
    let scaleYi: number | null = null;
    let scaleDate: string | null = null;
    const scaleRaw = extractBalanced(src, "Data_fluctuationScale");
    if (scaleRaw) {
      try {
        const obj = JSON.parse(scaleRaw) as {
          categories?: string[];
          series?: { data?: number[]; y?: number }[] | { y?: number }[];
        };
        const cats = obj.categories ?? [];
        const s0 = (obj.series as { data?: number[]; y?: number }[] | undefined)?.[0];
        if (s0 && Array.isArray(s0.data) && s0.data.length > 0) {
          const li = s0.data.length - 1;
          scaleYi = num(s0.data[li]);
          scaleDate = cats[li] ?? null;
        } else if (Array.isArray(obj.series) && obj.series.length > 0) {
          const items = obj.series as { y?: number }[];
          const li = items.length - 1;
          scaleYi = num(items[li]?.y);
          scaleDate = cats[li] ?? null;
        }
      } catch {
        scaleYi = null;
      }
    }

    // current managers with Eastmoney power scores
    const managers: MgrPower[] = [];
    const mgrRaw = extractBalanced(src, "Data_currentFundManager");
    if (mgrRaw) {
      try {
        const arr = JSON.parse(mgrRaw) as Record<string, unknown>[];
        for (const mg of arr) {
          const power = (mg.power ?? {}) as {
            avr?: string;
            categories?: string[];
            data?: number[];
          };
          const profit = (mg.profit ?? {}) as {
            categories?: string[];
            series?: { data?: { y: number }[] }[];
          };
          const powerAvgVal = num(power.avr);
          const rawPowerData = Array.isArray(power.data)
            ? power.data.map((v) => num(v) ?? 0)
            : [];
          const hasPower =
            powerAvgVal != null || rawPowerData.some((v) => v > 0);
          managers.push({
            id: String(mg.id ?? ""),
            name: String(mg.name ?? ""),
            star: num(mg.star),
            workTime: typeof mg.workTime === "string" ? mg.workTime : null,
            fundSize: typeof mg.fundSize === "string" ? mg.fundSize : null,
            pic: typeof mg.pic === "string" ? mg.pic : null,
            powerAvg: powerAvgVal,
            powerCats: hasPower && Array.isArray(power.categories) ? power.categories : [],
            powerData: hasPower ? rawPowerData : [],
            profitCats: Array.isArray(profit.categories) ? profit.categories : [],
            profitData: (profit.series?.[0]?.data ?? []).map((d) => num(d?.y) ?? 0),
          });
        }
      } catch {
        // leave empty
      }
    }

    // top holdings from F10 (names + weights + market); failure -> empty,
    // never faked. The only literal percentage in a row is 占净值比例 (the
    // 最新价/涨跌幅 cells are empty span placeholders in this payload).
    let holdings: Holding[] = [];
    let holdingsDate: string | null = null;
    let holdingsKind: "stock" | "bond" = "stock";
    try {
      const h = await fetchText(
        `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=`,
        "https://fund.eastmoney.com/f10/",
      );
      const dateMatch = h.match(/截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/);
      holdingsDate = dateMatch ? (dateMatch[1] ?? null) : null;
      // the response contains several quarters of tables; only the first
      // table is the latest quarter
      const firstTableEnd = h.indexOf("</table>");
      const scope = firstTableEnd > 0 ? h.slice(0, firstTableEnd) : h;
      const rowRe = /<tr>(.*?)<\/tr>/gs;
      for (const rm of scope.matchAll(rowRe)) {
        if (holdings.length >= 10) break;
        const row = rm[1] ?? "";
        // Quote links carry market + code: unify/r/1.600519 (SH),
        // unify/r/116.00700 (HK), unify/r/105.AMD (US). A-share rows put
        // the name in a 'tol' cell; QDII rows use 'toc' cells where the
        // second link carries the Chinese company name.
        const links = [
          ...row.matchAll(/unify\/r\/(\d+)\.([A-Za-z0-9]+)'[^>]*>([^<]+)<\/a>/g),
        ];
        const tolMatch = row.match(/<td class='to[lc]'><a[^>]*>([^<]+)<\/a>/);
        const weightMatch = row.match(/(\d+\.\d+)%/);
        let code: string | null = null;
        let name: string | null = null;
        let market: string | null = null;
        if (links.length > 0) {
          market = links[0]?.[1] ?? null;
          code = links[0]?.[2] ?? null;
        }
        if (links.length > 0 && tolMatch) {
          name = (tolMatch[1] ?? "").trim();
        } else if (links.length >= 2) {
          name = (links[1]?.[3] ?? "").trim();
        } else if (links.length === 1) {
          name = (links[0]?.[3] ?? "").trim();
        }
        if (code && name) {
          holdings.push({
            code,
            name,
            weight: weightMatch ? num(weightMatch[1]) : null,
            market,
            industry: null,
          });
        }
      }
    } catch {
      holdings = [];
    }
    // industry classification per top holding (Eastmoney quote endpoint);
    // sequential, and cached together with the detail payload for 12h
    if (holdings.length > 0) {
      for (const hd of holdings) {
        hd.industry = await fetchStockIndustry(hd);
      }
    }
    // pure bond / money funds have no stock rows: fall back to the F10
    // bond-holdings table (zqcc) so the analysis still shows what the
    // fund actually holds, labeled as bonds
    if (holdings.length === 0) {
      try {
        const hb = await fetchText(
          `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=zqcc&code=${code}&year=&month=`,
          "https://fund.eastmoney.com/f10/",
        );
        const bDate = hb.match(/截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/);
        const bEnd = hb.indexOf("</table>");
        const bScope = bEnd > 0 ? hb.slice(0, bEnd) : hb;
        const bonds: Holding[] = [];
        for (const rm of bScope.matchAll(/<tr>(.*?)<\/tr>/gs)) {
          if (bonds.length >= 10) break;
          const row = rm[1] ?? "";
          const nm = row.match(/<td class='tol'>([^<]+)<\/td>/);
          const cells = [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) =>
            (c[1] ?? "").trim(),
          );
          const wMatch = row.match(/(\d+\.\d+)%/);
          const bName = nm ? (nm[1] ?? "").trim() : "";
          const bCode = cells[1] ?? "";
          if (bName && /^\d{5,}$/.test(bCode)) {
            bonds.push({
              code: bCode,
              name: bName,
              weight: wMatch ? num(wMatch[1]) : null,
              market: null,
              industry: null,
            });
          }
        }
        if (bonds.length > 0) {
          holdings = bonds;
          holdingsKind = "bond";
          if (bDate) holdingsDate = bDate[1] ?? holdingsDate;
        }
      } catch {
        // keep the empty stock holdings
      }
    }
    const concentration =
      holdings.length > 0
        ? Math.round(
            holdings.reduce((a, b) => a + (b.weight ?? 0), 0) * 100,
          ) / 100
        : null;

    // company + type from suggest API base info (best effort)
    let company: string | null = null;
    let type: string | null = null;
    try {
      const s = await fetchText(
        `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${code}`,
        "https://fund.eastmoney.com/",
      );
      const parsed = JSON.parse(s) as {
        Datas?: { FundBaseInfo?: { FCODE?: string; JJGS?: string; FTYPE?: string } }[];
      };
      const hit = (parsed.Datas ?? []).find((d) => d.FundBaseInfo?.FCODE === code);
      company = hit?.FundBaseInfo?.JJGS ?? null;
      type = hit?.FundBaseInfo?.FTYPE ?? null;
    } catch {
      company = null;
    }

    return {
      code,
      name,
      type,
      company,
      rate: num(strVar(src, "fund_Rate")),
      sourceRate: num(strVar(src, "fund_sourceRate")),
      syl1m: num(strVar(src, "syl_1y")),
      syl3m: num(strVar(src, "syl_3y")),
      syl6m: num(strVar(src, "syl_6y")),
      syl1y: num(strVar(src, "syl_1n")),
      maxDrawdown: stats.maxDrawdown,
      volatility: stats.volatility,
      stockPosition,
      scaleYi,
      scaleDate,
      latestNav: lastPoint ? lastPoint.y : null,
      latestNavDate,
      trend: trendOut,
      holdings,
      holdingsDate,
      holdingsKind,
      concentration,
      periodReturns,
      managers,
    };
  }, force);
}

// ---------------------------------------------------------------------------
// K-line (candlesticks aggregated from the accumulated NAV series)
// ---------------------------------------------------------------------------
// Funds publish exactly one NAV per trading day — there is no intraday
// OHLC and no volume. The K-line is therefore synthesized honestly from the
// accumulated NAV series (Data_ACWorthTrend, which does not drop on
// dividend payouts the way unit NAV does):
//   daily candle : open = previous day's NAV, close = today's NAV,
//                  high/low = the larger/smaller of the two
//   weekly/monthly: open = first NAV of the period, close = last NAV,
//                  high/low = max/min NAV inside the period
// The client labels this methodology under the chart; nothing is invented.

interface NavPoint {
  x: number;
  y: number;
}

async function loadAcTrend(ctx: Ctx, code: string) {
  return cachedJson<NavPoint[]>(
    ctx,
    `fund:actrend:${code}`,
    12 * 3600 * 1000,
    async () => {
      const src = await fetchText(
        `https://fund.eastmoney.com/pingzhongdata/${code}.js`,
        "https://fund.eastmoney.com/",
      );
      const acRaw = extractBalanced(src, "Data_ACWorthTrend");
      if (acRaw) {
        try {
          const arr = JSON.parse(acRaw) as [number, number][];
          const pts = arr
            .filter(
              (p) =>
                Array.isArray(p) &&
                typeof p[0] === "number" &&
                typeof p[1] === "number" &&
                (p[1] ?? 0) > 0,
            )
            .map((p) => ({ x: p[0] ?? 0, y: p[1] ?? 0 }))
            .sort((a, b) => a.x - b.x);
          if (pts.length > 0) return pts;
        } catch {
          // fall through to unit NAV trend
        }
      }
      const trendRaw = extractBalanced(src, "Data_netWorthTrend");
      if (trendRaw) {
        const arr = JSON.parse(trendRaw) as { x: number; y: number }[];
        return arr
          .filter((p) => typeof p.x === "number" && typeof p.y === "number" && p.y > 0)
          .map((p) => ({ x: p.x, y: p.y }))
          .sort((a, b) => a.x - b.x);
      }
      return [];
    },
  );
}

// NAV timestamps are China-time midnights; shift +8h before taking the date.
function cstDateStr(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function periodKeyOf(dateStr: string, period: "day" | "week" | "month"): string {
  if (period === "day") return dateStr;
  if (period === "month") return dateStr.slice(0, 7);
  // ISO week key (YYYY-Www) from the calendar date
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week =
    1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface Candle {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  changePct: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
}

function buildCandles(
  points: NavPoint[],
  period: "day" | "week" | "month",
): Candle[] {
  const groups = new Map<string, NavPoint[]>();
  for (const p of points) {
    const key = periodKeyOf(cstDateStr(p.x), period);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const raw: { date: string; open: number; close: number; high: number; low: number }[] = [];
  let prevClose: number | null = null;
  for (const g of groups.values()) {
    const first = g[0];
    const last = g[g.length - 1];
    if (!first || !last) continue;
    const open = period === "day" ? (prevClose ?? first.y) : first.y;
    const close = last.y;
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    if (period !== "day") {
      for (const p of g) {
        if (p.y > high) high = p.y;
        if (p.y < low) low = p.y;
      }
    }
    raw.push({ date: cstDateStr(last.x), open, close, high, low });
    prevClose = close;
  }
  const closes = raw.map((c) => c.close);
  const ma = (i: number, w: number): number | null => {
    if (i + 1 < w) return null;
    let s = 0;
    for (let j = i - w + 1; j <= i; j++) s += closes[j] ?? 0;
    return Math.round((s / w) * 10000) / 10000;
  };
  return raw.map((c, i) => {
    const prev = i > 0 ? raw[i - 1] : undefined;
    const base = prev ? prev.close : c.open;
    return {
      date: c.date,
      open: Math.round(c.open * 10000) / 10000,
      close: Math.round(c.close * 10000) / 10000,
      high: Math.round(c.high * 10000) / 10000,
      low: Math.round(c.low * 10000) / 10000,
      changePct:
        base > 0 ? Math.round(((c.close - base) / base) * 10000) / 100 : null,
      ma5: ma(i, 5),
      ma10: ma(i, 10),
      ma20: ma(i, 20),
    };
  });
}

// ---------------------------------------------------------------------------
// market index benchmarks （上证指数 / 沪深300 / 纳斯达克100 / 标普500）
// ---------------------------------------------------------------------------
// Index daily closes come from the Eastmoney quote kline endpoint
// (push2his), fetched server-side and cached 12h per index. Secids were
// verified live: 1.000001 上证指数， 1.000300 沪深300, 100.NDX (Eastmoney
// names this series 「纳斯达克」 — it is the Nasdaq-100; the Nasdaq
// Composite IXIC returns no data on this endpoint, so it is not used),
// 100.SPX 标普500. Every comparison number is computed from the fund's
// real accumulated-NAV series and the indices' real closes, aligned by
// calendar date (last close at or before the target date: US indices
// trade on different days than fund NAV dates, so exact same-day
// matching is impossible and is not faked).

interface BenchDef {
  key: string;
  name: string;
  short: string;
  secid: string;
}

const BENCHMARKS: BenchDef[] = [
  { key: "sh", name: "上证指数", short: "上证", secid: "1.000001" },
  { key: "hs300", name: "沪深300", short: "沪深300", secid: "1.000300" },
  { key: "ndx", name: "纳斯达克100", short: "纳指", secid: "100.NDX" },
  { key: "spx", name: "标普500", short: "标普", secid: "100.SPX" },
];

interface IndexPoint {
  date: string;
  close: number;
}

async function loadIndexSeries(ctx: Ctx, def: BenchDef) {
  return cachedJson<IndexPoint[]>(
    ctx,
    `index:series:v1:${def.secid}`,
    12 * 3600 * 1000,
    async () => {
      const url =
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${def.secid}` +
        `&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3` +
        `&fields2=f51,f52,f53,f54,f55&klt=101&fqt=1&beg=20000101&end=20500101`;
      // the full-history payload is large and the quote endpoint drops a
      // cold first request now and then — retry once before giving up
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await fetchText(url, "https://quote.eastmoney.com/");
          const parsed = JSON.parse(text) as {
            data?: { klines?: string[] } | null;
          };
          const out: IndexPoint[] = [];
          for (const line of parsed.data?.klines ?? []) {
            const f = line.split(",");
            const close = num(f[2]);
            if (f[0] && close != null && close > 0) out.push({ date: f[0], close });
          }
          out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
          if (out.length === 0) throw new Error(`index series empty for ${def.secid}`);
          return out;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`index fetch failed for ${def.secid}`);
    },
  );
}

function atOrBeforeDate<T extends { date: string }>(
  pts: T[],
  date: string,
): T | undefined {
  let lo = 0;
  let hi = pts.length - 1;
  let ans: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pts[mid];
    if (!p) break;
    if (p.date <= date) {
      ans = p;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateDiffDays(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) /
      (24 * 3600 * 1000),
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;

interface FundPt {
  date: string;
  y: number;
}

// fund return between the NAV points bracketing [startDate, endDate]
function retBetween(
  start: { y: number } | undefined,
  end: { y: number } | undefined,
): number | null {
  if (!start || !end || start.y <= 0) return null;
  return round2((end.y / start.y - 1) * 100);
}

function indexRetBetween(
  start: IndexPoint | undefined,
  end: IndexPoint | undefined,
): number | null {
  if (!start || !end || start.close <= 0) return null;
  return round2((end.close / start.close - 1) * 100);
}

interface FundYearRet {
  year: number;
  ret: number;
  startDate: string; // NAV date the year's return is measured from
  endDate: string; // NAV date the year's return is measured to
  full: boolean; // measured from the previous year-end NAV (a complete year)
  complete: boolean; // the calendar year is over in the fund's data
}

function fundYearReturns(fundPts: FundPt[]): FundYearRet[] {
  const out: FundYearRet[] = [];
  const first = fundPts[0];
  const last = fundPts[fundPts.length - 1];
  if (!first || !last) return out;
  const firstYear = Number(first.date.slice(0, 4));
  const lastYear = Number(last.date.slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) {
    const prevEnd = atOrBeforeDate(fundPts, `${y - 1}-12-31`);
    const start =
      prevEnd ?? fundPts.find((p) => p.date >= `${y}-01-01` && p.date <= `${y}-12-31`);
    const end = atOrBeforeDate(fundPts, `${y}-12-31`);
    if (!start || !end) continue;
    if (dateDiffDays(start.date, end.date) < 20) continue; // stub period, not a year
    out.push({
      year: y,
      ret: round2((end.y / start.y - 1) * 100),
      startDate: start.date,
      endDate: end.date,
      full: !!prevEnd,
      complete: y < lastYear,
    });
  }
  return out;
}

const BENCH_PERIODS: { key: string; label: string; days: number }[] = [
  { key: "m1", label: "近1月", days: 30 },
  { key: "m3", label: "近3月", days: 91 },
  { key: "m6", label: "近6月", days: 182 },
  { key: "y1", label: "近1年", days: 365 },
  { key: "y3", label: "近3年", days: 365 * 3 },
  { key: "y5", label: "近5年", days: 365 * 5 },
];

function benchInsights(
  def: BenchDef,
  periods: { key: string; fund: number | null; index: number | null; excess: number | null }[],
  since: { fund: number | null; index: number | null; excess: number | null; startDate: string },
  yearsDesc: { year: number; beat: boolean | null; complete: boolean; full: boolean }[],
  beatStreak: number,
  longestBeatStreak: number,
  yearsBeaten: number,
  yearsCompared: number,
): string[] {
  const out: string[] = [];
  const f1 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
  const f2 = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  const rel = (excess: number) => (excess >= 0 ? "跑赢" : "跑输");
  const relPhrase = (excess: number, fund: number, index: number) =>
    Math.abs(excess) < 0.05
      ? `与${def.name}基本持平（基金 ${f1(fund)}% vs ${def.short} ${f1(index)}%）`
      : `${rel(excess)}${def.name} ${Math.abs(excess).toFixed(1)} 个百分点（基金 ${f1(fund)}% vs ${def.short} ${f1(index)}%）`;
  const p1 = periods.find((p) => p.key === "y1");
  if (p1 && p1.fund != null && p1.index != null && p1.excess != null) {
    out.push(`近1年${relPhrase(p1.excess, p1.fund, p1.index)}`);
  }
  const p5 = periods.find((p) => p.key === "y5");
  if (p5 && p5.excess != null && p5.fund != null && p5.index != null) {
    out.push(`近5年累计${relPhrase(p5.excess, p5.fund, p5.index)}`);
  } else if (since.excess != null && since.fund != null && since.index != null) {
    out.push(
      Math.abs(since.excess) < 0.05
        ? `自 ${since.startDate} 有净值以来累计与${def.name}基本持平（基金 ${f2(since.fund)}% vs ${def.short} ${f2(since.index)}%）`
        : `自 ${since.startDate} 有净值以来累计${rel(since.excess)}${def.name} ${Math.abs(since.excess).toFixed(1)} 个百分点（基金 ${f2(since.fund)}% vs ${def.short} ${f2(since.index)}%）`,
    );
  }
  if (beatStreak >= 2) {
    const lastFull = yearsDesc.find((y) => y.full && y.complete);
    if (lastFull) {
      out.push(
        `${lastFull.year - beatStreak + 1}–${lastFull.year} 年连续 ${beatStreak} 个完整年度跑赢${def.name}`,
      );
    }
  } else if (longestBeatStreak >= 3) {
    out.push(`历史上最长曾连续 ${longestBeatStreak} 个完整年度跑赢${def.name}`);
  }
  if (yearsCompared >= 3) {
    out.push(
      `在可比的 ${yearsCompared} 个完整年度中跑赢${def.name} ${yearsBeaten} 次`,
    );
  }
  return out.slice(0, 3);
}

// manager page bio (best effort parse of the public manager profile page)
async function loadManagerBio(ctx: Ctx, id: string): Promise<string | null> {
  const { data } = await cachedJson<{ bio: string | null }>(
    ctx,
    `mgrbio:${id}`,
    7 * 24 * 3600 * 1000,
    async () => {
      try {
        const html = await fetchText(
          `https://fund.eastmoney.com/manager/${id}.html`,
          "https://fund.eastmoney.com/",
        );
        const text = html
          .replace(/<script[\s\S]*?<\/script>/g, " ")
          .replace(/<style[\s\S]*?<\/style>/g, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ");
        const marker = "基金经理简介：";
        const idx = text.indexOf(marker);
        if (idx < 0) return { bio: null };
        let bio = text.slice(idx + marker.length, idx + marker.length + 700).trim();
        const cutMarkers = ["现任基金", "基金经理管理过的基金", "历任基金", "查详细资料"];
        for (const cm of cutMarkers) {
          const ci = bio.indexOf(cm, 40);
          if (ci > 0) bio = bio.slice(0, ci).trim();
        }
        return { bio: bio.length >= 20 ? bio : null };
      } catch {
        return { bio: null };
      }
    },
  );
  return data.bio;
}

// ---------------------------------------------------------------------------
// periodic reports (F10 announcements, category 3 = 定期报告)
// ---------------------------------------------------------------------------

interface FundReport {
  id: string;
  title: string;
  kind: string;
  period: string;
  publishDate: string;
  pdfUrl: string;
  pageUrl: string;
}

function classifyReport(title: string): { kind: string; period: string } | null {
  let m = title.match(/(\d{4})年年度报告/);
  if (m) return { kind: "年度报告", period: `${m[1]} 年年报` };
  m = title.match(/(\d{4})年中期报告/);
  if (m) return { kind: "半年度报告", period: `${m[1]} 年半年报` };
  m = title.match(/(\d{4})年第([1-4])季度报告/);
  if (m) return { kind: "季度报告", period: `${m[1]} 年第 ${m[2]} 季度` };
  return null;
}

async function loadFundReports(ctx: Ctx, code: string) {
  return cachedJson<FundReport[]>(
    ctx,
    `reports:${code}`,
    24 * 3600 * 1000,
    async () => {
      const text = await fetchText(
        `https://api.fund.eastmoney.com/f10/JJGG?fundcode=${code}&pageIndex=1&pageSize=14&type=3`,
        "https://fund.eastmoney.com/",
      );
      const parsed = JSON.parse(text) as {
        Data?: { ID?: string; TITLE?: string; PUBLISHDATE?: string }[] | null;
      };
      const out: FundReport[] = [];
      for (const item of parsed.Data ?? []) {
        const title = item.TITLE ?? "";
        const id = item.ID ?? "";
        const cls = classifyReport(title);
        if (!id || !cls) continue;
        out.push({
          id,
          title,
          kind: cls.kind,
          period: cls.period,
          publishDate: (item.PUBLISHDATE ?? "").slice(0, 10),
          pdfUrl: `https://pdf.dfcfw.com/pdf/H2_${id}_1.pdf`,
          pageUrl: `https://fund.eastmoney.com/gonggao/${code},${id}.html`,
        });
      }
      return out;
    },
  );
}

// ---------------------------------------------------------------------------
// impact factors (computed from a fund's real holdings + category)
// ---------------------------------------------------------------------------

type FundCategory = "qdii" | "bond" | "money" | "aequity" | "fof" | "other";

function fundCategoryOf(type: string | null): FundCategory {
  const t = type ?? "";
  if (t.includes("QDII")) return "qdii";
  if (t.includes("货币")) return "money";
  if (t.includes("纯债") || t.includes("短债") || t.includes("债券")) return "bond";
  if (t.includes("FOF")) return "fof";
  if (t.includes("股票") || t.includes("混合") || t.includes("指数")) return "aequity";
  return "other";
}

const CATEGORY_LABELS: Record<FundCategory, string> = {
  qdii: "QDII / 海外权益",
  bond: "债券型",
  money: "货币型",
  aequity: "A股权益",
  fof: "FOF",
  other: "其他",
};

// well-known, unambiguous sector groupings for top-holding names as they
// appear in Eastmoney F10 holdings tables
const CHIP_HOLDING_NAMES = [
  "AMD", "超威半导体", "英伟达", "阿斯麦", "台积电", "博通", "美光", "美光科技", "拉姆研究",
  "泛林", "应用材料", "英特尔", "高通", "德州仪器", "恩智浦", "中芯国际",
  "寒武纪", "海光信息", "北方华创", "中微公司", "韦尔股份", "兆易创新", "澜起科技",
];
const CHIP_TICKERS = [
  "AMD", "NVDA", "ASML", "TSM", "AVGO", "MU", "LRCX", "AMAT", "INTC", "QCOM",
  "TXN", "MRVL", "ARM",
];
const INTERNET_HOLDING_NAMES = [
  "苹果", "微软", "谷歌", "亚马逊", "Meta", "奈飞", "网飞", "阿里巴巴", "腾讯",
  "拼多多", "美团", "京东", "百度", "特斯拉",
];
const INTERNET_TICKERS = [
  "AAPL", "MSFT", "GOOG", "GOOGL", "AMZN", "META", "NFLX", "TSLA", "BABA",
  "PDD", "NTES", "BIDU",
];

interface FactorItem {
  name: string;
  detail: string;
  keywords: string[];
  // factor-theme keys this factor maps to in the shared news pool
  themes: string[];
}

// Shared news-pool themes. Every factor carries one or more of these keys;
// news is collected once per theme and mapped onto all funds whose factor
// profile contains the theme. Bond/money themes never mix with equity ones.
const NEWS_THEMES: Record<string, { label: string; searchHints: string }> = {
  "us-tech": { label: "美股科技股", searchHints: "美股科技股、纳斯达克、标普500、苹果 微软 谷歌 亚马逊 Meta 英伟达等巨头财报与股价" },
  semiconductor: { label: "半导体产业链", searchHints: "费城半导体指数、芯片股、英伟达 AMD 阿斯麦 台积电 美光 财报与股价、半导体行业" },
  "fed-rates": { label: "美联储与美元利率", searchHints: "美联储、利率决议、降息预期、鲍威尔、美国通胀数据" },
  "usd-fx": { label: "美元与人民币汇率", searchHints: "美元指数、美元兑人民币、人民币汇率走势" },
  "a-share": { label: "A股大盘与流动性", searchHints: "A股、沪深300、上证指数、北向资金、两市成交额" },
  pharma: { label: "医药行业", searchHints: "医药行业政策、创新药、集采、医药板块" },
  tech: { label: "A股科技/半导体", searchHints: "A股半导体、芯片、电子板块、国产替代" },
  consumer: { label: "消费行业", searchHints: "白酒、食品饮料、消费板块、消费数据" },
  "new-energy": { label: "新能源行业", searchHints: "光伏、锂电、新能源汽车、储能行业" },
  finance: { label: "金融行业", searchHints: "银行、证券、保险板块与金融政策" },
  "gov-bond": { label: "国债收益率", searchHints: "10年期国债收益率、国债收益率走势、债券市场" },
  "monetary-policy": { label: "央行货币政策", searchHints: "央行、公开市场操作、逆回购、MLF、降准降息" },
  credit: { label: "信用债事件", searchHints: "信用债、评级下调、债券违约、城投债" },
  "money-market": { label: "银行间资金面", searchHints: "资金面、DR007、同业存单、银行间市场" },
};

function computeFactors(f: FundDetail): { category: FundCategory; factors: FactorItem[] } {
  const cat = fundCategoryOf(f.type);
  const factors: FactorItem[] = [];
  const inGroup = (h: Holding, names: string[], tickers: string[]) =>
    names.some((n) => h.name.includes(n)) || tickers.includes(h.code.toUpperCase());
  const groupWeight = (names: string[], tickers: string[]) =>
    f.holdings
      .filter((h) => inGroup(h, names, tickers))
      .reduce((a, b) => a + (b.weight ?? 0), 0);
  const tops = f.holdings.slice(0, 3);
  tops.forEach((h, i) => {
    const themes: string[] = [];
    if (inGroup(h, CHIP_HOLDING_NAMES, CHIP_TICKERS)) themes.push("semiconductor");
    if (inGroup(h, INTERNET_HOLDING_NAMES, INTERNET_TICKERS)) themes.push("us-tech");
    if (themes.length === 0) {
      if (cat === "qdii") themes.push("us-tech");
      else if (cat === "aequity") themes.push("a-share");
    }
    factors.push({
      name: `${h.name}（第 ${i + 1} 大重仓）`,
      detail: `${h.name} 占基金净值 ${h.weight != null ? `${h.weight.toFixed(2)}%` : "一定比例"}，是本基金第 ${i + 1} 大重仓，其财报、指引与股价走势会直接传导至基金净值。`,
      keywords: [h.name],
      themes,
    });
  });
  const chipW = groupWeight(CHIP_HOLDING_NAMES, CHIP_TICKERS);
  if (chipW >= 8) {
    const chipNames = f.holdings
      .filter((h) => inGroup(h, CHIP_HOLDING_NAMES, CHIP_TICKERS))
      .map((h) => h.name);
    factors.push({
      name: "半导体产业链暴露",
      detail: `前十大持仓中半导体公司（${chipNames.join("、")}）合计占净值约 ${chipW.toFixed(1)}%，费城半导体指数与全球芯片股行情对本基金净值影响显著。`,
      keywords: ["费城半导体指数", "芯片股", "半导体板块"],
      themes: ["semiconductor"],
    });
  }
  const netW = groupWeight(INTERNET_HOLDING_NAMES, INTERNET_TICKERS);
  if (netW >= 10 && chipW < 8) {
    factors.push({
      name: "大型科技/互联网平台暴露",
      detail: `前十大持仓中大型科技与互联网平台公司合计占净值约 ${netW.toFixed(1)}%，其财报季表现与监管动态对净值影响较大。`,
      keywords: ["美股科技股", "互联网巨头财报"],
      themes: ["us-tech"],
    });
  }
  if (f.concentration != null && f.concentration >= 25) {
    factors.push({
      name: "持仓集中度",
      detail: `前十大重仓合计占净值 ${f.concentration.toFixed(1)}%，集中度较高，少数重仓股的涨跌即可显著影响净值。`,
      keywords: [],
      themes: [],
    });
  }
  if (cat === "qdii") {
    factors.push(
      {
        name: "美股大盘（纳斯达克 / 标普 500）",
        detail: "本基金主要投资海外市场，美股三大指数的整体涨跌是净值的系统性驱动。",
        keywords: ["纳斯达克指数", "标普500指数", "美股收盘"],
        themes: ["us-tech"],
      },
      {
        name: "美联储利率预期",
        detail: "美联储降息/加息预期影响全球成长股估值与美元流动性，进而影响海外权益资产定价。",
        keywords: ["美联储", "降息预期", "鲍威尔"],
        themes: ["fed-rates"],
      },
      {
        name: "美元兑人民币汇率",
        detail: "本基金以人民币计价投资美元资产，汇率波动会直接增厚或侵蚀人民币份额的净值。",
        keywords: ["美元兑人民币", "人民币汇率", "美元指数"],
        themes: ["usd-fx"],
      },
      {
        name: "重仓公司财报季",
        detail: "重仓美股公司财报与业绩指引公布期，个股单日大幅波动的概率上升，净值波动通常同步放大。",
        keywords: tops.map((h) => `${h.name} 财报`),
        themes: ["us-tech"],
      },
    );
  } else if (cat === "bond") {
    factors.push(
      {
        name: "10 年期国债收益率",
        detail: "债券价格与收益率反向变动：国债收益率下行时存量债券价格上涨，本基金净值受益；收益率上行则承压。",
        keywords: ["10年期国债收益率", "国债收益率"],
        themes: ["gov-bond"],
      },
      {
        name: "央行货币政策与公开市场操作",
        detail: "降准降息、逆回购与 MLF 操作决定资金价格中枢，是债券牛熊的核心驱动。",
        keywords: ["央行", "公开市场操作", "逆回购", "MLF", "降准"],
        themes: ["monetary-policy"],
      },
      {
        name: "信用债评级与违约事件",
        detail: "本基金持有信用债，发行主体评级下调或违约事件会直接冲击相关持仓估值，并可能引发同类资产抛售。",
        keywords: ["信用债", "评级下调", "债券违约", "城投债"],
        themes: ["credit"],
      },
      {
        name: "银行间资金面",
        detail: "月末、季末及缴税期资金面收紧会推高短端利率，短债与纯债基金的收益率和净值都会受影响。",
        keywords: ["资金面", "DR007", "银行间", "缴税期"],
        themes: ["money-market"],
      },
    );
  } else if (cat === "money") {
    factors.push(
      {
        name: "货币市场利率",
        detail: "同业存单与回购利率决定货币基金可配置资产的收益率水平，资金面松紧直接影响七日年化。",
        keywords: ["同业存单", "资金面", "货币市场利率"],
        themes: ["money-market"],
      },
      {
        name: "央行公开市场操作",
        detail: "逆回购投放与到期量反映央行态度，季末/年末的操作节奏对货基收益影响明显。",
        keywords: ["央行", "逆回购", "公开市场操作"],
        themes: ["monetary-policy"],
      },
    );
  } else if (cat === "aequity") {
    const sectorHint = /医药|医疗|生物/.test(f.name)
      ? "医药"
      : /科技|芯片|半导体|电子/.test(f.name)
        ? "科技"
        : /消费|白酒|食品/.test(f.name)
          ? "消费"
          : /新能源|光伏|锂电|汽车/.test(f.name)
            ? "新能源"
            : /金融|银行|证券/.test(f.name)
              ? "金融"
              : null;
    const sectorTheme =
      sectorHint === "医药"
        ? "pharma"
        : sectorHint === "科技"
          ? "tech"
          : sectorHint === "消费"
            ? "consumer"
            : sectorHint === "新能源"
              ? "new-energy"
              : sectorHint === "金融"
                ? "finance"
                : null;
    factors.push(
      {
        name: "A股宽基指数（沪深 300 / 中证 500）",
        detail: "本基金主要投资 A 股，宽基指数走势与市场风险偏好是净值的系统性驱动。",
        keywords: ["沪深300", "A股", "上证指数"],
        themes: ["a-share"],
      },
      ...(sectorHint && sectorTheme
        ? [{
            name: `${sectorHint}行业政策与景气度`,
            detail: `基金名称显示其聚焦${sectorHint}方向，行业政策、招标集采与景气数据会直接影响重仓板块估值。`,
            keywords: [`${sectorHint}行业`, `${sectorHint}政策`],
            themes: [sectorTheme],
          }]
        : []),
      {
        name: "市场流动性与北向资金",
        detail: "两市成交额与北向资金流向反映增量资金态度，流动性收缩时权益资产普遍承压。",
        keywords: ["北向资金", "两市成交额", "A股流动性"],
        themes: ["a-share"],
      },
    );
  } else {
    factors.push({
      name: "权益与债券市场大势",
      detail: "本基金的净值主要随其配置的权益、债券等底层资产的整体行情波动。",
      keywords: ["A股", "债券市场", "基金"],
      themes: ["a-share", "gov-bond"],
    });
  }
  return { category: cat, factors };
}

// ---------------------------------------------------------------------------
// research-task plumbing (views / statements / news are collected by spawned
// research tasks and written back through the save actions — never invented)
// ---------------------------------------------------------------------------

const WATCH_FUND_CODES = ["006373", "270023", "485119", "007520", "016527"];

interface PriorityManager {
  id: string;
  name: string;
  company: string;
  repCode: string;
  repName: string;
  deep: boolean; // deep = also extract periodic-report outlook excerpts
}

async function priorityManagers(ctx: Ctx): Promise<PriorityManager[]> {
  const managers = (await loadManagerIndex(ctx)).data;
  const byId = new Map(managers.map((m) => [m.id, m]));
  const picked = new Map<string, PriorityManager>();
  for (const code of WATCH_FUND_CODES) {
    try {
      const det = (await loadFundDetail(ctx, code)).data;
      for (const mg of det.managers) {
        const full = byId.get(mg.id);
        if (full && !picked.has(full.id)) {
          picked.set(full.id, {
            id: full.id,
            name: full.name,
            company: full.company,
            repCode: full.repCode,
            repName: full.repName,
            deep: true,
          });
        }
      }
    } catch {
      // skip fund if detail fetch fails
    }
  }
  try {
    const rank = await loadRanking(ctx, "all", "1nzf", 100);
    const fm = fundManagerMap(managers);
    const seen = new Set<string>();
    for (const row of rank.data.rows) {
      if (picked.size >= 16) break;
      const mg = fm.get(row.code);
      if (!mg || seen.has(mg.id)) continue;
      seen.add(mg.id);
      const full = byId.get(mg.id);
      if (full && !picked.has(full.id)) {
        picked.set(full.id, {
          id: full.id,
          name: full.name,
          company: full.company,
          repCode: full.repCode,
          repName: full.repName,
          deep: false,
        });
      }
    }
  } catch {
    // leaders are a bonus layer; watch managers already cover the core
  }
  return [...picked.values()];
}

const MEDIA_RULES =
  "来源仅限主流财经媒体与基金公司官方渠道：中国证券报、上海证券报、证券时报、证券日报、第一财经、21世纪经济报道、界面新闻、财联社、每日经济新闻、经济观察报、新华社、Reuters、基金公司官网或官方公众号公开稿。";

function managerTaskMessage(list: PriorityManager[]): string {
  const lines = list
    .map(
      (m) =>
        `- id=${m.id}｜${m.name}｜${m.company}｜代表基金 ${m.repCode} ${m.repName}${m.deep ? "｜★需做报告展望摘录" : ""}`,
    )
    .join("\n");
  return [
    "你是一名严谨的财经资料检索员，为「基金对比平台」更新基金经理的公开观点与定期报告展望资料。平台 artifact slug：ji-jin-dui-bi-ping-tai-2。每处理完一位经理，调用该 artifact 的 saveManagerInsights 动作保存（参数见动作 schema）。",
    "",
    "## 本次要处理的经理",
    lines,
    "",
    "## 任务一：观点动态（每位经理都要做）",
    "用网页检索该经理近 12 个月（优先近 6 个月）的公开采访、论坛/峰会发言、署名文章或媒体报道中表达的观点。",
    MEDIA_RULES,
    "每条必须先打开原文页面核对内容后才可收录，字段：date（发布日期，YYYY-MM-DD）、source（媒体名称）、title（原文标题，照抄）、summary（1-2 句忠实转述其核心观点，不得改变原意、不得把媒体转述写成经理原话）、url（原文链接）、quote（仅当能从原文逐字摘录经理本人的一句话时才填，必须与原文完全一致；否则留空/不填）。",
    "严禁编造：检索不到可靠报道的经理就跳过其观点部分，不要凑数、不要用其他经理的话冒充。每位经理最多 4 条，按时间取最新。",
    "",
    "## 任务二：定期报告展望摘录（仅对标注 ★ 的经理）",
    "先调用该 artifact 的 getFundReports 动作（参数 {code: 代表基金代码}）取得该基金最新一期定期报告（季报/半年报/年报）与官方 PDF 链接；打开 PDF 全文，找到基金经理论述投资策略、运作分析与未来展望的章节（季报常见为「报告期内基金的投资策略和运作分析」；年报/半年报常见为「管理人对宏观经济、证券市场及行业走势的简要展望」或运作分析章节），从中摘录关于未来安排与展望的核心内容 100-200 字：必须是原文连续片段的忠实摘录（可截取连续段落），不得改写拼接、不得加入自己的总结。",
    "字段：fundCode、fundName、kind（季度报告/半年度报告/年度报告）、period（报告的 period 字段，如「2026 年第 3 季度」）、date（报告 publishDate）、excerpt（摘录原文）、section（章节名）、sourceUrl（PDF 链接）。读不到 PDF 全文就跳过该经理的任务二，不要编造摘录。",
    "",
    "## 保存与汇报",
    "每位经理处理完调用一次 saveManagerInsights：{managerId, managerName, views: [...], statements: [...]}（没有收录到的数组传空数组）。",
    "保存后必须再调用一次 markManagerSearched 回写覆盖终态：{managerId, managerName, viewsFound: 本次是否收录到至少 1 条观点（或该经理此前已有收录）, statementsFound: 本次是否取得报告展望摘录（或此前已有收录）；若该经理不要求做报告摘录，statementsFound 传 null}。检索过但确实没有公开报道时 viewsFound 传 false——这是如实结论，平台会标注「已检索，暂无公开报道收录」，不要为了让它为 true 而编造内容。",
    "全部完成后简要汇报每位经理收录的观点条数与是否取得报告摘录。",
  ].join("\n");
}

function fundNewsTaskMessage(
  funds: { code: string; name: string; type: string | null; keywords: string[] }[],
): string {
  const blocks = funds
    .map(
      (f) =>
        `### ${f.code} ${f.name}（类型：${f.type ?? "未知"})\n检索关键词（围绕这些因子找新闻）：${[...new Set(f.keywords)].join("、")}`,
    )
    .join("\n\n");
  return [
    "你是一名严谨的财经新闻检索员，为「基金对比平台」更新每只基金的「相关新闻」。平台 artifact slug：ji-jin-dui-bi-ping-tai-2。每处理完一只基金，调用该 artifact 的 saveFundNews 动作保存（参数 {code, items}）。",
    "",
    "## 待处理基金与检索因子",
    blocks,
    "",
    "## 规则",
    "只检索与该基金上述因子直接相关的近期新闻（近 30 天，优先近 14 天）。来源仅限公开财经媒体与通讯社：财联社、第一财经、证券时报、证券日报、界面新闻、每日经济新闻、21世纪经济报道、中国证券报、上海证券报、新华社、Reuters 等。",
    "每条必须先打开原文核对后才可收录，字段：date（YYYY-MM-DD）、source（媒体名）、title（原文标题，照抄）、url（原文链接）、relation（一句话说明这条新闻与本基金的关联，必须落到该基金的真实持仓或类型上，例如「本基金重仓 AMD、英伟达等芯片股，芯片股大跌直接拖累净值」；债券基金的新闻只能关联利率、货币政策、信用债等因子）。",
    "类型必须对版：债券基金绝不收录美股/科技股新闻，QDII 权益基金不收录国内债市新闻。匹配不到真实新闻就传空数组，严禁编造标题、日期或内容。每只基金最多 6 条，按时间取最新。",
    "全部完成后简要汇报每只基金收录条数。",
  ].join("\n");
}

async function spawnManagerInsightsTask(
  ctx: Ctx,
  list: PriorityManager[],
  dedupeKey: string,
): Promise<boolean> {
  if (list.length === 0) return false;
  const res = await ctx.agent.spawnTask(managerTaskMessage(list), {
    expectsAction: "saveManagerInsights",
    dedupeKey,
  });
  return res.ok;
}

async function spawnFundNewsTask(
  ctx: Ctx,
  codes: string[],
  dedupeKey: string,
): Promise<boolean> {
  const funds: { code: string; name: string; type: string | null; keywords: string[] }[] = [];
  for (const code of codes) {
    try {
      const det = (await loadFundDetail(ctx, code)).data;
      const { factors } = computeFactors(det);
      funds.push({
        code,
        name: det.name,
        type: det.type,
        keywords: factors.flatMap((x) => x.keywords),
      });
    } catch {
      // skip funds whose detail cannot be loaded
    }
  }
  if (funds.length === 0) return false;
  const res = await ctx.agent.spawnTask(fundNewsTaskMessage(funds), {
    expectsAction: "saveFundNews",
    dedupeKey,
  });
  return res.ok;
}

function themeNewsTaskMessage(themes: string[]): string {
  const blocks = themes
    .map((t) => {
      const meta = NEWS_THEMES[t];
      return `- theme=${t}｜${meta?.label ?? t}｜检索方向：${meta?.searchHints ?? t}`;
    })
    .join("\n");
  return [
    "你是一名严谨的财经新闻检索员，为「基金对比平台」更新「因子新闻池」：新闻按影响因子主题统一收录一次，再映射到所有受该因子影响的基金页面。平台 artifact slug：ji-jin-dui-bi-ping-tai-2。每个主题处理完调用该 artifact 的 saveThemeNews 动作保存（参数 {theme, items}）。",
    "",
    "## 本次要更新的主题",
    blocks,
    "",
    "## 规则",
    "只检索与该主题直接相关的近期新闻（近 14 天，优先近 7 天）。来源仅限公开财经媒体与通讯社：财联社、第一财经、证券时报、证券日报、界面新闻、每日经济新闻、21世纪经济报道、中国证券报、上海证券报、新华社、Reuters 等。",
    "每条必须先打开原文核对后才可收录，字段：date（YYYY-MM-DD）、source（媒体名）、title（原文标题，照抄）、url（原文链接）。主题必须对版：债券类主题（gov-bond / monetary-policy / credit / money-market）只收利率、货币政策、信用债、资金面新闻，绝不收美股科技新闻；美股类主题（us-tech / semiconductor / fed-rates / usd-fx）只收海外市场新闻。",
    "每个主题最多 5 条，按时间取最新；匹配不到真实新闻就传空数组，严禁编造标题、日期或内容。",
    "全部完成后简要汇报每个主题收录条数。",
  ].join("\n");
}

async function spawnThemeNewsTask(
  ctx: Ctx,
  themes: string[],
  dedupeKey: string,
): Promise<boolean> {
  const valid = themes.filter((t) => NEWS_THEMES[t]);
  if (valid.length === 0) return false;
  const res = await ctx.agent.spawnTask(themeNewsTaskMessage(valid), {
    expectsAction: "saveThemeNews",
    dedupeKey,
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// full-market coverage rollout (ledger + daily batches)
// ---------------------------------------------------------------------------

function parseScaleYi(scale: string): number {
  const m = scale.replace(/,/g, "").match(/([\d.]+)/);
  return m ? Number(m[1]) || 0 : 0;
}

async function upsertCoverage(
  ctx: Ctx,
  managerId: string,
  managerName: string,
  patch: { viewsStatus?: string; statementsStatus?: string; batchAttemptedAt?: number },
) {
  const db = ctx.db<typeof schema>();
  const now = Date.now();
  await db
    .insert(schema.managerCoverage)
    .values({
      managerId,
      managerName,
      viewsStatus: patch.viewsStatus ?? "pending",
      statementsStatus: patch.statementsStatus ?? "pending",
      batchAttemptedAt: patch.batchAttemptedAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.managerCoverage.managerId,
      set: {
        managerName,
        ...(patch.viewsStatus ? { viewsStatus: patch.viewsStatus } : {}),
        ...(patch.statementsStatus ? { statementsStatus: patch.statementsStatus } : {}),
        ...(patch.batchAttemptedAt != null
          ? { batchAttemptedAt: patch.batchAttemptedAt }
          : {}),
        updatedAt: now,
      },
    });
}

// Next batch of managers for the daily full-coverage rollout: watchlist and
// leaderboard managers first (via priorityManagers), then everyone else by
// managed scale (largest first). Managers whose views already reached a
// terminal state (has_views / searched_none) are skipped; a manager whose
// last batch attempt was < 20h ago is also skipped so a stalled task cannot
// starve the queue.
async function nextCoverageBatch(
  ctx: Ctx,
  size: number,
): Promise<PriorityManager[]> {
  const db = ctx.db<typeof schema>();
  const covRows = await db.select().from(schema.managerCoverage);
  const cov = new Map(covRows.map((r) => [r.managerId, r]));
  const done = (id: string) => {
    const c = cov.get(id);
    if (!c) return false;
    if (c.viewsStatus === "has_views" || c.viewsStatus === "searched_none") return true;
    if (c.batchAttemptedAt && Date.now() - c.batchAttemptedAt < 20 * 3600 * 1000) return true;
    return false;
  };
  const out: PriorityManager[] = [];
  const seen = new Set<string>();
  const push = (m: PriorityManager) => {
    if (out.length >= size || seen.has(m.id) || done(m.id)) return;
    seen.add(m.id);
    out.push(m);
  };
  for (const m of await priorityManagers(ctx)) push({ ...m, deep: true });
  const managers = (await loadManagerIndex(ctx)).data;
  const sorted = [...managers].sort(
    (a, b) => parseScaleYi(b.scale) - parseScaleYi(a.scale) || b.tenureDays - a.tenureDays,
  );
  for (const m of sorted) {
    if (out.length >= size) break;
    push({
      id: m.id,
      name: m.name,
      company: m.company,
      repCode: m.repCode,
      repName: m.repName,
      deep: true,
    });
  }
  return out;
}

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// shared zod schemas
// ---------------------------------------------------------------------------

const fundHitSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.string(),
  managerId: z.string().nullable(),
  managerName: z.string().nullable(),
});

const mgrHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  company: z.string(),
  scale: z.string(),
  tenureDays: z.number(),
  fundCount: z.number(),
  bestReturn: z.string(),
});

const rankRowSchema = z.object({
  code: z.string(),
  name: z.string(),
  date: z.string(),
  nav: z.number().nullable(),
  accNav: z.number().nullable(),
  day: z.number().nullable(),
  w1: z.number().nullable(),
  m1: z.number().nullable(),
  m3: z.number().nullable(),
  m6: z.number().nullable(),
  y1: z.number().nullable(),
  y2: z.number().nullable(),
  y3: z.number().nullable(),
  ytd: z.number().nullable(),
  since: z.number().nullable(),
  inception: z.string(),
  fee: z.string(),
  managerId: z.string().nullable(),
  managerName: z.string().nullable(),
  type: z.string(),
});

const mgrPowerSchema = z.object({
  id: z.string(),
  name: z.string(),
  star: z.number().nullable(),
  workTime: z.string().nullable(),
  fundSize: z.string().nullable(),
  pic: z.string().nullable(),
  powerAvg: z.number().nullable(),
  powerCats: z.array(z.string()),
  powerData: z.array(z.number()),
  profitCats: z.array(z.string()),
  profitData: z.array(z.number()),
});

const fundDetailSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  company: z.string().nullable(),
  rate: z.number().nullable(),
  sourceRate: z.number().nullable(),
  syl1m: z.number().nullable(),
  syl3m: z.number().nullable(),
  syl6m: z.number().nullable(),
  syl1y: z.number().nullable(),
  maxDrawdown: z.number().nullable(),
  volatility: z.number().nullable(),
  stockPosition: z.number().nullable(),
  scaleYi: z.number().nullable(),
  scaleDate: z.string().nullable(),
  latestNav: z.number().nullable(),
  latestNavDate: z.string().nullable(),
  trend: z.array(z.object({ x: z.number(), y: z.number() })),
  holdings: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      weight: z.number().nullable(),
      market: z.string().nullable(),
      industry: z.string().nullable(),
    }),
  ),
  holdingsDate: z.string().nullable(),
  holdingsKind: z.enum(["stock", "bond"]),
  concentration: z.number().nullable(),
  periodReturns: z.object({
    day: z.number().nullable(),
    d3: z.number().nullable(),
    w1: z.number().nullable(),
    m1: z.number().nullable(),
  }),
  managers: z.array(mgrPowerSchema),
});

const FT_VALUES = ["all", "gp", "hh", "zq", "zs", "qdii", "fof"] as const;
const SC_VALUES = ["1yzf", "3yzf", "6yzf", "1nzf", "3nzf", "jnzf"] as const;

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export const Actions = {
  getHomeMeta: defineAction({
    description:
      "Returns whole-market coverage counts (funds, managers), category counts, and the latest NAV date from cached Eastmoney data.",
    request: z.object({}),
    response: z.object({
      fundCount: z.number(),
      managerCount: z.number(),
      latestNavDate: z.string().nullable(),
      indexUpdatedAt: z.string(),
      counts: z.object({
        gp: z.number().nullable(),
        hh: z.number().nullable(),
        zq: z.number().nullable(),
        zs: z.number().nullable(),
        qdii: z.number().nullable(),
        fof: z.number().nullable(),
      }),
    }),
    async handler(ctx) {
      const [funds, managers, rank] = await Promise.all([
        loadFundIndex(ctx),
        loadManagerIndex(ctx),
        loadRanking(ctx, "all", "1nzf", 5),
      ]);
      return {
        fundCount: funds.data.length,
        managerCount: managers.data.length,
        latestNavDate: rank.data.rows[0]?.date ?? null,
        indexUpdatedAt: new Date(funds.updatedAt).toISOString(),
        counts: {
          gp: rank.data.counts.gp ?? null,
          hh: rank.data.counts.hh ?? null,
          zq: rank.data.counts.zq ?? null,
          zs: rank.data.counts.zs ?? null,
          qdii: rank.data.counts.qdii ?? null,
          fof: rank.data.counts.fof ?? null,
        },
      };
    },
  }),

  searchAll: defineAction({
    description:
      "Searches the whole market: funds by code/name/pinyin and managers by exact name, using the cached Eastmoney indexes.",
    request: z.object({ query: z.string().min(1).max(40) }),
    response: z.object({
      funds: z.array(fundHitSchema),
      managers: z.array(mgrHitSchema),
      fundTotal: z.number(),
      managerTotal: z.number(),
    }),
    async handler(ctx, args) {
      const q = args.query.trim();
      const qUpper = q.toUpperCase();
      const [funds, managers] = await Promise.all([
        loadFundIndex(ctx),
        loadManagerIndex(ctx),
      ]);
      const fm = fundManagerMap(managers.data);

      const scored: { f: FundIdx; s: number }[] = [];
      for (const f of funds.data) {
        let s = -1;
        if (f.code === q) s = 100;
        else if (f.code.startsWith(q)) s = 90;
        else if (f.name.startsWith(q)) s = 80;
        else if (f.name.includes(q)) s = 70;
        else if (f.abbr.includes(qUpper) || f.pinyin.includes(qUpper)) s = 50;
        if (s >= 0) scored.push({ f, s });
      }
      scored.sort((a, b) => b.s - a.s);
      const fundHits = scored.slice(0, 15).map(({ f }) => {
        const mg = fm.get(f.code);
        return {
          code: f.code,
          name: f.name,
          type: f.type,
          managerId: mg?.id ?? null,
          managerName: mg?.name ?? null,
        };
      });

      const mgrScored: { m: MgrIdx; s: number }[] = [];
      for (const m of managers.data) {
        let s = -1;
        if (m.name === q) s = 100;
        else if (m.name.startsWith(q)) s = 80;
        else if (m.name.includes(q)) s = 70;
        else if (m.company.includes(q)) s = 30;
        if (s >= 0) mgrScored.push({ m, s });
      }
      mgrScored.sort((a, b) => b.s - a.s || b.m.tenureDays - a.m.tenureDays);
      const mgrHits = mgrScored.slice(0, 8).map(({ m }) => ({
        id: m.id,
        name: m.name,
        company: m.company,
        scale: m.scale,
        tenureDays: m.tenureDays,
        fundCount: m.fundCodes.length,
        bestReturn: m.bestReturn,
      }));

      return {
        funds: fundHits,
        managers: mgrHits,
        fundTotal: scored.length,
        managerTotal: mgrScored.length,
      };
    },
  }),

  getRanking: defineAction({
    description:
      "Returns the fund ranking table for a category (ft) and period sort (sc) from the Eastmoney ranking endpoint, with each fund's current manager attached.",
    request: z.object({
      ft: z.enum(FT_VALUES).default("all"),
      sc: z.enum(SC_VALUES).default("1nzf"),
      limit: z.number().int().min(10).max(100).default(50),
    }),
    response: z.object({
      rows: z.array(rankRowSchema),
      total: z.number(),
      asOf: z.string().nullable(),
      updatedAt: z.string(),
    }),
    async handler(ctx, args) {
      const [rank, managers, funds] = await Promise.all([
        loadRanking(ctx, args.ft, args.sc, args.limit),
        loadManagerIndex(ctx),
        loadFundIndex(ctx),
      ]);
      const fm = fundManagerMap(managers.data);
      const typeMap = new Map(funds.data.map((f) => [f.code, f.type]));
      return {
        rows: rank.data.rows.map((r) => {
          const mg = fm.get(r.code);
          return {
            ...r,
            managerId: mg?.id ?? null,
            managerName: mg?.name ?? null,
            type: typeMap.get(r.code) ?? "",
          };
        }),
        total: rank.data.total,
        asOf: rank.data.rows[0]?.date ?? null,
        updatedAt: new Date(rank.updatedAt).toISOString(),
      };
    },
  }),

  getManagerLeaders: defineAction({
    description:
      "Builds the fund-manager leaderboard: for 1y/3y it aggregates the top-ranked funds' period returns onto their current managers; for tenure it ranks by best tenure return. Methodology is returned for on-page labeling.",
    request: z.object({
      period: z.enum(["1n", "3n", "tenure"]).default("1n"),
    }),
    response: z.object({
      period: z.string(),
      asOf: z.string().nullable(),
      methodology: z.string(),
      items: z.array(
        z.object({
          managerId: z.string(),
          name: z.string(),
          company: z.string(),
          scale: z.string(),
          tenureDays: z.number(),
          fundCount: z.number(),
          bestFundCode: z.string(),
          bestFundName: z.string(),
          periodReturn: z.number().nullable(),
          topFundCount: z.number(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const managers = (await loadManagerIndex(ctx)).data;
      if (args.period === "tenure") {
        const items = [...managers]
          .map((m) => ({
            managerId: m.id,
            name: m.name,
            company: m.company,
            scale: m.scale,
            tenureDays: m.tenureDays,
            fundCount: m.fundCodes.length,
            bestFundCode: m.repCode,
            bestFundName: m.repName,
            periodReturn: num(m.bestReturn.replace("%", "")),
            topFundCount: 0,
          }))
          .filter((x) => x.periodReturn != null)
          .sort((a, b) => (b.periodReturn ?? 0) - (a.periodReturn ?? 0))
          .slice(0, 30);
        return {
          period: args.period,
          asOf: null,
          methodology:
            "按基金经理任期最佳回报排序，数据来源：天天基金（东方财富）基金经理公开档案",
          items,
        };
      }
      const sc = args.period === "1n" ? "1nzf" : "3nzf";
      const rank = await loadRanking(ctx, "all", sc, 100);
      const fm = fundManagerMap(managers);
      const byId = new Map(managers.map((m) => [m.id, m]));
      const agg = new Map<
        string,
        { best: RankRow; bestVal: number; count: number }
      >();
      for (const row of rank.data.rows) {
        const val = args.period === "1n" ? row.y1 : row.y3;
        if (val == null) continue;
        const mg = fm.get(row.code);
        if (!mg) continue;
        const cur = agg.get(mg.id);
        if (!cur) agg.set(mg.id, { best: row, bestVal: val, count: 1 });
        else {
          cur.count++;
          if (val > cur.bestVal) {
            cur.best = row;
            cur.bestVal = val;
          }
        }
      }
      const items = [...agg.entries()]
        .map(([id, v]) => {
          const m = byId.get(id);
          return {
            managerId: id,
            name: m?.name ?? "",
            company: m?.company ?? "",
            scale: m?.scale ?? "",
            tenureDays: m?.tenureDays ?? 0,
            fundCount: m?.fundCodes.length ?? 0,
            bestFundCode: v.best.code,
            bestFundName: v.best.name,
            periodReturn: v.bestVal,
            topFundCount: v.count,
          };
        })
        .sort((a, b) => (b.periodReturn ?? 0) - (a.periodReturn ?? 0))
        .slice(0, 30);
      return {
        period: args.period,
        asOf: rank.data.rows[0]?.date ?? null,
        methodology: `按经理在管基金中${args.period === "1n" ? "近1年" : "近3年"}收益最高者聚合排序（取全市场收益前100只基金归因到现任经理），数据来源：天天基金（东方财富）`,
        items,
      };
    },
  }),

  getFundDetail: defineAction({
    description:
      "Returns one fund's real detail: stage returns （昨日/近3日/近1周/近1月 computed from the accumulated-NAV series, plus 近1/3/6月 and 近1年）, computed max drawdown and volatility from its NAV history, fee, top holdings with per-stock industry classification (bond holdings for pure bond funds), and current managers with Eastmoney power scores.",
    request: z.object({ code: z.string().regex(/^\d{6}$/) }),
    response: z.object({
      fund: fundDetailSchema,
      updatedAt: z.string(),
    }),
    async handler(ctx, args) {
      const { data, updatedAt } = await loadFundDetail(ctx, args.code);
      // fill type from index when suggest API had none
      if (!data.type) {
        const idx = await loadFundIndex(ctx);
        const hit = idx.data.find((f) => f.code === args.code);
        if (hit) data.type = hit.type;
      }
      return { fund: data, updatedAt: new Date(updatedAt).toISOString() };
    },
  }),

  getFundKline: defineAction({
    description:
      "Returns candlestick (K-line) data for one fund, aggregated server-side from its real accumulated NAV history: daily/weekly/monthly candles with open/high/low/close, period change %, and MA5/MA10/MA20. Funds publish one NAV per day, so candles are synthesized from NAV points (no intraday data, no volume) — the methodology is returned for on-page labeling.",
    request: z.object({
      code: z.string().regex(/^\d{6}$/),
      period: z.enum(["day", "week", "month"]).default("day"),
      range: z.enum(["6m", "1y", "3y", "5y", "all"]).default("1y"),
    }),
    response: z.object({
      candles: z.array(
        z.object({
          date: z.string(),
          open: z.number(),
          close: z.number(),
          high: z.number(),
          low: z.number(),
          changePct: z.number().nullable(),
          ma5: z.number().nullable(),
          ma10: z.number().nullable(),
          ma20: z.number().nullable(),
        }),
      ),
      totalCandles: z.number(),
      basis: z.string(),
      updatedAt: z.string(),
    }),
    async handler(ctx, args) {
      const { data: points, updatedAt } = await loadAcTrend(ctx, args.code);
      const all = buildCandles(points, args.period);
      const lastCandle = all[all.length - 1];
      let candles = all;
      if (args.range !== "all" && lastCandle) {
        const months =
          args.range === "6m" ? 6 : args.range === "1y" ? 12 : args.range === "3y" ? 36 : 60;
        const end = new Date(`${lastCandle.date}T00:00:00Z`);
        end.setUTCMonth(end.getUTCMonth() - months);
        const cutoff = end.toISOString().slice(0, 10);
        candles = all.filter((c) => c.date >= cutoff);
      }
      // cap transport/rendering cost on very long daily histories
      if (candles.length > 2000) candles = candles.slice(-2000);
      return {
        candles,
        totalCandles: all.length,
        basis:
          "由天天基金累计净值序列合成：日K 开=上一交易日净值、收=当日净值；周/月K 开=期内首日净值、收=期内末日净值、高/低=期内最高/最低净值。基金每日仅公布一个净值，无盘中价与成交量。",
        updatedAt: new Date(updatedAt).toISOString(),
      };
    },
  }),

  getFundBenchmarks: defineAction({
    description:
      "Compares one fund against the four major market indices （上证指数/沪深300/纳斯达克100/标普500）: period returns and excess returns computed from the fund's accumulated-NAV series vs real Eastmoney index daily closes aligned by calendar date, calendar-year win/loss per index with consecutive-year beat streaks, deterministic analysis sentences, and a normalized (rebased to 100 at fund start) overlay series for charting.",
    request: z.object({ code: z.string().regex(/^\d{6}$/) }),
    response: z.object({
      fundStartDate: z.string().nullable(),
      fundLatestDate: z.string().nullable(),
      isBondOrMoney: z.boolean(),
      methodology: z.string(),
      benchmarks: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          short: z.string(),
          latestClose: z.number().nullable(),
          latestDate: z.string().nullable(),
          periods: z.array(
            z.object({
              key: z.string(),
              label: z.string(),
              fund: z.number().nullable(),
              index: z.number().nullable(),
              excess: z.number().nullable(),
            }),
          ),
          sinceStart: z.object({
            fund: z.number().nullable(),
            index: z.number().nullable(),
            excess: z.number().nullable(),
            startDate: z.string(),
          }),
          years: z.array(
            z.object({
              year: z.number(),
              fund: z.number().nullable(),
              index: z.number().nullable(),
              excess: z.number().nullable(),
              beat: z.boolean().nullable(),
              complete: z.boolean(),
              full: z.boolean(),
            }),
          ),
          beatStreak: z.number(),
          longestBeatStreak: z.number(),
          yearsBeaten: z.number(),
          yearsCompared: z.number(),
          insights: z.array(z.string()),
        }),
      ),
      series: z.array(
        z.object({
          date: z.string(),
          fund: z.number(),
          sh: z.number().nullable(),
          hs300: z.number().nullable(),
          ndx: z.number().nullable(),
          spx: z.number().nullable(),
        }),
      ),
      updatedAt: z.string(),
    }),
    async handler(ctx, args) {
      const [detail, ac] = await Promise.all([
        loadFundDetail(ctx, args.code),
        loadAcTrend(ctx, args.code),
      ]);
      const cat = fundCategoryOf(detail.data.type);
      const fundPts: FundPt[] = ac.data.map((p) => ({
        date: cstDateStr(p.x),
        y: p.y,
      }));
      const first = fundPts[0];
      const last = fundPts[fundPts.length - 1];

      const idxSeries = new Map<string, IndexPoint[]>();
      let latestIdxAt = ac.updatedAt;
      for (const def of BENCHMARKS) {
        try {
          const r = await loadIndexSeries(ctx, def);
          idxSeries.set(def.key, r.data);
          if (r.updatedAt > latestIdxAt) latestIdxAt = r.updatedAt;
        } catch {
          idxSeries.set(def.key, []);
        }
      }

      const yearRets = fundYearReturns(fundPts);

      const benchmarks = BENCHMARKS.map((def) => {
        const idx = idxSeries.get(def.key) ?? [];
        const idxLast = idx[idx.length - 1];
        const idxEndAtFund = last ? atOrBeforeDate(idx, last.date) : undefined;
        const periods = BENCH_PERIODS.map((bp) => {
          if (!first || !last || dateDiffDays(first.date, last.date) < bp.days - 5) {
            return { key: bp.key, label: bp.label, fund: null, index: null, excess: null };
          }
          const startDate = shiftDate(last.date, -bp.days);
          const fundRet = retBetween(atOrBeforeDate(fundPts, startDate), last);
          const idxRet = indexRetBetween(
            atOrBeforeDate(idx, startDate),
            idxEndAtFund,
          );
          return {
            key: bp.key,
            label: bp.label,
            fund: fundRet,
            index: idxRet,
            excess:
              fundRet != null && idxRet != null ? round2(fundRet - idxRet) : null,
          };
        });
        const sinceFund =
          first && last ? retBetween(first, last) : null;
        const sinceIdx =
          first && last
            ? indexRetBetween(atOrBeforeDate(idx, first.date), idxEndAtFund)
            : null;
        const sinceStart = {
          fund: sinceFund,
          index: sinceIdx,
          excess:
            sinceFund != null && sinceIdx != null
              ? round2(sinceFund - sinceIdx)
              : null,
          startDate: first?.date ?? "",
        };
        const years = yearRets
          .map((yr) => {
            const iRet = indexRetBetween(
              atOrBeforeDate(idx, yr.startDate),
              atOrBeforeDate(idx, yr.endDate),
            );
            const excess = iRet != null ? round2(yr.ret - iRet) : null;
            return {
              year: yr.year,
              fund: yr.ret as number | null,
              index: iRet,
              excess,
              beat: excess != null ? excess > 0 : null,
              complete: yr.complete,
              full: yr.full,
            };
          })
          .sort((a, b) => b.year - a.year);
        const fullComplete = years
          .filter((y) => y.full && y.complete && y.beat != null)
          .sort((a, b) => b.year - a.year);
        let beatStreak = 0;
        for (const y of fullComplete) {
          if (y.beat) beatStreak++;
          else break;
        }
        let longestBeatStreak = 0;
        let run = 0;
        for (const y of [...fullComplete].sort((a, b) => a.year - b.year)) {
          run = y.beat ? run + 1 : 0;
          if (run > longestBeatStreak) longestBeatStreak = run;
        }
        const yearsCompared = fullComplete.length;
        const yearsBeaten = fullComplete.filter((y) => y.beat).length;
        return {
          key: def.key,
          name: def.name,
          short: def.short,
          latestClose: idxLast ? idxLast.close : null,
          latestDate: idxLast ? idxLast.date : null,
          periods,
          sinceStart,
          years,
          beatStreak,
          longestBeatStreak,
          yearsBeaten,
          yearsCompared,
          insights: benchInsights(
            def,
            periods,
            sinceStart,
            years,
            beatStreak,
            longestBeatStreak,
            yearsBeaten,
            yearsCompared,
          ),
        };
      });

      // normalized overlay series: fund and each index rebased to 100 at
      // the fund's first NAV point, aligned on fund NAV dates
      const series: {
        date: string;
        fund: number;
        sh: number | null;
        hs300: number | null;
        ndx: number | null;
        spx: number | null;
      }[] = [];
      if (first && first.y > 0) {
        const bases = new Map<string, number | null>();
        for (const def of BENCHMARKS) {
          const idx = idxSeries.get(def.key) ?? [];
          const base = atOrBeforeDate(idx, first.date) ?? idx[0];
          bases.set(def.key, base ? base.close : null);
        }
        const maxPts = 480;
        const step =
          fundPts.length > maxPts ? Math.ceil(fundPts.length / maxPts) : 1;
        const sampled = fundPts.filter((_, i) => i % step === 0);
        if (last && sampled[sampled.length - 1] !== last) sampled.push(last);
        const ptr = new Map<string, number>(BENCHMARKS.map((d) => [d.key, 0]));
        const lastClose = new Map<string, number | null>(
          BENCHMARKS.map((d) => [d.key, null]),
        );
        for (const p of sampled) {
          const row: (typeof series)[number] = {
            date: p.date,
            fund: round2((p.y / first.y) * 100),
            sh: null,
            hs300: null,
            ndx: null,
            spx: null,
          };
          for (const def of BENCHMARKS) {
            const idx = idxSeries.get(def.key) ?? [];
            let i = ptr.get(def.key) ?? 0;
            while (i < idx.length && (idx[i]?.date ?? "") <= p.date) {
              lastClose.set(def.key, idx[i]?.close ?? null);
              i++;
            }
            ptr.set(def.key, i);
            const base = bases.get(def.key);
            const lc = lastClose.get(def.key);
            const v =
              base != null && base > 0 && lc != null
                ? round2((lc / base) * 100)
                : null;
            if (def.key === "sh") row.sh = v;
            else if (def.key === "hs300") row.hs300 = v;
            else if (def.key === "ndx") row.ndx = v;
            else if (def.key === "spx") row.spx = v;
          }
          series.push(row);
        }
      }

      return {
        fundStartDate: first?.date ?? null,
        fundLatestDate: last?.date ?? null,
        isBondOrMoney: cat === "bond" || cat === "money",
        methodology:
          "基金涨跌按累计净值（复权）计算，指数按东方财富行情日收盘价计算，两者按日历日期对齐（取目标日期当日或之前最近一个交易日收盘）。「纳指」为东方财富纳斯达克指数序列（NDX，纳斯达克100）。指数均为价格指数，不含成分股分红再投资，与基金净值口径不完全一致，对比仅供参考。",
        benchmarks,
        series,
        updatedAt: new Date(latestIdxAt).toISOString(),
      };
    },
  }),

  getManagerDetail: defineAction({
    description:
      "Returns a manager's profile: bio from the public manager page, tenure/scale from the manager index, power scores from the representative fund, and the full list of funds under management.",
    request: z.object({ id: z.string().min(1).max(20) }),
    response: z.object({
      manager: z.object({
        id: z.string(),
        name: z.string(),
        company: z.string(),
        scale: z.string(),
        tenureDays: z.number(),
        bestReturn: z.string(),
        repCode: z.string(),
        repName: z.string(),
        bio: z.string().nullable(),
        star: z.number().nullable(),
        workTime: z.string().nullable(),
        powerAvg: z.number().nullable(),
        powerCats: z.array(z.string()),
        powerData: z.array(z.number()),
        profitCats: z.array(z.string()),
        profitData: z.array(z.number()),
        repMetrics: z.object({
          maxDrawdown: z.number().nullable(),
          volatility: z.number().nullable(),
          stockPosition: z.number().nullable(),
          concentration: z.number().nullable(),
          syl1y: z.number().nullable(),
          scaleYi: z.number().nullable(),
        }),
        funds: z.array(
          z.object({ code: z.string(), name: z.string(), type: z.string() }),
        ),
      }),
    }),
    async handler(ctx, args) {
      const [managers, funds] = await Promise.all([
        loadManagerIndex(ctx),
        loadFundIndex(ctx),
      ]);
      const m = managers.data.find((x) => x.id === args.id);
      if (!m) throw new Error("未找到该基金经理");
      const typeMap = new Map(funds.data.map((f) => [f.code, f.type]));
      const bio = await loadManagerBio(ctx, m.id);

      let power: MgrPower | null = null;
      let repMetrics = {
        maxDrawdown: null as number | null,
        volatility: null as number | null,
        stockPosition: null as number | null,
        concentration: null as number | null,
        syl1y: null as number | null,
        scaleYi: null as number | null,
      };
      if (m.repCode) {
        try {
          const det = (await loadFundDetail(ctx, m.repCode)).data;
          power = det.managers.find((x) => x.id === m.id) ?? det.managers[0] ?? null;
          repMetrics = {
            maxDrawdown: det.maxDrawdown,
            volatility: det.volatility,
            stockPosition: det.stockPosition,
            concentration: det.concentration,
            syl1y: det.syl1y,
            scaleYi: det.scaleYi,
          };
        } catch {
          // keep nulls
        }
      }

      return {
        manager: {
          id: m.id,
          name: m.name,
          company: m.company,
          scale: m.scale,
          tenureDays: m.tenureDays,
          bestReturn: m.bestReturn,
          repCode: m.repCode,
          repName: m.repName,
          bio,
          star: power?.star ?? null,
          workTime: power?.workTime ?? null,
          powerAvg: power?.powerAvg ?? null,
          powerCats: power?.powerCats ?? [],
          powerData: power?.powerData ?? [],
          profitCats: power?.profitCats ?? [],
          profitData: power?.profitData ?? [],
          repMetrics,
          funds: m.fundCodes.map((code, i) => ({
            code,
            name: m.fundNames[i] ?? code,
            type: typeMap.get(code) ?? "",
          })),
        },
      };
    },
  }),

  getFundReports: defineAction({
    description:
      "Returns a fund's official periodic reports (quarterly / semi-annual / annual) from Eastmoney F10 announcements, with publish dates and official PDF links.",
    request: z.object({ code: z.string().regex(/^\d{6}$/) }),
    response: z.object({
      reports: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          kind: z.string(),
          period: z.string(),
          publishDate: z.string(),
          pdfUrl: z.string(),
          pageUrl: z.string(),
        }),
      ),
      updatedAt: z.string(),
    }),
    async handler(ctx, args) {
      const { data, updatedAt } = await loadFundReports(ctx, args.code);
      return { reports: data, updatedAt: new Date(updatedAt).toISOString() };
    },
  }),

  getManagerInsights: defineAction({
    description:
      "Returns a manager's collected public views (interviews/speeches with source links) and periodic-report outlook excerpts stored by the research pipeline. Empty arrays mean nothing has been collected yet — never fabricated.",
    request: z.object({ id: z.string().min(1).max(20) }),
    response: z.object({
      views: z.array(
        z.object({
          title: z.string(),
          source: z.string(),
          url: z.string(),
          date: z.string(),
          summary: z.string(),
          quote: z.string().nullable(),
        }),
      ),
      statements: z.array(
        z.object({
          fundCode: z.string(),
          fundName: z.string(),
          kind: z.string(),
          period: z.string(),
          date: z.string(),
          excerpt: z.string(),
          section: z.string(),
          sourceUrl: z.string(),
        }),
      ),
      updatedAt: z.string().nullable(),
      viewsStatus: z.string(),
      statementsStatus: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [vRows, sRows, covRows] = await Promise.all([
        db
          .select()
          .from(schema.managerViews)
          .where(eq(schema.managerViews.managerId, args.id)),
        db
          .select()
          .from(schema.managerStatements)
          .where(eq(schema.managerStatements.managerId, args.id)),
        db
          .select()
          .from(schema.managerCoverage)
          .where(eq(schema.managerCoverage.managerId, args.id)),
      ]);
      const views = [...vRows]
        .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate))
        .slice(0, 20)
        .map((r) => ({
          title: r.title,
          source: r.source,
          url: r.url,
          date: r.publishedDate,
          summary: r.summary,
          quote: r.quote,
        }));
      const statements = [...sRows]
        .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate))
        .slice(0, 10)
        .map((r) => ({
          fundCode: r.fundCode,
          fundName: r.fundName,
          kind: r.kind,
          period: r.periodLabel,
          date: r.publishedDate,
          excerpt: r.excerpt,
          section: r.section,
          sourceUrl: r.sourceUrl,
        }));
      const last = Math.max(
        0,
        ...vRows.map((r) => r.collectedAt),
        ...sRows.map((r) => r.collectedAt),
      );
      const cov = covRows[0];
      return {
        views,
        statements,
        updatedAt: last > 0 ? new Date(last).toISOString() : null,
        viewsStatus:
          views.length > 0 ? "has_views" : (cov?.viewsStatus ?? "pending"),
        statementsStatus:
          statements.length > 0
            ? "has_excerpt"
            : (cov?.statementsStatus ?? "pending"),
      };
    },
  }),

  saveManagerInsights: defineAction({
    description:
      "Saves researched public views and periodic-report outlook excerpts for one manager. Called by the research task; every item must carry a real source URL, duplicates are ignored.",
    request: z.object({
      managerId: z.string().min(1).max(20),
      managerName: z.string().min(1).max(40),
      views: z
        .array(
          z.object({
            title: z.string().min(4).max(200),
            source: z.string().min(2).max(60),
            url: z.string().url().max(1000),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            summary: z.string().min(10).max(400),
            quote: z.string().max(300).optional(),
          }),
        )
        .max(8),
      statements: z
        .array(
          z.object({
            fundCode: z.string().regex(/^\d{6}$/),
            fundName: z.string().min(2).max(80),
            kind: z.enum(["季度报告", "半年度报告", "年度报告"]),
            period: z.string().min(4).max(30),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            excerpt: z.string().min(50).max(600),
            section: z.string().min(2).max(80),
            sourceUrl: z.string().url().max(1000),
          }),
        )
        .max(4),
    }),
    response: z.object({
      savedViews: z.number(),
      savedStatements: z.number(),
    }),
    async handler(ctx, args) {
      if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
      const db = ctx.db<typeof schema>();
      const now = Date.now();
      const existingUrls = new Set(
        (
          await db
            .select()
            .from(schema.managerViews)
            .where(eq(schema.managerViews.managerId, args.managerId))
        ).map((r) => r.url),
      );
      let savedViews = 0;
      for (const v of args.views) {
        if (existingUrls.has(v.url)) continue;
        existingUrls.add(v.url);
        await db.insert(schema.managerViews).values({
          managerId: args.managerId,
          managerName: args.managerName,
          title: v.title,
          source: v.source,
          url: v.url,
          publishedDate: v.date,
          summary: v.summary,
          quote: v.quote ?? null,
          collectedAt: now,
        });
        savedViews++;
      }
      const existingKeys = new Set(
        (
          await db
            .select()
            .from(schema.managerStatements)
            .where(eq(schema.managerStatements.managerId, args.managerId))
        ).map((r) => `${r.fundCode}|${r.periodLabel}`),
      );
      let savedStatements = 0;
      for (const s of args.statements) {
        const key = `${s.fundCode}|${s.period}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        await db.insert(schema.managerStatements).values({
          managerId: args.managerId,
          fundCode: s.fundCode,
          fundName: s.fundName,
          kind: s.kind,
          periodLabel: s.period,
          publishedDate: s.date,
          excerpt: s.excerpt,
          section: s.section,
          sourceUrl: s.sourceUrl,
          collectedAt: now,
        });
        savedStatements++;
      }
      return { savedViews, savedStatements };
    },
  }),

  ensureManagerInsights: defineAction({
    description:
      "On-demand collection: if a manager has no stored views/statements and no recent attempt, spawns a research task for that manager only.",
    request: z.object({ id: z.string().min(1).max(20) }),
    response: z.object({
      started: z.boolean(),
      hasData: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [vRows, sRows] = await Promise.all([
        db
          .select()
          .from(schema.managerViews)
          .where(eq(schema.managerViews.managerId, args.id)),
        db
          .select()
          .from(schema.managerStatements)
          .where(eq(schema.managerStatements.managerId, args.id)),
      ]);
      const hasData = vRows.length + sRows.length > 0;
      // spawning a research task is owner-only: agent capabilities are
      // unavailable on shared pages, so guests (and shared-page owners)
      // simply see the already-collected data
      if (!isOwnerViewer(ctx)) return { started: false, hasData };
      const marker = await cacheRead(ctx, `insights_try:${args.id}`);
      if (marker && Date.now() - marker.updatedAt < 7 * 24 * 3600 * 1000) {
        return { started: false, hasData };
      }
      const managers = (await loadManagerIndex(ctx)).data;
      const m = managers.find((x) => x.id === args.id);
      if (!m) throw new Error("未找到该基金经理");
      await cacheWrite(ctx, `insights_try:${args.id}`, "1");
      const ym = new Date().toISOString().slice(0, 7);
      const started = await spawnManagerInsightsTask(
        ctx,
        [
          {
            id: m.id,
            name: m.name,
            company: m.company,
            repCode: m.repCode,
            repName: m.repName,
            deep: true,
          },
        ],
        `insights-mgr-${args.id}-${ym}`,
      ).catch(() => false);
      return { started, hasData };
    },
  }),

  refreshManagerInsights: defineAction({
    description:
      "Weekly refresh: spawns a research task that updates public views and report outlook excerpts for priority managers (watchlist managers + leaderboard leaders).",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      started: z.boolean(),
      managerCount: z.number(),
    }),
    async handler(ctx): Promise<{
      ok: true;
      started: boolean;
      managerCount: number;
    }> {
      if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
      const list = await priorityManagers(ctx);
      const started = await spawnManagerInsightsTask(
        ctx,
        list,
        `insights-weekly-${isoWeekKey(new Date())}`,
      ).catch(() => false);
      return { ok: true, started, managerCount: list.length };
    },
  }),

  getFundFactors: defineAction({
    description:
      "Computes a fund's impact factors from its real top holdings and category (QDII/bond/equity/money): holding drivers, sector exposure, and the external variables that move its NAV.",
    request: z.object({ code: z.string().regex(/^\d{6}$/) }),
    response: z.object({
      categoryLabel: z.string(),
      holdingsDate: z.string().nullable(),
      factors: z.array(z.object({ name: z.string(), detail: z.string() })),
    }),
    async handler(ctx, args) {
      const { data } = await loadFundDetail(ctx, args.code);
      const { category, factors } = computeFactors(data);
      return {
        categoryLabel: CATEGORY_LABELS[category],
        holdingsDate: data.holdingsDate,
        factors: factors.map((x) => ({ name: x.name, detail: x.detail })),
      };
    },
  }),

  getFundNews: defineAction({
    description:
      "Returns news for one fund: fund-specific items collected for this fund plus items mapped from the shared factor-theme news pool via this fund's factor profile (each pool item's relevance note is generated from the fund's own factor it matched). Empty means nothing matched yet.",
    request: z.object({ code: z.string().regex(/^\d{6}$/) }),
    response: z.object({
      items: z.array(
        z.object({
          title: z.string(),
          source: z.string(),
          url: z.string(),
          date: z.string(),
          relation: z.string(),
        }),
      ),
      updatedAt: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.fundNews)
        .where(eq(schema.fundNews.fundCode, args.code));
      const own = rows.map((r) => ({
        title: r.title,
        source: r.source,
        url: r.url,
        date: r.publishedDate,
        relation: r.relation,
        collectedAt: r.collectedAt,
      }));
      // factor-theme pool mapping: this fund's factor themes -> pool items,
      // with the relevance note generated from the fund's own matched factor
      const pooled: typeof own = [];
      let poolLast = 0;
      try {
        const det = (await loadFundDetail(ctx, args.code)).data;
        const { factors } = computeFactors(det);
        const themeFactor = new Map<string, FactorItem>();
        for (const fc of factors) {
          for (const t of fc.themes) {
            if (!themeFactor.has(t)) themeFactor.set(t, fc);
          }
        }
        if (themeFactor.size > 0) {
          const poolRows = await db.select().from(schema.themeNews);
          const seenUrl = new Set(own.map((x) => x.url));
          for (const r of poolRows) {
            const fc = themeFactor.get(r.theme);
            if (!fc || seenUrl.has(r.url)) continue;
            seenUrl.add(r.url);
            pooled.push({
              title: r.title,
              source: r.source,
              url: r.url,
              date: r.publishedDate,
              relation: `与本基金的影响因子「${fc.name}」相关：${fc.detail}`,
              collectedAt: r.collectedAt,
            });
            if (r.collectedAt > poolLast) poolLast = r.collectedAt;
          }
        }
      } catch {
        // pool mapping is best-effort; fund-specific items still returned
      }
      const items = [...own, ...pooled]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 12)
        .map(({ collectedAt: _c, ...rest }) => rest);
      const last = Math.max(0, poolLast, ...rows.map((r) => r.collectedAt));
      return {
        items,
        updatedAt: last > 0 ? new Date(last).toISOString() : null,
      };
    },
  }),

  saveFundNews: defineAction({
    description:
      "Saves researched news items matched to one fund's impact factors. Called by the research task; every item must carry a real source URL, duplicates are ignored.",
    request: z.object({
      code: z.string().regex(/^\d{6}$/),
      items: z
        .array(
          z.object({
            title: z.string().min(4).max(200),
            source: z.string().min(2).max(60),
            url: z.string().url().max(1000),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            relation: z.string().min(10).max(220),
          }),
        )
        .max(8),
    }),
    response: z.object({ saved: z.number() }),
    async handler(ctx, args) {
      if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
      const db = ctx.db<typeof schema>();
      const existing = new Set(
        (
          await db
            .select()
            .from(schema.fundNews)
            .where(eq(schema.fundNews.fundCode, args.code))
        ).map((r) => r.url),
      );
      let saved = 0;
      const now = Date.now();
      for (const it of args.items) {
        if (existing.has(it.url)) continue;
        existing.add(it.url);
        await db.insert(schema.fundNews).values({
          fundCode: args.code,
          title: it.title,
          source: it.source,
          url: it.url,
          publishedDate: it.date,
          relation: it.relation,
          collectedAt: now,
        });
        saved++;
      }
      return { saved };
    },
  }),

  ensureFundNews: defineAction({
    description:
      "On-demand news collection: if a fund's stored news is missing or older than 20h and no recent attempt exists, spawns a research task for that fund's impact factors.",
    request: z.object({ code: z.string().regex(/^\d{6}$/) }),
    response: z.object({ started: z.boolean(), fresh: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.fundNews)
        .where(eq(schema.fundNews.fundCode, args.code));
      let last = Math.max(0, ...rows.map((r) => r.collectedAt));
      let hasAny = rows.length > 0;
      // news mapped from the shared factor-theme pool counts as coverage too
      try {
        const det = (await loadFundDetail(ctx, args.code)).data;
        const { factors } = computeFactors(det);
        const themes = new Set(factors.flatMap((x) => x.themes));
        if (themes.size > 0) {
          const poolRows = await db.select().from(schema.themeNews);
          for (const r of poolRows) {
            if (!themes.has(r.theme)) continue;
            hasAny = true;
            if (r.collectedAt > last) last = r.collectedAt;
          }
        }
      } catch {
        // ignore pool check failures
      }
      const fresh = hasAny && Date.now() - last < 20 * 3600 * 1000;
      if (fresh) return { started: false, fresh };
      // owner-only: research tasks cannot be spawned from a shared page
      if (!isOwnerViewer(ctx)) return { started: false, fresh };
      const marker = await cacheRead(ctx, `fundnews_try:${args.code}`);
      if (marker && Date.now() - marker.updatedAt < 6 * 3600 * 1000) {
        return { started: false, fresh };
      }
      await cacheWrite(ctx, `fundnews_try:${args.code}`, "1");
      const day = new Date().toISOString().slice(0, 10);
      const started = await spawnFundNewsTask(
        ctx,
        [args.code],
        `fundnews-${args.code}-${day}`,
      ).catch(() => false);
      return { started, fresh };
    },
  }),

  refreshEnrichment: defineAction({
    description:
      "Kicks off both enrichment pipelines at once: manager views/report excerpts for priority managers and factor-matched news for the watchlist funds.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      managerTaskStarted: z.boolean(),
      newsTaskStarted: z.boolean(),
      themeTaskStarted: z.boolean(),
    }),
    async handler(ctx): Promise<{
      ok: true;
      managerTaskStarted: boolean;
      newsTaskStarted: boolean;
      themeTaskStarted: boolean;
    }> {
      if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
      const list = await priorityManagers(ctx);
      const managerTaskStarted = await spawnManagerInsightsTask(
        ctx,
        list,
        `insights-weekly-${isoWeekKey(new Date())}`,
      ).catch(() => false);
      const day = new Date().toISOString().slice(0, 10);
      const newsTaskStarted = await spawnFundNewsTask(
        ctx,
        WATCH_FUND_CODES,
        `fundnews-daily-${day}`,
      ).catch(() => false);
      const themeTaskStarted = await spawnThemeNewsTask(
        ctx,
        Object.keys(NEWS_THEMES),
        `theme-news-${day}`,
      ).catch(() => false);
      return { ok: true, managerTaskStarted, newsTaskStarted, themeTaskStarted };
    },
  }),

  markManagerSearched: defineAction({
    description:
      "Records a manager's enrichment terminal state after research: whether public views were found and whether a report outlook excerpt was obtained. Called by research tasks for every manager they process, including those with nothing found (an honest searched-none record, never fabricated content).",
    request: z.object({
      managerId: z.string().min(1).max(20),
      managerName: z.string().min(1).max(40),
      viewsFound: z.boolean(),
      statementsFound: z.boolean().nullable(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
      const db = ctx.db<typeof schema>();
      const [vRows, sRows] = await Promise.all([
        db
          .select()
          .from(schema.managerViews)
          .where(eq(schema.managerViews.managerId, args.managerId)),
        db
          .select()
          .from(schema.managerStatements)
          .where(eq(schema.managerStatements.managerId, args.managerId)),
      ]);
      await upsertCoverage(ctx, args.managerId, args.managerName, {
        viewsStatus:
          vRows.length > 0 || args.viewsFound ? "has_views" : "searched_none",
        ...(args.statementsFound != null
          ? {
              statementsStatus:
                sRows.length > 0 || args.statementsFound
                  ? "has_excerpt"
                  : "searched_none",
            }
          : {}),
      });
      return { ok: true };
    },
  }),

  saveThemeNews: defineAction({
    description:
      "Saves researched news items into the shared factor-theme news pool under one theme key. Called by the theme-news research task; every item must carry a real source URL, duplicates per theme are ignored.",
    request: z.object({
      theme: z.string().min(2).max(40),
      items: z
        .array(
          z.object({
            title: z.string().min(4).max(200),
            source: z.string().min(2).max(60),
            url: z.string().url().max(1000),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          }),
        )
        .max(8),
    }),
    response: z.object({ saved: z.number() }),
    async handler(ctx, args) {
      if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
      if (!NEWS_THEMES[args.theme]) throw new Error(`未知新闻主题：${args.theme}`);
      const db = ctx.db<typeof schema>();
      const existing = new Set(
        (
          await db
            .select()
            .from(schema.themeNews)
            .where(eq(schema.themeNews.theme, args.theme))
        ).map((r) => r.url),
      );
      let saved = 0;
      const now = Date.now();
      for (const it of args.items) {
        if (existing.has(it.url)) continue;
        existing.add(it.url);
        await db.insert(schema.themeNews).values({
          theme: args.theme,
          title: it.title,
          source: it.source,
          url: it.url,
          publishedDate: it.date,
          collectedAt: now,
        });
        saved++;
      }
      return { saved };
    },
  }),

  getCoverageStats: defineAction({
    description:
      "Full-market enrichment coverage progress: totals for funds and managers, how many managers have collected views / were researched with none found, how many have report outlook excerpts, factor-news pool coverage per theme, and funds with directly collected news. Used for progress reporting.",
    request: z.object({}),
    response: z.object({
      totalFunds: z.number(),
      totalManagers: z.number(),
      managersWithViews: z.number(),
      managersViewsCollected: z.number(),
      managersViewsSearchedNone: z.number(),
      managersViewsPending: z.number(),
      managersStatementsCollected: z.number(),
      managersStatementsSearchedNone: z.number(),
      managersStatementsPending: z.number(),
      fundsWithDirectNews: z.number(),
      themePool: z.array(
        z.object({
          theme: z.string(),
          label: z.string(),
          items: z.number(),
          latestDate: z.string().nullable(),
        }),
      ),
      lastBatchAt: z.string().nullable(),
      lastBatchManagers: z.array(z.string()),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const [funds, managers] = await Promise.all([
        loadFundIndex(ctx),
        loadManagerIndex(ctx),
      ]);
      const totalManagers = managers.data.length;
      const [vRows, sRows, covRows, newsRows, poolRows] = await Promise.all([
        db.select().from(schema.managerViews),
        db.select().from(schema.managerStatements),
        db.select().from(schema.managerCoverage),
        db.select().from(schema.fundNews),
        db.select().from(schema.themeNews),
      ]);
      const withViews = new Set(vRows.map((r) => r.managerId));
      const withStmt = new Set(sRows.map((r) => r.managerId));
      let vNone = 0;
      let sNone = 0;
      let vDone = 0;
      let sDone = 0;
      for (const c of covRows) {
        if (c.viewsStatus === "searched_none") vNone++;
        if (c.viewsStatus === "has_views" || c.viewsStatus === "searched_none") vDone++;
        if (c.statementsStatus === "searched_none") sNone++;
        if (c.statementsStatus === "has_excerpt" || c.statementsStatus === "searched_none") sDone++;
      }
      const themePool = Object.entries(NEWS_THEMES).map(([theme, meta]) => {
        const items = poolRows.filter((r) => r.theme === theme);
        return {
          theme,
          label: meta.label,
          items: items.length,
          latestDate:
            items.length > 0
              ? items.map((r) => r.publishedDate).sort().slice(-1)[0] ?? null
              : null,
        };
      });
      const batchState = await cacheRead(ctx, "coverage_batch_state");
      let lastBatchAt: string | null = null;
      let lastBatchManagers: string[] = [];
      if (batchState) {
        try {
          const parsed = JSON.parse(batchState.payload) as {
            at?: number;
            managers?: string[];
          };
          lastBatchAt = parsed.at ? new Date(parsed.at).toISOString() : null;
          lastBatchManagers = parsed.managers ?? [];
        } catch {
          // ignore malformed state
        }
      }
      return {
        totalFunds: funds.data.length,
        totalManagers,
        managersWithViews: withViews.size,
        managersViewsCollected: Math.max(withViews.size, vDone - vNone),
        managersViewsSearchedNone: vNone,
        managersViewsPending: Math.max(
          0,
          totalManagers - Math.max(vDone, withViews.size + vNone),
        ),
        managersStatementsCollected: withStmt.size,
        managersStatementsSearchedNone: sNone,
        managersStatementsPending: Math.max(0, totalManagers - Math.max(sDone, withStmt.size + sNone)),
        fundsWithDirectNews: new Set(newsRows.map((r) => r.fundCode)).size,
        themePool,
        lastBatchAt,
        lastBatchManagers,
      };
    },
  }),

  runCoverageBatch: defineAction({
    description:
      "Daily full-coverage batch: picks the next ~15 unprocessed managers (watchlist/leaderboard first, then by managed scale), marks them attempted, spawns one research task for their views + report outlook excerpts, and spawns the factor-theme news pool refresh. Run daily until all managers reach a terminal coverage state; afterwards it degrades to incremental theme-pool updates.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      batchSize: z.number(),
      batchManagers: z.array(z.string()),
      managerTaskStarted: z.boolean(),
      themeTaskStarted: z.boolean(),
      remainingEstimate: z.number(),
    }),
    async handler(ctx): Promise<{
      ok: true;
      batchSize: number;
      batchManagers: string[];
      managerTaskStarted: boolean;
      themeTaskStarted: boolean;
      remainingEstimate: number;
    }> {
      if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
      const batch = await nextCoverageBatch(ctx, 15);
      const now = Date.now();
      for (const m of batch) {
        await upsertCoverage(ctx, m.id, m.name, { batchAttemptedAt: now });
      }
      await cacheWrite(
        ctx,
        "coverage_batch_state",
        JSON.stringify({ at: now, managers: batch.map((m) => m.name) }),
      );
      const day = new Date().toISOString().slice(0, 10);
      let managerTaskStarted = false;
      if (batch.length > 0) {
        managerTaskStarted = await spawnManagerInsightsTask(
          ctx,
          batch,
          `coverage-batch-${day}`,
        ).catch(() => false);
      }
      const themeTaskStarted = await spawnThemeNewsTask(
        ctx,
        Object.keys(NEWS_THEMES),
        `theme-news-${day}`,
      ).catch(() => false);
      const db = ctx.db<typeof schema>();
      const covRows = await db.select().from(schema.managerCoverage);
      const managers = (await loadManagerIndex(ctx)).data;
      const doneCount = covRows.filter(
        (c) => c.viewsStatus === "has_views" || c.viewsStatus === "searched_none",
      ).length;
      return {
        ok: true,
        batchSize: batch.length,
        batchManagers: batch.map((m) => m.name),
        managerTaskStarted,
        themeTaskStarted,
        remainingEstimate: Math.max(0, managers.length - doneCount - batch.length),
      };
    },
  }),

  compareFunds: defineAction({
    description:
      "Returns full real details for 2-4 funds for the comparison view (metrics, holdings, managers with power scores).",
    request: z.object({
      codes: z.array(z.string().regex(/^\d{6}$/)).min(2).max(4),
    }),
    response: z.object({
      funds: z.array(fundDetailSchema),
    }),
    async handler(ctx, args) {
      const idx = await loadFundIndex(ctx);
      const typeMap = new Map(idx.data.map((f) => [f.code, f.type]));
      const out: FundDetail[] = [];
      for (const code of args.codes) {
        const { data } = await loadFundDetail(ctx, code);
        if (!data.type) data.type = typeMap.get(code) ?? null;
        out.push(data);
      }
      return { funds: out };
    },
  }),

  refreshData: defineAction({
    description:
      "Forces a refresh of the fund index, manager index, and headline rankings from Eastmoney; run nightly after NAV publication.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      fundCount: z.number(),
      managerCount: z.number(),
      refreshedAt: z.string(),
    }),
    async handler(ctx): Promise<{
      ok: true;
      fundCount: number;
      managerCount: number;
      refreshedAt: string;
    }> {
      const funds = await loadFundIndex(ctx, true);
      const managers = await loadManagerIndex(ctx, true);
      await loadRanking(ctx, "all", "1nzf", 50, true);
      // factor-matched news for the watchlist rides the nightly refresh;
      // agent tasks spawn only for the owner / owner schedules (the public
      // index refresh above stays available to everyone)
      try {
        if (!isOwnerViewer(ctx)) throw new Error(OWNER_ONLY_MSG);
        const day = new Date().toISOString().slice(0, 10);
        await spawnFundNewsTask(ctx, WATCH_FUND_CODES, `fundnews-daily-${day}`);
        // shared factor-theme news pool refresh (same dedupe key as the
        // daily coverage batch, so the two never double-spawn in one day)
        await spawnThemeNewsTask(ctx, Object.keys(NEWS_THEMES), `theme-news-${day}`);
      } catch {
        // news enrichment must never break the core data refresh
      }
      return {
        ok: true,
        fundCount: funds.data.length,
        managerCount: managers.data.length,
        refreshedAt: new Date().toISOString(),
      };
    },
  }),
} satisfies ActionsModule;
