// dsh-butler-panel / lib/p4-learnings.mjs —— P4「会学习」露出面（日报两段：🕳 坑库 / 🩺 会话健康）
//
// 【为什么有这两个段】（卡「冲刺600·批1-4」，2026-10-09）
//   P4「会学习」的**主干真跑通**（tickd job `pitfall` 每 30 分钟 / 坑库 217 条 / 会话健康 1671 文件全 ok），
//   但**露出面缺两块**：日报里既没有坑库段（report.mjs 对 `pitfall`/坑库 零命中），也没有会话健康段
//   ⇒ 「学习链在跑」这件事除翻 state 文件外无人可见。本模块只补露出面，**不动 P4 本体**。
//
// 【纪律】
//   · **纯只读**：只 `readFileSync` 三个 state 文件；不写任何 state、不改坑库/健康数据、不发网络请求。
//   · **判定不复制**：权重与排序 = 唯一真源 `tools\dsh-butler\lib\pitfall-score.mjs` 的 `topN()`
//     （`score = 次数 × 0.5^(距末次出现天数/30)`，与开工记忆简报 Top 3 **同一份口径**）；本模块只渲染。
//   · **失败显式**：文件缺失 / 解析失败 ⇒ 显式成段（`❔ … 不可读 —— 这不是"…空/全健康"`），
//     绝不静默留空、绝不把读不到当 0（既有纪律：判定不可用必须显式出口）。
//   · 空态沿用日报既有写法：`- ⚪ **0 条**（空态 · …）`。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// 【2c · 2c-B5】状态路径统一入口（legacy 期与 path.join(dir, name) 逐字节相同）。
import { butlerLibPath, statePathResolver } from './butler-root.mjs';
const resolveStatePath = await statePathResolver();

export const P4_LEARNINGS_VERSION = '0.1.0';

/** 权重榜条数（与坑库索引「高频坑 Top 5」同数）。 */
export const P4_TOP_N = 5;
/** 损坏明细最多列几条（防刷屏）。 */
const CORRUPT_SHOW = 5;

/** DSH home 解析：与 report.mjs 同链（BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）。 */
function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 权重/排序库（唯一判定真源）。惰性加载：日报生成器与单测共用同一份实现。 */
let scoreLibCache = null;
async function loadScoreLib() {
  if (scoreLibCache) return scoreLibCache;
  const { pathToFileURL } = await import('node:url');
  scoreLibCache = await import(pathToFileURL(butlerLibPath('pitfall-score.mjs')).href);
  return scoreLibCache;
}

/**
 * 「历史种子」判据 —— 与 `tools\dsh-butler\lib\pitfall-render.mjs#isSeedPitfall` **逐条一致**
 * （此处内联：渲染链会拉起 paths/store/generated-docs 一堆模块，日报侧只为分类统计不值得）。
 */
export function isSeedPitfall(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.source === 'seed') return true;
  if (String(p.name ?? '') === 'seed') return true;
  return String(p.sigKey ?? '').startsWith('seed|');
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: `数据文件不存在（${file}）` };
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

const pad = (n) => String(n).padStart(2, '0');
/** 时间戳归一：epoch ms（数字）与 ISO 字符串（state 文件的 updatedAt 形态）都要吃。 */
function tsOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : NaN;
  if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; }
  return NaN;
}
/** `MM-DD HH:mm`（本地时区）；无效时间戳 → `—`。 */
function fmtMin(v) {
  const t = tsOf(v);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** `MM-DD`；无效时间戳 → `—`。 */
function fmtDay(v) {
  const t = tsOf(v);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 距今小时数文本（` · 0.2h 前`）；时间戳缺失 → 空串。 */
function ageText(v, now) {
  const t = tsOf(v);
  if (!Number.isFinite(t)) return '';
  const h = (Number(now) - t) / 3600000;
  if (!Number.isFinite(h)) return '';
  return ` · ${(h < 0 ? 0 : h).toFixed(1)}h 前`;
}
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, n);

/**
 * 只读采集（三份 state 文件）。永不抛错：每份各自 ok/reason，渲染侧据此出显式降级行。
 * @param {{home?:string, now?:number, topN?:number, scoreLib?:object}} [opts]
 */
export async function collectP4Learnings(opts = {}) {
  const dir = opts.home ?? dshHome();
  const now = Number(opts.now) || Date.now();
  const topN = Number(opts.topN) || P4_TOP_N;
  const out = { home: dir, now, pitfalls: null, candidates: null, health: null };

  // ① 坑库（~/.dsh/butler-pitfalls.json）
  const pfRes = readJson(path.join(dir, 'butler-pitfalls.json'));
  if (!pfRes.ok) {
    out.pitfalls = { ok: false, reason: pfRes.reason };
  } else {
    try {
      const list = Array.isArray(pfRes.data?.pitfalls) ? pfRes.data.pitfalls : [];
      const lib = opts.scoreLib ?? (await loadScoreLib());
      const ranked = lib.rankPitfalls(list, now);
      const live = ranked.filter((p) => !p.excluded);
      const seeds = live.filter(isSeedPitfall).length;
      out.pitfalls = {
        ok: true,
        total: ranked.length,
        clustered: live.length - seeds,
        seeds,
        excluded: ranked.length - live.length,
        top: lib.topN(list, topN, now),
        updatedAt: pfRes.data?.updatedAt ?? null,
        device: pfRes.data?.device ?? null,
        counters: pfRes.data?.counters ?? null,
      };
    } catch (e) {
      out.pitfalls = { ok: false, reason: String(e?.message ?? e) };
    }
  }

  // ② 升级候选（~/.dsh/butler-p4-candidates.json）
  const cdRes = readJson(resolveStatePath('butler-p4-candidates.json', { home: dir }).path);
  if (!cdRes.ok) {
    out.candidates = { ok: false, reason: cdRes.reason };
  } else {
    const list = Array.isArray(cdRes.data?.candidates) ? cdRes.data.candidates : [];
    const by = (s) => list.filter((c) => (c?.status ?? 'pending') === s).length;
    out.candidates = {
      ok: true, total: list.length,
      pending: by('pending'), adopted: by('adopted'), rejected: by('rejected'),
      generatedAt: cdRes.data?.generatedAt ?? null,
    };
  }

  // ③ 会话文件健康（~/.dsh/butler-sessions-health.json）
  const hRes = readJson(resolveStatePath('butler-sessions-health.json', { home: dir }).path);
  if (!hRes.ok) {
    out.health = { ok: false, reason: hRes.reason };
  } else {
    const files = (hRes.data?.files && typeof hRes.data.files === 'object') ? hRes.data.files : {};
    const entries = Object.entries(files);
    const s = hRes.data?.summary ?? {};
    const countBy = (k) => Number(s?.[k] ?? entries.filter(([, v]) => v?.status === k).length) || 0;
    const corrupt = entries.filter(([, v]) => v?.status === 'corrupt' || v?.status === 'unreadable');
    out.health = {
      ok: true,
      total: entries.length,
      summary: {
        ok: countBy('ok'), warn: countBy('warn'),
        corrupt: countBy('corrupt'), unreadable: countBy('unreadable'),
      },
      corruptSamples: corrupt.slice(0, CORRUPT_SHOW).map(([k, v]) => ({
        name: k, status: v?.status, frameErrors: v?.frameErrors ?? null,
        badLines: v?.badLines ?? null, file: v?.file ?? null,
      })),
      updatedAt: hRes.data?.updatedAt ?? null,
      device: hRes.data?.device ?? null,
    };
  }

  return out;
}

/**
 * 🕳 坑库段（含段标题与尾空行）。已采集状态 → 段文本行数组。
 * @param {object} state collectP4Learnings() 的返回值
 */
export function pitfallSectionLines(state) {
  const L = ['## 🕳 坑库（P4 会学习）', ''];
  const p = state?.pitfalls;
  if (!p?.ok) {
    L.push(`- ❔ 坑库数据不可读（${p?.reason ?? '未采集'}）—— 这不是"坑库为空"，学习链状态未知`);
    L.push('');
    return L;
  }
  L.push(`- 📚 坑库：**${p.total}** 条（会话聚类 ${p.clustered} · 历史种子 ${p.seeds}${p.excluded ? ` · 已剔除 ${p.excluded}` : ''}）· 数据更新 ${fmtMin(p.updatedAt)}｜权重 \`score = 次数 × 0.5^(距末次出现天数/30)\``);
  const top = p.top ?? [];
  if (!p.total || !top.length) {
    L.push('- ⚪ **0 条**（空态 · 坑库还没有条目）⇒ tickd job `pitfall` 还没扫到会话坑');
  } else {
    L.push(`- 🔥 权重 Top ${top.length}：`);
    top.forEach((x, i) => {
      const sig = oneLine(`${x.name ?? '?'}|${x.code ?? 'NO_CODE'}`, 60);
      const flag = x.likelyFixed ? ' · 🟡 疑似已修复' : x.stage === 'candidate' ? ' · 🚀 升级候选' : '';
      L.push(`  ${i + 1}. \`${sig}\` — ${x.count ?? 0} 次 / ${x.sessionCount ?? 0} 会话，score ${x.score ?? 0}，末次 ${fmtDay(x.lastSeen)}${flag}`);
      const sample = oneLine(x.normText, 120);
      if (sample) L.push(`     - 样本：\`${sample}${String(x.normText ?? '').length > 120 ? '…' : ''}\``);
    });
  }
  const c = state?.candidates;
  if (c?.ok) {
    L.push(`- 🚀 待采纳升级候选：**${c.pending}** 个（累计 ${c.total} · 已采纳 ${c.adopted}${c.rejected ? ` · 已忽略 ${c.rejected}` : ''}）→ 采纳/忽略入口 = 大管家面板「坑升级候选」（**永不自动改 persona / 技能**）`);
  } else {
    L.push(`- ❔ 升级候选数据不可读（${c?.reason ?? '未采集'}）`);
  }
  L.push(`- 指针：分主题坑库 \`docs\\坑库\\<主题>-<host>.md\`｜原始数据：坑库状态 + P4 候选池（状态目录下）`);
  L.push('');
  return L;
}

/**
 * 🩺 会话健康段（含段标题与尾空行）。数据源 = tickd job `pitfall` 每 30 分钟刷新的体检快照。
 * @param {object} state collectP4Learnings() 的返回值
 */
export function sessionHealthSectionLines(state) {
  const L = ['## 🩺 会话健康（P4 会学习）', ''];
  const h = state?.health;
  if (!h?.ok) {
    L.push(`- ❔ 会话健康数据不可读（${h?.reason ?? '未采集'}）—— 这不是"全部健康"`);
    L.push('');
    return L;
  }
  const s = h.summary ?? {};
  const bad = (s.corrupt ?? 0) + (s.unreadable ?? 0);
  const lv = bad ? '🔴' : ((s.warn ?? 0) ? '⚠️' : '✅');
  L.push(`- ${lv} 会话文件：**${h.total}** 个 —— ✅ ok ${s.ok ?? 0} · ⚠️ warn ${s.warn ?? 0} · 🔴 损坏 ${s.corrupt ?? 0} · ❔ 不可读 ${s.unreadable ?? 0}（本轮体检 ${fmtMin(h.updatedAt)}${ageText(h.updatedAt, state.now)}）`);
  for (const x of h.corruptSamples ?? []) {
    L.push(`  - 🔴 \`${x.name}\`：status=${x.status}${x.frameErrors ? ` · 帧错误 ${x.frameErrors}` : ''}${x.badLines ? ` · 坏行 ${x.badLines}` : ''}${x.file ? `（${x.file}）` : ''}`);
  }
  if (bad > (h.corruptSamples ?? []).length) L.push(`  - …另有 ${bad - (h.corruptSamples ?? []).length} 个`);
  L.push('- 口径：逐文件解压会话日志（读帧 / 坏行 / frameErrors），数据源 `~/.dsh/butler-sessions-health.json`（tickd job `pitfall` 每 30 分钟刷新）');
  L.push('');
  return L;
}
