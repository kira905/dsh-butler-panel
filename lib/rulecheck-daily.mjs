// dsh-butler-panel / lib/rulecheck-daily.mjs —— 日报「🧭 规矩体检」段（V3 地基 · 只进日报）
//
// 【由来】主人 2026-10-19 12:08 拍板：四件规矩（DoR 八条 / DoD 十条 / 缺陷分级 / 复盘+惯例）
//   升档 = **只进日报** —— 不拦卡、不推送手机、不改任何判据；observe 档观察 ≥2 周看误报率，
//   再谈是否升到"拦"。所以本文件**只做两件事**：只读取数 + 渲染 ≤6 行事实。
//
// 【红线（本卡 / 本模块）】
//   · 不拦卡：不碰看板账本、不改卡状态、不调任何写口；
//   · 不推送：不 import 任何 notify / push / 外部通道模块，不发网络请求（rulecheck 本身零网络）；
//   · 不改判据：判据一律来自 `tools\rulecheck.mjs` 的 `--json`（现跑），本文件**不复制**任何规则；
//   · 失败 fail-open：坏数据 / 超时 / 非 0 退出 ⇒ **整段不渲染**（不造假行、不拖垮日报其余段）。
//
// 【取数口径（写死，便于对照与复跑）】
//   · DoR   = `rulecheck dor --json` 的默认发现面（块格式生效日 2026-10-15 之后建的卡；存量不追溯）。
//   · DoD   = 近 7 日改过的 `docs\交付报告-*.md`（按 mtime 降序，单次最多 400 份 / 命令行字符预算内）。
//   · 缺陷分级 = 同一批报告（`rulecheck defect --json`；缺缺陷段 = 无缺陷要报，不判红）。
//   · 复盘  = 近 7 日改过的 `docs\复盘-*.md`；惯例 = `rulecheck practice --json --since <7 天前>`（其自身发现面）。
//   · 计数口径：只把「有勾选块」的记录计入 `勾 X/Y`；「无块」单独计数（避免把"没建块"混成"条条违规"）。
//   · 子进程 env 显式钉 `DSH_WORKSPACE` / `BUTLER_DSH_HOME`，保证与调用方（日报）读的是同一个 home / 工作区。
//
// 【开关】`~/.dsh/butler-autonomy.json` 的 `modules['rulecheck-daily']`（登记在
//   `tools\dsh-butler\lib\autonomy-modules.mjs#MODULE_IDS`，默认 on；变更走
//   `butler-autonomy-cli.mjs module on|off rulecheck-daily`）。off ⇒ 整段不出现（不是空行）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { workspaceRoot } from './butler-root.mjs';

export const RULECHECK_DAILY_VERSION = '0.1.0';
export const RULECHECK_DAILY_MODULE = 'rulecheck-daily';
/** 观察窗（天）：DoD / 缺陷 / 复盘 / 惯例的发现面 */
export const WINDOW_DAYS = 7;
/** 单次送入 rulecheck 的报告上限（双重闸：份数 + 命令行字符预算，防 Windows 32K 命令行上限） */
export const MAX_REPORT_FILES = 400;
export const ARGV_CHAR_BUDGET = 24000;
/** 单次子进程超时 / 全部子进程总预算 */
export const SUBPROCESS_TIMEOUT_MS = 20000;
export const TOTAL_BUDGET_MS = 45000;
/** 工具根（DSH_WORKSPACE 决定；夹具可注入），用于定位 rulecheck 与 autonomy-modules */
export const DEFAULT_TOOL_ROOT = workspaceRoot();
/** 判据条数（真源 = tools\lib\rulecheck-rules.mjs 的 DOR_ITEMS / DOD_ITEMS；此处只用于文案标签） */
export const DOR_ITEM_COUNT = 8;
export const DOD_ITEM_COUNT = 10;
/**
 * 「新报告带 DoD 块、旧的不追」生效日（主人 2026-10-19 令）：
 *   交付报告的 DoD / 缺陷分级发现面 = **该日 0 点之后**的报告；此前的存量报告**不追溯**
 *   （与 DoR 侧「块格式生效日之后的卡、存量不追溯」同口径）。
 */
export const DOD_BLOCK_SINCE_LABEL = '2026-10-19';
export const DOD_BLOCK_SINCE_MS = Date.parse(`${DOD_BLOCK_SINCE_LABEL}T00:00:00+08:00`);

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const stampStr = (ms) => {
  const d = new Date(ms);
  return `${dateStr(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 近 N 天改过的档（mtime），按新到旧；返回 {files, total, truncated} */
export function listRecentDocs(docsDir, prefix, cutoffMs, cap = MAX_REPORT_FILES) {
  let names = [];
  try { names = fs.readdirSync(docsDir); } catch { return { files: [], total: 0, truncated: false }; }
  const all = [];
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith('.md')) continue;
    const p = path.join(docsDir, n);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= cutoffMs) all.push({ p, m: st.mtimeMs });
    } catch { /* 读不到就跳过（不把坏档当 0） */ }
  }
  all.sort((a, b) => b.m - a.m);
  const picked = [];
  let chars = 0;
  for (const x of all) {
    if (picked.length >= cap) break;
    if (chars + x.p.length + 8 > ARGV_CHAR_BUDGET) break;
    picked.push(x.p);
    chars += x.p.length + 8;
  }
  return { files: picked, total: all.length, truncated: picked.length < all.length };
}

/**
 * 跑一次 rulecheck --json（只读子进程）。
 * @returns {{ok:true, json:object, ms:number}|{ok:false, reason:string}}
 */
export function runRulecheck(o) {
  const { rulecheckPath, cmd, args = [], workspace, home, timeoutMs = SUBPROCESS_TIMEOUT_MS, env } = o;
  if (!fs.existsSync(rulecheckPath)) return { ok: false, reason: `找不到 rulecheck：${rulecheckPath}` };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [rulecheckPath, cmd, '--json', ...args], {
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs),
    maxBuffer: 64 * 1024 * 1024,
    env: env ?? { ...process.env, DSH_WORKSPACE: workspace, BUTLER_DSH_HOME: home },
  });
  const ms = Date.now() - t0;
  if (r.error) return { ok: false, reason: `rulecheck ${cmd} 子进程失败：${r.error.code || r.error.message}` };
  if (r.status !== 0) {
    const tail = String(r.stderr || '').trim().split('\n').slice(-1)[0] || '';
    return { ok: false, reason: `rulecheck ${cmd} rc=${r.status}${tail ? `：${tail.slice(0, 160)}` : ''}` };
  }
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (e) {
    return { ok: false, reason: `rulecheck ${cmd} 输出不是 JSON：${String(e?.message ?? e).slice(0, 120)}` };
  }
  if (!json || json.tool !== 'rulecheck' || !Array.isArray(json.files)) {
    return { ok: false, reason: `rulecheck ${cmd} 输出形态不认（缺 tool/files）` };
  }
  return { ok: true, json, ms };
}

const countIssues = (recs) => (recs || []).reduce((a, r) => {
  for (const i of (r.issues || [])) {
    if (i.level === '🔴') a.red += 1;
    else if (i.level === '🟡') a.yellow += 1;
  }
  return a;
}, { red: 0, yellow: 0 });

/** 把「勾选块」类记录聚合成分档计数（DoR / DoD 共用） */
function sumChecklists(recs) {
  const acc = { records: recs.length, withBlock: 0, noBlock: 0, checked: 0, total: 0, red: 0, yellow: 0, redWithBlock: 0, redNoBlock: 0 };
  for (const r of recs) {
    const found = r?.meta?.blockFound === true;
    if (found) {
      acc.withBlock += 1;
      acc.checked += Number(r?.counts?.checked || 0);
      acc.total += Number(r?.counts?.total || 0);
    } else {
      acc.noBlock += 1;
    }
    const c = countIssues([r]);
    acc.red += c.red;
    acc.yellow += c.yellow;
    if (found) acc.redWithBlock += c.red; else acc.redNoBlock += c.red;
  }
  return acc;
}

const fmtChecklistRed = (a) => {
  if (!a.red) return '🔴 0';
  const parts = [];
  if (a.redNoBlock) parts.push(`无块 ${a.redNoBlock}`);
  if (a.redWithBlock) parts.push(`其他 ${a.redWithBlock}`);
  return `🔴 ${a.red}${parts.length ? `（${parts.join(' + ')}）` : ''}`;
};

/**
 * 只读取数（不读开关）。成功 ⇒ {ok:true, numbers, asOf, asOfLabel, ...}；任一子进程坏 ⇒ {ok:false, reason}。
 * @param {{workspace?:string, home?:string, toolRoot?:string, rulecheckPath?:string, now?:number,
 *          windowDays?:number, timeoutMs?:number, totalBudgetMs?:number}} [opts]
 */
export function collectRulecheckDaily(opts = {}) {
  const workspace = opts.workspace || process.env.DSH_WORKSPACE || DEFAULT_TOOL_ROOT;
  const home = opts.home || process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  const toolRoot = opts.toolRoot || DEFAULT_TOOL_ROOT;
  const rulecheckPath = opts.rulecheckPath || path.join(toolRoot, 'tools', 'rulecheck.mjs');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : WINDOW_DAYS;
  const cutoff = now - windowDays * 86400000;
  const deadline = Date.now() + (Number.isFinite(opts.totalBudgetMs) ? opts.totalBudgetMs : TOTAL_BUDGET_MS);
  const docsDir = path.join(workspace, 'docs');
  const timeoutFor = () => {
    const remain = deadline - Date.now();
    if (remain < 1000) return 0;
    return Math.min(Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : SUBPROCESS_TIMEOUT_MS, remain);
  };
  const base = { rulecheckPath, workspace, home };
  const run = (cmd, args) => {
    const t = timeoutFor();
    if (!t) return { ok: false, reason: `总预算 ${Math.round((Number.isFinite(opts.totalBudgetMs) ? opts.totalBudgetMs : TOTAL_BUDGET_MS) / 1000)}s 用尽（未跑 ${cmd}）` };
    return runRulecheck({ ...base, cmd, args, timeoutMs: t });
  };

  // ① DoR（默认发现面：块格式生效日之后的卡；存量不追溯）
  const dorRun = run('dor', []);
  if (!dorRun.ok) return { ok: false, reason: dorRun.reason };
  const dorRecs = dorRun.json.files || [];
  const dorSum = sumChecklists(dorRecs);
  const dorSince = dorRecs.find((r) => r?.discovery?.since)?.discovery?.since || null;

  // ② DoD / ③ 缺陷分级：**生效日之后**的报告（主人 2026-10-19 令「新报告带块 · 旧的不追」；
  //    与 DoR 侧「存量不追溯」同口径）；复盘 / 惯例对照仍按观察窗（WINDOW_DAYS），不受此限。
  const reportCutoff = Math.max(cutoff, DOD_BLOCK_SINCE_MS);
  // 「新报告」判据 = **文件名里的日期**（`交付报告-…-YYYYMMDD.md`）≥ 生效日，**不是 mtime**：
  //   否则「老报告今天被加一条订正注」会被误当成新报告（实测 2026-10-19：4 份 10-11~10-16 的旧报告
  //   因当日加注而 mtime 变新 ⇒ 被算进新报告分母并报「无块」）。无日期后缀的档退回 mtime 判据。
  const sinceStamp = Number(DOD_BLOCK_SINCE_LABEL.replace(/-/g, ''));
  const reportsRaw = listRecentDocs(docsDir, '交付报告-', reportCutoff);
  const newReportFiles = reportsRaw.files.filter((p) => {
    const m = /-(\d{8})\.md$/.exec(path.basename(p));
    return !m || Number(m[1]) >= sinceStamp;
  });
  const reports = { files: newReportFiles, total: newReportFiles.length, truncated: reportsRaw.truncated };
  let dodSum = { records: 0, withBlock: 0, noBlock: 0, checked: 0, total: 0, red: 0, yellow: 0, redWithBlock: 0, redNoBlock: 0 };
  let defectSum = { records: reports.total, sections: 0, P0: 0, P1: 0, P2: 0, P3: 0, red: 0, yellow: 0 };
  if (reports.files.length) {
    const dodRun = run('dod', reports.files.flatMap((f) => ['--file', f]));
    if (!dodRun.ok) return { ok: false, reason: dodRun.reason };
    dodSum = sumChecklists(dodRun.json.files || []);

    const defRun = run('defect', reports.files.flatMap((f) => ['--file', f]));
    if (!defRun.ok) return { ok: false, reason: defRun.reason };
    const defRecs = defRun.json.files || [];
    const dIss = countIssues(defRecs);
    defectSum = {
      records: defRecs.length,
      sections: defRecs.filter((r) => r?.meta?.sectionFound === true).length,
      P0: 0, P1: 0, P2: 0, P3: 0,
      red: dIss.red, yellow: dIss.yellow,
    };
    for (const r of defRecs) {
      const by = r?.counts?.byLevel || {};
      for (const k of ['P0', 'P1', 'P2', 'P3']) defectSum[k] += Number(by[k] || 0);
    }
  } else {
    dodSum.records = 0;
    defectSum = { records: 0, sections: 0, P0: 0, P1: 0, P2: 0, P3: 0, red: 0, yellow: 0 };
  }

  // ④ 复盘档（近 N 日改过）
  const postmortems = listRecentDocs(docsDir, '复盘-', cutoff, 100);
  let pmSum = { records: 0, red: 0, yellow: 0 };
  if (postmortems.files.length) {
    const pmRun = run('postmortem', postmortems.files.flatMap((f) => ['--file', f]));
    if (!pmRun.ok) return { ok: false, reason: pmRun.reason };
    const pmIss = countIssues(pmRun.json.files || []);
    pmSum = { records: (pmRun.json.files || []).length, red: pmIss.red, yellow: pmIss.yellow };
  }

  // ⑤ 惯例对照（rulecheck 自己的发现面：docs\方案-*.md 里 --since 之后改过的）
  const practiceRun = run('practice', ['--since', dateStr(cutoff)]);
  if (!practiceRun.ok) return { ok: false, reason: practiceRun.reason };
  const prRecs = practiceRun.json.files || [];
  const prIss = countIssues(prRecs);
  const practiceSum = {
    records: prRecs.length,
    withSection: prRecs.filter((r) => r?.meta?.sectionFound === true).length,
    red: prIss.red,
    yellow: prIss.yellow,
  };

  return {
    ok: true,
    asOf: new Date(now).toISOString(),
    asOfLabel: stampStr(now),
    windowDays,
    source: 'live',
    truncated: { reports: reports.truncated, reportsTotal: reports.total },
    numbers: { dor: { ...dorSum, since: dorSince }, dod: { ...dodSum, truncated: reports.truncated }, defect: defectSum, postmortem: pmSum, practice: practiceSum },
    timings: { dor: dorRun.ms },
  };
}

/**
 * 渲染 ≤6 行（含小标题与 asOf 行）；只报事实、不下命令。
 * @param {ReturnType<typeof collectRulecheckDaily>} data
 * @returns {string[]}
 */
export function renderRulecheckDailyLines(data) {
  if (!data || data.ok !== true) return [];
  const n = data.numbers;
  const since = n.dor.since || '2026-10-15';
  const repScope = `自 ${DOD_BLOCK_SINCE_LABEL} 起新增报告 ${n.defect.records} 份（存量不追溯）${n.dod.truncated ? `（窗口内共 ${data.truncated?.reportsTotal ?? n.defect.records} 份，最多取 ${MAX_REPORT_FILES}）` : ''}`;
  const L = [];
  L.push('## 🧭 规矩体检（V3 地基 · observe 档 · 只报事实）');
  L.push(`- DoR ${DOR_ITEM_COUNT} 条（开工就绪）· 生效日 ${since} 起卡 ${n.dor.records} 张 · 有块 ${n.dor.withBlock}（勾 ${n.dor.checked}/${n.dor.total}）· 无块 ${n.dor.noBlock} · ${fmtChecklistRed(n.dor)}`);
  L.push(`- DoD ${DOD_ITEM_COUNT} 条（交付自签）· ${repScope} · 有块 ${n.dod.withBlock}（勾 ${n.dod.checked}/${n.dod.total}）· 无块 ${n.dod.noBlock} · ${fmtChecklistRed(n.dod)}${n.dod.yellow ? ` · 🟡 ${n.dod.yellow}` : ''}`);
  L.push(`- 缺陷分级 · 同批报告（有缺陷段 ${n.defect.sections}）· P0 ${n.defect.P0} · P1 ${n.defect.P1} · P2 ${n.defect.P2} · P3 ${n.defect.P3}${n.defect.red ? ` · 🔴 ${n.defect.red}` : ''}${n.defect.yellow ? ` · 🟡 ${n.defect.yellow}` : ''}`);
  L.push(`- 复盘+惯例 · 近 ${data.windowDays} 日复盘档 ${n.postmortem.records} 份 · 方案档 ${n.practice.records} 份（有惯例对照 ${n.practice.withSection}）· 🔴 ${n.postmortem.red + n.practice.red} · 🟡 ${n.postmortem.yellow + n.practice.yellow}`);
  L.push(`- 数据：现跑 \`rulecheck\`（只读 · 无副作用）· asOf ${data.asOfLabel} · 只报事实（不拦卡 · 不推送手机 · 不改判据）`);
  return L;
}

/** 读模块开关（登记表缺失 / 未登记 ⇒ 判关，不渲染；读不到配置时 infra 走 baseline=开） */
export async function readRulecheckDailyGate(opts = {}) {
  const toolRoot = opts.toolRoot || DEFAULT_TOOL_ROOT;
  const home = opts.home || process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  const modFile = path.join(toolRoot, 'tools', 'dsh-butler', 'lib', 'autonomy-modules.mjs');
  const mod = await import(pathToFileURL(modFile).href);
  const r = mod.isModuleEnabled(RULECHECK_DAILY_MODULE, { home });
  return { enabled: r.enabled === true, known: r.known, source: r.source, reason: r.reason, label: r.label };
}

/**
 * 日报段唯一入口：先判开关，再取数，再渲染。
 * 任何一步失败 ⇒ {lines: [], reason}（**整段不出现**，绝不造假行/绝不拖垮日报）。
 * @returns {Promise<{lines:string[], reason?:string, data?:object, gate?:object}>}
 */
export async function rulecheckDailySection(opts = {}) {
  try {
    const gate = await readRulecheckDailyGate(opts);
    if (!gate.enabled) return { lines: [], reason: `开关关（${RULECHECK_DAILY_MODULE} · ${gate.reason}）`, gate };
    const data = collectRulecheckDaily(opts);
    if (!data.ok) return { lines: [], reason: `取数失败（fail-open 不渲染）：${data.reason}`, gate };
    return { lines: renderRulecheckDailyLines(data), data, gate };
  } catch (e) {
    return { lines: [], reason: `判定不可用（fail-open 不渲染）：${String(e?.message ?? e)}` };
  }
}
