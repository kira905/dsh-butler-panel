/**
 * dsh-butler-panel / lib/daily-handoff-line.mjs —— 日报「📒 账本对账」**一行**（缺陷 I-6 · V-A）
 *
 * 为什么存在：`arrive-b`（接机后看板账本并回）停下以后，**跨机并回没有任何信号会提醒人**。
 *   当次实测：`runs 2078 / applied 0 / stats.lastApplyAt null`，`jobs['arrive-b'].enabled=false`
 *   （主人 2026-10-28 13:49 本地手关，why="拆仓库钩子"），而**对端**最新包停在
 *   `<peer>-2026-09-16T01-38-14-board-snapshot.json` = **42.6 天前**。这条事实此前只活在
 *   状态文件里（没人翻）⇒ 0 人类可见面。本模块把它压成日报摘要段的一行。
 *
 * 口径与约束（真源 `docs\方案-账本并回信号与换机一条命令-20261028.md` v6 §3 + r6 报告 §8）：
 *   · **只读**：四个源全现成，不新建状态文件、不写盘、不开 ssh、不联网、不 spawn。
 *   · **取源必须是对端**：交给 `arrive-b` 自己的 `pickPeerSnapshot()` 选包（它内部跳过本机自己导出的）。
 *     本机那份**不许**当对账龄印出来 —— 那会偏乐观 29 天（-13.4 天 vs 真相 -42.6 天，r5 N1）。
 *   · **永不抛错**：整行包 try/catch（`lib\queue-watch.mjs` 每 1 分钟整份重写日报，抛一次 = 每小时最多 60 次污染）。
 *   · **单 fs 口**：所有文件访问经**同一行** `const fs = fsMod ?? nodeFs`，单测可注入白名单桩（V3③）。
 *   · **时区**：时间戳一律 `Asia/Shanghai` 并标「本地」（r5 N2/N3；裸印时分会被读成"凌晨 5:49 关的"，
 *     真相是下午 13:49）。若运行环境不支持时区数据，退化印 UTC 并带 `Z`。
 *   · **不复制判定**：选包规则在 `arrive-b.mjs`，本模块只渲染它给的结果。
 *   · **龄期取较旧者**（A3 · 主人 2026-10-29 拍板「其他按建议落」）：`ageDays` 取「文件 mtime」与
 *     「文件名里的 stamp（**UTC**）」**较旧的那个**，见 {@link ageBasisMs}。对端包经 scp / git 重新落盘
 *     时 mtime 会被刷成"现在"⇒ 只按 mtime 会把「对端 43 天没并回来」藏成"几分钟前"。
 *     `mtimeMs` 字段**保留原值不动**（日报/面板/单测在读），新口径挂 `stampMs` / `basisMs` / `basis`。
 *
 * 两层契约（省 V-B 一次回改）：
 *   `handoffLedgerData(opts)` → 数据对象（含 `missing[]` 明细，供报告/面板用）
 *   `handoffLedgerLine(data)` → 一行 markdown（纯渲染）
 *   `handoffLedgerSummaryLine(opts)` → 上面两层的组合 + 兜底（`report.mjs` 只调这一个）
 *
 * 只扫 `prod` 一档、候选 `file` 用裸名 —— 与 `arrive-b` 的判包规则**同源（同函数）**但不完全同形态：
 *   `arrive-b` 还会扫仓3 工作副本（`repo-workspace` 优先）且给绝对路径。当前该副本目录不存在 ⇒ 两口径取到
 *   同一份；一旦它恢复，本行看的是 `prod`、`arrive-b` 看的是那边（r6 N4′，V-B 若要用绝对路径请自行 join）。
 *
 * 「为什么不干脆从 PATH 摘掉 ssh」：摘 PATH 只能挡住**按名字调用**的 ssh，挡不住
 *   `%SystemRoot%\System32\OpenSSH\ssh.exe` 绝对路径、也挡不住本模块将来改成走 HTTP 或 scp；
 *   而本模块的零联网面是**代码级**（没有网络模块、没有子进程模块、没有 fetch）——
 *   评审能一眼读完、单测能静态扫到。摘 PATH 是环境级约束（会连带影响别人的脚本），
 *   本档零成本、可复跑、不进机器全局状态（r5 认过的判断，r6 §5 要求施工时补回这一句）。
 *
 * @see tools\dsh-butler-panel\lib\daily-mirror-line.mjs  同族样板（日报纯库 + 单 fs 口 + 永不抛错）
 */
import path from 'node:path';
import os from 'node:os';
import nodeFs from 'node:fs';
// 跨目录引用走 ./butler-root.mjs（目录由环境变量解析；deploy.mjs 的 preflight-imports 门禁要求
// 跨包引用不得写成相对路径，因为部署到 profile 后相对路径会指到 node_modules 下不存在的包）。
// ⚠️ `dshHome` 是**导出名**，`stateDshHome` 是本地别名；直接 import { stateDshHome } 会 SyntaxError（r4/r5 B1）。
import { importButlerLib, workspaceRoot, statePathResolver, dshHome as stateDshHome } from './butler-root.mjs';
const resolveStatePath = await statePathResolver();
const { parseSnapshotName, pickPeerSnapshot } = await importButlerLib('arrive-b.mjs');

/** 行首（与日报其它段同款：emoji + 段名 + 全角冒号）。 */
export const HANDOFF_LEDGER_PREFIX = '📒 账本对账：';

/** 「对端包陈旧」阈值（天）。现读 42.6 天 ⇒ 上线当天必 ⚠️，这正是这张卡要的可见性。 */
export const STALE_DAYS = 7;

/** 缺源时的固定串（r6 N2′：`pick.reason` 只进 `missing[]`，**不上日报正文** —— 它含裸印的 UTC stamp）。 */
export const NO_PEER_SNAPSHOT = '❔ 不可探测（没有对端快照）';

/** 缺源文案表（一处定义，渲染与单测共用，防"改了实现忘了判据"）。 */
export const MISSING_TEXT = Object.freeze({
  ledger: '本机 rev ❔ 不可探测（账本读不到）',
  snapDir: '❔ 不可探测（快照目录读不到）',
  peer: NO_PEER_SNAPSHOT,
  self: '❔ 不可探测（没有本机快照）',
  job: 'job 状态 ❔ 不可探测',
  arrive: '❔ 不可探测（arrive-b 状态读不到）',
  lastRun: '上次运行 ❔ 不可探测',
  render: '❔ 不可探测（渲染异常）',
});

/** 缺省工作区根（与 report.mjs 的 dshWorkspace() 缺省同值）。 */
export const DEFAULT_DSH_ROOT = workspaceRoot();

/**
 * 本机 host（小写）。`handoff-arrive-b.mjs` 里的 `selfHostName()` 是本地函数、**不导出** ⇒ 这里自己算。
 * @returns {string}
 */
export function selfHostName(env = process.env, hostname = os.hostname) {
  try {
    return String(env?.COMPUTERNAME ?? hostname() ?? 'unknown').toLowerCase();
  } catch {
    return 'unknown';
  }
}

/** 错误码/消息的短形态（只用于「不可探测（原因）」里的括号）。 */
function codeOf(e) {
  return String(e?.code ?? e?.message ?? e ?? 'unknown').slice(0, 60);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ISO 串 → ms；非法/缺失 ⇒ null。 */
function isoMs(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const SHANGHAI = 'Asia/Shanghai';

/** 取 `Asia/Shanghai` 的年月日时分（不依赖系统 locale / 不引第三方）。 */
function shanghaiParts(ms) {
  try {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const p = {};
    for (const x of f.formatToParts(new Date(ms))) {
      if (x.type !== 'literal') p[x.type] = x.value;
    }
    if (p.year && p.month && p.day && p.hour && p.minute) return p;
  } catch { /* 时区数据缺失 ⇒ 退化 UTC */ }
  return null;
}

/** `YYYY-MM-DD HH:mm`（本地 Asia/Shanghai）。非有限值 ⇒ null。 */
export function fmtLocalFull(ms) {
  if (!Number.isFinite(ms)) return null;
  const p = shanghaiParts(ms);
  if (p) return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'; } catch { return null; }
}

/** `MM-DD HH:mm`（本地 Asia/Shanghai）。非有限值 ⇒ null。 */
export function fmtLocalShort(ms) {
  if (!Number.isFinite(ms)) return null;
  const p = shanghaiParts(ms);
  if (p) return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  try { return new Date(ms).toISOString().slice(5, 16).replace('T', ' ') + 'Z'; } catch { return null; }
}

/** 龄期 `-42.6 天`（负值 = 文件时间在未来，印 `+` 更诚实）。 */
export function fmtAgeDays(ms, now) {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return null;
  const d = (now - ms) / 86400000;
  const s = Math.abs(d).toFixed(1);
  return d >= 0 ? `-${s} 天` : `+${s} 天`;
}

/**
 * 龄期**基准时刻**：`mtime` 与「文件名 stamp」里**较旧的那个**（A3）。
 *
 * 为什么不能只按 mtime：对端包一旦经 scp / git 重新落盘，mtime 就被刷成"现在"
 * ⇒ 「对端 43 天没并回来」会被读成"几分钟前"，把真风险藏起来。文件名
 * `<host>-<YYYY-MM-DDTHH-mm-ss>-<label>.json` 里的 stamp 是**导出那一刻**，且**是 UTC**
 * （实测 `<peer>-2026-10-15T06-23-27-depart.json` 的本地 mtime = 14:23:27(+08:00)）⇒ 解析必须补 `Z`。
 *
 * 契约：**永不抛**。文件名不合形态 / stamp 非法 ⇒ `stampMs = null`（**不**退化成 0 或 now）；
 * 两个都不是有限值（或 mtime 非正数）⇒ `basisMs = null`，由调用方渲染成 ❔。
 *
 * @param {{mtimeMs?: number|string|null, file?: string|null}} [input]
 * @returns {{mtimeMs: number|null, stampMs: number|null, basisMs: number|null, basis: 'stamp'|'mtime'|'none'}}
 */
export function ageBasisMs(input = {}) {
  const positive = (v) => {
    try {
      const n = Number(v);
      return (Number.isFinite(n) && n > 0) ? n : null; // mtime = 0 ⇒ 视为"没有"（真实 mtime 恒 > 0）
    } catch { return null; }
  };
  const mtimeMs = positive(input?.mtimeMs);
  let stampMs = null;
  try {
    const parsed = parseSnapshotName(input?.file);
    if (parsed && typeof parsed.stamp === 'string') {
      // `YYYY-MM-DDTHH-mm-ss` ⇒ `YYYY-MM-DDTHH:mm:ssZ`（UTC；不补 Z 会整整差 8 小时）
      const iso = parsed.stamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/, '$1T$2:$3:$4Z');
      const t = Date.parse(iso);
      if (Number.isFinite(t)) stampMs = t;
    }
  } catch { stampMs = null; }
  const basisMs = (mtimeMs === null)
    ? stampMs
    : (stampMs === null ? mtimeMs : Math.min(mtimeMs, stampMs));
  const basis = basisMs === null ? 'none' : (basisMs === mtimeMs ? 'mtime' : 'stamp');
  return { mtimeMs, stampMs, basisMs, basis };
}

/** 龄期基准的可选读取（手搓 data 对象没有 `basisMs` 时退回 `mtimeMs`）。 */
function basisOf(o) {
  if (Number.isFinite(o?.basisMs)) return o.basisMs;
  return Number.isFinite(o?.mtimeMs) ? o.mtimeMs : null;
}

/**
 * 读一个 JSON 文件（**绝不抛**）。读失败 / 空文件 / 解析失败 ⇒ `{ok:false, reason}`。
 * ⚠️ 第二参固定 `'utf8'`（不传 `{flag}`）：单测的白名单桩会断言 `options.flag` 不存在或为 `'r'`。
 */
function readJsonQuiet(fs, file) {
  let raw;
  try {
    raw = fs.readFileSync(String(file), 'utf8');
  } catch (e) {
    return { ok: false, reason: `读不到（${codeOf(e)}）` };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: '空文件' };
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return { ok: false, reason: '形状异常（非对象）' };
    return { ok: true, value: v };
  } catch {
    return { ok: false, reason: '解析失败（非法 JSON）' };
  }
}

/**
 * 采四个源，返回**数据对象**（不做渲染、不抛）。
 * @param {object} [o]
 * @param {string} [o.home]     状态主目录（缺省 `stateDshHome()`；单测**必须显式传**，N-d）
 * @param {string} [o.dshRoot]  工作区根（缺省 `<工作区根>`，见 `DSH_WORKSPACE`）
 * @param {string} [o.snapDir]  快照目录（缺省 `<dshRoot>\tools\board-snapshots`）
 * @param {string} [o.snapKind] `'peer'`（缺省 = 不限 label）| `'depart'` | `'board-snapshot'`（V-B 用）
 * @param {object} [o.fsMod]    `node:fs`（单测注入白名单桩）
 * @param {string} [o.selfHost] 本机 host（缺省现算；单测注入）
 * @param {number} [o.now]      现在（ms；单测注入）
 * @param {number} [o.staleDays] 陈旧阈值（天；缺省 {@link STALE_DAYS}）
 * @returns {{rev:number|null, tasks:number|null, snap:object|null, self:object|null,
 *            arrive:object|null, job:object|null, missing:string[], missingReason:string|null,
 *            snapDirError:string|null, now:number, staleDays:number}}
 */
export function handoffLedgerData(o = {}) {
  const fs = o.fsMod ?? nodeFs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleDays = Number.isFinite(o.staleDays) ? o.staleDays : STALE_DAYS;
  const home = (typeof o.home === 'string' && o.home.trim()) ? o.home.trim() : stateDshHome();
  const dshRoot = (typeof o.dshRoot === 'string' && o.dshRoot.trim()) ? o.dshRoot.trim() : DEFAULT_DSH_ROOT;
  const snapDir = (typeof o.snapDir === 'string' && o.snapDir.trim())
    ? o.snapDir.trim()
    : path.join(dshRoot, 'tools', 'board-snapshots');
  // N1′：只有 `snapKind !== 'peer'` 才按 label 过滤；`'peer'` = 不过滤（缺省即此）。
  //   照字面"给了就过滤"会把 30 份候选全滤掉 ⇒ 那行永远 ❔（I-6 目标直接失效）。
  const snapKind = (typeof o.snapKind === 'string' && o.snapKind.trim()) ? o.snapKind.trim() : 'peer';
  const selfHost = (typeof o.selfHost === 'string' && o.selfHost.trim()) ? o.selfHost.trim().toLowerCase() : selfHostName();

  const data = {
    rev: null, tasks: null, snap: null, self: null, arrive: null, job: null,
    missing: [], missingReason: null, snapDirError: null, now, staleDays,
    home, dshRoot, snapDir, snapKind, selfHost,
  };
  const ageOf = (ms) => (Number.isFinite(ms) ? (now - ms) / 86400000 : null);
  const staleOf = (days) => (days !== null && days > staleDays);

  // ---- ① arrive-b 状态（<home>\butler-arrive-b.json，经统一状态入口）----
  let arriveRaw = null;
  try {
    const p = resolveStatePath('butler-arrive-b.json', { home }).path;
    const r = readJsonQuiet(fs, p);
    if (r.ok) arriveRaw = r.value;
    else data.missing.push(`arrive: ${r.reason}`);
  } catch (e) {
    data.missing.push(`arrive: ${codeOf(e)}`);
  }
  if (arriveRaw) {
    const st = (arriveRaw.stats && typeof arriveRaw.stats === 'object') ? arriveRaw.stats : {};
    const ls = (arriveRaw.lastSnapshot && typeof arriveRaw.lastSnapshot === 'object') ? arriveRaw.lastSnapshot : null;
    data.arrive = {
      runs: numOrNull(st.runs),
      applied: numOrNull(st.applied),
      unchanged: numOrNull(st.unchanged),
      yielded: numOrNull(st.yielded),
      conflicts: numOrNull(st.conflicts),
      lastCode: (typeof arriveRaw.lastCode === 'string' && arriveRaw.lastCode) ? arriveRaw.lastCode : null,
      lastRunAt: isoMs(arriveRaw.updatedAt),
      lastApplyAt: isoMs(st.lastApplyAt),
      // 上次并回用的快照（V-B 会要；本行不印）
      lastSnapshot: ls ? { file: ls.file ?? null, revision: ls.revision ?? null, taskCount: ls.taskCount ?? null } : null,
      jobEnabled: null,
      jobSince: null,
    };
  }

  // ---- ② 快照目录：对端最新包（`pickPeerSnapshot` 内部跳过本机包）+ 本机上次出发 ----
  let candidates = null;
  try {
    const names = fs.readdirSync(snapDir);
    candidates = [];
    for (const f of (Array.isArray(names) ? names : [])) {
      if (typeof f !== 'string' || !/\.json$/i.test(f)) continue;
      let st = null;
      try { st = fs.statSync(path.join(snapDir, f)); } catch { continue; }
      if (snapKind !== 'peer') {
        const parsed0 = parseSnapshotName(f);
        if (!parsed0 || parsed0.label !== snapKind) continue;
      }
      candidates.push({ kind: 'prod', dir: snapDir, file: f, mtimeMs: Number(st?.mtimeMs) || 0 });
    }
  } catch (e) {
    data.snapDirError = codeOf(e);
    data.missing.push(`snapDir: ${codeOf(e)}`);
  }

  if (candidates) {
    let pick = null;
    try {
      pick = pickPeerSnapshot({ candidates, selfHost });
    } catch (e) {
      data.missing.push(`pick: ${codeOf(e)}`);
    }
    if (pick && pick.ok === true && pick.picked) {
      const m = Number(pick.picked.mtimeMs) || 0;
      const ab = ageBasisMs({ mtimeMs: m, file: pick.picked.file });
      const ageDays = ageOf(ab.basisMs);
      data.snap = {
        file: pick.picked.file ?? null,
        host: pick.picked.host ?? null,
        label: pick.picked.label ?? null,
        mtimeMs: m,
        stampMs: ab.stampMs,
        basisMs: ab.basisMs,
        basis: ab.basis,
        ageDays,
        stale: staleOf(ageDays),
      };
    } else {
      data.missingReason = pick?.reason ?? null;
      data.missing.push(`peer: ${pick?.reason ?? '选包器没有给出结果'}`);
    }
    // 本机上次出发（r6 N3′：`rejected[]` 元素没有 host 字段 ⇒ 在这里从候选头顶算，别去抠 why 字符串）
    let selfBest = null;
    for (const c of candidates) {
      const p = parseSnapshotName(c.file);
      if (!p || p.host !== selfHost) continue;
      if (!selfBest || c.mtimeMs > selfBest.mtimeMs) selfBest = c;
    }
    if (selfBest) {
      // 同一口径：本机包同样可能被重落盘 ⇒ 也取 mtime / stamp 较旧者（同一个 helper，不另生复杂度）
      const ab = ageBasisMs({ mtimeMs: selfBest.mtimeMs, file: selfBest.file });
      const ageDays = ageOf(ab.basisMs);
      data.self = {
        file: selfBest.file,
        mtimeMs: selfBest.mtimeMs,
        stampMs: ab.stampMs,
        basisMs: ab.basisMs,
        basis: ab.basis,
        ageDays,
        stale: staleOf(ageDays),
      };
    }
  }

  // ---- ③ 本机账本（<home>\task-board\ledger-v2.json；只读 revision + tasks.length）----
  try {
    const r = readJsonQuiet(fs, path.join(home, 'task-board', 'ledger-v2.json'));
    if (r.ok) {
      data.rev = numOrNull(r.value.revision);
      data.tasks = Array.isArray(r.value.tasks) ? r.value.tasks.length : null;
      if (data.rev === null) data.missing.push('ledger: 缺 revision');
    } else {
      data.missing.push(`ledger: ${r.reason}`);
    }
  } catch (e) {
    data.missing.push(`ledger: ${codeOf(e)}`);
  }

  // ---- ④ 并回 job 开关（<home>\butler-autonomy.json；只读 jobs['arrive-b'].{enabled,since}）----
  try {
    const r = readJsonQuiet(fs, resolveStatePath('butler-autonomy.json', { home }).path);
    if (r.ok) {
      const j = r.value.jobs ? r.value.jobs['arrive-b'] : null;
      if (j && typeof j === 'object') {
        data.job = { enabled: j.enabled !== false, sinceMs: isoMs(j.since) };
      } else {
        data.missing.push('job: jobs[arrive-b] 不存在');
      }
    } else {
      data.missing.push(`job: ${r.reason}`);
    }
  } catch (e) {
    data.missing.push(`job: ${codeOf(e)}`);
  }
  if (data.arrive) {
    data.arrive.jobEnabled = data.job ? data.job.enabled : null;
    data.arrive.jobSince = data.job ? data.job.sinceMs : null;
  }

  return data;
}

/** 段 ①：本机账本。 */
function segLedger(d) {
  if (d.rev === null || d.rev === undefined) return MISSING_TEXT.ledger;
  const n = (d.tasks === null || d.tasks === undefined) ? '?' : d.tasks;
  return `本机 rev ${d.rev} / ${n} 张`;
}

/** 段 ②：对端最新包（**必须是"对端"**，本机那份绝不当对账龄印）。 */
function segPeer(d) {
  if (!d.snap) {
    if (d.snapDirError) return `对端最新包 ${MISSING_TEXT.snapDir}`;
    return `对端最新包 ${MISSING_TEXT.peer}`;
  }
  // 时刻与龄期用同一个基准（否则会出现「本地 15:39（-30.0 天）」这种自相矛盾的一行）；文案不动。
  const basis = basisOf(d.snap);
  const at = fmtLocalFull(basis);
  const age = fmtAgeDays(basis, d.now);
  const stale = d.snap.stale === true ? ' ⚠️' : '';
  const host = d.snap.host ?? '?';
  return `对端最新包 本地 ${at ?? '?'}（${age ?? '?'}${stale} · 对端 ${host}）`;
}

/** 段 ③：本机上次出发（辅助读数，**不参与对账龄**）。 */
function segSelf(d) {
  if (!d.self) {
    if (d.snapDirError) return `本机上次出发 ${MISSING_TEXT.snapDir}`;
    return `本机上次出发 ${MISSING_TEXT.self}`;
  }
  const basis = basisOf(d.self);
  const at = fmtLocalFull(basis);
  const age = fmtAgeDays(basis, d.now);
  return `本机上次出发 本地 ${at ?? '?'}（${age ?? '?'}）`;
}

/** 段 ④：并回 job 开关（**只解释"以后还跑不跑"**，不解释过去的轮数）。 */
function segJob(d) {
  if (!d.job) return MISSING_TEXT.job;
  const at = fmtLocalShort(d.job.sinceMs);
  const when = at ? `（本地 ${at} 起）` : '';
  return d.job.enabled ? `并回 job 在跑${when}` : `并回 job 已关${when}`;
}

/** 段 ⑤：运行计数 + 真写入 + 三分项（「0 次」后面必须紧跟分项，否则会被读成故障）。 */
function segArrive(d) {
  const a = d.arrive;
  if (!a) return MISSING_TEXT.arrive;
  const n = (v) => (v === null || v === undefined ? '?' : v);
  return `已跑 ${n(a.runs)} 轮 / 真写入 ${n(a.applied)} 次`
    + `（幂等跳过 ${n(a.unchanged)} · 让出 ${n(a.yielded)} · 冲突 ${n(a.conflicts)}）`;
}

/** 段 ⑥：上次运行（与 job 开关**分开段**，防"因为关了所以 0 次"的误读）。 */
function segLastRun(d) {
  const at = d.arrive ? fmtLocalShort(d.arrive.lastRunAt) : null;
  if (!at) return MISSING_TEXT.lastRun;
  return `上次运行 本地 ${at}`;
}

/**
 * 渲染**一行**（纯函数；数据对象进 → 字符串出）。
 * @param {object} data {@link handoffLedgerData} 的返回（或手搓的同形对象）
 * @returns {string} 一行 markdown（**永不抛错**）
 */
export function handoffLedgerLine(data) {
  try {
    const d = (data && typeof data === 'object') ? data : {};
    const segs = [segLedger(d), segPeer(d), segSelf(d), segJob(d), segArrive(d), segLastRun(d)];
    return HANDOFF_LEDGER_PREFIX + segs.join(' · ');
  } catch (e) {
    return HANDOFF_LEDGER_PREFIX + MISSING_TEXT.render + `（${codeOf(e)}）`;
  }
}

/**
 * 采数 + 渲染 + 兜底（日报唯一的调用入口）。
 * @param {object} [o] {@link handoffLedgerData} 的入参
 * @returns {string} 一行 markdown（**永不抛错**）
 */
export function handoffLedgerSummaryLine(o = {}) {
  try {
    return handoffLedgerLine(handoffLedgerData(o));
  } catch (e) {
    return HANDOFF_LEDGER_PREFIX + MISSING_TEXT.render + `（${codeOf(e)}）`;
  }
}
