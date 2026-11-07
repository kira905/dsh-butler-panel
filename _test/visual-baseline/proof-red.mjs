#!/usr/bin/env node
// dsh-butler-panel/_test/visual-baseline/proof-red.mjs
//
// V31-020 · 先证红演练（一条命令）= 四步 + 三断言 + 一自证
//
//   步1  记下两份 lib\client.js 的 sha（跑前基准）
//   步2  用**当前源码**渲 identical-<theme> → 与正式基线比 ⇒ **必须全绿**（证"夹具不空转 + 基线可复现"）
//   步3  用 proof\red-inject.css 渲 injected-<theme> → 与正式基线比 ⇒ **必须判红**，且每页：
//        ① 差异图存在且非空 ② 差异包围盒落在 Tab 下划线带（h ≤ 4 且 y ∈ {119,139}）
//        ③ 差异像素 30 ≤ px ≤ 400（防"随便红"）
//   步4  复原：注入只走 CSS 文件、**从不写源码** ⇒ 复核两份 client.js 的 sha == 步1；
//        删临时目录（--keep 保留现场）
//
// --selftest：用**空注入件**重跑 步2→步3，断言"演练自己必须报失败（该红没红）"。
//             若空注入下演练仍判过 ⇒ 演练是永远绿的空壳 ⇒ 自证 rc 1。
//
// 用法：
//   node proof-red.mjs [--theme dark|light|both] [--baseline <pair根>] [--out <目录>] [--keep] [--selftest]
// 默认：--theme both · --baseline %VB%\baseline-v31-020 · --out %VB%\_tmp\proof-red-<ts>
//
// rc：0 = 全过；1 = 任一断言不过；2 = 用法错；3 = 缺前置（无 Chrome / 正式基线不存在 / 注入件缺失）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const RENDER = path.join(HERE, 'static-render.mjs');
const DIFF = path.join(HERE, 'visual-diff.mjs');
const INJECT = path.join(HERE, 'proof', 'red-inject.css');
// 源码根：默认按仓库布局推导（本仓 lib/client.js 与相邻仓的生态面板）；
// 也可用 `--butler/--eco` 或环境变量 PANEL_CLIENT / ECO_PANEL_CLIENT 指定。
const BUTLER = arg('butler', process.env.PANEL_CLIENT || path.join(HERE, '..', '..', 'lib', 'client.js'));
const ECO = arg('eco', process.env.ECO_PANEL_CLIENT || path.join(HERE, '..', '..', '..', 'dsh-ecosystem-panel', 'lib', 'client.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);
const KNOWN_V = new Set(['theme', 'baseline', 'out']);
const KNOWN_F = new Set(['keep', 'selftest', 'help']);
for (let i = 0; i < argv.length; i++) {
	const t = argv[i];
	if (!t.startsWith('--')) { console.error(`用法错误：多余参数 ${t}`); process.exit(2); }
	const n = t.slice(2);
	if (KNOWN_V.has(n)) { if (argv[i + 1] === undefined) { console.error(`用法错误：--${n} 缺值`); process.exit(2); } i++; }
	else if (!KNOWN_F.has(n)) { console.error(`用法错误：未知参数 ${t}`); process.exit(2); }
}
if (has('--help')) {
	console.log('用法: node proof-red.mjs [--theme dark|light|both] [--baseline <pair根>] [--out <目录>] [--keep] [--selftest]');
	process.exit(0);
}
const THEME_ARG = arg('theme', 'both');
if (!['dark', 'light', 'both'].includes(THEME_ARG)) { console.error('用法错误：--theme 只认 dark/light/both'); process.exit(2); }
const THEMES = THEME_ARG === 'both' ? ['dark', 'light'] : [THEME_ARG];
const BASE = path.resolve(arg('baseline', path.join(HERE, 'baseline-v31-020')));
const OUT = path.resolve(arg('out', path.join(HERE, '_tmp', 'proof-red-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14))));
const KEEP = has('--keep');
const SELFTEST = has('--selftest');
const TAB_Y = new Set([119, 139]);   // 生态面板 Tab 在 y=119，大管家在 y=139（实测）
const PX_MIN = 30, PX_MAX = 400;
const fails = [];
function check(ok, msg) { console.log(`  ${ok ? '✔' : '✖'} ${msg}`); if (!ok) fails.push(msg); return ok; }
function sha(f) { return fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null; }
function run(args) {
	const r = spawnSync(NODE, args, { encoding: 'utf8', timeout: 240000, cwd: HERE });
	const out = (r.stdout ?? '') + (r.stderr ?? '');
	if (out.includes('找不到 chrome')) { console.log('缺前置：没有 Chrome/Edge（static-render 报的）'); process.exit(3); }
	return { rc: r.status === null ? 1 : r.status, out, last: out.trim().split(/\r?\n/).slice(-1)[0] ?? '' };
}

/** 注入结果的逐页判定（正常模式判"红得对不对"；自证模式判"该红没红"） */
function judgeInjected(res, diffDir) {
	const lines = []; let ok = 0;
	if (!res || !Array.isArray(res.pages)) return { ok: false, good: 0, total: 0, lines: ['没有 --json 结果 / 结构不对'] };
	for (const p of res.pages) {
		const img = path.join(diffDir, `diff-${p.key}.png`);
		const imgOk = fs.existsSync(img) && fs.statSync(img).size > 0;
		const bb = p.bbox;
		const geoOk = !!bb && bb.h <= 4 && TAB_Y.has(bb.y);
		const pxOk = p.diffPixels >= PX_MIN && p.diffPixels <= PX_MAX;
		const good = p.verdict === 'FAIL' && imgOk && geoOk && pxOk;
		if (good) ok++;
		lines.push(`      ${good ? '✔' : '✖'} ${p.key.padEnd(16)} ${p.verdict.padEnd(4)} 差异 ${String(p.diffPixels).padStart(4)} px${pxOk ? '' : `（不在 ${PX_MIN}~${PX_MAX}）`} · bbox ${bb ? `${bb.w}x${bb.h}@(${bb.x},${bb.y})` : '无'}${geoOk ? '' : '（不在下划线带）'} · 差异图 ${imgOk ? '有' : '缺'}`);
	}
	return { ok: ok === res.pages.length, good: ok, total: res.pages.length, lines };
}

// ── 前置 ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(BASE, 'pair.json'))) {
	console.log(`缺前置：正式基线不存在：${path.join(BASE, 'pair.json')}`);
	console.log(`  ⇒ 先落基线：node static-render.mjs --formal --tag ${path.basename(BASE)} --theme dark --out ${path.basename(BASE)}\\dark（light 同理）`);
	process.exit(3);
}
if (!SELFTEST && !fs.existsSync(INJECT)) { console.log(`缺前置：注入件缺失：${INJECT}`); process.exit(3); }
for (const f of [RENDER, DIFF]) if (!fs.existsSync(f)) { console.log(`缺前置：器具缺失：${f}`); process.exit(3); }

const pair = JSON.parse(fs.readFileSync(path.join(BASE, 'pair.json'), 'utf8'));
const injectFile = SELFTEST ? path.join(OUT, 'empty-inject.css') : INJECT;
fs.mkdirSync(OUT, { recursive: true });
if (SELFTEST) fs.writeFileSync(injectFile, '/* 空注入件：故意什么都不改，用来证明演练不是永远绿 */\n', 'utf8');

console.log(`先证红演练${SELFTEST ? '（--selftest 自证模式）' : ''} · 基线 ${BASE}（tag=${pair.tag}）· 主题 ${THEMES.join('+')} · 临时目录 ${OUT}`);
console.log(`注入件 ${SELFTEST ? '（空件，自证用）' : INJECT}`);

// ── 步1：跑前 sha 基准 ──────────────────────────────────────────────────────
const before = { butler: sha(BUTLER), eco: sha(ECO) };
console.log(`\n步1 · 源码 sha 基准：butler=${String(before.butler).slice(0, 12)}… eco=${String(before.eco).slice(0, 12)}…`);

// ── 步2：同源码重渲必须全绿 ─────────────────────────────────────────────────
console.log('\n步2 · 同源码重渲 vs 正式基线 ⇒ 必须全绿（证夹具不空转 + 基线可复现）');
for (const t of THEMES) {
	const dir = path.join(OUT, `identical-${t}`);
	const r1 = run([RENDER, '--tag', `proof-identical-${t}`, '--theme', t, '--out', dir]);
	if (r1.rc !== 0) { check(false, `${t}: 渲染失败 rc=${r1.rc} · ${r1.last}`); continue; }
	const r2 = run([DIFF, '--baseline', BASE, '--theme', t, '--candidate', dir]);
	check(r2.rc === 0, `${t}: 同源码重渲 rc=${r2.rc}（须 0）· ${r2.last}`);
	if (r2.rc !== 0) console.log(r2.out.trim().split(/\r?\n/).slice(-7).map((l) => '      ' + l).join('\n'));
}

// ── 步3：注入必须红，且红得对 ───────────────────────────────────────────────
console.log(`\n步3 · 注入 ${SELFTEST ? '（空件）' : '「当前 Tab 下划线 → 纯红」'} vs 正式基线`);
for (const t of THEMES) {
	const dir = path.join(OUT, `injected-${t}`);
	const diffDir = path.join(OUT, `diff-${t}`);
	const jsonFile = path.join(OUT, `result-${t}.json`);
	const r1 = run([RENDER, '--tag', `proof-injected-${t}`, '--theme', t, '--inject-css-file', injectFile, '--out', dir]);
	if (r1.rc !== 0) { check(false, `${t}: 注入渲染失败 rc=${r1.rc} · ${r1.last}`); continue; }
	fs.rmSync(diffDir, { recursive: true, force: true });
	const r2 = run([DIFF, '--baseline', BASE, '--theme', t, '--candidate', dir, '--out', diffDir, '--json', jsonFile]);
	const res = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')) : null;
	const j = judgeInjected(res, diffDir);
	if (j.lines.length) console.log(j.lines.join('\n'));
	if (SELFTEST) {
		const noRed = r2.rc === 0 && !!res && res.summary.diffPixels === 0;
		check(noRed, `${t}: 空注入下比对 rc=${r2.rc} 差异=${res ? res.summary.diffPixels : 'n/a'}（须 rc 0 且差异 0 ⇒ 本来就该绿）`);
		check(j.ok === false, `${t}: 演练检查器对空注入判「不过」（该红没红被抓住）`);
	} else {
		check(r2.rc === 1, `${t}: 注入后判定 rc=${r2.rc}（须 1）· ${r2.last}`);
		check(j.ok, `${t}: 逐页判红 + 差异图非空 + bbox 落在下划线带 + px∈[${PX_MIN},${PX_MAX}]（${j.good}/${j.total}）`);
	}
}

// ── 步4：复原（没写源码的直接证据） ─────────────────────────────────────────
const after = { butler: sha(BUTLER), eco: sha(ECO) };
console.log('\n步4 · 复原：注入只走 CSS 文件，源码一个字节没动');
check(before.butler === after.butler, `butler lib\\client.js sha 未变（${String(after.butler).slice(0, 12)}…）`);
check(before.eco === after.eco, `eco lib\\client.js sha 未变（${String(after.eco).slice(0, 12)}…）`);
for (const t of THEMES) {
	const tm = pair.themes?.[t];
	if (!tm) continue;
	const mf = path.join(BASE, tm.manifest);
	if (!fs.existsSync(mf)) continue;
	const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
	const eq = m.sources?.butlerSha === after.butler && m.sources?.ecoSha === after.eco;
	console.log(`      ${eq ? '✔' : '·'} 与基线 manifest 记录一致（${t}）= ${eq}（基线记录 butler=${String(m.sources?.butlerSha).slice(0, 12)}…）`);
}

if (!KEEP) { fs.rmSync(OUT, { recursive: true, force: true }); console.log(`\n临时目录已清（--keep 保留现场）：${OUT}`); }
else console.log(`\n现场保留：${OUT}`);

// ── 汇总（永远最后一行） ────────────────────────────────────────────────────
if (SELFTEST) {
	const ok = fails.length === 0;
	console.log(`\n自证${ok ? ' PASS' : ' 失败'}：空注入下演练必须报「该红没红」⇒ ${ok ? '抓到（演练不是空壳）' : `没抓到（${fails.length} 条不过）`} · rc=${ok ? 0 : 1}`);
	process.exit(ok ? 0 : 1);
}
const ok = fails.length === 0;
console.log(`\n断言 ${ok ? '3/3 PASS' : `${3 - Math.min(3, fails.length)}/3 PASS`} · 失败 ${fails.length} 条 · 自证另跑 --selftest · rc=${ok ? 0 : 1}`);
if (!ok) for (const f of fails) console.log(`  ✖ ${f}`);
process.exit(ok ? 0 : 1);
