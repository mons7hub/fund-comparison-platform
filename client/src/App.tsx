import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type FundDetail = ApiResponse<typeof api, "getFundDetail">["fund"];
type RankRow = ApiResponse<typeof api, "getRanking">["rows"][number];
type ManagerDetail = ApiResponse<typeof api, "getManagerDetail">["manager"];
type LeaderItem = ApiResponse<typeof api, "getManagerLeaders">["items"][number];
type SearchData = ApiResponse<typeof api, "searchAll">;
type ManagerInsights = ApiResponse<typeof api, "getManagerInsights">;
type FundFactors = ApiResponse<typeof api, "getFundFactors">;
type FundNewsData = ApiResponse<typeof api, "getFundNews">;
type FundBenchmarks = ApiResponse<typeof api, "getFundBenchmarks">;
type BenchItem = FundBenchmarks["benchmarks"][number];
type BenchSeriesRow = FundBenchmarks["series"][number];

// ---------------------------------------------------------------------------
// user investment profile (optional, stored locally in the browser)
// ---------------------------------------------------------------------------

interface Profile {
  risk: number; // 1 保守 .. 5 激进
  maxDD: number; // 最大可接受回撤 %
  sensitivity: number; // 1 不敏感 2 一般 3 很敏感
  distribution: "concentrated" | "balanced" | "diversified";
  singleCap: number; // 单只基金仓位上限 %
  horizon: "short" | "mid" | "long";
  goal: "preserve" | "steady" | "growth" | "aggressive";
}

const PROFILE_KEY = "fund-profile-v1";
const BASKET_KEY = "fund-basket-v1";

function loadProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

interface BasketItem {
  code: string;
  name: string;
}

function loadBasket(): BasketItem[] {
  try {
    const raw = localStorage.getItem(BASKET_KEY);
    return raw ? (JSON.parse(raw) as BasketItem[]) : [];
  } catch {
    return [];
  }
}

const RISK_LABELS = ["", "保守型", "稳健型", "平衡型", "成长型", "激进型"];

// ---------------------------------------------------------------------------
// theme color (user-selectable on the home page, stored locally)
// ---------------------------------------------------------------------------

interface ThemeOption {
  key: string;
  label: string;
  /** accent used in light mode */
  light: string;
  /** accent used in dark mode (brighter, for contrast on dark surfaces) */
  dark: string;
  /** text color on top of the accent, per mode */
  lightInk: string;
  darkInk: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  { key: "blue", label: "蓝色", light: "#1d6fd1", dark: "#5ea2ec", lightInk: "#ffffff", darkInk: "#08182c" },
  { key: "teal", label: "青绿", light: "#0d7a5f", dark: "#35b98a", lightInk: "#ffffff", darkInk: "#0b1512" },
  { key: "violet", label: "紫色", light: "#7c3aed", dark: "#a78bfa", lightInk: "#ffffff", darkInk: "#1c1033" },
  { key: "orange", label: "橙色", light: "#c2610a", dark: "#f0a04b", lightInk: "#ffffff", darkInk: "#2a1503" },
  { key: "red", label: "红色", light: "#c62f3b", dark: "#f0717d", lightInk: "#ffffff", darkInk: "#2c0a0e" },
];

const THEME_KEY = "fund-theme-v1";
const DEFAULT_THEME = THEME_OPTIONS[0] as ThemeOption;

function loadThemeKey(): string {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw && THEME_OPTIONS.some((o) => o.key === raw) ? raw : DEFAULT_THEME.key;
  } catch {
    return DEFAULT_THEME.key;
  }
}

function themeOption(key: string): ThemeOption {
  return THEME_OPTIONS.find((o) => o.key === key) ?? DEFAULT_THEME;
}

/** Push the chosen accent onto the :root CSS variables (overrides theme.css). */
function applyTheme(key: string) {
  const opt = themeOption(key);
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement.style;
  root.setProperty("--accent", dark ? opt.dark : opt.light);
  root.setProperty("--accent-ink", dark ? opt.darkInk : opt.lightInk);
}

function ThemePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-sm text-[var(--dim)]">主题色</span>
      {THEME_OPTIONS.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            aria-label={`主题色：${o.label}`}
            onClick={() => onChange(o.key)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${
              active
                ? "border-[var(--accent)] bg-[var(--surface2)] font-medium text-[var(--text)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
            }`}
          >
            <span
              aria-hidden="true"
              className="inline-block h-3.5 w-3.5 rounded-full"
              style={{ background: o.light }}
            />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// risk class + match score (all computed from real metrics)
// ---------------------------------------------------------------------------

function riskClass(type: string | null, volatility?: number | null): number {
  const t = type ?? "";
  let rc: number;
  if (t.includes("货币")) rc = 1;
  else if (t.includes("纯债") || t.includes("短债")) rc = 2;
  else if (t.includes("债券")) rc = t.includes("二级") || t.includes("可转") ? 3 : 2;
  else if (t.includes("偏债") || t.includes("平衡")) rc = 3;
  else if (t.includes("FOF")) rc = 3;
  else if (t.includes("偏股") || t.includes("股票") || t.includes("指数") || t.includes("QDII")) rc = 4;
  else if (t.includes("混合")) rc = 4;
  else rc = 3;
  if (volatility != null) {
    if (volatility >= 30 && rc < 5) rc += 1;
    if (volatility < 6 && rc > 2) rc -= 1;
  }
  return Math.min(5, Math.max(1, rc));
}

interface MatchResult {
  score: number;
  reasons: { good: boolean; text: string }[];
}

function detailMatch(p: Profile, f: FundDetail): MatchResult {
  let score = 100;
  const reasons: { good: boolean; text: string }[] = [];
  if (f.maxDrawdown != null) {
    if (f.maxDrawdown > p.maxDD) {
      const pen = Math.min(45, (f.maxDrawdown - p.maxDD) * 1.6);
      score -= pen;
      reasons.push({
        good: false,
        text: `历史最大回撤 ${f.maxDrawdown.toFixed(1)}%，超过你能接受的 ${p.maxDD}%`,
      });
    } else {
      reasons.push({
        good: true,
        text: `历史最大回撤 ${f.maxDrawdown.toFixed(1)}%，在你 ${p.maxDD}% 的承受线内`,
      });
    }
  }
  const rc = riskClass(f.type, f.volatility);
  if (rc > p.risk) {
    score -= 11 * (rc - p.risk);
    reasons.push({
      good: false,
      text: `这类基金的波动等级（${rc}/5）高于你的风险偏好（${p.risk}/5）`,
    });
  } else {
    reasons.push({ good: true, text: `波动等级与你的风险偏好基本合拍` });
  }
  if (f.volatility != null) {
    if (p.sensitivity === 3 && f.volatility > 22) {
      score -= 14;
      reasons.push({
        good: false,
        text: `年化波动 ${f.volatility.toFixed(1)}%，日常涨跌幅度大，你对回撤比较敏感，拿着容易焦虑`,
      });
    } else if (p.sensitivity === 3 && f.volatility > 15) {
      score -= 7;
      reasons.push({
        good: false,
        text: `年化波动 ${f.volatility.toFixed(1)}%，不算低，短期波动时要稳住`,
      });
    } else if (p.sensitivity === 1) {
      reasons.push({ good: true, text: `你对短期涨跌不敏感，它的波动对你影响不大` });
    }
  }
  if (p.horizon === "short" && rc >= 4) {
    score -= 10;
    reasons.push({
      good: false,
      text: `你计划持有不到 1 年，高波动基金短期不确定性大`,
    });
  }
  if (p.goal === "preserve" && rc >= 4) {
    score -= 10;
    reasons.push({ good: false, text: `你的目标是保值优先，这类基金进攻性偏强` });
  }
  return { score: Math.max(5, Math.min(99, Math.round(score))), reasons };
}

function listMatch(p: Profile, row: RankRow): number {
  const rc = riskClass(row.type || null);
  let score = 100 - 13 * Math.max(0, rc - p.risk);
  if (p.sensitivity === 3 && row.m1 != null && row.m1 < -3) score -= 8;
  if (p.horizon === "short" && rc >= 4) score -= 8;
  return Math.max(5, Math.min(99, Math.round(score)));
}

// ---------------------------------------------------------------------------
// style analysis from real holdings / position / volatility
// ---------------------------------------------------------------------------

function styleTags(f: FundDetail): string[] {
  const tags: string[] = [];
  if (f.stockPosition != null) {
    if (f.stockPosition >= 85) tags.push("高仓位运作");
    else if (f.stockPosition >= 60) tags.push("中高仓位");
    else if (f.stockPosition >= 30) tags.push("仓位灵活");
    else tags.push("低股票仓位");
  }
  if (f.concentration != null) {
    if (f.concentration >= 55) tags.push("持仓高度集中");
    else if (f.concentration >= 38) tags.push("持仓相对集中");
    else tags.push("持仓较分散");
  }
  if (f.volatility != null) {
    if (f.volatility >= 26) tags.push("高波动");
    else if (f.volatility >= 14) tags.push("中等波动");
    else tags.push("低波动");
  }
  const t = f.type ?? "";
  if (t.includes("QDII")) tags.push("海外配置");
  if (t.includes("指数")) tags.push("指数跟踪");
  if (t.includes("债券")) tags.push("固收打底");
  return tags;
}

function styleParagraph(f: FundDetail): string {
  const parts: string[] = [];
  if (f.stockPosition != null) {
    parts.push(
      f.stockPosition >= 80
        ? `股票仓位约 ${f.stockPosition.toFixed(0)}%，长期保持高仓位运作，不靠频繁择时躲跌，收益主要来自选股`
        : f.stockPosition >= 50
          ? `股票仓位约 ${f.stockPosition.toFixed(0)}%，仓位上有一定腾挪空间`
          : `股票仓位约 ${f.stockPosition.toFixed(0)}%，仓位偏低，组合以稳健资产打底`,
    );
  }
  if (f.holdings.length > 0 && f.concentration != null) {
    const top = f.holdings.slice(0, 3).map((h) => h.name).join("、");
    parts.push(
      `前十大重仓股合计占净值 ${f.concentration.toFixed(1)}%${
        f.concentration >= 50 ? "，集中度高，敢于重仓看好的公司" : f.concentration >= 35 ? "，集中度适中" : "，持仓相对分散，单只股票的影响有限"
      }；前三大重仓为 ${top}`,
    );
  }
  if (f.maxDrawdown != null && f.volatility != null) {
    parts.push(
      `从净值历史实算：最大回撤 ${f.maxDrawdown.toFixed(1)}%，近一年年化波动 ${f.volatility.toFixed(1)}%${
        f.volatility >= 26 ? "，弹性大、颠簸也大" : f.volatility >= 14 ? "，波动处于中等水平" : "，走势相对平稳"
      }`,
    );
  }
  if (f.managers.length > 0) {
    const m = f.managers[0];
    if (m && m.powerAvg != null) {
      parts.push(
        `东方财富对经理 ${m.name} 的综合能力评分 ${m.powerAvg.toFixed(1)} 分（经验值/收益率/抗风险/稳定性/择时五维，数据日期以来源为准）`,
      );
    }
  }
  return parts.length > 0 ? parts.join("。") + "。" : "暂无足够数据生成风格分析。";
}

// ---------------------------------------------------------------------------
// holdings breakdown: which stocks / bonds, which types, what share
// ---------------------------------------------------------------------------

type FundHolding = FundDetail["holdings"][number];

function marketLabelOf(h: FundHolding): string {
  switch (h.market) {
    case "1":
    case "0":
      return "A股";
    case "116":
      return "港股";
    case "105":
    case "106":
      return "美股";
    default:
      return h.code.length === 6 && /^\d+$/.test(h.code)
        ? "A股"
        : h.code.length === 5 && /^\d+$/.test(h.code)
          ? "港股"
          : "其他市场";
  }
}

// bond "type" is classified from the bond's own name keywords — an honest,
// labeled heuristic over the disclosed top holdings
function bondKindOf(name: string): string {
  if (/国债/.test(name)) return "国债";
  if (/农发|国开|进出口|政策性/.test(name)) return "政策性金融债";
  if (/地方政府|地方债/.test(name)) return "地方政府债";
  if (/二级资本|资本债|永续|银行/.test(name)) return "商业银行债";
  return "信用债及其他";
}

interface HoldingGroup {
  label: string;
  weight: number;
  names: string[];
}

// groups the disclosed top-10 holdings by industry (stocks) or bond type,
// weights are % of fund NAV, summed from the real holding weights
function groupHoldings(f: FundDetail): HoldingGroup[] {
  const map = new Map<string, HoldingGroup>();
  for (const h of f.holdings) {
    const label =
      f.holdingsKind === "bond"
        ? bondKindOf(h.name)
        : (h.industry ?? "未分类（暂无行业数据）");
    const g = map.get(label) ?? { label, weight: 0, names: [] };
    g.weight += h.weight ?? 0;
    g.names.push(h.name);
    map.set(label, g);
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight);
}

function marketMixOf(f: FundDetail): HoldingGroup[] {
  const map = new Map<string, HoldingGroup>();
  for (const h of f.holdings) {
    const label = marketLabelOf(h);
    const g = map.get(label) ?? { label, weight: 0, names: [] };
    g.weight += h.weight ?? 0;
    g.names.push(h.name);
    map.set(label, g);
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight);
}

// deterministic holdings analysis paragraph, every number from real data
function holdingsParagraph(f: FundDetail): string {
  if (f.holdings.length === 0) return "";
  const parts: string[] = [];
  const top1 = f.holdings[0];
  const top3 = f.holdings.slice(0, 3);
  const top3W = top3.reduce((a, b) => a + (b.weight ?? 0), 0);
  if (f.holdingsKind === "bond") {
    const groups = groupHoldings(f);
    const g0 = groups[0];
    parts.push(
      `这只基金股票持仓为空，披露的前 ${f.holdings.length} 大债券合计占净值 ${f.concentration?.toFixed(1) ?? "—"}%${g0 ? `，以${g0.label}为主（前十大内占净值 ${g0.weight.toFixed(1)}%）` : ""}；第一大持仓 ${top1?.name ?? ""} 占 ${top1?.weight?.toFixed(2) ?? "—"}%，债券持仓相对分散，单只债券对净值的影响有限，净值主要随债券市场整体收益率变动`,
    );
    return parts.join("。") + "。";
  }
  const groups = groupHoldings(f).filter((g) => !g.label.startsWith("未分类"));
  const g0 = groups[0];
  const g1 = groups[1];
  if (g0) {
    parts.push(
      `按东方财富行业分类，前十大重仓里权重最大的类型是「${g0.label}」，合计占净值 ${g0.weight.toFixed(1)}%（${g0.names.slice(0, 3).join("、")}${g0.names.length > 3 ? "等" : ""}）${g1 ? `；其次是「${g1.label}」占 ${g1.weight.toFixed(1)}%` : ""}——这只基金的净值涨跌，很大程度上跟着${g0.label}板块走`,
    );
  }
  parts.push(
    `前三大重仓（${top3.map((h) => h.name).join("、")}）合计占净值 ${top3W.toFixed(1)}%，第一大重仓 ${top1?.name ?? ""} 占 ${top1?.weight?.toFixed(2) ?? "—"}%`,
  );
  const mix = marketMixOf(f);
  if (mix.length > 1) {
    parts.push(
      `市场分布上，前十大分布在 ${mix.map((m) => `${m.label} ${m.weight.toFixed(1)}%`).join("、")}，跨市场配置会让净值同时受多个市场与汇率影响`,
    );
  }
  return parts.join("。") + "。";
}

// ---------------------------------------------------------------------------
// advice generation (rule-based on real metrics)
// ---------------------------------------------------------------------------

interface AdviceBlock {
  personas: { label: string; pick: string; text: string }[];
  allocation: { code: string; name: string; pct: number }[];
  allocationNote: string;
  warnings: string[];
  personal: { pick: string; text: string } | null;
}

function pctOr(v: number | null, fallback: string): string {
  return v == null ? fallback : `${v.toFixed(1)}%`;
}

function buildAdvice(funds: FundDetail[], profile: Profile | null): AdviceBlock {
  const byDD = [...funds].sort(
    (a, b) => (a.maxDrawdown ?? 1e9) - (b.maxDrawdown ?? 1e9),
  );
  const calm = byDD[0];
  const byRet = [...funds].sort((a, b) => (b.syl1y ?? -1e9) - (a.syl1y ?? -1e9));
  const bold = byRet[0];
  const byRatio = [...funds].sort((a, b) => {
    const ra = (a.syl1y ?? 0) / Math.max(1, a.maxDrawdown ?? 1);
    const rb = (b.syl1y ?? 0) / Math.max(1, b.maxDrawdown ?? 1);
    return rb - ra;
  });
  const balancedPick = byRatio[0];

  const personas: AdviceBlock["personas"] = [];
  if (calm) {
    personas.push({
      label: "风险承受能力较低，想稳稳地赚点钱",
      pick: calm.code,
      text: `建议选 ${calm.name}。它在几只里回撤控制最好——历史最大回撤 ${pctOr(calm.maxDrawdown, "暂无数据")}，年化波动 ${pctOr(calm.volatility, "暂无数据")}，近1年收益 ${pctOr(calm.syl1y, "暂无数据")}。涨得可能不是最快，但跌的时候跌得少，拿得住才是真的赚到。`,
    });
  }
  if (balancedPick && balancedPick.code !== calm?.code) {
    personas.push({
      label: "想兼顾收益和回撤，攻守平衡",
      pick: balancedPick.code,
      text: `建议选 ${balancedPick.name}。按「近1年收益 ÷ 最大回撤」算，它的性价比在这几只里最高：近1年收益 ${pctOr(balancedPick.syl1y, "暂无数据")}，最大回撤 ${pctOr(balancedPick.maxDrawdown, "暂无数据")}，每承担一份回撤换来的回报更划算。`,
    });
  }
  if (bold && bold.code !== calm?.code) {
    personas.push({
      label: "风险偏好高，信奉风浪越大鱼越贵",
      pick: bold.code,
      text: `可以选 ${bold.name}。它近1年收益 ${pctOr(bold.syl1y, "暂无数据")} 领跑，但代价是最大回撤 ${pctOr(bold.maxDrawdown, "暂无数据")}、年化波动 ${pctOr(bold.volatility, "暂无数据")}——涨起来痛快，跌起来也真疼，只适合能拿长、跌了不慌的人。`,
    });
  }

  // allocation: weight by match score (profile) or return/vol efficiency
  const weights = funds.map((f) => {
    if (profile) return Math.max(10, detailMatch(profile, f).score);
    const eff = (f.syl1y ?? 0) / Math.max(5, f.volatility ?? 20);
    return Math.max(10, 50 + eff * 10);
  });
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  let alloc = funds.map((f, i) => ({
    code: f.code,
    name: f.name,
    pct: Math.round(((weights[i] ?? 0) / totalW) * 100),
  }));
  const cap = profile ? profile.singleCap : 70;
  let leftover = 0;
  alloc = alloc.map((a) => {
    if (a.pct > cap) {
      leftover += a.pct - cap;
      return { ...a, pct: cap };
    }
    return a;
  });
  // distribute leftover to uncapped funds proportionally
  if (leftover > 0) {
    const room = alloc.filter((a) => a.pct < cap);
    if (room.length > 0) {
      const each = Math.floor(leftover / room.length);
      alloc = alloc.map((a) =>
        a.pct < cap ? { ...a, pct: Math.min(cap, a.pct + each) } : a,
      );
      leftover = alloc.reduce((a, b) => a + b.pct, 0);
      leftover = 100 - leftover;
    }
  }
  const allocSum = alloc.reduce((a, b) => a + b.pct, 0);
  const allocationNote =
    allocSum < 100
      ? `按${profile ? "你的画像匹配度" : "收益/波动效率"}加权，并受单只仓位上限 ${cap}% 约束：合计配 ${allocSum}%，其余 ${100 - allocSum}% 建议留作现金或另选低相关性的基金分散，不要硬塞进同一只。`
      : `按${profile ? "你的画像匹配度" : "收益/波动效率"}加权得出，单只不超过 ${cap}%。`;

  const warnings: string[] = [];
  if (profile) {
    for (const f of funds) {
      if (f.maxDrawdown != null && f.maxDrawdown > profile.maxDD) {
        warnings.push(
          `${f.name} 的历史最大回撤 ${f.maxDrawdown.toFixed(1)}%，超过你设定的 ${profile.maxDD}% 上限，真跌起来可能拿不住，配置前想清楚。`,
        );
      }
    }
  }

  let personal: AdviceBlock["personal"] = null;
  if (profile) {
    const scored = funds
      .map((f) => ({ f, m: detailMatch(profile, f) }))
      .sort((a, b) => b.m.score - a.m.score);
    const top = scored[0];
    if (top) {
      const good = top.m.reasons.filter((r) => r.good).map((r) => r.text);
      personal = {
        pick: top.f.code,
        text: `按你的画像（${RISK_LABELS[profile.risk]}、最多接受 ${profile.maxDD}% 回撤），最合你的是 ${top.f.name}，匹配度 ${top.m.score} 分。${good.slice(0, 2).join("；")}。`,
      };
    }
  }

  return { personas, allocation: alloc, allocationNote, warnings, personal };
}

// ---------------------------------------------------------------------------
// small UI helpers
// ---------------------------------------------------------------------------

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "暂无数据";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function pctColor(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-[var(--text)]";
  return v > 0 ? "text-[var(--rise)]" : "text-[var(--fall)]";
}

function tenureText(days: number): string {
  if (!days) return "暂无数据";
  const y = Math.floor(days / 365);
  const rest = days % 365;
  return y > 0 ? `${y}年又${rest}天` : `${rest}天`;
}

function PowerBars({
  cats,
  data,
  avg,
}: {
  cats: string[];
  data: number[];
  avg: number | null;
}) {
  if (cats.length === 0 || data.length === 0) {
    return <p className="text-sm text-[var(--dim)]">暂无能力评分数据</p>;
  }
  return (
    <div className="space-y-2">
      {cats.map((c, i) => {
        const v = data[i] ?? 0;
        return (
          <div key={c} className="flex items-center gap-2 text-sm">
            <span className="w-16 shrink-0 text-[var(--dim)]">{c}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.min(100, Math.max(0, v))}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums">{v.toFixed(1)}</span>
          </div>
        );
      })}
      {avg != null && (
        <p className="text-xs text-[var(--dim)]">综合评分 {avg.toFixed(1)} / 100（东方财富）</p>
      )}
    </div>
  );
}

function MatchBadge({ score }: { score: number }) {
  const color =
    score >= 75 ? "var(--fall)" : score >= 55 ? "var(--amber)" : "var(--rise)";
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color, background: "var(--surface2)" }}
    >
      匹配 {score}
    </span>
  );
}

// ---------------------------------------------------------------------------
// NAV chart / K-line (candles synthesized server-side from accumulated NAV;
// Xueqiu-style interactions: line/candle modes, zoom, draggable timeline
// brush for the date range, tap-to-pin crosshair readout)
// ---------------------------------------------------------------------------

type KlinePeriod = "day" | "week" | "month";
type KlineRange = "6m" | "1y" | "3y" | "5y" | "all";
type KlineMode = "line" | "candle";
type KlineData = ApiResponse<typeof api, "getFundKline">;
type Candle = KlineData["candles"][number];

const MA_COLORS = { ma5: "#d29a35", ma10: "#5b7fa6", ma20: "#8a6fae" } as const;

// Xueqiu-style NAV chart: the selected period's full candle series is
// fetched once; the visible window is client-side state. One gesture on
// the main chart does exactly one thing: dragging moves the selected
// point (pin) and nothing else — there is no speed-based gesture split.
// When the point is dragged past the left/right chart edge and the
// finger keeps pushing outward, the window auto-scrolls in that
// direction so the point can travel to dates outside the current window;
// on release the readout stays on the last touched point. Large jumps
// use the range presets, zoom buttons, and the bottom timeline brush.
function FundKlineChart({ code }: { code: string }) {
  const [period, setPeriod] = useState<KlinePeriod>("day");
  const [range, setRange] = useState<KlineRange>("1y");
  const [mode, setMode] = useState<KlineMode>("line");
  const [win, setWin] = useState<{ start: number; end: number } | null>(null);
  const [pin, setPin] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const brushRef = useRef<SVGSVGElement>(null);
  const mainDragRef = useRef<{ pointerId: number } | null>(null);
  // Edge auto-scroll state while the dragged point is pushed past a chart
  // edge: dir -1 scrolls toward earlier dates, +1 toward later ones;
  // overshoot is how far past the edge candle (in candles) the finger is.
  const edgeRef = useRef<{
    dir: -1 | 1;
    overshoot: number;
    raf: number;
    acc: number;
    last: number;
  } | null>(null);
  const brushDragRef = useRef<{
    kind: "move" | "left" | "right";
    startX: number;
    startWin: { start: number; end: number };
  } | null>(null);

  const q = useQuery({
    queryKey: ["kline", code, period],
    queryFn: () => api.getFundKline({ code, period, range: "all" }),
    staleTime: 3600_000,
  });
  const candles: Candle[] = useMemo(() => q.data?.candles ?? [], [q.data]);
  const total = candles.length;
  const lastCandle = candles[total - 1];

  // default window for a range preset: candles whose date is within the
  // preset span ending at the latest candle (always shows the newest data)
  const presetWin = useMemo(() => {
    if (total === 0 || !lastCandle) return { start: 0, end: 0 };
    if (range === "all") return { start: 0, end: total - 1 };
    const months = range === "6m" ? 6 : range === "1y" ? 12 : range === "3y" ? 36 : 60;
    const end = new Date(`${lastCandle.date}T00:00:00Z`);
    end.setUTCMonth(end.getUTCMonth() - months);
    const cutoff = end.toISOString().slice(0, 10);
    let start = candles.findIndex((c) => c.date >= cutoff);
    if (start < 0) start = 0;
    // keep at least a handful of candles visible on very short histories
    if (total - 1 - start < 4) start = Math.max(0, total - 5);
    return { start, end: total - 1 };
  }, [candles, range, total, lastCandle]);

  const view = win ?? presetWin;
  // latest window / series length for the edge auto-scroll rAF loop, which
  // runs outside React renders
  const viewRef = useRef(view);
  viewRef.current = view;
  const totalRef = useRef(total);
  totalRef.current = total;
  const vis = useMemo(
    () => candles.slice(view.start, view.end + 1),
    [candles, view.start, view.end],
  );
  const visFirst = vis[0];
  const visLast = vis[vis.length - 1];
  const dispIdx =
    hover != null
      ? view.start + hover
      : pin != null
        ? Math.min(Math.max(pin, view.start), view.end)
        : view.end;
  const sel: Candle | undefined = candles[dispIdx];
  const winChange =
    visFirst && visLast && visFirst.close > 0
      ? ((visLast.close - visFirst.close) / visFirst.close) * 100
      : null;

  const W = 720;
  const H = 300;
  const padR = 58;
  const padT = 12;
  const padB = 24;
  const plotW = W - padR - 6;
  const plotH = H - padT - padB;

  const geom = useMemo(() => {
    if (vis.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const c of vis) {
      const lo = mode === "line" ? c.close : c.low;
      const hi = mode === "line" ? c.close : c.high;
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const span = max - min || max * 0.02 || 1;
    min -= span * 0.06;
    max += span * 0.06;
    const y = (v: number) => padT + ((max - v) / (max - min)) * plotH;
    const step = plotW / vis.length;
    const x = (i: number) => 6 + step * (i + 0.5);
    const bodyW = Math.max(1, Math.min(11, step * 0.62));
    const maLine = (key: "ma5" | "ma10" | "ma20") => {
      const pts: string[] = [];
      vis.forEach((c, i) => {
        const v = c[key];
        if (v != null) pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      });
      return pts.join(" ");
    };
    const linePts = vis
      .map((c, i) => `${x(i).toFixed(1)},${y(c.close).toFixed(1)}`)
      .join(" ");
    const areaPath =
      vis.length > 0
        ? `M ${x(0).toFixed(1)},${y(vis[0]?.close ?? 0).toFixed(1)} ` +
          vis
            .map((c, i) => `L ${x(i).toFixed(1)},${y(c.close).toFixed(1)}`)
            .join(" ") +
          ` L ${x(vis.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L ${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`
        : "";
    const ticks = [0, 1, 2, 3, 4].map((k) => {
      const v = min + ((max - min) * k) / 4;
      return { v, y: y(v) };
    });
    const dateIdx = [0, 0.25, 0.5, 0.75, 1].map((f) =>
      Math.min(vis.length - 1, Math.round(f * (vis.length - 1))),
    );
    return { min, max, y, x, step, bodyW, maLine, linePts, areaPath, ticks, dateIdx };
  }, [vis, mode, plotW, plotH]);

  // ---- brush (timeline) geometry over the full period series ----
  const BW = 720;
  const BH = 58;
  const brushGeom = useMemo(() => {
    if (total === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const c of candles) {
      if (c.close < min) min = c.close;
      if (c.close > max) max = c.close;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const span = max - min || max * 0.02 || 1;
    min -= span * 0.08;
    max += span * 0.08;
    const bx = (i: number) => 6 + ((i + 0.5) / total) * (BW - 12);
    const by = (v: number) => 5 + ((max - v) / (max - min)) * (BH - 12);
    const pts = candles
      .map((c, i) => `${bx(i).toFixed(1)},${by(c.close).toFixed(1)}`)
      .join(" ");
    return { bx, pts, winX0: bx(view.start) - (BW - 12) / total / 2, winX1: bx(view.end) + (BW - 12) / total / 2 };
  }, [candles, total, view.start, view.end]);

  const idxFromClientX = (clientX: number, rect: DOMRect, count: number) => {
    const vx = ((clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(count - 1, Math.floor((vx - 6) / (plotW / count))));
  };

  // ---- edge auto-scroll (runs on rAF while the point is pushed past an
  // edge; the window slides under the stationary finger and the pin rides
  // the edge candle, so the point travels beyond the original window) ----
  const stopEdgeScroll = () => {
    const ed = edgeRef.current;
    if (ed) {
      cancelAnimationFrame(ed.raf);
      edgeRef.current = null;
    }
  };
  const runEdgeScroll = () => {
    const ed = edgeRef.current;
    if (!ed) return;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - ed.last) / 1000));
    ed.last = now;
    // scroll speed grows with how far the finger pushes past the edge
    const speed = Math.max(2, Math.min(6, ed.overshoot) * 9); // candles / sec
    ed.acc += speed * dt;
    const k = Math.floor(ed.acc);
    if (k > 0) {
      ed.acc -= k;
      const v = viewRef.current;
      const len = v.end - v.start;
      let s = v.start + ed.dir * k;
      s = Math.max(0, Math.min(totalRef.current - 1 - len, s));
      if (s !== v.start) {
        setWin({ start: s, end: s + len });
        setPin(ed.dir < 0 ? s : s + len);
      } else {
        // window already at the series boundary: pin stays on the edge
        setPin(ed.dir < 0 ? v.start : v.end);
      }
    }
    ed.raf = requestAnimationFrame(runEdgeScroll);
  };
  const startEdgeScroll = (dir: -1 | 1, overshoot: number) => {
    const ed = edgeRef.current;
    if (ed && ed.dir === dir) {
      ed.overshoot = overshoot;
      return;
    }
    stopEdgeScroll();
    edgeRef.current = {
      dir,
      overshoot,
      raf: 0,
      acc: 0,
      last: performance.now(),
    };
    edgeRef.current.raf = requestAnimationFrame(runEdgeScroll);
  };
  useEffect(() => stopEdgeScroll, []);

  // Main-chart gestures (mouse + touch unified): a drag moves ONLY the
  // selected point, at any speed — the window never pans under the finger.
  // The point clamps at the window edge; pushing it more than half a
  // candle past the edge starts the edge auto-scroll above, so one
  // continuous drag can carry the point to any date in the series. On
  // release the readout stays on the last touched point (no snap-back to
  // the latest NAV date). The svg keeps touch-pan-y: vertical slides
  // still scroll the page (the browser takes over and fires
  // pointercancel, which ends the gesture cleanly).
  const onMainDown = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || vis.length === 0) return;
    stopEdgeScroll();
    const rect = svg.getBoundingClientRect();
    const idx = idxFromClientX(e.clientX, rect, vis.length);
    setPin(view.start + idx);
    setHover(null);
    mainDragRef.current = { pointerId: e.pointerId };
    svg.setPointerCapture(e.pointerId);
  };
  const onMainMove = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || vis.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const drag = mainDragRef.current;
    if (drag && e.pointerId === drag.pointerId) {
      const vx = ((e.clientX - rect.left) / rect.width) * W;
      const count = view.end - view.start + 1;
      const step = plotW / count;
      // fractional candle position under the finger (0 = first candle)
      const f = (vx - 6) / step - 0.5;
      if (f < -0.5) {
        setPin(view.start);
        startEdgeScroll(-1, -f - 0.5);
      } else if (f > count - 1 + 0.5) {
        setPin(view.end);
        startEdgeScroll(1, f - (count - 1) - 0.5);
      } else {
        stopEdgeScroll();
        const idx = Math.max(0, Math.min(count - 1, Math.round(f)));
        setPin(view.start + idx);
      }
      return;
    }
    if (e.pointerType === "mouse") {
      setHover(idxFromClientX(e.clientX, rect, vis.length));
    }
  };
  const onMainUp = (e: PointerEvent<SVGSVGElement>) => {
    if (mainDragRef.current?.pointerId === e.pointerId) {
      mainDragRef.current = null;
      stopEdgeScroll();
    }
  };

  const onBrushDown = (e: PointerEvent<SVGSVGElement>) => {
    const svg = brushRef.current;
    if (!svg || total === 0 || !brushGeom) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * BW;
    // generous handle grab zone so the edges are easy to catch on touch
    const handleW = Math.max(30, (brushGeom.winX1 - brushGeom.winX0) * 0.18);
    const kind =
      Math.abs(vx - brushGeom.winX0) <= handleW
        ? "left"
        : Math.abs(vx - brushGeom.winX1) <= handleW
          ? "right"
          : vx > brushGeom.winX0 && vx < brushGeom.winX1
            ? "move"
            : vx <= brushGeom.winX0
              ? "left"
              : "right";
    brushDragRef.current = { kind, startX: vx, startWin: { ...view } };
    svg.setPointerCapture(e.pointerId);
  };
  const onBrushMove = (e: PointerEvent<SVGSVGElement>) => {
    const drag = brushDragRef.current;
    const svg = brushRef.current;
    if (!drag || !svg || total === 0) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * BW;
    const di = Math.round(((vx - drag.startX) / (BW - 12)) * total);
    const len = drag.startWin.end - drag.startWin.start;
    const MIN = Math.min(4, total - 1);
    if (drag.kind === "move") {
      let s = drag.startWin.start + di;
      s = Math.max(0, Math.min(total - 1 - len, s));
      setWin({ start: s, end: s + len });
    } else if (drag.kind === "left") {
      const s = Math.max(0, Math.min(drag.startWin.end - MIN, drag.startWin.start + di));
      setWin({ start: s, end: drag.startWin.end });
    } else {
      const en = Math.max(
        drag.startWin.start + MIN,
        Math.min(total - 1, drag.startWin.end + di),
      );
      setWin({ start: drag.startWin.start, end: en });
    }
  };
  const onBrushUp = () => {
    brushDragRef.current = null;
  };

  const zoomBy = (factor: number) => {
    if (total === 0) return;
    const len = view.end - view.start;
    const newLen = Math.max(
      Math.min(4, total - 1),
      Math.min(total - 1, Math.round(len * factor)),
    );
    const anchor = pin != null && pin >= view.start && pin <= view.end ? pin : view.end;
    let end = Math.min(total - 1, Math.max(anchor, view.end));
    let start = end - newLen;
    if (start < 0) {
      start = 0;
      end = newLen;
    }
    setWin({ start, end });
  };

  const resetWin = () => {
    setWin(null);
    setPin(null);
    setHover(null);
  };

  const stepPin = (d: number) => {
    if (total === 0) return;
    const base = pin ?? view.end;
    const next = Math.min(total - 1, Math.max(0, base + d));
    setPin(next);
    if (next < view.start) setWin({ start: next, end: next + (view.end - view.start) });
    if (next > view.end) setWin({ start: next - (view.end - view.start), end: next });
  };

  const periods: { key: KlinePeriod; label: string }[] = [
    { key: "day", label: "日K" },
    { key: "week", label: "周K" },
    { key: "month", label: "月K" },
  ];
  const ranges: { key: KlineRange; label: string }[] = [
    { key: "6m", label: "近半年" },
    { key: "1y", label: "近1年" },
    { key: "3y", label: "近3年" },
    { key: "5y", label: "近5年" },
    { key: "all", label: "全部" },
  ];
  const selUp = (sel?.changePct ?? 0) >= 0;
  const selLocal = dispIdx - view.start;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg font-bold text-[var(--text)]">净值走势 / K 线</h3>
        <div className="flex gap-1.5" role="group" aria-label="K线周期">
          {periods.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                setPeriod(p.key);
                resetWin();
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                period === p.key
                  ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                  : "bg-[var(--surface2)] text-[var(--dim)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <div className="flex gap-1.5" role="group" aria-label="K线区间">
          {ranges.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => {
                setRange(r.key);
                setWin(null);
                setPin(null);
                setHover(null);
              }}
              className={`rounded-full px-3 py-1 text-xs ${
                range === r.key && win == null
                  ? "bg-[var(--text)] text-[var(--bg)]"
                  : "bg-[var(--surface2)] text-[var(--dim)]"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex overflow-hidden rounded-lg bg-[var(--surface2)]" role="group" aria-label="图表类型">
            <button
              type="button"
              onClick={() => setMode("line")}
              className={`px-2.5 py-1 text-xs font-medium ${
                mode === "line" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"
              }`}
            >
              走势
            </button>
            <button
              type="button"
              onClick={() => setMode("candle")}
              className={`px-2.5 py-1 text-xs font-medium ${
                mode === "candle" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"
              }`}
            >
              蜡烛
            </button>
          </div>
          <button
            type="button"
            aria-label="放大图表（缩小日期区间）"
            onClick={() => zoomBy(0.55)}
            className="rounded-lg bg-[var(--surface2)] px-2.5 py-1 text-xs font-medium text-[var(--text)]"
          >
            ＋ 放大
          </button>
          <button
            type="button"
            aria-label="缩小图表（扩大日期区间）"
            onClick={() => zoomBy(1.8)}
            className="rounded-lg bg-[var(--surface2)] px-2.5 py-1 text-xs font-medium text-[var(--text)]"
          >
            － 缩小
          </button>
          <button
            type="button"
            onClick={resetWin}
            className="rounded-lg bg-[var(--surface2)] px-2.5 py-1 text-xs font-medium text-[var(--dim)]"
          >
            重置
          </button>
        </div>
      </div>

      {q.isPending && <p className="py-10 text-center text-sm text-[var(--dim)]">正在拉取净值历史…</p>}
      {q.isError && <p className="py-10 text-center text-sm text-[var(--dim)]">走势加载失败，请稍后重试</p>}
      {q.data && total === 0 && (
        <p className="py-10 text-center text-sm text-[var(--dim)]">暂无足够净值历史生成走势图</p>
      )}

      {geom && brushGeom && sel && vis.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm tabular-nums">
            <span className="font-medium text-[var(--text)]">{sel.date}</span>
            {mode === "candle" ? (
              <>
                <span className="text-[var(--dim)]">开 {sel.open.toFixed(4)}</span>
                <span className="text-[var(--dim)]">高 {sel.high.toFixed(4)}</span>
                <span className="text-[var(--dim)]">低 {sel.low.toFixed(4)}</span>
                <span className="text-[var(--dim)]">收 {sel.close.toFixed(4)}</span>
              </>
            ) : (
              <span className="text-[var(--dim)]">累计净值 {sel.close.toFixed(4)}</span>
            )}
            <span className={selUp ? "text-[var(--rise)]" : "text-[var(--fall)]"}>
              {period === "day" ? "当日 " : period === "week" ? "当周 " : "当月 "}
              {fmtPct(sel.changePct)}
            </span>
            {pin != null && (
              <span className="inline-flex items-center gap-1.5">
                <span className="rounded-full bg-[var(--surface2)] px-2 py-0.5 text-xs text-[var(--dim)]">
                  已锁定该点
                </span>
                <button
                  type="button"
                  aria-label="上一个数据点"
                  onClick={() => stepPin(-1)}
                  className="rounded-md bg-[var(--surface2)] px-2 py-0.5 text-xs text-[var(--text)]"
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="下一个数据点"
                  onClick={() => stepPin(1)}
                  className="rounded-md bg-[var(--surface2)] px-2 py-0.5 text-xs text-[var(--text)]"
                >
                  ›
                </button>
                <button
                  type="button"
                  onClick={() => setPin(null)}
                  className="rounded-md bg-[var(--surface2)] px-2 py-0.5 text-xs text-[var(--dim)]"
                >
                  取消锁定
                </button>
              </span>
            )}
            <span className="ml-auto flex gap-2 text-xs">
              <span style={{ color: MA_COLORS.ma5 }}>MA5 {sel.ma5?.toFixed(3) ?? "—"}</span>
              <span style={{ color: MA_COLORS.ma10 }}>MA10 {sel.ma10?.toFixed(3) ?? "—"}</span>
              <span style={{ color: MA_COLORS.ma20 }}>MA20 {sel.ma20?.toFixed(3) ?? "—"}</span>
            </span>
          </div>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="mt-1 w-full touch-pan-y select-none"
            role="img"
            aria-label={`${period === "day" ? "日" : period === "week" ? "周" : "月"}K线图，当前显示 ${vis.length} 根K线，在图上拖动只移动选中的数据点，把点拖到图表左右边缘继续往外推时窗口自动平移，可一路拖到当前区间之外的日期，松手后读数停留在最后一次触碰的点`}
            onPointerDown={onMainDown}
            onPointerMove={onMainMove}
            onPointerUp={onMainUp}
            onPointerCancel={onMainUp}
            onPointerLeave={() => setHover(null)}
          >
            {geom.ticks.map((t, i) => (
              <g key={i}>
                <line x1={6} x2={6 + plotW} y1={t.y} y2={t.y} stroke="var(--border)" strokeWidth="0.6" strokeDasharray="3 3" />
                <text x={W - padR + 6} y={t.y + 4} fontSize="11" fill="var(--dim)">
                  {t.v.toFixed(3)}
                </text>
              </g>
            ))}
            {geom.dateIdx.map((ci, i) => {
              const c = vis[ci];
              if (!c) return null;
              return (
                <text
                  key={i}
                  x={geom.x(ci)}
                  y={H - 6}
                  fontSize="11"
                  fill="var(--dim)"
                  textAnchor={i === 0 ? "start" : i === geom.dateIdx.length - 1 ? "end" : "middle"}
                >
                  {c.date.slice(0, 7)}
                </text>
              );
            })}
            {(["ma5", "ma10", "ma20"] as const).map((k) => (
              <polyline
                key={k}
                points={geom.maLine(k)}
                fill="none"
                stroke={MA_COLORS[k]}
                strokeWidth="1"
                opacity="0.85"
              />
            ))}
            {mode === "line" ? (
              <>
                <path d={geom.areaPath} fill="var(--accent)" opacity="0.10" />
                <polyline
                  points={geom.linePts}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.6"
                />
              </>
            ) : (
              vis.map((c, i) => {
                const up = c.close >= c.open;
                const color = up ? "var(--rise)" : "var(--fall)";
                const yO = geom.y(c.open);
                const yC = geom.y(c.close);
                const top = Math.min(yO, yC);
                const hgt = Math.max(1, Math.abs(yC - yO));
                const cx = geom.x(i);
                return (
                  <g key={c.date + i}>
                    <line
                      x1={cx}
                      x2={cx}
                      y1={geom.y(c.high)}
                      y2={geom.y(c.low)}
                      stroke={color}
                      strokeWidth={Math.max(0.7, geom.bodyW * 0.14)}
                    />
                    <rect
                      x={cx - geom.bodyW / 2}
                      y={top}
                      width={geom.bodyW}
                      height={hgt}
                      fill={up ? "var(--surface)" : color}
                      stroke={color}
                      strokeWidth="0.9"
                    />
                  </g>
                );
              })
            )}
            {selLocal >= 0 && selLocal < vis.length && (
              <g>
                <line
                  x1={geom.x(selLocal)}
                  x2={geom.x(selLocal)}
                  y1={padT}
                  y2={padT + plotH}
                  stroke="var(--dim)"
                  strokeWidth="0.8"
                  strokeDasharray="4 3"
                />
                <circle
                  cx={geom.x(selLocal)}
                  cy={geom.y(sel.close)}
                  r="3.4"
                  fill="var(--surface)"
                  stroke="var(--accent)"
                  strokeWidth="1.8"
                />
              </g>
            )}
          </svg>

          <div className="mt-1">
            <svg
              ref={brushRef}
              viewBox={`0 0 ${BW} ${BH}`}
              className="w-full touch-none select-none"
              role="slider"
              aria-label="日期区间选择器：拖动中间平移区间，拖动两端手柄拉伸或压缩区间"
              aria-valuetext={`${visFirst?.date ?? ""} 至 ${visLast?.date ?? ""}`}
              onPointerDown={onBrushDown}
              onPointerMove={onBrushMove}
              onPointerUp={onBrushUp}
              onPointerCancel={onBrushUp}
            >
              <polyline
                points={brushGeom.pts}
                fill="none"
                stroke="var(--dim)"
                strokeWidth="1"
                opacity="0.65"
              />
              <rect
                x={brushGeom.winX0}
                y={1}
                width={Math.max(4, brushGeom.winX1 - brushGeom.winX0)}
                height={BH - 2}
                fill="var(--accent)"
                opacity="0.13"
              />
              <line x1={brushGeom.winX0} x2={brushGeom.winX0} y1={1} y2={BH - 1} stroke="var(--accent)" strokeWidth="2.4" />
              <line x1={brushGeom.winX1} x2={brushGeom.winX1} y1={1} y2={BH - 1} stroke="var(--accent)" strokeWidth="2.4" />
              {[brushGeom.winX0, brushGeom.winX1].map((hx, i) => (
                <g key={i}>
                  <rect
                    x={hx - 6}
                    y={BH / 2 - 13}
                    width={12}
                    height={26}
                    rx={6}
                    fill="var(--accent)"
                  />
                  <line
                    x1={hx - 2.2}
                    x2={hx - 2.2}
                    y1={BH / 2 - 6}
                    y2={BH / 2 + 6}
                    stroke="var(--accent-ink)"
                    strokeWidth="1.6"
                  />
                  <line
                    x1={hx + 2.2}
                    x2={hx + 2.2}
                    y1={BH / 2 - 6}
                    y2={BH / 2 + 6}
                    stroke="var(--accent-ink)"
                    strokeWidth="1.6"
                  />
                </g>
              ))}
            </svg>
            <div className="text-xs tabular-nums text-[var(--dim)]">
              <div className="flex items-baseline justify-between">
                <span>{candles[0]?.date ?? ""}</span>
                <span>{lastCandle?.date ?? ""}</span>
              </div>
              <p className="mt-0.5 text-center text-[var(--text)]">
                当前区间 {visFirst?.date} 至 {visLast?.date}
                {winChange != null && (
                  <>
                    {" · 区间涨跌 "}
                    <span className={winChange >= 0 ? "text-[var(--rise)]" : "text-[var(--fall)]"}>
                      {fmtPct(winChange)}
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>

          <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
            {q.data?.basis}
            在图上拖动只移动选中的那个点，快慢都一样跟手，松手后读数停留在最后一次触碰的点上；把点拖到图表左 / 右边缘并继续往外推，窗口会自动跟着平移，选点能一路拖到当前区间之外的日期。大跨度跳日期请用上方区间按钮、下方时间轴把手（拖中间平移、拖两端拉伸）或「放大 / 缩小」按钮。红涨绿跌，蜡烛模式下阳线为空心、阴线为实心，与国内行情软件一致；均线为收盘净值的移动平均。
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function SearchBar({
  onOpenFund,
  onOpenManager,
  onAddCompare,
  basketCodes,
}: {
  onOpenFund: (code: string) => void;
  onOpenManager: (id: string) => void;
  onAddCompare: (item: BasketItem) => void;
  basketCodes: Set<string>;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const search = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.searchAll({ query: debounced }),
    enabled: debounced.length >= 1,
    staleTime: 60_000,
  });
  const data: SearchData | undefined = search.data;
  const showDrop = open && debounced.length >= 1;

  return (
    <div ref={boxRef} className="relative">
      <input
        aria-label="搜索基金或基金经理"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="搜基金名 / 代码 / 拼音，或基金经理姓名（如：李耀柱）"
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-base text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
      />
      {showDrop && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl">
          {search.isPending && (
            <p className="px-4 py-3 text-sm text-[var(--dim)]">搜索中…</p>
          )}
          {search.isError && (
            <p className="px-4 py-3 text-sm text-[var(--dim)]">搜索失败，请稍后重试</p>
          )}
          {data && data.managers.length > 0 && (
            <div>
              <p className="px-4 pb-1 pt-3 text-xs font-medium text-[var(--dim)]">
                基金经理（共 {data.managerTotal} 位）
              </p>
              {data.managers.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onOpenManager(m.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-[var(--surface2)]"
                >
                  <span>
                    <span className="font-medium text-[var(--text)]">{m.name}</span>
                    <span className="ml-2 text-sm text-[var(--dim)]">{m.company}</span>
                  </span>
                  <span className="shrink-0 text-xs text-[var(--dim)]">
                    在管 {m.fundCount} 只 · 规模 {m.scale || "暂无数据"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {data && data.funds.length > 0 && (
            <div>
              <p className="px-4 pb-1 pt-3 text-xs font-medium text-[var(--dim)]">
                基金（共 {data.fundTotal} 只匹配）
              </p>
              {data.funds.map((f) => (
                <div
                  key={f.code}
                  className="flex w-full items-start justify-between gap-2 px-4 py-2.5 hover:bg-[var(--surface2)]"
                >
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="block w-full text-left"
                      onClick={() => {
                        onOpenFund(f.code);
                        setOpen(false);
                      }}
                    >
                      <span className="block truncate font-medium text-[var(--text)]">{f.name}</span>
                      <span className="block text-xs text-[var(--dim)]">
                        {f.code} · {f.type}
                      </span>
                    </button>
                    {f.managerName &&
                      (f.managerId ? (
                        <button
                          type="button"
                          aria-label={`查看基金经理${f.managerName}的主页`}
                          onClick={() => {
                            if (f.managerId) {
                              onOpenManager(f.managerId);
                              setOpen(false);
                            }
                          }}
                          className="mt-0.5 text-xs text-[var(--accent)] underline decoration-dotted underline-offset-2"
                        >
                          经理 {f.managerName} ›
                        </button>
                      ) : (
                        <span className="mt-0.5 block text-xs text-[var(--dim)]">经理 {f.managerName}</span>
                      ))}
                  </div>
                  <button
                    type="button"
                    aria-label={basketCodes.has(f.code) ? `将${f.name}移出对比` : `将${f.name}加入对比`}
                    onClick={() => onAddCompare({ code: f.code, name: f.name })}
                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-sm ${
                      basketCodes.has(f.code)
                        ? "bg-[var(--surface2)] text-[var(--dim)]"
                        : "bg-[var(--accent)] text-[var(--accent-ink)]"
                    }`}
                  >
                    {basketCodes.has(f.code) ? "已加入" : "+ 对比"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {data && data.funds.length === 0 && data.managers.length === 0 && (
            <p className="px-4 py-3 text-sm text-[var(--dim)]">
              全市场没有找到「{debounced}」，换个关键词试试
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// manager leaderboard
// ---------------------------------------------------------------------------

function LeadersView({
  onOpenManager,
  onOpenFund,
}: {
  onOpenManager: (id: string) => void;
  onOpenFund: (code: string) => void;
}) {
  const [period, setPeriod] = useState<"1n" | "3n" | "tenure">("1n");
  const q = useQuery({
    queryKey: ["leaders", period],
    queryFn: () => api.getManagerLeaders({ period }),
    staleTime: 3600_000,
  });
  const periods: { key: "1n" | "3n" | "tenure"; label: string }[] = [
    { key: "1n", label: "近1年" },
    { key: "3n", label: "近3年" },
    { key: "tenure", label: "任期最佳" },
  ];
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        {periods.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPeriod(p.key)}
            className={`rounded-full px-3.5 py-1.5 text-sm ${
              period === p.key
                ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                : "bg-[var(--surface)] text-[var(--dim)] border border-[var(--border)]"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {q.data?.methodology && (
        <p className="mb-3 text-xs leading-relaxed text-[var(--dim)]">
          榜单口径：{q.data.methodology}
          {q.data.asOf ? ` · 数据日期 ${q.data.asOf}` : ""}
        </p>
      )}
      {q.isPending && <p className="py-8 text-center text-[var(--dim)]">正在聚合全市场数据…</p>}
      {q.isError && <p className="py-8 text-center text-[var(--dim)]">榜单加载失败，请稍后重试</p>}
      <ol className="divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {(q.data?.items ?? []).map((m: LeaderItem, i: number) => (
          <li key={m.managerId}>
            <button
              type="button"
              onClick={() => onOpenManager(m.managerId)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              <span
                className={`font-display w-7 shrink-0 text-center text-lg font-bold ${
                  i < 3 ? "text-[var(--amber)]" : "text-[var(--dim)]"
                }`}
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="font-medium text-[var(--text)]">{m.name}</span>
                  <span className="ml-2 text-sm text-[var(--dim)]">{m.company}</span>
                </span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  任职 {tenureText(m.tenureDays)} · 在管 {m.fundCount} 只 · 规模 {m.scale || "暂无数据"}
                </span>
                <span
                  className="block truncate text-xs text-[var(--dim)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenFund(m.bestFundCode);
                  }}
                >
                  代表作：{m.bestFundName}
                </span>
              </span>
              <span className={`shrink-0 text-right tabular-nums ${pctColor(m.periodReturn)}`}>
                <span className="block text-lg font-semibold">{fmtPct(m.periodReturn)}</span>
                <span className="block text-xs text-[var(--dim)]">
                  {period === "tenure" ? "任期最佳回报" : period === "1n" ? "代表基金近1年" : "代表基金近3年"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ranking + categories
// ---------------------------------------------------------------------------

const FT_TABS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "gp", label: "股票型" },
  { key: "hh", label: "混合型" },
  { key: "zq", label: "债券型" },
  { key: "zs", label: "指数型" },
  { key: "qdii", label: "QDII" },
  { key: "fof", label: "FOF" },
];

const SC_TABS: { key: string; label: string; field: keyof RankRow }[] = [
  { key: "1nzf", label: "近1年", field: "y1" },
  { key: "3yzf", label: "近3月", field: "m3" },
  { key: "6yzf", label: "近6月", field: "m6" },
  { key: "3nzf", label: "近3年", field: "y3" },
  { key: "jnzf", label: "今年来", field: "ytd" },
  { key: "1yzf", label: "近1月", field: "m1" },
];

function RankingView({
  ft,
  setFt,
  profile,
  onOpenFund,
  onOpenManager,
  onAddCompare,
  basketCodes,
}: {
  ft: string;
  setFt: (v: string) => void;
  profile: Profile | null;
  onOpenFund: (code: string) => void;
  onOpenManager: (id: string) => void;
  onAddCompare: (item: BasketItem) => void;
  basketCodes: Set<string>;
}) {
  const [sc, setSc] = useState("1nzf");
  const [sortByMatch, setSortByMatch] = useState(false);
  const q = useQuery({
    queryKey: ["ranking", ft, sc],
    queryFn: () =>
      api.getRanking({
        ft: ft as "all" | "gp" | "hh" | "zq" | "zs" | "qdii" | "fof",
        sc: sc as "1yzf" | "3yzf" | "6yzf" | "1nzf" | "3nzf" | "jnzf",
        limit: 50,
      }),
    staleTime: 3600_000,
  });
  const scTab = SC_TABS.find((t) => t.key === sc) ?? SC_TABS[0];
  const rows = useMemo(() => {
    const list = [...(q.data?.rows ?? [])];
    if (sortByMatch && profile) {
      list.sort((a, b) => listMatch(profile, b) - listMatch(profile, a));
    }
    return list;
  }, [q.data, sortByMatch, profile]);

  return (
    <section>
      <div className="mb-2 flex flex-wrap gap-2">
        {FT_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setFt(t.key)}
            className={`rounded-full px-3.5 py-1.5 text-sm ${
              ft === t.key
                ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                : "border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {SC_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSc(t.key)}
            className={`rounded-full px-3 py-1 text-xs ${
              sc === t.key
                ? "bg-[var(--text)] text-[var(--bg)]"
                : "bg-[var(--surface2)] text-[var(--dim)]"
            }`}
          >
            {t.label}
          </button>
        ))}
        {profile && (
          <button
            type="button"
            onClick={() => setSortByMatch((v) => !v)}
            className={`rounded-full px-3 py-1 text-xs ${
              sortByMatch
                ? "bg-[var(--amber)] text-white"
                : "bg-[var(--surface2)] text-[var(--dim)]"
            }`}
          >
            按与我的匹配度排序
          </button>
        )}
      </div>
      {q.data && (
        <p className="mb-2 text-xs text-[var(--dim)]">
          共 {q.data.total.toLocaleString()} 只 · 净值日期 {q.data.asOf ?? "暂无数据"} · 按{scTab?.label}收益排序
        </p>
      )}
      {q.isPending && <p className="py-8 text-center text-[var(--dim)]">加载排行中…</p>}
      {q.isError && <p className="py-8 text-center text-[var(--dim)]">排行加载失败，请稍后重试</p>}
      <ol className="divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {rows.map((r, i) => (
          <li key={r.code} className="flex items-center gap-2 px-4 py-3">
            <span className="w-6 shrink-0 text-center text-sm text-[var(--dim)]">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => onOpenFund(r.code)}
              >
                <span className="block truncate font-medium text-[var(--text)]">{r.name}</span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  {r.code} · {r.type || "暂无分类"}
                </span>
              </button>
              {r.managerName &&
                (r.managerId ? (
                  <button
                    type="button"
                    aria-label={`查看基金经理${r.managerName}的主页`}
                    onClick={() => {
                      if (r.managerId) onOpenManager(r.managerId);
                    }}
                    className="mt-0.5 text-xs text-[var(--accent)] underline decoration-dotted underline-offset-2"
                  >
                    经理 {r.managerName} ›
                  </button>
                ) : (
                  <span className="mt-0.5 block text-xs text-[var(--dim)]">经理 {r.managerName}</span>
                ))}
            </div>
            {profile && <MatchBadge score={listMatch(profile, r)} />}
            <span className="shrink-0 text-right">
              <span className={`block tabular-nums font-semibold ${pctColor(r[scTab?.field ?? "y1"] as number | null)}`}>
                {fmtPct(r[scTab?.field ?? "y1"] as number | null)}
              </span>
              <span className="block text-xs tabular-nums text-[var(--dim)]">
                净值 {r.nav?.toFixed(4) ?? "暂无数据"}
              </span>
            </span>
            <button
              type="button"
              aria-label={basketCodes.has(r.code) ? `将${r.name}移出对比` : `将${r.name}加入对比`}
              onClick={() => onAddCompare({ code: r.code, name: r.name })}
              className={`shrink-0 rounded-lg px-2.5 py-1.5 text-sm ${
                basketCodes.has(r.code)
                  ? "bg-[var(--surface2)] text-[var(--dim)]"
                  : "bg-[var(--accent)] text-[var(--accent-ink)]"
              }`}
            >
              {basketCodes.has(r.code) ? "已加入" : "+ 对比"}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

type CoverageStats = ApiResponse<typeof api, "getCoverageStats">;

function CoveragePanel() {
  const q = useQuery({
    queryKey: ["coverage-stats"],
    queryFn: () => api.getCoverageStats({}),
    staleTime: 600_000,
  });
  const c: CoverageStats | undefined = q.data;
  if (q.isPending) {
    return <p className="mt-4 text-sm text-[var(--dim)]">正在统计全量补全进度…</p>;
  }
  if (!c) return null;
  const themesCovered = c.themePool.filter((t) => t.items > 0).length;
  const poolItems = c.themePool.reduce((a, t) => a + t.items, 0);
  const viewsDone = c.managersViewsCollected + c.managersViewsSearchedNone;
  const pct = (done: number, total: number) =>
    total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 0;
  const Bar = ({ done, total }: { done: number; total: number }) => (
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface2)]">
      <div
        className="h-full rounded-full bg-[var(--accent)]"
        style={{ width: `${pct(done, total)}%` }}
      />
    </div>
  );
  return (
    <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="font-display text-lg font-bold text-[var(--text)]">全量资料补全进度</h3>
      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
        目标：全部 {c.totalManagers.toLocaleString()} 位经理、{c.totalFunds.toLocaleString()} 只基金。定期报告清单与影响因素由公开数据自动生成、全量可达；经理观点与报告展望摘录按在管规模每天分批检索推进；基金新闻改为按因子主题统一收录的新闻池，映射到每只受影响的基金。
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <p className="text-sm text-[var(--text)]">
            经理观点：已收录 {c.managersViewsCollected.toLocaleString()} 位 · 已检索暂无公开报道{" "}
            {c.managersViewsSearchedNone.toLocaleString()} 位 · 待推进 {c.managersViewsPending.toLocaleString()} 位
          </p>
          <Bar done={viewsDone} total={c.totalManagers} />
        </div>
        <div>
          <p className="text-sm text-[var(--text)]">
            报告展望摘录：已覆盖 {c.managersStatementsCollected.toLocaleString()} 位经理
            {c.managersStatementsSearchedNone > 0
              ? ` · 已检索未取得摘录 ${c.managersStatementsSearchedNone.toLocaleString()} 位`
              : ""}
          </p>
          <Bar
            done={c.managersStatementsCollected + c.managersStatementsSearchedNone}
            total={c.totalManagers}
          />
        </div>
        <div>
          <p className="text-sm text-[var(--text)]">
            因子新闻池：{themesCovered}/{c.themePool.length} 个主题已收录，共 {poolItems} 条
            {c.fundsWithDirectNews > 0
              ? ` · 另有 ${c.fundsWithDirectNews} 只基金有专项收录新闻`
              : ""}
          </p>
          <p className="mt-1 text-xs text-[var(--dim)]">
            {c.themePool
              .map((t) => `${t.label} ${t.items}`)
              .join(" · ")}
          </p>
        </div>
      </div>
      {c.lastBatchAt && (
        <p className="mt-3 text-xs text-[var(--dim)]">
          最近一批推进：{c.lastBatchAt.slice(0, 10)}
          {c.lastBatchManagers.length > 0 ? `（${c.lastBatchManagers.join("、")}）` : ""}
        </p>
      )}
    </div>
  );
}

function CategoriesView({ onPick }: { onPick: (ft: string) => void }) {
  const meta = useQuery({
    queryKey: ["home-meta"],
    queryFn: () => api.getHomeMeta({}),
    staleTime: 3600_000,
  });
  const cats: { key: string; label: string; desc: string; count: number | null }[] = [
    { key: "gp", label: "股票型", desc: "股票仓位高，弹性大、波动也大", count: meta.data?.counts.gp ?? null },
    { key: "hh", label: "混合型", desc: "股债灵活配置，最看经理能力", count: meta.data?.counts.hh ?? null },
    { key: "zq", label: "债券型", desc: "以债券打底，追求稳健票息", count: meta.data?.counts.zq ?? null },
    { key: "zs", label: "指数型", desc: "跟踪指数，费率低、风格透明", count: meta.data?.counts.zs ?? null },
    { key: "qdii", label: "QDII", desc: "投资海外市场，分散单一市场风险", count: meta.data?.counts.qdii ?? null },
    { key: "fof", label: "FOF", desc: "一篮子基金的基金，二次分散", count: meta.data?.counts.fof ?? null },
  ];
  return (
    <section>
      <p className="mb-3 text-sm text-[var(--dim)]">
        全市场共 {meta.data ? meta.data.fundCount.toLocaleString() : "…"} 只基金、{meta.data ? meta.data.managerCount.toLocaleString() : "…"} 位基金经理在册。点任意分类看该类排行。
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {cats.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick(c.key)}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left"
          >
            <span className="font-display block text-xl font-bold text-[var(--text)]">{c.label}</span>
            <span className="mt-1 block text-sm text-[var(--dim)]">{c.desc}</span>
            <span className="mt-2 block text-xs text-[var(--dim)]">
              {c.count != null ? `共 ${c.count.toLocaleString()} 只` : "统计中…"}
            </span>
          </button>
        ))}
      </div>
      <CoveragePanel />
    </section>
  );
}

// ---------------------------------------------------------------------------
// benchmark comparison （上证指数 / 沪深300 / 纳斯达克100 / 标普500）
// ---------------------------------------------------------------------------

const BENCH_SERIES: { key: "fund" | "sh" | "hs300" | "ndx" | "spx"; label: string; color: string }[] = [
  { key: "fund", label: "本基金", color: "var(--accent)" },
  { key: "sh", label: "上证指数", color: "#b97f16" },
  { key: "hs300", label: "沪深300", color: "#2563eb" },
  { key: "ndx", label: "纳指", color: "#9333ea" },
  { key: "spx", label: "标普500", color: "#db2777" },
];

type BenchRange = "1y" | "3y" | "5y" | "all";

function FundBenchmarkSection({ code }: { code: string }) {
  const q = useQuery({
    queryKey: ["fund-benchmarks", code],
    queryFn: () => api.getFundBenchmarks({ code }),
    staleTime: 3600_000,
  });
  const [range, setRange] = useState<BenchRange>("3y");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const data: FundBenchmarks | undefined = q.data;

  // window slice + rebase every series to 100 at the window start
  const chart = useMemo(() => {
    if (!data || data.series.length === 0) return null;
    const all = data.series;
    const lastRow = all[all.length - 1];
    if (!lastRow) return null;
    let rows = all;
    if (range !== "all") {
      const years = range === "1y" ? 1 : range === "3y" ? 3 : 5;
      const end = new Date(`${lastRow.date}T00:00:00Z`);
      end.setUTCFullYear(end.getUTCFullYear() - years);
      const cutoff = end.toISOString().slice(0, 10);
      rows = all.filter((r) => r.date >= cutoff);
      if (rows.length < 2) rows = all;
    }
    const rebased: { date: string; values: Record<string, number | null> }[] = rows.map((r) => ({
      date: r.date,
      values: { fund: r.fund, sh: r.sh, hs300: r.hs300, ndx: r.ndx, spx: r.spx },
    }));
    for (const s of BENCH_SERIES) {
      const firstIdx = rebased.findIndex((r) => r.values[s.key] != null);
      if (firstIdx < 0) continue;
      const base = rebased[firstIdx]?.values[s.key] ?? null;
      if (base == null || base <= 0) continue;
      for (const r of rebased) {
        const v = r.values[s.key];
        r.values[s.key] = v != null ? Math.round((v / base) * 10000) / 100 : null;
      }
    }
    let min = Infinity;
    let max = -Infinity;
    for (const r of rebased) {
      for (const s of BENCH_SERIES) {
        const v = r.values[s.key];
        if (v != null) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      min = 90;
      max = 110;
    }
    const pad = (max - min) * 0.06;
    return { rows: rebased, min: min - pad, max: max + pad };
  }, [data, range]);

  const sel: BenchItem | undefined = useMemo(() => {
    if (!data) return undefined;
    if (selKey) return data.benchmarks.find((b) => b.key === selKey) ?? data.benchmarks[0];
    const best = [...data.benchmarks].sort((a, b) => b.beatStreak - a.beatStreak)[0];
    return best && best.beatStreak > 0 ? best : data.benchmarks[1] ?? data.benchmarks[0];
  }, [data, selKey]);

  const fmt1 = (v: number | null | undefined) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const fmtExcess = (v: number | null | undefined) =>
    v == null ? "" : `差 ${v >= 0 ? "+" : ""}${v.toFixed(1)}`;

  const W = 720;
  const H = 240;
  const padB = 22;
  const plotW = W - 12;
  const plotH = H - 10 - padB;
  const geom = useMemo(() => {
    if (!chart) return null;
    const n = chart.rows.length;
    const x = (i: number) => 6 + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v: number) => 10 + ((chart.max - v) / (chart.max - chart.min)) * plotH;
    const pathOf = (key: string) => {
      const segs: string[] = [];
      let cur: string[] = [];
      chart.rows.forEach((r, i) => {
        const v = r.values[key];
        if (v == null) {
          if (cur.length > 1) segs.push(`M${cur.join(" L")}`);
          cur = [];
        } else {
          cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        }
      });
      if (cur.length > 1) segs.push(`M${cur.join(" L")}`);
      return segs.join(" ");
    };
    const ticks = [0, 1, 2, 3].map((k) => chart.min + ((chart.max - chart.min) * k) / 3);
    const dateIdx = [0, 0.33, 0.66, 1].map((f) => Math.min(n - 1, Math.max(0, Math.round(f * (n - 1)))));
    return { x, y, pathOf, ticks, dateIdx, n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart]);

  const dispI = chart ? Math.min(chart.rows.length - 1, Math.max(0, hover ?? chart.rows.length - 1)) : 0;
  const dispRow = chart?.rows[dispI];
  const periodRows = useMemo(() => {
    if (!data) return [];
    const first = data.benchmarks[0];
    if (!first) return [];
    const rows = first.periods.map((p, i) => ({
      label: p.label,
      fund: p.fund,
      cells: data.benchmarks.map((b) => b.periods[i] ?? null),
    }));
    rows.push({
      label: "成立来",
      fund: first.sinceStart.fund,
      cells: data.benchmarks.map((b) => ({
        key: "since",
        label: "成立来",
        fund: b.sinceStart.fund,
        index: b.sinceStart.index,
        excess: b.sinceStart.excess,
      })),
    });
    return rows;
  }, [data]);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="font-display text-lg font-bold text-[var(--text)]">与大盘指数对比</h3>
      <p className="mt-1 text-xs text-[var(--dim)]">
        对比对象：上证指数、沪深300、纳斯达克100（纳指）、标普500 · 指数收盘价来自东方财富行情
        {data?.fundLatestDate ? ` · 基金净值截至 ${data.fundLatestDate}` : ""}
      </p>
      {q.isPending && <p className="mt-3 text-sm text-[var(--dim)]">正在拉取四大指数历史收盘价并对齐计算…</p>}
      {q.isError && <p className="mt-3 text-sm text-[var(--dim)]">指数对比加载失败，请稍后重试</p>}
      {data && data.series.length === 0 && (
        <p className="mt-3 text-sm text-[var(--dim)]">暂无足够净值历史生成指数对比</p>
      )}
      {data && chart && geom && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {(
              [
                { key: "1y", label: "近1年" },
                { key: "3y", label: "近3年" },
                { key: "5y", label: "近5年" },
                { key: "all", label: "成立来" },
              ] as { key: BenchRange; label: string }[]
            ).map((r) => (
              <button
                key={r.key}
                type="button"
                aria-label={`走势区间 ${r.label}`}
                onClick={() => setRange(r.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                  range === r.key
                    ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                    : "bg-[var(--surface2)] text-[var(--dim)]"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {BENCH_SERIES.map((s) => {
              const lastV = [...chart.rows].reverse().find((r) => r.values[s.key] != null)?.values[s.key];
              return (
                <span key={s.key} className="flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-4 rounded-full" style={{ background: s.color }} />
                  <span className="text-[var(--text)]">{s.label}</span>
                  <span className="tabular-nums" style={{ color: lastV != null && lastV - 100 >= 0 ? "var(--rise)" : "var(--fall)" }}>
                    {lastV != null ? fmt1(lastV - 100) : "—"}
                  </span>
                </span>
              );
            })}
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="mt-1 w-full touch-pan-y select-none"
            role="img"
            aria-label="基金与四大指数归一化走势对比图"
            onPointerMove={(e) => {
              const rect = svgRef.current?.getBoundingClientRect();
              if (!rect || !chart) return;
              const vx = ((e.clientX - rect.left) / rect.width) * W;
              const i = Math.round(((vx - 6) / plotW) * (chart.rows.length - 1));
              setHover(Math.min(chart.rows.length - 1, Math.max(0, i)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            {geom.ticks.map((t, i) => (
              <g key={i}>
                <line x1={6} x2={W - 6} y1={geom.y(t)} y2={geom.y(t)} stroke="var(--border)" strokeWidth={0.6} />
                <text x={W - 8} y={geom.y(t) - 3} textAnchor="end" fontSize={11} fill="var(--dim)">
                  {t.toFixed(0)}
                </text>
              </g>
            ))}
            {BENCH_SERIES.map((s) => (
              <path key={s.key} d={geom.pathOf(s.key)} fill="none" stroke={s.color} strokeWidth={s.key === "fund" ? 2.4 : 1.5} />
            ))}
            {dispRow && (
              <line
                x1={geom.x(dispI)}
                x2={geom.x(dispI)}
                y1={10}
                y2={10 + plotH}
                stroke="var(--dim)"
                strokeWidth={0.8}
                strokeDasharray="3 3"
              />
            )}
            {geom.dateIdx.map((di, i) => {
              const row = chart.rows[di];
              if (!row) return null;
              return (
                <text
                  key={i}
                  x={geom.x(di)}
                  y={H - 6}
                  textAnchor={i === 0 ? "start" : i === geom.dateIdx.length - 1 ? "end" : "middle"}
                  fontSize={11}
                  fill="var(--dim)"
                >
                  {row.date.slice(0, 7)}
                </text>
              );
            })}
          </svg>
          <p className="text-xs tabular-nums text-[var(--dim)]">
            {dispRow ? `${dispRow.date}：` : ""}
            {BENCH_SERIES.map((s, i) => {
              const v = dispRow?.values[s.key];
              return (
                <span key={s.key}>
                  {i > 0 ? " · " : ""}
                  {s.label} {v != null ? fmt1(v - 100) : "—"}
                </span>
              );
            })}
            <span className="ml-1">（区间涨跌，起点归一为 0%）</span>
          </p>

          <div className="mt-4 overflow-x-auto">
            <div className="min-w-[430px]">
              <div className="grid grid-cols-[52px_repeat(5,1fr)] gap-x-1 border-b border-[var(--border)] pb-1.5 text-xs text-[var(--dim)]">
                <span>区间</span>
                <span className="text-right">本基金</span>
                {data.benchmarks.map((b) => (
                  <span key={b.key} className="text-right">{b.short}</span>
                ))}
              </div>
              {periodRows.map((r) => (
                <div key={r.label} className="grid grid-cols-[52px_repeat(5,1fr)] gap-x-1 border-b border-[var(--border)] py-1.5 text-xs last:border-0">
                  <span className="text-[var(--dim)]">{r.label}</span>
                  <span className="text-right font-medium tabular-nums" style={{ color: pctColor(r.fund) }}>{fmt1(r.fund)}</span>
                  {r.cells.map((c, ci) => (
                    <span key={ci} className="text-right tabular-nums">
                      <span style={{ color: pctColor(c?.index) }}>{fmt1(c?.index)}</span>
                      {c?.excess != null && (
                        <span className="block text-[10px] leading-tight text-[var(--dim)]">{fmtExcess(c.excess)}</span>
                      )}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-xs text-[var(--dim)]">「差」为本基金涨跌幅减去该指数涨跌幅（百分点），为正即跑赢。</p>

          {sel && (
            <div className="mt-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-sm font-medium text-[var(--text)]">逐年对比</span>
                {data.benchmarks.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    aria-label={`逐年对比 ${b.name}`}
                    onClick={() => setSelKey(b.key)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                      sel.key === b.key
                        ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                        : "bg-[var(--surface2)] text-[var(--dim)]"
                    }`}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-sm text-[var(--text)]">
                {sel.beatStreak >= 2
                  ? `截至最近一个完整年度，已连续 ${sel.beatStreak} 年跑赢${sel.name}`
                  : sel.yearsCompared > 0
                    ? `最近一个完整年度${sel.years.find((y) => y.complete && y.full)?.beat ? "跑赢" : "未跑赢"}${sel.name}；可比的 ${sel.yearsCompared} 个完整年度中跑赢 ${sel.yearsBeaten} 次${sel.longestBeatStreak >= 2 ? `，最长连续跑赢 ${sel.longestBeatStreak} 年` : ""}`
                    : `与${sel.name}暂无完整年度可比数据`}
              </p>
              <ul className="mt-1 divide-y divide-[var(--border)]">
                {sel.years.map((y) => (
                  <li key={y.year} className="flex items-baseline justify-between gap-2 py-1.5 text-sm">
                    <span className="shrink-0 text-[var(--text)]">
                      {y.year} 年
                      {!y.complete && <span className="ml-1 text-xs text-[var(--dim)]">今年以来</span>}
                      {y.complete && !y.full && <span className="ml-1 text-xs text-[var(--dim)]">成立首年</span>}
                    </span>
                    <span className="text-right tabular-nums text-[var(--dim)]">
                      基金 <span style={{ color: pctColor(y.fund) }}>{fmt1(y.fund)}</span>
                      {" · "}{sel.short} <span style={{ color: pctColor(y.index) }}>{fmt1(y.index)}</span>
                    </span>
                    <span
                      className={`w-12 shrink-0 text-right text-xs font-medium ${
                        y.beat == null ? "text-[var(--dim)]" : y.beat ? "text-[var(--accent)]" : "text-[var(--dim)]"
                      }`}
                    >
                      {y.beat == null ? "—" : y.beat ? `跑赢 ${Math.abs(y.excess ?? 0).toFixed(1)}` : `跑输 ${Math.abs(y.excess ?? 0).toFixed(1)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4">
            <p className="text-sm font-medium text-[var(--text)]">指数对比分析</p>
            {data.isBondOrMoney && (
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
                本基金为债券/货币型，与股票指数的风险收益特征不同：熊市年份跑赢股指多因股指下跌，不代表权益投资能力；以下对比仅作市场背景参考。
              </p>
            )}
            <ul className="mt-1.5 space-y-2">
              {data.benchmarks.map((b) => (
                <li key={b.key}>
                  <p className="text-sm font-medium text-[var(--text)]">{b.name}</p>
                  {b.insights.length > 0 ? (
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-[var(--dim)]">
                      {b.insights.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-0.5 text-sm text-[var(--dim)]">数据不足，暂无法与该指数对比</p>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">{data.methodology}</p>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// fund detail
// ---------------------------------------------------------------------------

function MetricCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl bg-[var(--surface2)] px-3 py-2.5">
      <p className="text-xs text-[var(--dim)]">{label}</p>
      <p className={`mt-0.5 text-base font-semibold tabular-nums ${color ?? "text-[var(--text)]"}`}>{value}</p>
    </div>
  );
}

function FundNewsSection({ code }: { code: string }) {
  const facQ = useQuery({
    queryKey: ["fund-factors", code],
    queryFn: () => api.getFundFactors({ code }),
    staleTime: 3600_000,
  });
  const newsQ = useQuery({
    queryKey: ["fund-news", code],
    queryFn: () => api.getFundNews({ code }),
    staleTime: 600_000,
  });
  const triedRef = useRef(false);
  const [collecting, setCollecting] = useState(false);
  useEffect(() => {
    if (!newsQ.data || triedRef.current) return;
    const stale =
      !newsQ.data.updatedAt ||
      Date.now() - new Date(newsQ.data.updatedAt).getTime() > 20 * 3600 * 1000;
    if (newsQ.data.items.length === 0 || stale) {
      triedRef.current = true;
      api
        .ensureFundNews({ code })
        .then((r) => setCollecting(r.started))
        .catch(() => undefined);
    }
  }, [newsQ.data, code]);
  const fac: FundFactors | undefined = facQ.data;
  const news: FundNewsData | undefined = newsQ.data;
  return (
    <>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold text-[var(--text)]">影响因素</h3>
        <p className="mt-1 text-xs text-[var(--dim)]">
          基于本基金真实持仓与类型（{fac?.categoryLabel ?? "读取中"})
          {fac?.holdingsDate ? ` · 持仓截至 ${fac.holdingsDate}` : ""}自动生成
        </p>
        {facQ.isPending && <p className="mt-2 text-sm text-[var(--dim)]">正在分析持仓与因子…</p>}
        {facQ.isError && <p className="mt-2 text-sm text-[var(--dim)]">影响因素加载失败，请稍后重试</p>}
        {fac && (
          <ul className="mt-2 space-y-3">
            {fac.factors.map((x) => (
              <li key={x.name}>
                <p className="text-sm font-medium text-[var(--text)]">{x.name}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">{x.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold text-[var(--text)]">相关新闻</h3>
        <p className="mt-1 text-xs text-[var(--dim)]">
          按上述影响因子从全市场「因子新闻池」映射（新闻按因子主题统一收录、每日更新），并含针对本基金持仓的专项收录；关联说明按本基金的因子画像生成
          {news?.updatedAt ? ` · 最近更新 ${news.updatedAt.slice(0, 10)}` : ""}
        </p>
        {newsQ.isPending && <p className="mt-2 text-sm text-[var(--dim)]">正在读取相关新闻…</p>}
        {news && news.items.length === 0 && (
          <div className="mt-2">
            <p className="text-sm text-[var(--dim)]">暂无相关新闻</p>
            <p className="mt-1 text-xs text-[var(--dim)]">
              {collecting
                ? "已按本基金的影响因子启动专项检索，约几分钟后刷新页面可见。"
                : "本基金的因子主题暂未匹配到近期新闻；新闻池每日更新，打开本页也会触发一次专项检索。"}
            </p>
          </div>
        )}
        {news && news.items.length > 0 && (
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {news.items.map((n) => (
              <li key={n.url} className="py-2.5">
                <p className="text-xs text-[var(--dim)]">
                  {n.date} · {n.source}
                </p>
                <a
                  href={n.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 block text-sm font-medium leading-snug text-[var(--text)] underline-offset-2 hover:underline"
                >
                  {n.title}
                </a>
                <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                  <span className="text-[var(--accent)]">与本基金的关联：</span>
                  {n.relation}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-[var(--dim)]">
          新闻引自公开财经媒体报道，关联说明基于本基金真实持仓与类型生成，不代表平台立场，不构成投资建议。
        </p>
      </div>
    </>
  );
}

function FundDetailView({
  code,
  profile,
  onOpenManager,
  onAddCompare,
  basketCodes,
  onBack,
}: {
  code: string;
  profile: Profile | null;
  onOpenManager: (id: string) => void;
  onAddCompare: (item: BasketItem) => void;
  basketCodes: Set<string>;
  onBack: () => void;
}) {
  const q = useQuery({
    queryKey: ["fund", code],
    queryFn: () => api.getFundDetail({ code }),
    staleTime: 3600_000,
  });
  const f = q.data?.fund;
  const match = f && profile ? detailMatch(profile, f) : null;
  return (
    <section>
      <button type="button" onClick={onBack} className="mb-3 text-sm text-[var(--accent)]">
        ← 返回
      </button>
      {q.isPending && <p className="py-10 text-center text-[var(--dim)]">正在拉取真实净值与持仓数据…</p>}
      {q.isError && <p className="py-10 text-center text-[var(--dim)]">该基金详情加载失败，请稍后重试</p>}
      {f && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="font-display text-2xl font-bold text-[var(--text)]">{f.name}</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              {f.code} · {f.type ?? "暂无分类"} · {f.company ?? "暂无公司信息"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {styleTags(f).map((t) => (
                <span key={t} className="rounded-full bg-[var(--surface2)] px-2.5 py-1 text-xs text-[var(--text)]">
                  {t}
                </span>
              ))}
              {match && <MatchBadge score={match.score} />}
            </div>
            <p className="mt-3 text-sm text-[var(--dim)]">
              最新净值 {f.latestNav?.toFixed(4) ?? "暂无数据"}（{f.latestNavDate ?? "暂无日期"}）
            </p>
            <button
              type="button"
              onClick={() => onAddCompare({ code: f.code, name: f.name })}
              className={`mt-3 rounded-xl px-4 py-2.5 text-sm font-medium ${
                basketCodes.has(f.code)
                  ? "bg-[var(--surface2)] text-[var(--dim)]"
                  : "bg-[var(--accent)] text-[var(--accent-ink)]"
              }`}
            >
              {basketCodes.has(f.code) ? "已在对比篮中（点击移出）" : "加入对比"}
            </button>
          </div>

          <FundKlineChart code={code} />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricCell label="昨日涨跌" value={fmtPct(f.periodReturns.day)} color={pctColor(f.periodReturns.day)} />
            <MetricCell label="近3日" value={fmtPct(f.periodReturns.d3)} color={pctColor(f.periodReturns.d3)} />
            <MetricCell label="近1周" value={fmtPct(f.periodReturns.w1)} color={pctColor(f.periodReturns.w1)} />
            <MetricCell label="近1月" value={fmtPct(f.periodReturns.m1)} color={pctColor(f.periodReturns.m1)} />
            <MetricCell label="近3月" value={fmtPct(f.syl3m)} color={pctColor(f.syl3m)} />
            <MetricCell label="近6月" value={fmtPct(f.syl6m)} color={pctColor(f.syl6m)} />
            <MetricCell label="近1年" value={fmtPct(f.syl1y)} color={pctColor(f.syl1y)} />
            <MetricCell label="最大回撤（历史实算）" value={f.maxDrawdown != null ? `${f.maxDrawdown.toFixed(1)}%` : "暂无数据"} />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricCell label="年化波动（近1年实算）" value={f.volatility != null ? `${f.volatility.toFixed(1)}%` : "暂无数据"} />
            <MetricCell label="股票仓位（测算）" value={f.stockPosition != null ? `${f.stockPosition.toFixed(1)}%` : "暂无数据"} />
            <MetricCell label="申购费率" value={f.rate != null ? `${f.rate.toFixed(2)}%` : "暂无数据"} />
            <MetricCell label="规模" value={f.scaleYi != null ? `${f.scaleYi.toFixed(1)} 亿元` : "暂无数据"} />
          </div>

          <FundBenchmarkSection code={code} />

          {match && (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <h3 className="font-display text-lg font-bold text-[var(--text)]">与你的画像匹配度 {match.score} 分</h3>
              <ul className="mt-2 space-y-1.5 text-sm">
                {match.reasons.map((r, i) => (
                  <li key={i} className={r.good ? "text-[var(--fall)]" : "text-[var(--rise)]"}>
                    {r.good ? "✓ " : "⚠ "}
                    <span className="text-[var(--text)]">{r.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-display text-lg font-bold text-[var(--text)]">基金详细分析</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{styleParagraph(f)}</p>
            {holdingsParagraph(f) && (
              <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{holdingsParagraph(f)}</p>
            )}
            <p className="mt-2 text-xs text-[var(--dim)]">基于公开数据计算：净值历史、股票仓位测算与定期报告披露持仓。</p>

            {f.holdings.length === 0 && (
              <p className="mt-3 text-sm text-[var(--dim)]">暂无持仓数据（该基金最新一期披露中未取得股票或债券持仓明细）</p>
            )}

            {f.holdings.length > 0 && f.holdingsKind === "stock" && f.stockPosition != null && (
              <div className="mt-4">
                <p className="text-sm font-medium text-[var(--text)]">资产大类构成（仓位测算）</p>
                <div className="mt-2 space-y-2">
                  {[
                    { label: "股票", pct: f.stockPosition },
                    { label: "债券、现金及其他资产（100% − 股票仓位）", pct: Math.max(0, 100 - f.stockPosition) },
                  ].map((r) => (
                    <div key={r.label} className="flex items-center gap-2 text-sm">
                      <span className="w-40 shrink-0 text-[var(--dim)]">{r.label}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
                        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, Math.max(0, r.pct)).toFixed(1)}%` }} />
                      </div>
                      <span className="w-14 shrink-0 text-right tabular-nums text-[var(--text)]">{r.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {f.holdings.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-[var(--text)]">
                  {f.holdingsKind === "bond" ? "持仓债券类型构成" : "持仓股票类型构成（行业）"}
                  <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                    仅统计已披露的前 {f.holdings.length} 大持仓，权重为占基金净值比例
                  </span>
                </p>
                <div className="mt-2 space-y-2">
                  {groupHoldings(f).map((g) => (
                    <div key={g.label} className="flex items-center gap-2 text-sm">
                      <span className="w-32 shrink-0 truncate text-[var(--dim)]" title={g.label}>{g.label}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface2)]">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${f.concentration && f.concentration > 0 ? Math.min(100, (g.weight / f.concentration) * 100).toFixed(1) : 0}%` }}
                        />
                      </div>
                      <span className="w-24 shrink-0 text-right tabular-nums text-[var(--text)]">
                        {g.weight.toFixed(2)}%
                        {f.concentration && f.concentration > 0 && (
                          <span className="text-xs text-[var(--dim)]"> · 占前十大 {((g.weight / f.concentration) * 100).toFixed(0)}%</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
                  {f.holdingsKind === "bond"
                    ? "债券类型按债券名称关键词归类（国债 / 政策性金融债 / 商业银行债 / 信用债等），仅供快速了解持仓构成。"
                    : "行业为东方财富对每只个股的行业分类；未取得分类的个股单列为「未分类」。"}
                </p>
                {f.holdingsKind === "stock" && marketMixOf(f).length > 1 && (
                  <p className="mt-2 text-sm text-[var(--dim)]">
                    市场分布：
                    {marketMixOf(f).map((m, i) => (
                      <span key={m.label}>
                        {i > 0 ? "、" : ""}
                        {m.label} <span className="tabular-nums text-[var(--text)]">{m.weight.toFixed(1)}%</span>
                      </span>
                    ))}
                    <span className="text-xs">（前十大内占净值比例）</span>
                  </p>
                )}
              </div>
            )}

            {f.holdings.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-[var(--text)]">
                  前十大{f.holdingsKind === "bond" ? "债券持仓" : "重仓股"}
                  {f.holdingsDate ? `（截至 ${f.holdingsDate}）` : ""}
                </p>
                <ul className="mt-1 divide-y divide-[var(--border)]">
                  {f.holdings.map((h) => {
                    const maxW = Math.max(1, ...f.holdings.map((x) => x.weight ?? 0));
                    return (
                      <li key={`${h.code}-${h.name}`} className="py-2 text-sm">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 text-[var(--text)]">
                            {h.name} <span className="text-[var(--dim)]">{h.code}</span>
                            {f.holdingsKind === "stock" && (
                              <span className="ml-1.5 rounded bg-[var(--surface2)] px-1.5 py-0.5 text-xs text-[var(--dim)]">
                                {marketLabelOf(h)}
                                {h.industry ? ` · ${h.industry}` : ""}
                              </span>
                            )}
                            {f.holdingsKind === "bond" && (
                              <span className="ml-1.5 rounded bg-[var(--surface2)] px-1.5 py-0.5 text-xs text-[var(--dim)]">
                                {bondKindOf(h.name)}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums text-[var(--text)]">
                            {h.weight != null ? `${h.weight.toFixed(2)}%` : "暂无数据"}
                          </span>
                        </div>
                        {h.weight != null && (
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface2)]">
                            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${((h.weight / maxW) * 100).toFixed(1)}%` }} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {f.concentration != null && (
                  <p className="mt-2 text-xs text-[var(--dim)]">前十大合计占净值 {f.concentration.toFixed(1)}%</p>
                )}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-display text-lg font-bold text-[var(--text)]">现任基金经理</h3>
            {f.managers.length === 0 && <p className="mt-2 text-sm text-[var(--dim)]">暂无数据</p>}
            <div className="mt-2 space-y-4">
              {f.managers.map((m) => (
                <div key={m.id}>
                  <button
                    type="button"
                    aria-label={`查看基金经理${m.name}的主页`}
                    onClick={() => m.id && onOpenManager(m.id)}
                    className="text-left"
                  >
                    <span className="text-base font-medium text-[var(--accent)] underline decoration-dotted underline-offset-4">{m.name}</span>
                    <span className="ml-2 text-sm text-[var(--dim)]">
                      任职 {m.workTime ?? "暂无数据"} · 管理规模 {m.fundSize ?? "暂无数据"}
                    </span>
                    <span className="ml-2 text-sm text-[var(--accent)]">查看主页 ›</span>
                  </button>
                  <div className="mt-2">
                    <PowerBars cats={m.powerCats} data={m.powerData} avg={m.powerAvg} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <FundNewsSection code={code} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// manager detail
// ---------------------------------------------------------------------------

function ManagerInsightsSection({
  id,
  repCode,
  funds,
}: {
  id: string;
  repCode: string;
  funds: { code: string; name: string }[];
}) {
  const fundOptions =
    funds.length > 0 ? funds : repCode ? [{ code: repCode, name: repCode }] : [];
  const [reportCode, setReportCode] = useState<string>(
    repCode || fundOptions[0]?.code || "",
  );
  const insQ = useQuery({
    queryKey: ["mgr-insights", id],
    queryFn: () => api.getManagerInsights({ id }),
    staleTime: 600_000,
  });
  const repQ = useQuery({
    queryKey: ["fund-reports", reportCode],
    queryFn: () => api.getFundReports({ code: reportCode }),
    staleTime: 3600_000,
    enabled: reportCode.length === 6,
  });
  const triedRef = useRef(false);
  const [collecting, setCollecting] = useState(false);
  useEffect(() => {
    if (!insQ.data || triedRef.current) return;
    if (
      insQ.data.views.length === 0 &&
      insQ.data.statements.length === 0 &&
      (insQ.data.viewsStatus === "pending" || insQ.data.statementsStatus === "pending")
    ) {
      triedRef.current = true;
      api
        .ensureManagerInsights({ id })
        .then((r) => setCollecting(r.started))
        .catch(() => undefined);
    }
  }, [insQ.data, id]);
  const ins: ManagerInsights | undefined = insQ.data;
  const reports = repQ.data?.reports ?? [];
  const kindStyle = (kind: string) =>
    kind === "年度报告"
      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
      : "bg-[var(--surface2)] text-[var(--text)]";
  return (
    <>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold text-[var(--text)]">定期报告与展望</h3>
        <p className="mt-1 text-xs text-[var(--dim)]">
          报告原文来自天天基金公告披露；展望摘录引自报告原文中基金经理的运作分析与展望章节
        </p>

        {ins && ins.statements.length > 0 && (
          <div className="mt-3 space-y-2">
            {ins.statements.map((s) => (
              <div key={`${s.fundCode}-${s.period}`} className="rounded-xl bg-[var(--surface2)] p-3">
                <p className="text-xs text-[var(--dim)]">
                  <span className={`mr-1.5 rounded-md px-1.5 py-0.5 font-medium ${kindStyle(s.kind)}`}>
                    {s.kind}
                  </span>
                  {s.period} · {s.fundName} · {s.date} 发布
                </p>
                <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{s.excerpt}</p>
                <p className="mt-2 text-xs text-[var(--dim)]">
                  摘自报告「{s.section}」 ·{" "}
                  <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)]">
                    查看报告原文
                  </a>
                </p>
              </div>
            ))}
          </div>
        )}
        {ins && ins.statements.length === 0 && (
          <p className="mt-2 text-xs text-[var(--dim)]">
            {collecting
              ? "展望摘录正在检索整理中，约几分钟后刷新可见；下方可先打开报告原文。"
              : ins.statementsStatus === "searched_none"
                ? "已检索其代表基金最新一期定期报告，暂未取得可摘录的展望原文；下方可打开报告原文查看基金经理的运作分析与展望。"
                : "暂未收录展望摘录：全量补全按经理在管规模分批推进中，可从下方打开报告原文查看基金经理的运作分析与展望。"}
          </p>
        )}

        <div className="mt-4">
          <label htmlFor={`rep-fund-${id}`} className="text-xs text-[var(--dim)]">
            选择在管基金查看其定期报告
          </label>
          <select
            id={`rep-fund-${id}`}
            value={reportCode}
            onChange={(e) => setReportCode(e.target.value)}
            className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          >
            {fundOptions.map((f) => (
              <option key={f.code} value={f.code}>
                {f.name}（{f.code}）
              </option>
            ))}
          </select>
          {repQ.isPending && <p className="mt-2 text-sm text-[var(--dim)]">正在读取公告披露…</p>}
          {repQ.isError && <p className="mt-2 text-sm text-[var(--dim)]">报告列表加载失败，请稍后重试</p>}
          {repQ.data && reports.length === 0 && (
            <p className="mt-2 text-sm text-[var(--dim)]">该基金暂无定期报告记录</p>
          )}
          {reports.length > 0 && (
            <ul className="mt-1 divide-y divide-[var(--border)]">
              {reports.map((r) => (
                <li key={r.id} className="py-2.5">
                  <p className="text-xs text-[var(--dim)]">
                    <span className={`mr-1.5 rounded-md px-1.5 py-0.5 font-medium ${kindStyle(r.kind)}`}>
                      {r.kind}
                    </span>
                    {r.period} · 发布于 {r.publishDate}
                  </p>
                  <a
                    href={r.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block text-sm font-medium leading-snug text-[var(--text)] underline-offset-2 hover:underline"
                  >
                    {r.title}
                  </a>
                  <a
                    href={r.pdfUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-0.5 inline-block text-xs text-[var(--accent)]"
                  >
                    官方 PDF 原文 →
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold text-[var(--text)]">观点动态</h3>
        <p className="mt-1 text-xs text-[var(--dim)]">
          近期公开采访、发言与署名观点，收录自主流财经媒体与基金公司官方渠道，每周更新
          {ins?.updatedAt ? ` · 最近收录 ${ins.updatedAt.slice(0, 10)}` : ""}
        </p>
        {insQ.isPending && <p className="mt-2 text-sm text-[var(--dim)]">正在读取观点收录…</p>}
        {insQ.isError && <p className="mt-2 text-sm text-[var(--dim)]">观点动态加载失败，请稍后重试</p>}
        {ins && ins.views.length === 0 && (
          <div className="mt-2">
            <p className="text-sm text-[var(--dim)]">
              {ins.viewsStatus === "searched_none" ? "已检索，暂无公开报道收录" : "暂无收录"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              {ins.viewsStatus === "searched_none"
                ? "已检索该经理近 12 个月的公开采访、发言与署名文章，暂未找到可溯源的公开报道——这是检索后的如实结论；后续有新报道时会随每周更新补入。"
                : "全量补全进行中：全部基金经理按在管规模与热度排序、每天分批检索收录，自选与排行榜经理优先；打开本页也会即时触发针对该经理的检索。"}
              {collecting ? "已启动对该经理的检索，约几分钟后刷新页面可见。" : ""}
            </p>
            {!collecting && ins.viewsStatus !== "searched_none" && (
              <button
                type="button"
                onClick={() => {
                  api
                    .ensureManagerInsights({ id })
                    .then((r) => setCollecting(r.started))
                    .catch(() => undefined);
                }}
                className="mt-2 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent-ink)]"
              >
                检索收录该经理的公开观点
              </button>
            )}
          </div>
        )}
        {ins && ins.views.length > 0 && (
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {ins.views.map((v) => (
              <li key={v.url} className="py-2.5">
                <p className="text-xs text-[var(--dim)]">
                  {v.date} · {v.source}
                </p>
                <a
                  href={v.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 block text-sm font-medium leading-snug text-[var(--text)] underline-offset-2 hover:underline"
                >
                  {v.title}
                </a>
                <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">{v.summary}</p>
                {v.quote && (
                  <p className="mt-1.5 border-l-2 border-[var(--accent)] pl-2.5 text-sm leading-relaxed text-[var(--dim)]">
                    「{v.quote}」
                    <span className="ml-1 text-xs">（引自原文）</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-[var(--dim)]">
          本区内容引自公开报道与定期报告，不代表平台立场，不构成投资建议。
        </p>
      </div>
    </>
  );
}

function ManagerDetailView({
  id,
  onOpenFund,
  onAddCompare,
  basketCodes,
  onBack,
}: {
  id: string;
  onOpenFund: (code: string) => void;
  onAddCompare: (item: BasketItem) => void;
  basketCodes: Set<string>;
  onBack: () => void;
}) {
  const q = useQuery({
    queryKey: ["manager", id],
    queryFn: () => api.getManagerDetail({ id }),
    staleTime: 3600_000,
  });
  const m: ManagerDetail | undefined = q.data?.manager;
  const styleBits: string[] = [];
  if (m) {
    const rm = m.repMetrics;
    if (rm.stockPosition != null) {
      styleBits.push(
        rm.stockPosition >= 80
          ? `其代表基金 ${m.repName} 股票仓位约 ${rm.stockPosition.toFixed(0)}%，属于高仓位运作型`
          : `其代表基金 ${m.repName} 股票仓位约 ${rm.stockPosition.toFixed(0)}%，仓位有主动调整空间`,
      );
    }
    if (rm.concentration != null) {
      styleBits.push(
        rm.concentration >= 50
          ? `前十大重仓合计占净值 ${rm.concentration.toFixed(1)}%，持仓集中、敢下重注`
          : `前十大重仓合计占净值 ${rm.concentration.toFixed(1)}%，持仓集中度适中偏分散`,
      );
    }
    if (rm.maxDrawdown != null && rm.volatility != null) {
      styleBits.push(
        `代表基金历史最大回撤 ${rm.maxDrawdown.toFixed(1)}%、近一年年化波动 ${rm.volatility.toFixed(1)}%，${rm.volatility >= 26 ? "进攻性强" : rm.volatility >= 14 ? "攻守相对均衡" : "风格偏稳健"}`,
      );
    }
    const types = [...new Set(m.funds.map((x) => x.type).filter(Boolean))];
    if (types.length > 0) styleBits.push(`在管产品覆盖：${types.slice(0, 4).join("、")}`);
  }
  return (
    <section>
      <button type="button" onClick={onBack} className="mb-3 text-sm text-[var(--accent)]">
        ← 返回
      </button>
      {q.isPending && <p className="py-10 text-center text-[var(--dim)]">正在整理经理档案…</p>}
      {q.isError && <p className="py-10 text-center text-[var(--dim)]">经理档案加载失败，请稍后重试</p>}
      {m && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="font-display text-3xl font-bold text-[var(--text)]">{m.name}</h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              {m.company} · 任职 {m.workTime ?? tenureText(m.tenureDays)} · 管理规模 {m.scale || "暂无数据"}
              {m.star != null ? ` · 东方财富评级 ${m.star} 星` : ""}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <MetricCell label="任期最佳回报" value={m.bestReturn || "暂无数据"} />
              <MetricCell label="在管基金" value={`${m.funds.length} 只`} />
              <MetricCell label="从业年限" value={m.workTime ?? tenureText(m.tenureDays)} />
            </div>
            {m.bio ? (
              <p className="mt-3 text-sm leading-relaxed text-[var(--text)]">{m.bio}</p>
            ) : (
              <p className="mt-3 text-sm text-[var(--dim)]">暂无公开简介</p>
            )}
            <p className="mt-2 text-xs text-[var(--dim)]">简介来源：天天基金基金经理公开档案</p>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-display text-lg font-bold text-[var(--text)]">能力五维（东方财富评分）</h3>
            <div className="mt-3">
              <PowerBars cats={m.powerCats} data={m.powerData} avg={m.powerAvg} />
            </div>
            {m.profitCats.length > 0 && (
              <div className="mt-3 space-y-1 text-sm">
                {m.profitCats.map((c, i) => (
                  <p key={c} className="flex justify-between">
                    <span className="text-[var(--dim)]">{c}</span>
                    <span className={`tabular-nums font-medium ${pctColor(m.profitData[i])}`}>
                      {fmtPct(m.profitData[i] ?? null)}
                    </span>
                  </p>
                ))}
                <p className="text-xs text-[var(--dim)]">任期收益对比（代表基金口径）</p>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-display text-lg font-bold text-[var(--text)]">投资风格（基于公开数据计算）</h3>
            {styleBits.length > 0 ? (
              <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{styleBits.join("。")}。</p>
            ) : (
              <p className="mt-2 text-sm text-[var(--dim)]">暂无足够数据生成风格分析</p>
            )}
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-display text-lg font-bold text-[var(--text)]">在管基金（{m.funds.length} 只）</h3>
            <ul className="mt-2 divide-y divide-[var(--border)]">
              {m.funds.map((f) => (
                <li key={f.code} className="flex items-center gap-2 py-2.5">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenFund(f.code)}>
                    <span className="block truncate font-medium text-[var(--text)]">{f.name}</span>
                    <span className="block text-xs text-[var(--dim)]">{f.code} · {f.type || "暂无分类"}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={basketCodes.has(f.code) ? `将${f.name}移出对比` : `将${f.name}加入对比`}
                    onClick={() => onAddCompare({ code: f.code, name: f.name })}
                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-sm ${
                      basketCodes.has(f.code)
                        ? "bg-[var(--surface2)] text-[var(--dim)]"
                        : "bg-[var(--accent)] text-[var(--accent-ink)]"
                    }`}
                  >
                    {basketCodes.has(f.code) ? "已加入" : "+ 对比"}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <ManagerInsightsSection id={id} repCode={m.repCode} funds={m.funds} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

interface CompareRow {
  label: string;
  get: (f: FundDetail) => number | null;
  format: (v: number | null) => string;
  better: "high" | "low";
  colorPct?: boolean;
}

const COMPARE_ROWS: CompareRow[] = [
  { label: "近1月收益", get: (f) => f.syl1m, format: (v) => fmtPct(v), better: "high", colorPct: true },
  { label: "近3月收益", get: (f) => f.syl3m, format: (v) => fmtPct(v), better: "high", colorPct: true },
  { label: "近6月收益", get: (f) => f.syl6m, format: (v) => fmtPct(v), better: "high", colorPct: true },
  { label: "近1年收益", get: (f) => f.syl1y, format: (v) => fmtPct(v), better: "high", colorPct: true },
  { label: "最大回撤（实算）", get: (f) => f.maxDrawdown, format: (v) => (v == null ? "暂无数据" : `${v.toFixed(1)}%`), better: "low" },
  { label: "年化波动（实算）", get: (f) => f.volatility, format: (v) => (v == null ? "暂无数据" : `${v.toFixed(1)}%`), better: "low" },
  { label: "申购费率", get: (f) => f.rate, format: (v) => (v == null ? "暂无数据" : `${v.toFixed(2)}%`), better: "low" },
  { label: "股票仓位", get: (f) => f.stockPosition, format: (v) => (v == null ? "暂无数据" : `${v.toFixed(0)}%`), better: "high" },
  { label: "前十持仓集中度", get: (f) => f.concentration, format: (v) => (v == null ? "暂无数据" : `${v.toFixed(1)}%`), better: "low" },
  { label: "规模（亿元）", get: (f) => f.scaleYi, format: (v) => (v == null ? "暂无数据" : v.toFixed(1)), better: "high" },
];

function bestIndex(funds: FundDetail[], row: CompareRow): number {
  let bi = -1;
  let bv = 0;
  funds.forEach((f, i) => {
    const v = row.get(f);
    if (v == null) return;
    if (bi < 0 || (row.better === "high" ? v > bv : v < bv)) {
      bi = i;
      bv = v;
    }
  });
  return bi;
}

function CompareView({
  basket,
  profile,
  onRemove,
  onOpenFund,
  onOpenManager,
  openProfile,
}: {
  basket: BasketItem[];
  profile: Profile | null;
  onRemove: (code: string) => void;
  onOpenFund: (code: string) => void;
  onOpenManager: (id: string) => void;
  openProfile: () => void;
}) {
  const codes = basket.map((b) => b.code);
  const ready = codes.length >= 2;
  const q = useQuery({
    queryKey: ["compare", [...codes].sort().join(",")],
    queryFn: () => api.compareFunds({ codes: codes as [string, string] }),
    enabled: ready,
    staleTime: 3600_000,
  });
  const funds = q.data?.funds ?? [];
  const advice = useMemo(
    () => (funds.length >= 2 ? buildAdvice(funds, profile) : null),
    [funds, profile],
  );

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-lg font-bold text-[var(--text)]">对比篮（{basket.length}/4）</h3>
        {basket.length === 0 && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            还没有选基金。用上方搜索，或在排行、经理页点「+ 对比」，凑齐 2 只就能开始深度对比。
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {basket.map((b) => (
            <span
              key={b.code}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface2)] py-1.5 pl-3 pr-1.5 text-sm text-[var(--text)]"
            >
              {b.name}
              <button
                type="button"
                aria-label={`将${b.name}移出对比篮`}
                onClick={() => onRemove(b.code)}
                className="rounded-full px-1.5 text-[var(--dim)]"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {basket.length === 1 && (
          <p className="mt-2 text-sm text-[var(--amber)]">再选 1 只就可以开始对比了。</p>
        )}
      </div>

      {ready && q.isPending && (
        <p className="py-8 text-center text-[var(--dim)]">正在拉取这几只基金的净值历史并实算回撤、波动…</p>
      )}
      {ready && q.isError && (
        <p className="py-8 text-center text-[var(--dim)]">对比数据加载失败，请稍后重试</p>
      )}

      {funds.length >= 2 && (
        <>
          <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-4 py-3 text-left font-medium text-[var(--dim)]">指标</th>
                  {funds.map((f) => (
                    <th key={f.code} className="px-3 py-3 text-left">
                      <button type="button" onClick={() => onOpenFund(f.code)} className="font-medium text-[var(--accent)]">
                        {f.name}
                      </button>
                      <span className="block text-xs font-normal text-[var(--dim)]">
                        {f.code} · {f.type ?? ""}
                      </span>
                      {profile && (
                        <span className="mt-1 block">
                          <MatchBadge score={detailMatch(profile, f).score} />
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => {
                  const bi = bestIndex(funds, row);
                  return (
                    <tr key={row.label} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-4 py-2.5 text-[var(--dim)]">{row.label}</td>
                      {funds.map((f, i) => {
                        const v = row.get(f);
                        return (
                          <td
                            key={f.code}
                            className={`px-3 py-2.5 tabular-nums ${
                              i === bi ? "font-bold" : ""
                            } ${row.colorPct ? pctColor(v) : "text-[var(--text)]"}`}
                          >
                            {row.format(v)}
                            {i === bi && v != null && (
                              <span className="ml-1 text-xs text-[var(--amber)]">★</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-4 py-2 text-xs text-[var(--dim)]">
              ★ 为该行最优值（收益/仓位/规模取最高，回撤/波动/费率/集中度取最低）；最大回撤与年化波动由净值历史在服务端实算。
            </p>
          </div>

          <div>
            <h3 className="font-display mb-3 text-xl font-bold text-[var(--text)]">基金经理正面对决</h3>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {funds.map((f) => {
                const m = f.managers[0];
                return (
                  <div key={f.code} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                    <p className="text-sm text-[var(--dim)]">{f.name}</p>
                    {m ? (
                      <>
                        <button
                          type="button"
                          aria-label={`查看基金经理${m.name}的主页`}
                          onClick={() => m.id && onOpenManager(m.id)}
                          className="font-display mt-0.5 text-xl font-bold text-[var(--accent)]"
                        >
                          {m.name}
                          <span className="ml-2 align-middle text-sm font-normal">查看主页 ›</span>
                        </button>
                        <p className="text-sm text-[var(--dim)]">
                          任职 {m.workTime ?? "暂无数据"} · 管理规模 {m.fundSize ?? "暂无数据"}
                        </p>
                        <div className="mt-3">
                          <PowerBars cats={m.powerCats} data={m.powerData} avg={m.powerAvg} />
                        </div>
                        {m.profitCats.length > 0 && (
                          <p className="mt-2 text-sm text-[var(--dim)]">
                            任期收益{" "}
                            <span className={`font-medium ${pctColor(m.profitData[0])}`}>
                              {fmtPct(m.profitData[0] ?? null)}
                            </span>
                            ，同期同类平均 {fmtPct(m.profitData[1] ?? null)}，沪深300 {fmtPct(m.profitData[2] ?? null)}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="mt-1 text-sm text-[var(--dim)]">暂无经理数据</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {styleTags(f).map((t) => (
                        <span key={t} className="rounded-full bg-[var(--surface2)] px-2 py-0.5 text-xs text-[var(--text)]">
                          {t}
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{styleParagraph(f)}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {advice && (
            <div className="rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface)] p-4">
              <h3 className="font-display text-xl font-bold text-[var(--text)]">AI 建议</h3>
              <p className="mt-1 text-xs text-[var(--dim)]">
                基于上面的真实指标（收益、实算回撤与波动、费率、经理能力评分）按规则生成，不构成投资建议。
              </p>
              {advice.personal ? (
                <div className="mt-3 rounded-xl bg-[var(--surface2)] p-3">
                  <p className="text-sm font-semibold text-[var(--text)]">按你的画像定制</p>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">{advice.personal.text}</p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={openProfile}
                  className="mt-3 rounded-xl bg-[var(--surface2)] px-3 py-2 text-sm text-[var(--accent)]"
                >
                  设置我的投资风格，建议会按你的风险偏好定制 →
                </button>
              )}
              <div className="mt-3 space-y-3">
                {advice.personas.map((p) => (
                  <div key={p.label}>
                    <p className="text-sm font-semibold text-[var(--text)]">如果你是：{p.label}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-[var(--text)]">{p.text}</p>
                  </div>
                ))}
              </div>
              {advice.warnings.length > 0 && (
                <div className="mt-3 space-y-1">
                  {advice.warnings.map((w, i) => (
                    <p key={i} className="text-sm text-[var(--rise)]">
                      ⚠ {w}
                    </p>
                  ))}
                </div>
              )}
              <div className="mt-4">
                <p className="text-sm font-semibold text-[var(--text)]">组合配比建议</p>
                <div className="mt-2 flex h-7 w-full overflow-hidden rounded-lg">
                  {advice.allocation.map((a, i) => (
                    <div
                      key={a.code}
                      className="flex items-center justify-center text-xs font-medium text-white"
                      style={{
                        width: `${a.pct}%`,
                        background: ["var(--accent)", "var(--amber)", "#5b7fa6", "#8a6fae"][i % 4],
                      }}
                    >
                      {a.pct}%
                    </div>
                  ))}
                </div>
                <ul className="mt-2 space-y-0.5 text-sm text-[var(--text)]">
                  {advice.allocation.map((a) => (
                    <li key={a.code}>
                      {a.name}：{a.pct} 份
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">{advice.allocationNote}</p>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// profile panel
// ---------------------------------------------------------------------------

function OptionRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-[var(--text)]">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-full px-3 py-1.5 text-sm ${
              value === o.value
                ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                : "bg-[var(--surface2)] text-[var(--dim)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProfilePanel({
  initial,
  onSave,
  onClear,
  onClose,
}: {
  initial: Profile | null;
  onSave: (p: Profile) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [p, setP] = useState<Profile>(
    initial ?? {
      risk: 3,
      maxDD: 20,
      sensitivity: 2,
      distribution: "balanced",
      singleCap: 50,
      horizon: "mid",
      goal: "steady",
    },
  );
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" role="dialog" aria-label="我的投资风格设置">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-5 sm:rounded-2xl">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-display text-xl font-bold text-[var(--text)]">我的投资风格</h3>
          <button type="button" onClick={onClose} aria-label="关闭设置" className="px-2 text-xl text-[var(--dim)]">
            ×
          </button>
        </div>
        <p className="mb-4 text-sm text-[var(--dim)]">
          完全自愿设置。设了之后，每只基金会多一个「与你匹配度」，对比建议和组合配比都会按你的画像来。只存在你这台设备的浏览器里。
        </p>
        <div className="space-y-4">
          <OptionRow
            label="风险承受能力"
            value={p.risk}
            onChange={(v) => setP({ ...p, risk: v })}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: RISK_LABELS[n] ?? String(n) }))}
          />
          <OptionRow
            label="最大能接受的回撤（最惨浮亏多少还拿得住）"
            value={p.maxDD}
            onChange={(v) => setP({ ...p, maxDD: v })}
            options={[5, 10, 15, 20, 30, 40].map((n) => ({ value: n, label: `${n}%` }))}
          />
          <OptionRow
            label="涨跌敏感度（跌多少就开始睡不着）"
            value={p.sensitivity}
            onChange={(v) => setP({ ...p, sensitivity: v })}
            options={[
              { value: 1, label: "心态稳，跌了正好加仓" },
              { value: 2, label: "一般，会看但不太慌" },
              { value: 3, label: "敏感，跌几个点就想赎回" },
            ]}
          />
          <OptionRow
            label="持仓分布偏好"
            value={p.distribution}
            onChange={(v) => setP({ ...p, distribution: v })}
            options={[
              { value: "concentrated" as const, label: "集中重仓少数基金" },
              { value: "balanced" as const, label: "均衡持有几只" },
              { value: "diversified" as const, label: "分散持有多只" },
            ]}
          />
          <OptionRow
            label="单只基金仓位上限"
            value={p.singleCap}
            onChange={(v) => setP({ ...p, singleCap: v })}
            options={[30, 40, 50, 70, 100].map((n) => ({ value: n, label: n === 100 ? "不限" : `${n}%` }))}
          />
          <OptionRow
            label="计划持有期限"
            value={p.horizon}
            onChange={(v) => setP({ ...p, horizon: v })}
            options={[
              { value: "short" as const, label: "1 年以内" },
              { value: "mid" as const, label: "1–3 年" },
              { value: "long" as const, label: "3 年以上" },
            ]}
          />
          <OptionRow
            label="投资目标"
            value={p.goal}
            onChange={(v) => setP({ ...p, goal: v })}
            options={[
              { value: "preserve" as const, label: "保值优先" },
              { value: "steady" as const, label: "稳健增值" },
              { value: "growth" as const, label: "追求成长" },
              { value: "aggressive" as const, label: "博取高收益" },
            ]}
          />
        </div>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => onSave(p)}
            className="flex-1 rounded-xl bg-[var(--accent)] py-3 font-medium text-[var(--accent-ink)]"
          >
            保存画像
          </button>
          {initial && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-xl bg-[var(--surface2)] px-4 py-3 text-[var(--dim)]"
            >
              清除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// main app
// ---------------------------------------------------------------------------

type View =
  | { kind: "leaders" }
  | { kind: "ranking" }
  | { kind: "categories" }
  | { kind: "compare" }
  | { kind: "manager"; id: string }
  | { kind: "fund"; code: string };

const TABS: { kind: View["kind"]; label: string }[] = [
  { kind: "leaders", label: "经理排行榜" },
  { kind: "ranking", label: "基金排行" },
  { kind: "categories", label: "基金分类" },
  { kind: "compare", label: "基金对比" },
];

export function App() {
  const [stack, setStack] = useState<View[]>([{ kind: "leaders" }]);
  const view = stack[stack.length - 1] ?? { kind: "leaders" as const };
  const [basket, setBasket] = useState<BasketItem[]>(loadBasket);
  const [profile, setProfile] = useState<Profile | null>(loadProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [rankFt, setRankFt] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const [themeKey, setThemeKey] = useState<string>(loadThemeKey);

  useEffect(() => {
    applyTheme(themeKey);
    try {
      localStorage.setItem(THEME_KEY, themeKey);
    } catch {
      // ignore
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => applyTheme(themeKey);
    mq.addEventListener("change", onScheme);
    return () => mq.removeEventListener("change", onScheme);
  }, [themeKey]);

  const meta = useQuery({
    queryKey: ["home-meta"],
    queryFn: () => api.getHomeMeta({}),
    staleTime: 3600_000,
  });

  const basketCodes = useMemo(() => new Set(basket.map((b) => b.code)), [basket]);

  useEffect(() => {
    try {
      localStorage.setItem(BASKET_KEY, JSON.stringify(basket));
    } catch {
      // ignore
    }
  }, [basket]);

  const push = (v: View) => setStack((s) => [...s, v]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const goTab = (kind: View["kind"]) => setStack([{ kind } as View]);

  const toggleBasket = (item: BasketItem) => {
    setBasket((prev) => {
      if (prev.some((b) => b.code === item.code)) {
        return prev.filter((b) => b.code !== item.code);
      }
      if (prev.length >= 4) return prev;
      return [...prev, item];
    });
  };

  const saveProfile = (p: Profile) => {
    setProfile(p);
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch {
      // ignore
    }
    setProfileOpen(false);
  };
  const clearProfile = () => {
    setProfile(null);
    try {
      localStorage.removeItem(PROFILE_KEY);
    } catch {
      // ignore
    }
    setProfileOpen(false);
  };

  const doRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg("");
    try {
      const r = await api.refreshData({});
      setRefreshMsg(`已更新：${r.fundCount.toLocaleString()} 只基金、${r.managerCount.toLocaleString()} 位经理`);
      meta.refetch();
    } catch {
      setRefreshMsg("更新失败，请稍后重试");
    } finally {
      setRefreshing(false);
    }
  };

  const isTabView = ["leaders", "ranking", "categories", "compare"].includes(view.kind);

  return (
    <div className="min-h-screen bg-[var(--bg)] pb-24">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--bg)]/95 pt-safe backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 pb-3 pt-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <SearchBar
                onOpenFund={(code) => push({ kind: "fund", code })}
                onOpenManager={(id) => push({ kind: "manager", id })}
                onAddCompare={toggleBasket}
                basketCodes={basketCodes}
              />
            </div>
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              className={`shrink-0 rounded-xl px-3 py-3 text-sm font-medium ${
                profile
                  ? "bg-[var(--amber)] text-white"
                  : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
              }`}
            >
              {profile ? `我的风格 · ${RISK_LABELS[profile.risk]}` : "我的投资风格"}
            </button>
          </div>
          <nav className="mt-3 flex gap-1" aria-label="主要板块">
            {TABS.map((t) => {
              const active = isTabView && view.kind === t.kind;
              return (
                <button
                  key={t.kind}
                  type="button"
                  onClick={() => goTab(t.kind)}
                  className={`flex-1 rounded-lg py-2 text-sm font-medium ${
                    active
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "text-[var(--dim)]"
                  }`}
                >
                  {t.label}
                  {t.kind === "compare" && basket.length > 0 ? ` (${basket.length})` : ""}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4">
        {!isTabView && view.kind === "fund" && (
          <FundDetailView
            code={view.code}
            profile={profile}
            onOpenManager={(id) => push({ kind: "manager", id })}
            onAddCompare={toggleBasket}
            basketCodes={basketCodes}
            onBack={back}
          />
        )}
        {!isTabView && view.kind === "manager" && (
          <ManagerDetailView
            id={view.id}
            onOpenFund={(code) => push({ kind: "fund", code })}
            onAddCompare={toggleBasket}
            basketCodes={basketCodes}
            onBack={back}
          />
        )}
        {view.kind === "leaders" && (
          <>
            <h1 className="font-display mb-1 text-2xl font-black text-[var(--text)]">
              先看人，再选基
            </h1>
            <p className="mb-4 text-sm text-[var(--dim)]">
              基金的长期业绩，归根结底是基金经理能力圈的定价——先从经理排行榜认识人，再看他管的基金。
            </p>
            <ThemePicker value={themeKey} onChange={setThemeKey} />
            <LeadersView
              onOpenManager={(id) => push({ kind: "manager", id })}
              onOpenFund={(code) => push({ kind: "fund", code })}
            />
          </>
        )}
        {view.kind === "ranking" && (
          <RankingView
            ft={rankFt}
            setFt={setRankFt}
            profile={profile}
            onOpenFund={(code) => push({ kind: "fund", code })}
            onOpenManager={(id) => push({ kind: "manager", id })}
            onAddCompare={toggleBasket}
            basketCodes={basketCodes}
          />
        )}
        {view.kind === "categories" && (
          <CategoriesView
            onPick={(ft) => {
              setRankFt(ft);
              goTab("ranking");
            }}
          />
        )}
        {view.kind === "compare" && (
          <CompareView
            basket={basket}
            profile={profile}
            onRemove={(code) => toggleBasket({ code, name: "" })}
            onOpenFund={(code) => push({ kind: "fund", code })}
            onOpenManager={(id) => push({ kind: "manager", id })}
            openProfile={() => setProfileOpen(true)}
          />
        )}
      </main>

      {basket.length > 0 && view.kind !== "compare" && (
        <button
          type="button"
          onClick={() => goTab("compare")}
          className="fixed inset-x-4 bottom-4 z-30 mx-auto max-w-5xl rounded-2xl bg-[var(--accent)] py-3.5 text-center font-medium text-[var(--accent-ink)] shadow-lg"
        >
          对比篮已有 {basket.length} 只{basket.length >= 2 ? "，点这里开始对比" : "，再选 1 只即可对比"}
        </button>
      )}

      <footer className="mx-auto max-w-5xl px-4 pb-8 pt-2 text-xs leading-relaxed text-[var(--dim)]">
        <p>
          数据来源：天天基金（东方财富）公开数据
          {meta.data?.latestNavDate ? ` · 最新净值日期 ${meta.data.latestNavDate}` : ""}
          {meta.data ? ` · 索引更新于 ${meta.data.indexUpdatedAt.slice(0, 10)}` : ""}。
          最大回撤与年化波动由净值历史实算；经理能力评分为东方财富公开评分；暂缺的字段显示「暂无数据」，不做估算填充。
        </p>
        <p className="mt-1">
          本平台仅提供信息展示与分析工具，不构成投资建议。基金过往业绩不预示未来表现，投资有风险，决策需谨慎。
        </p>
        <p className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={doRefresh}
            disabled={refreshing}
            className="rounded-lg bg-[var(--surface2)] px-3 py-1.5 text-xs text-[var(--text)]"
          >
            {refreshing ? "更新中…" : "手动更新数据"}
          </button>
          {refreshMsg && <span>{refreshMsg}</span>}
        </p>
      </footer>

      {profileOpen && (
        <ProfilePanel
          initial={profile}
          onSave={saveProfile}
          onClear={clearProfile}
          onClose={() => setProfileOpen(false)}
        />
      )}
    </div>
  );
}
