// dsh-butler-panel / lib/p4-candidates.mjs —— 「坑升级候选」只读采集（面板「🐋 管家」Tab 一段）
//
// 【为什么有它】(2026-10-09 · 卡「冲刺600·批4-1 面板坑升级候选段」)
//   v2 方案 §P4（`docs\大管家v2方案-从只读到真管家-20260909.md` L798）明文要求面板提供
//   「坑升级候选」段（一键采纳 / 忽略），生产一直没做；而 `docs\坑库\*.md` 的自动条目
//   早已写「见面板「坑升级候选」」⇒ **生产文档指向一个不存在的界面（悬空指针）**。
//   本模块只做**只读采集与裁剪**（渲染在前端、动作在共享底座），不写任何文件。
//
// 【纪律】
//   · **纯只读**：只 readFileSync 一个 state 文件；不写盘、不发网络、不触发任何计算。
//   · 数据不可读 ⇒ 显式 `ok:false` + reason（**绝不把"读不到"当成"没有候选"**）。
//   · **动作不在本文件**：采纳 / 忽略走既有统一闸门 `POST /api/dsh-butler/v1/action`
//     （动作 id = `p4-candidate-adopt` / `p4-candidate-reject`，实现在共享底座
//      `tools\dsh-butler\lib\manual-actions.mjs`，真写由既有 CLI
//      `tools\dsh-butler\mark-p4-adopted.mjs` 完成 —— 本面板不另写第二套写库逻辑）。
//   · **硬红线**：绝不自动改 persona / 技能（A 层保护区，只能人工过 P5 门）。
//   · 契约体积：默认只回 **pending** 前 N 条（`P4_PENDING_CAP`），别把它做成第二个大契约片。

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './state.js';
// 【2c · 2c-B5】状态路径统一入口（legacy 期与 path.join(home, name) 逐字节相同）。
import { statePathResolver } from './butler-root.mjs';
const resolveStatePath = await statePathResolver();

export const P4_CANDIDATES_VERSION = '0.1.0';
/** 默认返回的 pending 条数上限（面板「管家」Tab 一段，够用即可）。 */
export const P4_PENDING_CAP = 30;
/** 上限硬顶（前端 `?limit=` 也超不过它）。 */
export const P4_PENDING_MAX = 100;
/** 文本裁剪长度（防单条刷屏）。 */
const SIG_CAP = 200;
const NORM_CAP = 160;
const WHY_CAP = 200;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 单条候选 → 面板契约形态（只带前端要渲染的字段；不含 sessions 数组等大字段）。 */
function shape(c) {
  return {
    id: c?.id ?? null,
    sigKey: clip(c?.sigKey, SIG_CAP),
    name: c?.name ?? null,
    code: c?.code ?? null,
    category: c?.category ?? null,
    count: Number(c?.count ?? 0),
    sessionCount: Number(c?.sessionCount ?? 0),
    score: Number(c?.score ?? 0),
    suggested: c?.suggested ?? null,
    why: clip(c?.why, WHY_CAP),
    options: Array.isArray(c?.options) ? c.options.map((o) => ({ id: o?.id ?? null, label: clip(o?.label, 60) })) : [],
    normText: clip(c?.normText, NORM_CAP),
    status: c?.status ?? 'pending',
    createdAt: c?.createdAt ?? null,
    decidedAt: c?.decidedAt ?? null,
    crossHost: c?.crossHost ?? null,
  };
}

/**
 * 只读采集候选池。**永不抛错**（失败 = `ok:false` + reason，调用方按显式降级渲染）。
 * @param {{home?:string, cap?:number, now?:number}} [opts]
 * @returns {{ok:boolean, file:string, asOf:number, cap:number, counts:object, items:object[],
 *            truncated?:boolean, pendingTotal?:number, generatedAt?:string|null, reason?:string, note?:string}}
 */
export function collectP4Candidates(opts = {}) {
  const dir = opts.home ?? dshHome();
  const file = resolveStatePath('butler-p4-candidates.json', { home: dir }).path;
  const asOf = Number(opts.now) || Date.now();
  const cap = Math.max(1, Math.min(Number(opts.cap) || P4_PENDING_CAP, P4_PENDING_MAX));
  const base = {
    file, asOf, cap,
    counts: { total: 0, pending: 0, adopted: 0, rejected: 0, other: 0 },
    items: [], truncated: false, pendingTotal: 0, generatedAt: null,
  };
  try {
    if (!fs.existsSync(file)) {
      return { ok: false, ...base, reason: `候选池不存在（${file}）—— P4 tickd job 还没产出` };
    }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(j?.candidates) ? j.candidates : [];
    const counts = { total: list.length, pending: 0, adopted: 0, rejected: 0, other: 0 };
    for (const c of list) {
      const s = c?.status ?? 'pending';
      if (s === 'pending' || s === 'adopted' || s === 'rejected') counts[s] += 1;
      else counts.other += 1;
    }
    const pending = list
      .filter((c) => (c?.status ?? 'pending') === 'pending')
      .sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
    const items = pending.slice(0, cap).map(shape);
    return {
      ok: true, ...base, counts, items,
      pendingTotal: pending.length, truncated: pending.length > items.length,
      generatedAt: j?.generatedAt ?? null,
      note: '采纳 / 忽略 = 标记候选池状态（写入口 = 既有 CLI mark-p4-adopted.mjs，带 RMW 锁 + 原子写 + 可回滚报告）；**绝不自动改 persona / 技能**',
      actions: {
        adopt: 'p4-candidate-adopt', reject: 'p4-candidate-reject',
        endpoint: '/api/dsh-butler/v1/action',
      },
    };
  } catch (e) {
    return { ok: false, ...base, reason: String(e?.message ?? e) };
  }
}
