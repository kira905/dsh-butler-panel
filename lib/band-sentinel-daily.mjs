// dsh-butler-panel / lib/band-sentinel-daily.mjs —— 日报「🧭 号段哨兵」**一行**的渲染层
//
// 卡：V3功能面·号段哨兵日报行（2026-10-26）
//
// 为什么要这一行（问题陈述）：
//   号段哨兵（`tools\memory-engine\band-sentinel.mjs`，三台各读 `sqlite_sequence.seq`）已经挂在
//   tickd job `band-sentinel`（每天 08:50）。但它的结论只落在 tickd 状态文件里 —— 主人翻日报
//   **看不出昨天红没红**。更糟的一条（tickd JOBS 注释自己登记的代价）：
//   rc=3（号段异常）/ rc=4（取数失败 fail-closed）都在 `benignExitCodes` 里 ⇒ tickd 记
//   `lastStatus='deferred'`、**`failures` 不涨** ⇒ 「⏱ tick 调度健康」段永远不会变红。
//   ⇒ 本行就是那条缺失的出口，所以**必须把 `lastExitCode` 一起判**，只看 lastStatus/failures 会假绿。
//
// 分工（与 `lib\preset-drift-line.mjs` / `lib\audit-state-daily.mjs` 同一套纪律）：
//   · 判定与文案**全在本库**，日报（`report.mjs`）只 push 这一行；
//   · 数据源 = **tickd 状态文件**（按序探测，见下）—— 日报路径里**绝不**现场跑哨兵：
//     哨兵一轮要 2 次 ssh（实测 4.5 s，对端离线时更久），跑进日报会把整份日报拖住（本卡设计前提：零 SSH）；
//   · 读不到 / 没有该 job ⇒ 返回 `{ok:false, reason}`（**不带 line**），由调用方渲染「❔ unknown」——
//     **绝不静默变绿、也绝不静默留空**；
//   · 纯只读：本库不 spawn 任何进程、不发网络请求、不写任何文件（只有 `readFileSync`）。
//
// 数据源探测顺序（第一个能读到且能解析的生效）：
//   ① `opts.statePath`（显式传入，夹具/反证用）
//   ② `%DSH_TICKD_DIR%\state.json`（tickd 自己的口径：`butler-tickd.mjs` L105 `STATE_DIR`）
//   ③ `%TEMP%\dsh-butler-tickd\state.json`（生产缺省）
//   ④ `<SystemRoot>\Temp\dsh-butler-tickd\state.json`（有的机器 TEMP 落系统盘临时目录）
//
// 判据（**纯读 state，不复制哨兵口径**）：
//   · `lastStatus='ok'` + `lastExitCode=0`            ⇒ 🟢 绿（正常）
//   · `lastStatus='deferred'` + `lastExitCode=3`      ⇒ ⚠️ **号段异常**（哨兵判红；tickd 不记 failures）
//   · `lastStatus='deferred'` + `lastExitCode=4`      ⇒ ⚠️ **取数失败**（fail-closed：连不上对端/读不到库）
//   · `lastStatus='deferred'` + 其它码               ⇒ ⏸ 有结论地跑完但不认得的让路码（如实点名）
//   · `lastStatus='locked' / 'busy'`                  ⇒ ⏸ 让路（锁被占/交接窗口，本轮没跑）
//   · `lastStatus='exit-N' / 'error' / 'spawn-error'` ⇒ ⚠️ 真失败（这条才会涨 failures）
//   · 有 job 记录但没有 `lastStatus`（runs 0）        ⇒ ❔ 从未跑过
//   · 读数超过 36h 未更新（job 是日频 08:50）         ⇒ ⚠️ 读数陈旧（停机窗口/停摆期不许静默变绿）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIB_VERSION = '0.1.0';
export const JOB_ID = 'band-sentinel';
/** 日频 job 的读数新鲜窗（小时）：同 `tools\dsh-butler\lib\job-failure-delivery.mjs#FRESH_HOURS_DEFAULT` 口径。 */
export const STALE_HOURS = 36;

// 🟢 只用于非 ok 之外的显性档；正常档不挂图标（与卡面条目形态一致：`：上次 ok · 10-26 17:44 · …`）
const ICON = { ok: '', warn: '⚠️', idle: '⏸', unknown: '❔' };

function p2(n) { return String(n).padStart(2, '0'); }

/** ISO 字符串 → 本地时间 `MM-DD HH:mm`（tickd 写的是 UTC ISO，必须换成本地钟点再给人看）。 */
export function fmtLocal(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 待探测的状态文件清单（保持顺序、去重、一律绝对路径）。 */
export function stateCandidates(opts = {}) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!out.some((x) => x.toLowerCase() === abs.toLowerCase())) out.push(abs);
  };
  if (opts.statePath) { push(opts.statePath); return out; } // 显式传入 ⇒ 只用它（夹具要能构造"缺 job"的世界）
  const tickdDir = process.env.DSH_TICKD_DIR;
  if (tickdDir) push(path.join(tickdDir, 'state.json'));
  const tmp = process.env.TEMP || process.env.TMP || os.tmpdir();
  push(path.join(tmp, 'dsh-butler-tickd', 'state.json'));
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) push(path.join(sysRoot, 'Temp', 'dsh-butler-tickd', 'state.json'));
  return out;
}

/** 按序读状态文件（只读；每个候选都留痕，失败原因不吞）。 */
export function readTickdState(opts = {}) {
  const probed = [];
  for (const file of stateCandidates(opts)) {
    if (!fs.existsSync(file)) { probed.push({ file, ok: false, error: '文件不存在' }); continue; }
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      probed.push({ file, ok: true });
      return { ok: true, file, state, probed };
    } catch (e) {
      // tickd 用 tmp+rename 原子写，理论上读不到半截文件；真读到坏 JSON 也要留痕（不许静默下一条）
      probed.push({ file, ok: false, error: `解析失败：${String(e?.message ?? e).slice(0, 120)}` });
    }
  }
  return { ok: false, probed };
}

/**
 * 判一个 job 记录（纯函数，不做 IO）。
 * @returns {{tone:'ok'|'warn'|'idle'|'unknown', verdict:string, note?:string, ok:boolean}}
 */
export function judgeJob(job, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  if (!job || typeof job !== 'object') {
    return { tone: 'unknown', ok: false, verdict: '状态文件里没有该 job 的记录' };
  }
  const status = job.lastStatus == null ? null : String(job.lastStatus);
  const code = job.lastExitCode == null ? null : Number(job.lastExitCode);
  const endIso = job.lastEndAt || job.lastRunAt || null;
  const endMs = endIso ? Date.parse(endIso) : NaN;

  if (!status) {
    return {
      tone: 'unknown', ok: false,
      verdict: `从未跑过（runs ${Number(job.runs) || 0}；job 每天 08:50 应有一次）`,
    };
  }

  // ── 1) 正常 ────────────────────────────────────────────────
  if (status === 'ok' && (code === null || code === 0)) {
    if (Number.isFinite(endMs)) {
      const ageH = (nowMs - endMs) / 3600000;
      if (ageH > STALE_HOURS) {
        return {
          tone: 'warn', ok: false,
          verdict: `上次 ok 但**读数已 ${ageH.toFixed(1)}h 未更新**（job 每天 08:50；停机窗口/job 被摘/tickd 停摆都会这样）`,
        };
      }
    }
    return { tone: 'ok', ok: true, verdict: '上次 ok' };
  }

  // ── 2) 让路码（本 job 的 benignExitCodes = [3,4]）—— 这里才是真事件 ─────────
  if (status === 'deferred') {
    if (code === 3) {
      return {
        tone: 'warn', ok: false,
        verdict: '上次 **rc=3 号段异常**（哨兵判红：下一条新 id 已冲出本机独占段）',
        note: 'rc=3/4 按 benign 记账 ⇒ failures 不涨，"failures 0"不代表没出事',
      };
    }
    if (code === 4) {
      return {
        tone: 'warn', ok: false,
        verdict: '上次 **rc=4 取数失败**（fail-closed：对端连不上 / 读不到库 ⇒ 这一轮等于没查）',
        note: 'rc=3/4 按 benign 记账 ⇒ failures 不涨，"failures 0"不代表没出事',
      };
    }
    return {
      tone: 'idle', ok: false,
      verdict: `上次 deferred（rc=${code === null ? '?' : code} 让路码 · 本 job 只声明了 3/4，这个码不认得）`,
    };
  }

  // ── 3) 让路（没跑成，但不算失败）────────────────────────────
  if (status === 'locked' || status === 'busy') {
    return { tone: 'idle', ok: false, verdict: `上次 ${status}（让路：${status === 'locked' ? '锁被别的入口占着' : '交接窗口内'}，本轮没跑）` };
  }

  // ── 4) 真失败 ─────────────────────────────────────────────
  if (/^exit-\d+$/.test(status) || status === 'error' || status === 'spawn-error') {
    return { tone: 'warn', ok: false, verdict: `上次 **${status} 真失败**` };
  }

  return { tone: 'unknown', ok: false, verdict: `上次状态 \`${status}\` 不在已知口径里（未识别的 lastStatus）` };
}

/**
 * 日报唯一入口：取数 → 判定 → 渲染**一行**。
 * @param {{home?:string, toolRoot?:string, statePath?:string, now?:number}} opts
 * @returns {{ok:boolean, line?:string, reason?:string, file?:string, job?:object, probed?:Array}}
 */
export function bandSentinelDailyLine(opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const read = readTickdState(opts);

  if (!read.ok) {
    const detail = (read.probed ?? [])
      .map((x) => `${x.file}${x.ok ? '' : `（${x.error}）`}`)
      .join('、') || '（没有候选路径）';
    return {
      ok: false,
      reason: `tickd 状态文件读不到：${detail}`,
      probed: read.probed,
    };
  }

  const jobs = read.state?.jobs;
  const job = jobs && typeof jobs === 'object' ? jobs[JOB_ID] : undefined;

  if (!job || typeof job !== 'object') {
    const jobsN = jobs && typeof jobs === 'object' ? Object.keys(jobs).length : 0;
    return {
      ok: false,
      reason: `tickd 状态里没有 ${JOB_ID}（该文件共 ${jobsN} 个 job；job 可能被摘 / tickd 换机 / JOBS 表未含）`,
      file: read.file,
      probed: read.probed,
    };
  }

  const verdict = judgeJob(job, { now: nowMs });
  const runs = Number(job.runs) || 0;
  const failures = Number(job.failures) || 0;
  const when = fmtLocal(job.lastEndAt || job.lastRunAt);

  // failures 在「有真失败」时才加粗 —— 让路带（rc=3/4）的 0 要在后面注明"不代表没出事"
  const failText = failures > 0 ? `**failures ${failures}**` : `failures ${failures}`;
  const bits = [verdict.verdict];
  if (when) bits.push(when);
  bits.push(`累计 runs ${runs} / ${failText}`);
  if (verdict.note) bits.push(verdict.note);
  if (verdict.tone === 'warn' || verdict.tone === 'idle' || verdict.tone === 'unknown') {
    bits.push('详情看 `%TEMP%\\dsh-butler-tickd\\last-error\\band-sentinel.log`');
  }

  const head = '- 🧭 号段哨兵（记忆号段复发 · 三台只读）';
  const iconPrefix = ICON[verdict.tone] ? `${ICON[verdict.tone]} ` : '';
  return {
    ok: verdict.ok === true,
    line: `${head}：${iconPrefix}${bits.join(' · ')}`,
    reason: verdict.ok === true ? undefined : verdict.verdict,
    file: read.file,
    job: { lastStatus: job.lastStatus ?? null, lastExitCode: job.lastExitCode ?? null, runs, failures, lastEndAt: job.lastEndAt ?? null },
    probed: read.probed,
  };
}
