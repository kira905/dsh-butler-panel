// dsh-butler-panel / lib / telemetry-guard.mjs —— 遥测档位巡检（**只读** · 纯库 · 0 token）
//
// 背景（主人 2026-09-23 拍板 D23）：**保留官方上传通道**（不注入 DSH_TELEMETRY_DISABLED）
//   + 加一个每天一次的**只读**巡检，防"档位被人/被升级偷改"。挂 daily job 的日报子段，
//   **不新建 tickd job**（所以不需要登记 lib/butler-locks.mjs 与 registry-audit 口径）。
//
// 四项判据（口径真源 = docs\点单表-大管家全家桶待拍板-20260923.md D23 段）：
//   ① 主包 patch 的 mode 行仍为 FEEDBACK_ONLY            （变了 ⇒ 🔴）
//   ② 四个启动入口**都没有**注入 DSH_TELEMETRY_DISABLED  （出现 ⇒ 🟡）
//   ③ 生产 dsh 进程的 DSH_TELEMETRY_MODE / _OTLP_URL / _DISABLED 是否为空（有值 ⇒ 🟡）
//   ④ $DSH_HOME\.anonymous-user-id 是否存在 + mtime       （**只记录**，不判异常）
//
// 诚实边界（**不许省**）：包内不写本地导出日志 ⇒ 本模块**只能报"档位是否被动过"，
//   不能报"今天具体传没传"**。段文案与报告都不许把"今天没传"编出来。
//
// 红线：**只读**；**fail-open 但 fail-loud** —— 读不到（文件不存在 / 正则不匹配 /
//   进程读不出）一律出 `status:'unavailable'` + 原因，**绝不当成正常**。
//   判据 ③ 尤其危险：进程环境块读不全时"三个变量都是空"是**假绿**，故用哨兵
//   （环境块里必须能看见 DSH_HOME 或 DSH_PERMISSION_MODE）+ 截断标记双重把关。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceRoot, importToolLib } from './butler-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 版本（单卡改造不升组件版本号；本常量仅供自描述与单测断言）。 */
export const TELEMETRY_GUARD_VERSION = '0.1.0';

/** 遥测行 id / 包名（主包 cordis.patch.yml 里的条目）。 */
export const TELEMETRY_ROW_ID = 'session-telemetry-otel';
export const TELEMETRY_ROW_NAME = '@deepseek-ai/dsh-session-telemetry-otel';

/** 期望档位（包内 DEFAULT_TELEMETRY_MODE；枚举只有 FEEDBACK_ONLY / DISABLED 两个值）。 */
export const EXPECTED_MODE = 'FEEDBACK_ONLY';

/** 关通道的环境变量名（**任意非空值**即 opt-out，含 '0'/'false'）。 */
export const DISABLE_ENV = 'DSH_TELEMETRY_DISABLED';

/** 判据 ③ 要看的三个变量（顺序即展示顺序）。 */
export const TELEMETRY_ENV_NAMES = ['DSH_TELEMETRY_MODE', DISABLE_ENV, 'DSH_TELEMETRY_OTLP_URL'];

/** 环境变量读取哨兵：环境块里必须至少看见其中之一，否则判"读出来的空"不可信。 */
export const ENV_SENTINELS = ['DSH_HOME', 'DSH_PERMISSION_MODE'];

/** 本机四个启动入口（相对工作区根；都可被 opts.dshRoot / opts.entryFiles 覆盖）。 */
export const LAUNCH_ENTRIES = [
  { id: 'dsh-start.ps1', rel: 'dsh-start.ps1', kind: 'ps1' },
  { id: 'dsh-restart.ps1', rel: 'dsh-restart.ps1', kind: 'ps1' },
  { id: 'guard-ctl.mjs', rel: 'guard-ctl.mjs', kind: 'js' },
  { id: 'dsh-guard.cmd', rel: 'dsh-guard.cmd', kind: 'cmd' },
];

/** 默认工作区根（与 checks.mjs 的 DSH_ROOT 同口径；可注入）。 */
export const DEFAULT_DSH_ROOT = workspaceRoot();

// ---------------------------------------------------------------------------
// 路径解析（全部可注入 —— 单测必须能指向沙盒，绝不碰生产文件）
// ---------------------------------------------------------------------------

/** 数据根：DSH_HOME > ~/.dsh（与 report.mjs / checks.mjs 的 dshHome() 同口径）。 */
export function resolveHomeDir(env = process.env) {
  const override = env.BUTLER_DSH_HOME || env.DSH_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(env.USERPROFILE || os.homedir(), '.dsh');
}

/** 主包安装根：%APPDATA%\npm\node_modules\@deepseek-ai\dsh。 */
export function resolveNpmDshDir(env = process.env) {
  const appdata = env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
}

/** dsh-base 的 cordis.patch.yml（遥测行的配置真源）。 */
export function resolvePatchFile(env = process.env) {
  return path.join(resolveNpmDshDir(env), 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
}

/** 遥测包内 lib\index.js（旁证：DEFAULT_TELEMETRY_MODE 是否仍是 FEEDBACK_ONLY）。 */
export function resolveTelemetryPkgIndex(env = process.env) {
  return path.join(resolveNpmDshDir(env), 'node_modules', TELEMETRY_ROW_NAME, 'lib', 'index.js');
}

/** 匿名身份文件：$DSH_HOME\.anonymous-user-id。 */
export function resolveAnonIdFile(env = process.env) {
  return path.join(resolveHomeDir(env), '.anonymous-user-id');
}

// ---------------------------------------------------------------------------
// 判据 ①：patch 的 mode 行
// ---------------------------------------------------------------------------

/**
 * 从 cordis.patch.yml 文本里切出遥测行的 YAML 块（`- id: session-telemetry-otel` 起，
 * 到下一个顶层 `- id:` 或文件尾）。
 * @returns {{ startLine:number, endLine:number, block:string }|null}
 *   startLine = 遥测行自身行号，endLine = **块最后一行行号**（下一个 `- id:` 之前），均 1-based
 */
export function extractTelemetryRowBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${TELEMETRY_ROW_ID}\\s*$`).test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:\s*\S+/.test(lines[i])) { end = i; break; }
  }
  return { startLine: start + 1, endLine: end, block: lines.slice(start, end).join('\n') };
}

/**
 * 判定 patch 的档位行。
 * @returns {{ status:'ok'|'red'|'unavailable', modeLine:string|null, lineNo:number|null,
 *            expectedMode:string, hardDisabled:boolean, envOverrideForm:boolean, reason:string|null }}
 */
export function judgePatchMode(patchText) {
  const base = { modeLine: null, lineNo: null, expectedMode: EXPECTED_MODE, hardDisabled: false, envOverrideForm: false, reason: null };
  if (patchText == null) return { ...base, status: 'unavailable', reason: 'patch 文本不可用' };
  const row = extractTelemetryRowBlock(patchText);
  if (!row) return { ...base, status: 'unavailable', reason: `patch 里找不到遥测行（- id: ${TELEMETRY_ROW_ID}）` };
  const lines = row.block.split('\n');
  let modeLine = null;
  let lineNo = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*mode:\s*\S/.test(lines[i])) { modeLine = lines[i].trim(); lineNo = row.startLine + i; break; }
  }
  if (!modeLine) return { ...base, status: 'unavailable', reason: `遥测行（L${row.startLine}-${row.endLine}）内找不到 mode: 行` };
  // 硬编码改档 = 行里出现 'DISABLED' 字面量（枚举只有 FEEDBACK_ONLY / DISABLED 两个值）。
  const hardDisabled = /['"]DISABLED['"]/.test(modeLine);
  const hasExpected = modeLine.includes(EXPECTED_MODE);
  const envOverrideForm = /process\.env\.DSH_TELEMETRY_MODE\s*\|\|/.test(modeLine);
  const status = (!hardDisabled && hasExpected) ? 'ok' : 'red';
  return {
    ...base, status, modeLine, lineNo, hardDisabled, envOverrideForm,
    reason: status === 'ok' ? null : `档位行不再是「${EXPECTED_MODE}」形态：${modeLine}`,
  };
}

/** 旁证：包内 DEFAULT_TELEMETRY_MODE 是否仍为 FEEDBACK_ONLY（读不到只记 unavailable，不升级等级）。 */
export function judgePackageDefault(pkgText) {
  if (pkgText == null) return { ok: false, reason: 'index.js 不可读' };
  const m = String(pkgText).match(/DEFAULT_TELEMETRY_MODE\s*=\s*(?:[A-Za-z_$][\w$]*\.)?([A-Z_][A-Z_0-9]*)\s*;/);
  if (!m) return { ok: false, reason: 'index.js 里找不到 DEFAULT_TELEMETRY_MODE 赋值' };
  return { ok: true, value: m[1], expected: EXPECTED_MODE, match: m[1] === EXPECTED_MODE };
}

// ---------------------------------------------------------------------------
// 判据 ②：四个启动入口是否注入 DISABLE_ENV
// ---------------------------------------------------------------------------

/** 行内注释剥离（粗粒度，够用即可）：ps1/cmd 用 `#`，js/mjs 用 `//` 与 `/*`。 */
export function stripLineComment(line, kind) {
  const s = String(line ?? '');
  if (kind === 'js' || kind === 'mjs') {
    let cut = s.length;
    const i = s.indexOf('//');
    if (i >= 0) cut = Math.min(cut, i);
    const j = s.indexOf('/*');
    if (j >= 0) cut = Math.min(cut, j);
    return s.slice(0, cut);
  }
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(0, i) : s;
}

/**
 * 扫描一个入口文件文本里对 DISABLE_ENV 的引用。
 *   hard  : 剥离注释后仍带 `DISABLE_ENV = <非空值>` ⇒ 真注入（🟡）
 *   empty : 剥离注释后赋值但右侧为空串 ⇒ 无效注入（opt-out 需非空值；只记录）
 *   soft  : 剥离注释后出现该名但非赋值形态（如读取/判断）⇒ 只记录
 *   commentOnly : 只在注释里出现 ⇒ 只记录
 */
export function scanEntryInjection(text, { kind = 'ps1', file = '' } = {}) {
  const out = { file, hard: [], empty: [], soft: [], commentOnly: [] };
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.includes(DISABLE_ENV)) continue;
    const code = stripLineComment(raw, kind);
    const hit = { line: i + 1, text: raw.trim() };
    if (!code.includes(DISABLE_ENV)) { out.commentOnly.push(hit); continue; }
    const m = code.match(new RegExp(DISABLE_ENV + '\\s*=\\s*(.*)$'));
    if (!m) { out.soft.push(hit); continue; }
    const rhs = String(m[1] ?? '').trim();
    if (rhs === '' || rhs === "''" || rhs === '""') out.empty.push(hit);
    else out.hard.push(hit);
  }
  return out;
}

/** 读四个入口并汇总（文件缺失 ⇒ unavailable，绝不当"没有注入"）。 */
export function collectEntryInjections({ dshRoot = DEFAULT_DSH_ROOT, entryFiles = null } = {}) {
  const entries = entryFiles ?? LAUNCH_ENTRIES.map((e) => ({ ...e, file: path.join(dshRoot, e.rel) }));
  const files = [];
  for (const e of entries) {
    const file = e.file ?? path.join(dshRoot, e.rel ?? e.id);
    try {
      const text = fs.readFileSync(file, 'utf8');
      files.push({ id: e.id, file, exists: true, ...scanEntryInjection(text, { kind: e.kind, file }) });
    } catch (err) {
      files.push({ id: e.id, file, exists: false, error: String(err?.message ?? err), hard: [], empty: [], soft: [], commentOnly: [] });
    }
  }
  const missing = files.filter((f) => !f.exists);
  const hard = files.flatMap((f) => f.hard.map((h) => ({ ...h, id: f.id, file: f.file })));
  return {
    status: missing.length ? 'unavailable' : (hard.length ? 'yellow' : 'ok'),
    files, hard,
    empty: files.flatMap((f) => f.empty.map((h) => ({ ...h, id: f.id }))),
    soft: files.flatMap((f) => f.soft.map((h) => ({ ...h, id: f.id }))),
    commentOnly: files.flatMap((f) => f.commentOnly.map((h) => ({ ...h, id: f.id }))),
    checked: files.length,
    missing: missing.map((f) => ({ id: f.id, file: f.file, error: f.error })),
    reason: missing.length ? `${missing.length} 个入口读不到（${missing.map((f) => f.id).join('、')}）` : null,
  };
}

// ---------------------------------------------------------------------------
// 判据 ③：生产 dsh 进程的真实环境变量
// ---------------------------------------------------------------------------

/** 解析 win-proc-env.ps1 的输出。 */
export function parseProcEnvOutput(stdout) {
  const text = String(stdout ?? '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l === 'NO_PROCESS')) return { ok: false, noProcess: true, reason: '3080 无监听进程（DSH 未运行）' };
  const readErr = lines.find((l) => l.startsWith('READ_ERROR:'));
  if (readErr) return { ok: false, reason: readErr };
  const kv = {};
  for (const l of lines) {
    const i = l.indexOf('=');
    if (i <= 0) continue;
    kv[l.slice(0, i)] = l.slice(i + 1);
  }
  if (!kv.PID) return { ok: false, reason: '读取器输出无法解析（缺 PID 行）' };
  const pid = Number(kv.PID);
  const sentinel = kv.SENTINEL === '1';
  const truncated = kv.TRUNCATED === '1';
  const vars = {};
  for (const n of TELEMETRY_ENV_NAMES) {
    const v = kv[n];
    vars[n] = (v == null || v === '<UNSET>' || v === '') ? null : v;
  }
  if (!sentinel) return { ok: false, pid, vars, sentinel, truncated, reason: `环境块里看不见哨兵（${ENV_SENTINELS.join(' / ')}）⇒ 读出来的"空"不可信` };
  if (truncated) return { ok: false, pid, vars, sentinel, truncated, reason: '环境块被截断读取 ⇒ 判定不可用' };
  const set = TELEMETRY_ENV_NAMES.filter((n) => vars[n] != null);
  return {
    ok: true, pid, vars, sentinel, truncated,
    status: set.length ? 'yellow' : 'ok',
    setVars: set.map((n) => `${n}=${vars[n]}`),
    reason: null,
  };
}

// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】候选取自统一真源（pwsh 7 优先）：360 企业版 EDR 只对 5.1 弹窗。
// 【2026-10-09 订正 · 卡「冲刺600·批4-1」】原写法 = **跨目录相对静态 import**（`powerShellCandidates`
//   直接自 `../../lib/powershell-exe.mjs` 相对引入）—— 它**在仓库里跑得通、一部署必然崩**
//   （部署到 profile 后解析成 `node_modules/lib/…`，不存在）⇒ 正是 `preflight-imports.mjs`
//   部署门禁①的立项目标；实测把 panel 的 `deploy.mjs` **整条链挡死**
//   （2026-10-09 16:5x：门禁① 1 项未通过 ⇒ 拒绝部署，未写任何文件）。
//   改法 = 门禁头注明文推荐的正道：**绝对 `file:///` URL 的动态 import**；并加**内置回退**，
//   真源不可达时「pwsh 7 优先」语义不变（不让本模块因真源缺失而加载失败）。
//   ⚠️ 门禁按**行**匹配、不剥注释 ⇒ 本注释里也**不许**出现「import … from '<相对路径>'」的完整形态
//      （写了就自报假警，实测踩过；用反引号把路径与 from 拆开即可）。
let powerShellExeCandidates = () => ['pwsh', 'powershell.exe'];
try {
  const mod = await importToolLib('powershell-exe.mjs');
  if (typeof mod?.powerShellCandidates === 'function') {
    powerShellExeCandidates = () => mod.powerShellCandidates().map((c) => c.exe);
  }
} catch { /* 真源不可达：保持内置回退（顺序同为 pwsh → 5.1） */ }

/** 默认读取器：spawn pwsh 跑 win-proc-env.ps1（pwsh 优先，回退 Windows PowerShell）。 */
export function readProcEnvViaPwsh({ port = 3080, timeoutMs = 30_000, ps1 = null, shells = powerShellExeCandidates() } = {}) {
  const script = ps1 ?? path.join(HERE, 'win-proc-env.ps1');
  const errors = [];
  for (const sh of shells) {
    let r;
    try {
      r = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(port)],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    } catch (e) { errors.push(`${sh}: ${String(e?.message ?? e)}`); continue; }
    if (r.error) { errors.push(`${sh}: ${String(r.error.message ?? r.error)}`); continue; }
    const out = String(r.stdout ?? '');
    if (!out.trim()) {
      errors.push(`${sh}: 空输出（exit ${r.status}）${String(r.stderr ?? '').trim().slice(0, 160)}`);
      continue;
    }
    const parsed = parseProcEnvOutput(out);
    parsed.reader = sh;
    return parsed;
  }
  return { ok: false, reason: `进程环境读取器不可用（${errors.join(' | ') || '未知'}）` };
}

// ---------------------------------------------------------------------------
// 判据 ④：匿名身份文件（只记录）
// ---------------------------------------------------------------------------

export function collectAnonId({ file }) {
  try {
    const st = fs.statSync(file);
    return { status: 'ok', exists: true, file, sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'ok', exists: false, file, sizeBytes: null, mtimeMs: null };
    return { status: 'unavailable', exists: false, file, reason: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// 采集 + 判定
// ---------------------------------------------------------------------------

function readTextOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * 采集四项判据。**只读**，不写任何文件。
 * @param {object} [opts]
 * @param {string} [opts.dshRoot]            工作区根（默认 <workspace>，见 DSH_WORKSPACE）
 * @param {string} [opts.patchFile]          cordis.patch.yml 路径
 * @param {string} [opts.pkgIndexFile]       遥测包 index.js 路径
 * @param {string} [opts.homeDir]            数据根（默认 DSH_HOME）
 * @param {object[]} [opts.entryFiles]       四个入口（覆盖路径）
 * @param {Function} [opts.procEnvReader]    进程环境读取器（单测注入假件）
 * @param {number} [opts.now]
 */
export async function collectTelemetryGuard(opts = {}) {
  const env = opts.env ?? process.env;
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const patchFile = opts.patchFile ?? resolvePatchFile(env);
  const pkgIndexFile = opts.pkgIndexFile ?? resolveTelemetryPkgIndex(env);
  const homeDir = opts.homeDir ?? resolveHomeDir(env);
  const now = opts.now ?? Date.now();

  // ① patch 档位（判据主体）+ 包内默认（旁证）
  let patch;
  try {
    const text = readTextOrNull(patchFile);
    patch = judgePatchMode(text);
    patch.file = patchFile;
    if (text == null) {
      patch.status = 'unavailable';
      patch.reason = `patch 文件不可读：${patchFile}`;
    }
    patch.pkgDefault = judgePackageDefault(readTextOrNull(pkgIndexFile));
    patch.pkgIndexFile = pkgIndexFile;
  } catch (e) {
    patch = { status: 'unavailable', reason: String(e?.message ?? e), file: patchFile, modeLine: null, lineNo: null };
  }

  // ② 四入口注入
  let entries;
  try {
    entries = collectEntryInjections({ dshRoot, entryFiles: opts.entryFiles });
  } catch (e) {
    entries = { status: 'unavailable', reason: String(e?.message ?? e), files: [], hard: [], missing: [] };
  }

  // ③ 生产进程 env
  // ③ 生产进程 env（读取器可注入；返回形态 = parseProcEnvOutput 的结果）
  let procEnv;
  try {
    const reader = opts.procEnvReader ?? (() => readProcEnvViaPwsh({ port: opts.port ?? 3080 }));
    const got = await reader();
    if (got && typeof got.ok === 'boolean') procEnv = got;
    else procEnv = { ok: false, reason: '读取器返回了无法识别的结果' };
  } catch (e) {
    procEnv = { ok: false, reason: String(e?.message ?? e) };
  }

  // ④ 匿名身份（只记录）
  let anonId;
  try {
    anonId = collectAnonId({ file: opts.anonIdFile ?? resolveAnonIdFile(env) });
  } catch (e) {
    anonId = { status: 'unavailable', reason: String(e?.message ?? e), file: opts.anonIdFile ?? resolveAnonIdFile(env) };
  }

  const statuses = [patch.status, entries.status, procEnv.ok ? (procEnv.status ?? 'ok') : 'unavailable'];
  const reds = statuses.filter((s) => s === 'red').length;
  const yellows = statuses.filter((s) => s === 'yellow').length;
  const unavailable = statuses.filter((s) => s === 'unavailable').length;
  const level = reds ? 'red' : (yellows ? 'yellow' : (unavailable ? 'unknown' : 'ok'));

  return {
    ok: true, version: TELEMETRY_GUARD_VERSION, asOf: now,
    level, reds, yellows, unavailable,
    patch, entries, procEnv, anonId,
    // 诚实边界（段里逐字渲染；别删）
    boundary: '包内不写本地导出日志 ⇒ 本段只能报「档位是否被动过」，**不能报今天具体传没传**；'
      + '上传授权仅限「用户显式反馈」（patch 注释逐字 Ordinary activity never triggers capture）。',
  };
}

// ---------------------------------------------------------------------------
// 段渲染
// ---------------------------------------------------------------------------

function fmtTs(ms) {
  try {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return '—'; }
}

/** 日报段文本（`## 🛰 遥测档位（只读 · 防偷改）`）。 */
export function telemetrySectionLines(rep) {
  const L = [];
  L.push('## 🛰 遥测档位（只读 · 防偷改）');
  L.push('');
  if (!rep || !rep.ok) {
    L.push(`_（遥测档位段降级：${rep?.reason ?? '判定不可用'}）_`);
    L.push('');
    return L;
  }
  const ic = (s) => (s === 'red' ? '🔴' : s === 'yellow' ? '🟡' : s === 'unavailable' ? '❔' : '✅');

  // ① patch 档位
  const p = rep.patch ?? {};
  if (p.status === 'ok') {
    const extra = p.envOverrideForm ? '' : '（⚠️ 已非 env-override 形态）';
    L.push(`- ${ic(p.status)} patch 档位：\`${p.modeLine}\`（\`${path.basename(p.file ?? '')}\` L${p.lineNo}）${extra}`);
  } else if (p.status === 'red') {
    L.push(`- 🔴 patch 档位**被动过**：\`${p.modeLine ?? '—'}\`（L${p.lineNo ?? '?'}）—— 期望仍是 \`${EXPECTED_MODE}\`；**需主人知悉**`);
  } else {
    L.push(`- ❔ patch 档位：**判定不可用**（${p.reason ?? '未知'}）`);
  }
  if (p.pkgDefault) {
    if (p.pkgDefault.ok) L.push(`  - 旁证：包内 \`DEFAULT_TELEMETRY_MODE = ${p.pkgDefault.value}\`${p.pkgDefault.match ? '' : `（≠ ${EXPECTED_MODE}，与 patch 对照看）`}`);
    else L.push(`  - 旁证：❔ 包内默认档位不可读（${p.pkgDefault.reason}）`);
  }

  // ② 四入口注入
  const e = rep.entries ?? {};
  const nOk = (e.files ?? []).filter((f) => f.exists).length;
  if (e.status === 'ok') {
    L.push(`- ✅ 启动入口注入：${nOk}/${(e.files ?? []).length} 入口**均未注入** \`${DISABLE_ENV}\`（官方通道按主人 D23 保留）`);
  } else if (e.status === 'yellow') {
    for (const h of e.hard) L.push(`- 🟡 启动入口 \`${h.id}\` **被注入** \`${DISABLE_ENV}\`（L${h.line}：\`${h.text}\`）⇒ 通道被关，**需主人知悉**`);
  } else {
    L.push(`- ❔ 启动入口注入：**判定不可用**（${e.reason ?? '未知'}）`);
  }
  const extraHits = [...(e.empty ?? []).map((h) => `${h.id} L${h.line}（赋空值=无效）`), ...(e.soft ?? []).map((h) => `${h.id} L${h.line}（引用非赋值）`)];
  if (extraHits.length) L.push(`  - 另：命中但不构成注入：${extraHits.join(' · ')}`);
  if ((e.commentOnly ?? []).length) L.push(`  - 另：${e.commentOnly.length} 处仅出现在注释里（不算注入）`);

  // ③ 生产进程 env
  const pe = rep.procEnv ?? {};
  if (pe.ok && pe.status === 'ok') {
    L.push(`- ✅ 生产进程 env：PID ${pe.pid} · ${TELEMETRY_ENV_NAMES.join(' / ')} **均未设**（读取哨兵 OK${pe.reader ? ` · ${pe.reader}` : ''}）`);
  } else if (pe.ok && pe.status === 'yellow') {
    for (const s of pe.setVars ?? []) L.push(`- 🟡 生产进程 env：\`${s}\`（PID ${pe.pid}）⇒ 档位/端点**被改过**，需主人知悉`);
  } else if (pe.noProcess) {
    L.push(`- ❔ 生产进程 env：**判定不可用**（${pe.reason ?? 'DSH 未运行'}）`);
  } else {
    L.push(`- ❔ 生产进程 env：**判定不可用**（${pe.reason ?? '未知'}）`);
  }

  // ④ 匿名身份（只记录）
  const a = rep.anonId ?? {};
  if (a.status === 'ok') {
    if (a.exists) L.push(`- ℹ️ 匿名身份：\`.anonymous-user-id\` 存在（${a.sizeBytes}B · mtime ${fmtTs(a.mtimeMs)}）—— **只记录**，与"今天传没传"无关`);
    else L.push('- ℹ️ 匿名身份：`.anonymous-user-id` 不存在（**只记录**；该文件非导出计数，不能据此推断从未上行）');
  } else {
    L.push(`- ❔ 匿名身份：不可读（${a.reason ?? '未知'}）`);
  }

  L.push(`- ℹ️ ${rep.boundary}`);
  if (rep.level !== 'ok') L.push(`- 本段结论：${rep.level === 'red' ? '🔴 有档位被改' : rep.level === 'yellow' ? '🟡 有档位被改/被关' : '❔ 有判据不可用（不代表正常）'}（🔴 ${rep.reds} / 🟡 ${rep.yellows} / ❔ ${rep.unavailable}）`);
  L.push('');
  return L;
}

// ---------------------------------------------------------------------------
// CLI（手工巡检：`node lib\telemetry-guard.mjs`，只读、无副作用）
// ---------------------------------------------------------------------------

function isMain() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const argv = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return self === argv;
  } catch { return false; }
}

if (isMain()) {
  const rep = await collectTelemetryGuard({});
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  } else {
    for (const line of telemetrySectionLines(rep)) process.stdout.write(line + '\n');
  }
  process.exitCode = rep.level === 'red' ? 5 : (rep.level === 'yellow' ? 4 : (rep.level === 'unknown' ? 3 : 0));
}
