#!/usr/bin/env node
// dsh-butler-panel/_test/visual-baseline/visual-diff.mjs
//
// V31-020 · 视觉回归比对器（零依赖：tools/lib/png.mjs 纯 Node 解码）
//
// ⚠️ 本文件**不得**改 tools/lib/png.mjs（共享件，verify-colors.mjs 等在用）：
//    逐像素归属（哪个差异像素落在清单哪个 bbox 里）在这里自己走一遍循环。
//
// ── 判据（方案 §2.4 口径变更；旧「比例 ≤ 0.5%」已作废） ──────────────────────
//   差异像素 = |ΔR|+|ΔG|+|ΔB| > 6（通道和，与 png.mjs 同口径）
//   无 --allow-list ⇒ 判据 = **差异像素 = 0**
//   有 --allow-list ⇒ 判据 = **清单外 = 0** + 逐条对账（三档，见方案 §3.1.1）
//     ① 位置：差异像素必须全部落在清单声明的 bbox 内（清单外 = 0）
//     ② 条目：每条必须命中自己声明的 ≥1 组 before→after（每通道 ±1），
//              且 bbox 内实际差异像素数 == 声明的 pixels（--loose-count 时只警告）
//     ③ 残差：bbox 内未命中任何声明色对的差异像素 = **读数**，默认不判红；
//              --strict-color 时才必须 = 0
//   --threshold <比例>：**必须显式给**才生效（打印 deprecated）
//   --strict：等价「差异像素 = 0」（兼容老命令）
//
// ── --mask：已知「会变」的区域（A 路真宿主截图专用，2026-10-30 掩码卡） ──────────
//   ⚠️ 与 --allow-list **语义相反**，别混：
//     --allow-list = **允许的色变**（条目声明 before→after，必须逐条对得上账："这里变了，是我们要的"）
//     --mask       = **已知会变的区域**（时间戳/耗时读数/KPI 计数/相对时间）：区里差异一律不计，
//                    也不参与清单对账。它不是"我要的变化"，是"这条区域本来就不该进判据"。
//   · 掩码内差异不计入 diff / 清单外 / 残差；**逐页与汇总都必须打印「掩码吞掉多少 px」**
//     （防止掩码越加越大、把真问题吞了：吞了多少必须随时看得见）。
//   · 面积闸：每页掩码**总面积**必须 ≤ 掩码件 policy.maxMaskedPixelsPerPage（否则 rc 4 拒用）；
//     运行时**实测被吞像素** > 同一上限 ⇒ rc 1（掩码长胖了就红）。
//   · 绑定：appliesTo.baselineTag / appliesTo.baselinePageSha（6 页全给）/ appliesTo.viewport+dpr
//     任一与基线不符 ⇒ rc 4（掩码是"这一刻这张图"的指纹；A 路的裁后图像素坐标还依赖视口尺寸）。
//   · 可单独用（判据 = 掩码外差异 = 0），也可与 allow-list 并用。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   node visual-diff.mjs --baseline <目录|pair根> --candidate <目录> [选项]
//     --theme dark|light        pair 根时选子目录；两侧 manifest 都有 theme 时必须一致
//     --allow-list <json>       允许差异清单（schema 见 allow-lists\v31-018-dark.json）
//     --mask <json>             已知会变的区域清单（schema 见 a-masks\v31-020-host.json）
//                               —— 掩码内差异不计，逐页/汇总打印「掩码吞 N px」
//     --expect-tag <tag>        基线 manifest.tag 必须等于它
//     --threshold <比例>        比例口径（已作废，必须显式给）
//     --strict                  差异像素必须 = 0
//     --out <目录>              差异图 diff-<key>.png
//     --json <文件>             机器可读结果（字段写死在方案 §3.1.4）
//     --page <key>              只比一页
//     --strict-count            条目 pixels 严格相等（缺省）
//     --loose-count             条目 pixels 只警告
//     --strict-color            残差必须 = 0（缺省只读）
//     --dump-components         打印连通分量 + bbox + 像素数 + top 色对（JSON）
//     --dry-run                 只打印计划
//
// ── rc 矩阵（验收就照这张表） ────────────────────────────────────────────────
//   0  全绿（清单外 0 + 条目全对账 / 掩码外差异 0）  → 打印汇总行
//   1  红：清单外差异 / 条目计数不符 / 条目声明色对未命中 / strict-color 残差 > 0 /
//          掩码外差异 > 0 / 掩码吞掉的 px 超过 policy 上限
//   2  用法错                                   → 打印用法行
//   3  缺件：基线目录不存在 / 基线缺 manifest.json / 候选缺 manifest.json /
//          候选缺页 / 基线图缺失 / 图 sha 与 manifest 不符 / 清单文件缺失 /
//          掩码文件缺失 / pair.json 与 manifest 不一致
//   4  配套关系不成立（不许比）：--expect-tag 不符 / 主题不一致 / 清单绑定基线不符 /
//          清单 schema 不合法 / bbox 越界或重叠 / 掩码绑定基线不符（tag·6 页 sha·视口）/
//          掩码 schema 不合法 / 掩码 bbox 越界或重叠 / 掩码面积超 policy 上限
//   ⚠️ 任何 rc≠0 都必须有一行指名道姓的正文明细；**汇总行永远最后打印**。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../../../lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = ['butler-overview', 'butler-tasks', 'butler-assets', 'eco-bundles', 'eco-skills', 'eco-upgrades'];
const TOL = 6;        // 差异判据：通道和
const CTOL = 1;       // 色对命中判据：每通道

const VALUED = new Set(['baseline', 'candidate', 'theme', 'allow-list', 'mask', 'expect-tag', 'threshold', 'out', 'json', 'page']);
const FLAGS = new Set(['strict', 'strict-color', 'strict-count', 'loose-count', 'dump-components', 'dry-run', 'help']);
const argv = process.argv.slice(2);
const opt = {};
let usageErr = null;
for (let i = 0; i < argv.length; i++) {
	const t = argv[i];
	if (!t.startsWith('--')) { usageErr = `用法错误：多余的位置参数 ${t}`; break; }
	const name = t.slice(2);
	if (VALUED.has(name)) {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith('--')) { usageErr = `用法错误：--${name} 缺值`; break; }
		opt[name] = v; i++;
	} else if (FLAGS.has(name)) {
		opt[name] = true;
	} else { usageErr = `用法错误：未知参数 ${t}`; break; }
}

const USAGE = '用法: node visual-diff.mjs --baseline <目录|pair根> --candidate <目录> [--theme dark|light] [--allow-list <json>] [--mask <json>] [--expect-tag <tag>] [--out <dir>] [--json <file>] [--page <key>] [--strict|--strict-color|--loose-count|--threshold <比例>] [--dump-components] [--dry-run]';

const st = { pages: 0, diff: 0, outside: 0, entriesTotal: 0, entriesOk: 0, residual: 0, missing: 0, strictColorBad: 0, masked: 0, maskArea: 0, maskOverflow: 0, excluded: 0 };
let MASK = null;	// 掩码件（--mask）；语义见文件头：已知会变的区域，区内差异不计

function pct(n, d) { return d ? ((n / d) * 100).toFixed(1) : '0.0'; }
function summaryLine(rc, judge) {
	const epc = st.entriesTotal ? `${((st.entriesOk / st.entriesTotal) * 100).toFixed(0)}%` : '-';
	return `汇总：${st.pages} 页 · 差异 ${st.diff}${st.missing ? ` · 缺页 ${st.missing}` : ''} · 清单外 ${st.outside} · ` +
		`条目 ${st.entriesOk}/${st.entriesTotal}${st.entriesTotal ? `(${epc})` : ''} · 残差 ${st.residual}(${pct(st.residual, st.diff)}%)` +
		(MASK ? ` · 掩码吞 ${st.masked} px（掩码总面积 ${st.maskArea} px${st.maskOverflow ? ` · 超限 ${st.maskOverflow} px` : ''}${st.excluded ? ` · 整页排除 ${st.excluded} 页` : ''}）` : '') +
		` · 判据 ${judge} · rc=${rc}`;
}
function die(rc, lines, judge) {
	// 明细与汇总都走 stdout：保证「汇总行永远是最后一行」（stderr 与 stdout 混流时顺序不保证）
	for (const l of lines) console.log(l);
	console.log(summaryLine(rc, judge));
	process.exit(rc);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function rgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }
function hexAt(data, o) { return [data[o], data[o + 1], data[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''); }
function close3(a, b) { return Math.abs(a[0] - b[0]) <= CTOL && Math.abs(a[1] - b[1]) <= CTOL && Math.abs(a[2] - b[2]) <= CTOL; }

if (opt.help) { console.log(USAGE); process.exit(0); }
if (usageErr) { console.error(usageErr); console.error(USAGE); process.exit(2); }
if (!opt.baseline || !opt.candidate) { console.error(USAGE); process.exit(2); }
if (opt.theme && !['dark', 'light'].includes(opt.theme)) die(2, [`用法错误：--theme 只认 dark / light（给的是 ${opt.theme}）`], '-');
if (opt.threshold !== undefined) {
	const t = Number(opt.threshold);
	if (!Number.isFinite(t) || t < 0) die(2, [`用法错误：--threshold 需要非负小数（给的是 ${opt.threshold}）`], '-');
	opt.thresholdN = t;
}

// ── 1. 解析基线（目录优先；否则 pair 根按 --theme 取子目录） ───────────────────
const BASE_ARG = path.resolve(opt.baseline);
const CAND_DIR = path.resolve(opt.candidate);
let BASE_DIR = null, PAIR = null, PAIR_ROOT = null;
if (!fs.existsSync(BASE_ARG)) die(3, [`基线目录不存在：${BASE_ARG}`], '缺件');
if (fs.existsSync(path.join(BASE_ARG, 'manifest.json'))) {
	BASE_DIR = BASE_ARG;
} else if (fs.existsSync(path.join(BASE_ARG, 'pair.json'))) {
	PAIR_ROOT = BASE_ARG;
	try { PAIR = JSON.parse(fs.readFileSync(path.join(BASE_ARG, 'pair.json'), 'utf8')); } catch (e) { die(3, [`pair.json 解析失败：${e.message}`], '缺件'); }
	const themes = Object.keys(PAIR.themes ?? {});
	const t = opt.theme ?? PAIR.defaultTheme ?? themes[0];
	if (!t || !themes.includes(t)) die(3, [`基线目录不存在：${path.join(BASE_ARG, String(t))}（pair 根 ${BASE_ARG} 下没有 ${t}/，现有 ${themes.join('/') || '无'}）`], '缺件');
	BASE_DIR = path.join(BASE_ARG, t);
	if (!fs.existsSync(BASE_DIR)) die(3, [`基线目录不存在：${BASE_DIR}（pair 根 ${BASE_ARG} 登记了 ${t}/ 但没有这个目录）`], '缺件');
} else {
	die(3, [`基线缺 manifest.json：${path.join(BASE_ARG, 'manifest.json')}`,
		`  ⇒ 这不是基线目录，也不是 pair 根（没有 pair.json）。先用 static-render.mjs --formal --tag baseline-v31-020 --theme <dark|light> --out baseline-v31-020\\<theme> 落一套正式基线。`], '缺件');
}

// ── 2. 缺件检查 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(CAND_DIR)) die(3, [`候选目录不存在：${CAND_DIR}`], '缺件');
const MB_FILE = path.join(BASE_DIR, 'manifest.json');
const MC_FILE = path.join(CAND_DIR, 'manifest.json');
if (!fs.existsSync(MB_FILE)) die(3, [`基线缺 manifest.json：${MB_FILE}`,
	`  ⇒ 先用 static-render.mjs --formal --tag baseline-v31-020 --theme ${opt.theme ?? 'dark'} --out baseline-v31-020\\${opt.theme ?? 'dark'} 落基线。`], '缺件');
if (!fs.existsSync(MC_FILE)) die(3, [`候选缺 manifest.json：${MC_FILE}`], '缺件');
const mb = JSON.parse(fs.readFileSync(MB_FILE, 'utf8'));
const mc = JSON.parse(fs.readFileSync(MC_FILE, 'utf8'));
if (!Array.isArray(mb.pages) || !Array.isArray(mc.pages)) die(3, [`manifest 结构不对（缺 pages 数组）`], '缺件');

// ── 3. 一致性检查（rc 4） ────────────────────────────────────────────────────
if (opt['expect-tag'] && mb.tag !== opt['expect-tag']) {
	die(4, [`--expect-tag 期望 ${opt['expect-tag']} 实际 ${mb.tag}`], '配套关系');
}
if (opt.theme && mb.theme && opt.theme !== mb.theme) {
	die(4, [`主题不一致：--theme ${opt.theme} / 基线 ${mb.theme}（拒比）`], '配套关系');
}
if (mb.theme && mc.theme && mb.theme !== mc.theme) {
	die(4, [`主题不一致：基线 ${mb.theme} / 候选 ${mc.theme}（拒比）`], '配套关系');
}
if (opt.theme && mc.theme && opt.theme !== mc.theme) {
	die(4, [`主题不一致：--theme ${opt.theme} / 候选 ${mc.theme}（拒比）`], '配套关系');
}
if (!mb.theme || !mc.theme) console.log(`theme 未知（按不校验处理）：基线=${mb.theme ?? '缺'} 候选=${mc.theme ?? '缺'}`);
// pair.json 与 manifest 交叉校验（权威源 = 各态 manifest）
if (PAIR) {
	const t = path.basename(BASE_DIR);
	const reg = PAIR.themes?.[t];
	if (!reg) die(3, [`pair.json 与 manifest 不一致：pair 里没有 ${t} 这一态`], '缺件');
	if (PAIR.tag && mb.tag && PAIR.tag !== mb.tag) die(3, [`pair.json 与 manifest 不一致：pair.tag=${PAIR.tag} / manifest.tag=${mb.tag}`], '缺件');
	if (reg.pages && typeof reg.pages === 'object') {
		const bad = Object.entries(reg.pages).filter(([k, v]) => (mb.pages.find((p) => p.key === k)?.sha256 ?? null) !== v);
		if (bad.length) die(3, [`pair.json 与 manifest 不一致：${bad.map(([k]) => k).join(', ')} 的页 sha 对不上（权威源 = manifest）`], '缺件');
	}
}

// ── 4. 清单（结构校验 rc 4；文件缺失 rc 3） ───────────────────────────────────
let AL = null;
if (opt['allow-list']) {
	const ALF = path.resolve(opt['allow-list']);
	if (!fs.existsSync(ALF)) die(3, [`清单文件不存在：${ALF}`], '缺件');
	try { AL = JSON.parse(fs.readFileSync(ALF, 'utf8')); } catch (e) { die(4, [`清单 schema 不合法：JSON 解析失败 ${e.message}`], '配套关系'); }
	const bad = [];
	const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
	const isInt = (v) => Number.isInteger(v);
	if (AL.schemaVersion !== 1) bad.push('schemaVersion 必须 = 1');
	if (!isStr(AL.id)) bad.push('id 必须非空');
	if (isStr(AL.id) && AL.id !== path.basename(ALF, '.json')) bad.push(`id(${AL.id}) 必须等于文件名(${path.basename(ALF, '.json')})`);
	if (!isStr(AL.title)) bad.push('title 必须非空');
	if (!isStr(AL.source)) bad.push('顶层 source 必须非空（指到卡 A 报告 §3）');
	if (!AL.appliesTo || !isStr(AL.appliesTo?.baselineTag)) bad.push('appliesTo.baselineTag 必须非空');
	if (AL.appliesTo?.theme && !['dark', 'light'].includes(AL.appliesTo.theme)) bad.push('appliesTo.theme 只认 dark / light');
	if (AL.policy && AL.policy.strictCounts === undefined) bad.push('policy.strictCounts 建议显式写');
	if (!AL.pages || typeof AL.pages !== 'object') bad.push('pages 必须是对象');
	for (const [k, pg] of Object.entries(AL.pages ?? {})) {
		if (!PAGES.includes(k)) { bad.push(`清单页不存在：${k}（页键只认 ${PAGES.join('/')}）`); continue; }
		if (!Array.isArray(pg.entries)) { bad.push(`${k}.entries 必须是数组`); continue; }
		const ids = new Set(); const beforeToAfter = new Map();
		for (const e of pg.entries) {
			const tag = `${k}.${e?.id ?? '?'}`;
			if (!isStr(e?.id)) bad.push(`${tag}: id 必须非空`);
			if (ids.has(e?.id)) bad.push(`${tag}: 页内 id 重复`);
			ids.add(e?.id);
			if (!Array.isArray(e?.bbox) || e.bbox.length !== 4 || !e.bbox.every(isInt) || e.bbox.some((v) => v < 0)) bad.push(`${tag}: bbox 必须是 4 个非负整数`);
			if (!Array.isArray(e?.pairs) || !e.pairs.length) bad.push(`${tag}: pairs 至少 1 组`);
			for (const pr of e?.pairs ?? []) {
				if (!Array.isArray(pr) || pr.length !== 2 || !pr.every((v) => /^#[0-9a-f]{6}$/.test(v))) { bad.push(`${tag}: 色对必须是两个小写 #rrggbb`); continue; }
				const prev = beforeToAfter.get(pr[0]);
				if (prev && prev !== pr[1]) bad.push(`${tag}: 同页内 before ${pr[0]} 对应两个不同 after（${prev} / ${pr[1]}）`);
				beforeToAfter.set(pr[0], pr[1]);
			}
			if (e?.pixels !== null && !(isInt(e?.pixels) && e.pixels > 0)) bad.push(`${tag}: pixels 必须是正整数（--loose-count 下可 null）`);
			if (e?.pixels === null && !opt['loose-count']) bad.push(`${tag}: pixels=null 只在 --loose-count 下允许`);
			if (e?.residual !== undefined && e.residual !== null && !isInt(e.residual)) bad.push(`${tag}: residual 必须是整数或 null`);
			if (!isStr(e?.reason)) bad.push(`${tag}: reason 必须非空`);
			if (!isStr(e?.source)) bad.push(`${tag}: source 必须非空（指到卡 A §3 具体行）`);
		}
	}
	if (bad.length) die(4, ['清单 schema 不合法：', ...bad.map((b) => `  · ${b}`)], '配套关系');
	// 绑定关系（rc 4）
	if (AL.appliesTo.baselineTag !== mb.tag) {
		die(4, [`拒用清单：appliesTo.baselineTag=${AL.appliesTo.baselineTag} ≠ 实际基线 ${mb.tag}`,
			'  （清单是"那一刻的指纹"，绑错基线就是拿旧清单兜新改动）'], '配套关系');
	}
	if (AL.appliesTo.theme && mb.theme && AL.appliesTo.theme !== mb.theme) {
		die(4, [`拒用清单：appliesTo.theme=${AL.appliesTo.theme} ≠ 基线 ${mb.theme}`], '配套关系');
	}
	if (AL.appliesTo.baselinePageSha) {
		const diff = [];
		for (const [k, v] of Object.entries(AL.appliesTo.baselinePageSha)) {
			const bp = mb.pages.find((p) => p.key === k);
			if (!bp) { diff.push(`${k}（基线没这页）`); continue; }
			if (bp.sha256 !== v) diff.push(`${k}（manifest=${String(bp.sha256).slice(0, 12)}… 清单=${String(v).slice(0, 12)}…）`);
		}
		if (diff.length) die(4, [`拒用清单：baselinePageSha 与基线不符：${diff.join(' / ')}`, '  （基线可能被重落成同名不同图 ⇒ 清单必须跟着改）'], '配套关系');
	}
}

// ── 4b. 掩码件（--mask）：已知会变的区域 ──────────────────────────────────────
// 语义与 allow-list 相反：allow-list 是「允许的色变、要逐条对账」，mask 是「这里本来就该变、不计」。
if (opt.mask) {
	const MF = path.resolve(opt.mask);
	if (!fs.existsSync(MF)) die(3, [`掩码文件不存在：${MF}`], '缺件');
	try { MASK = JSON.parse(fs.readFileSync(MF, 'utf8')); } catch (e) { die(4, [`掩码 schema 不合法：JSON 解析失败 ${e.message}`], '配套关系'); }
	const bad = [];
	const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
	const isInt = (v) => Number.isInteger(v);
	if (MASK.schemaVersion !== 1) bad.push('schemaVersion 必须 = 1');
	if (!isStr(MASK.id)) bad.push('id 必须非空');
	if (isStr(MASK.id) && MASK.id !== path.basename(MF, '.json')) bad.push(`id(${MASK.id}) 必须等于文件名(${path.basename(MF, '.json')})`);
	if (!isStr(MASK.title)) bad.push('title 必须非空');
	if (!isStr(MASK.source)) bad.push('顶层 source 必须非空（指到交付报告 §3）');
	if (!MASK.appliesTo || !isStr(MASK.appliesTo?.baselineTag)) bad.push('appliesTo.baselineTag 必须非空');
	const shaMap = MASK.appliesTo?.baselinePageSha;
	if (!shaMap || typeof shaMap !== 'object') bad.push('appliesTo.baselinePageSha 必须是对象（6 页全给）');
	else {
		const miss = PAGES.filter((k) => !isStr(shaMap[k]));
		if (miss.length) bad.push(`appliesTo.baselinePageSha 缺页：${miss.join(', ')}（掩码必须绑全 6 页，防止拿旧掩码兜新改动）`);
	}
	const vp = MASK.appliesTo?.viewport;
	if (vp && (!isInt(vp.w) || !isInt(vp.h) || typeof vp.dpr !== 'number')) bad.push('appliesTo.viewport 必须给 {w:整数, h:整数, dpr:数字}');
	const cap = MASK.policy?.maxMaskedPixelsPerPage;
	if (!isInt(cap) || cap <= 0) bad.push('policy.maxMaskedPixelsPerPage 必须是正整数（面积闸，防掩码长胖）');
	const minRows = isInt(MASK.policy?.minCompareRows) ? MASK.policy.minCompareRows : 64;
	if (!MASK.pages || typeof MASK.pages !== 'object') bad.push('pages 必须是对象');
	for (const [k, pg] of Object.entries(MASK.pages ?? {})) {
		if (!PAGES.includes(k)) { bad.push(`掩码页不存在：${k}（页键只认 ${PAGES.join('/')}）`); continue; }
		if (pg.compareRows !== undefined && pg.compareRows !== null) {
			if (!isInt(pg.compareRows) || pg.compareRows < minRows) bad.push(`${k}.compareRows 必须是 ≥ ${minRows} 的整数（判据带太窄等于不判）`);
			if (!isStr(pg.compareReason)) bad.push(`${k}.compareReason 必须非空（为什么要削判据带）`);
		}
		if (pg.exclude !== undefined && pg.exclude !== null) {
			// 整页排除：必须写明理由 + 证据；且全件排除页数有上限（防止"一页页排除到只剩一页"）
			if (!isStr(pg.exclude?.reason)) bad.push(`${k}.exclude.reason 必须非空`);
			if (!isStr(pg.exclude?.evidence)) bad.push(`${k}.exclude.evidence 必须非空（为什么这张图不能判）`);
			if (Array.isArray(pg.masks) && pg.masks.length) bad.push(`${k}: 整页排除的页不要再给 masks（掩码没有意义）`);
			continue;
		}
		if (!Array.isArray(pg.masks) || !pg.masks.length) { bad.push(`${k}.masks 必须是非空数组`); continue; }
		const ids = new Set();
		for (const m of pg.masks) {
			const tag = `${k}.${m?.id ?? '?'}`;
			if (!isStr(m?.id)) bad.push(`${tag}: id 必须非空`);
			if (ids.has(m?.id)) bad.push(`${tag}: 页内 id 重复`);
			ids.add(m?.id);
			if (!isStr(m?.label)) bad.push(`${tag}: label 必须非空`);
			if (!Array.isArray(m?.bbox) || m.bbox.length !== 4 || !m.bbox.every(isInt) || m.bbox.some((v) => v < 0)) bad.push(`${tag}: bbox 必须是 4 个非负整数`);
			else if (m.bbox[2] <= 0 || m.bbox[3] <= 0) bad.push(`${tag}: bbox 宽高必须 > 0`);
			if (!isStr(m?.reason)) bad.push(`${tag}: reason 必须非空（为什么这条会变）`);
			if (!isStr(m?.evidence)) bad.push(`${tag}: evidence 必须非空（哪次对照、差了多少 px）`);
		}
		// 页内掩码互不重叠（重叠只会让"吞了多少 px"变得说不清）
		const ms = pg.masks.filter((m) => Array.isArray(m?.bbox) && m.bbox.length === 4 && m.bbox.every(isInt));
		for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
			const p = ms[i].bbox, q = ms[j].bbox;
			if (p[0] < q[0] + q[2] && q[0] < p[0] + p[2] && p[1] < q[1] + q[3] && q[1] < p[1] + p[3]) bad.push(`${k}: 掩码重叠 ${ms[i].id} × ${ms[j].id}`);
		}
		// 面积闸（静态）：声明面积本身就不能超过 policy 上限
		const area = pg.masks.reduce((n, m) => n + (Array.isArray(m?.bbox) && m.bbox.length === 4 ? m.bbox[2] * m.bbox[3] : 0), 0);
		if (isInt(cap) && area > cap) bad.push(`${k}: 掩码总面积 ${area} px 超过 policy.maxMaskedPixelsPerPage=${cap}（面积闸）`);
	}
	if (bad.length) die(4, ['掩码 schema 不合法：', ...bad.map((b) => `  · ${b}`)], '配套关系');
	// 排除页上限（防"一页页排除到只剩一页"）
	const maxEx = isInt(MASK.policy?.maxExcludedPages) ? MASK.policy.maxExcludedPages : 1;
	const exPages = Object.entries(MASK.pages ?? {}).filter(([, pg]) => pg?.exclude).map(([k]) => k);
	if (exPages.length > maxEx) die(4, [`拒用掩码：整页排除 ${exPages.length} 页（${exPages.join(',')}）超过 policy.maxExcludedPages=${maxEx}`,
		'  （排除页是"这张图坏了、不能判"，不是"不想判"；超过上限说明基线本身该重采）'], '配套关系');
	// 绑定（rc 4）：tag / 6 页 sha / 视口+dpr —— 任何一项不符都说明"这不是这份基线该用的掩码"
	if (MASK.appliesTo.baselineTag !== mb.tag) {
		die(4, [`拒用掩码：appliesTo.baselineTag=${MASK.appliesTo.baselineTag} ≠ 实际基线 ${mb.tag}`,
			'  （掩码绑的是"这一刻这张图"；绑错基线就是拿旧掩码兜新改动）'], '配套关系');
	}
	const shaBad = [];
	for (const k of PAGES) {
		const bp = mb.pages.find((p) => p.key === k);
		if (!bp) { shaBad.push(`${k}（基线没这页）`); continue; }
		if (bp.sha256 !== MASK.appliesTo.baselinePageSha[k]) shaBad.push(`${k}（manifest=${String(bp.sha256).slice(0, 12)}… 掩码=${String(MASK.appliesTo.baselinePageSha[k]).slice(0, 12)}…）`);
	}
	if (shaBad.length) die(4, [`拒用掩码：appliesTo.baselinePageSha 与基线不符：${shaBad.join(' / ')}`,
		'  （基线被重落成同名不同图 ⇒ 掩码必须跟着重做，不许沿用旧 bbox）'], '配套关系');
	if (MASK.appliesTo.viewport) {
		const vp = MASK.appliesTo.viewport, bv = mb.viewport ?? {};
		if (vp.w !== bv.w || vp.h !== bv.h || vp.dpr !== mb.dpr) {
			die(4, [`拒用掩码：视口不符 掩码 ${vp.w}x${vp.h}@${vp.dpr} / 基线 ${bv.w ?? '?'}x${bv.h ?? '?'}@${mb.dpr ?? '?'}`,
				'  （A 路裁后图的像素坐标依赖视口尺寸：视口一变卡片高度就变，bbox 全部失效）'], '配套关系');
		}
	}
}

// ── 5. 页集合 / 缺页 ────────────────────────────────────────────────────────
const bPages = new Map(mb.pages.map((p) => [p.key, p]));
const cPages = new Map(mc.pages.map((p) => [p.key, p]));
const wanted = [...bPages.keys()].filter((k) => !opt.page || k === opt.page);
const missing = [];
const keys = [];
for (const k of wanted) {
	if (!cPages.has(k)) { missing.push(k); continue; }
	keys.push(k);
}
console.log(`基线 ${opt.baseline}${PAIR_ROOT ? `（pair 根 → ${path.basename(BASE_DIR)}）` : ''}  (${mb.pages.length} 页, tag=${mb.tag}, theme=${mb.theme ?? '-'}, formal=${mb.formal === true}${mb.formal === true ? '' : ' 非正式基线'})`);
console.log(`候选 ${opt.candidate}  (${mc.pages.length} 页, tag=${mc.tag}, theme=${mc.theme ?? '-'}, formal=${mc.formal === true})`);
const judge = AL ? '清单外=0+逐条计数' : (opt.thresholdN !== undefined ? `比例 ≤ ${(opt.thresholdN * 100).toFixed(2)}%` : '差异像素=0');
if (opt.thresholdN !== undefined) console.log(`deprecated: 比例口径（--threshold）已由 V31-018 方案 §11.11 ② 作废，缺省判据是「差异像素 = 0」`);
console.log(`判据 ${judge}${AL ? ` · 清单 ${path.basename(String(opt['allow-list']))}（${Object.values(AL.pages).reduce((n, p) => n + p.entries.length, 0)} 条）` : ''}${MASK ? ` · 掩码 ${path.basename(String(opt.mask))}（${Object.values(MASK.pages).reduce((n, p) => n + ((p.masks ?? []).length), 0)} 区 / 每页面积上限 ${MASK.policy.maxMaskedPixelsPerPage} px${Object.values(MASK.pages).some((p) => p.exclude) ? ` / 整页排除 ${Object.values(MASK.pages).filter((p) => p.exclude).length} 页` : ''}）` : ''} · 比对页 ${keys.length}`);
if (MASK) console.log(`掩码口径：掩码内差异**不计**（时长读数/时间戳/计数等本来就会变）；逐页打印「掩码吞 N px」——吞得多就是掩码该重审了`);

if (opt['dry-run']) {
	for (const k of keys) console.log(`  [plan] ${k}: ${bPages.get(k).file} ↔ ${cPages.get(k).file}${AL?.pages?.[k] ? `（清单 ${AL.pages[k].entries.length} 条）` : ''}${MASK?.pages?.[k] ? `（掩码 ${MASK.pages[k].masks.length} 区）` : ''}`);
	if (missing.length) console.log(`  [plan] 候选缺页 ${missing.join(',')}`);
	console.log(summaryLine(0, judge + '（dry-run）'));
	process.exit(0);
}
if (!keys.length) die(3, [...missing.map((k) => `候选缺页：${k}`), '没有可比的页'], judge);
if (opt.out) fs.mkdirSync(path.resolve(opt.out), { recursive: true });

// ── 6. 逐页比 ───────────────────────────────────────────────────────────────
const pageResults = [];
let rcMax = 0;
const failLines = [];

for (const key of missing) { console.log(`  ✖ ${key}: 候选缺页`); failLines.push(`候选缺页：${key}`); st.missing++; rcMax = Math.max(rcMax, 3); }

for (const key of keys) {
	const bp = bPages.get(key), cp = cPages.get(key);
	const fa = path.join(BASE_DIR, bp.file);
	const fb = path.join(CAND_DIR, cp.file);
	if (!fs.existsSync(fa)) { console.log(`  ✖ ${key}: 基线图缺失（${fa}）`); failLines.push(`基线图缺失：${key}`); st.missing++; rcMax = Math.max(rcMax, 3); continue; }
	if (!fs.existsSync(fb)) { console.log(`  ✖ ${key}: 候选缺页（图不存在：${fb}）`); failLines.push(`候选缺页：${key}`); st.missing++; rcMax = Math.max(rcMax, 3); continue; }
	const bufA = fs.readFileSync(fa), bufB = fs.readFileSync(fb);
	// sha 校验：图不能被换而 manifest 不换
	if (bp.sha256 && sha256(bufA) !== bp.sha256) { console.log(`  ✖ ${key}: 基线图 sha 与 manifest 不符（基线可能被替换）`); failLines.push(`基线图 sha 与 manifest 不符：${key}（基线可能被替换）`); rcMax = Math.max(rcMax, 3); continue; }
	if (cp.sha256 && sha256(bufB) !== cp.sha256) { console.log(`  ✖ ${key}: 候选图 sha 与 manifest 不符（候选可能被替换）`); failLines.push(`候选图 sha 与 manifest 不符：${key}`); rcMax = Math.max(rcMax, 3); continue; }

	// 整页排除（掩码件声明该页不可判：图本身坏了，不是"不想判"）
	const exPage = MASK?.pages?.[key];
	if (exPage?.exclude) {
		console.log(`  ⏭ ${key}  整页排除（不判）：${exPage.exclude.reason}`);
		console.log(`      · 证据：${exPage.exclude.evidence}`);
		st.pages++; st.excluded++;
		pageResults.push({ key, verdict: 'SKIP', excluded: true, excludeReason: exPage.exclude.reason, diffPixels: null, totalPixels: null, ratio: null, outside: null, entries: [], residual: null, bbox: null, mask: null });
		continue;
	}

	const a = decodePng(bufA), b = decodePng(bufB);
	const w = a.width, h = a.height;
	const maskPage = MASK?.pages?.[key] ?? null;
	// 判据带（compareRows）：只比前 N 行（顶对齐）。A 路大管家三页专用 —— body 是实时数据、
	// 而且卡片高度会随内容变（630 vs 1111 实测），只取顶部「卡头+Tab 带」两者都对得上。
	const rows = maskPage && Number.isInteger(maskPage.compareRows) ? maskPage.compareRows : null;
	if (b.width !== w) {
		console.log(`  ✖ ${key}  宽度不一致 ${w} vs ${b.width}  ⇒ FAIL（宽度不一致直接判红，与判据带无关）`);
		pageResults.push({ key, verdict: 'FAIL', diffPixels: null, totalPixels: w * h, ratio: null, outside: null, entries: [], residual: null, reason: '宽度不一致' });
		failLines.push(`宽度不一致：${key} ${w} vs ${b.width}`);
		rcMax = Math.max(rcMax, 1);
		continue;
	}
	if (rows !== null && (a.height < rows || b.height < rows)) {
		console.log(`  ✖ ${key}  图高不足判据带 ${rows} 行（${a.height} / ${b.height}）  ⇒ FAIL（卡片连卡头都没画全）`);
		pageResults.push({ key, verdict: 'FAIL', diffPixels: null, totalPixels: w * rows, ratio: null, outside: null, entries: [], residual: null, reason: '图高不足判据带' });
		failLines.push(`图高不足判据带：${key} 需 ${rows} 行，实际 ${a.height}/${b.height}`);
		rcMax = Math.max(rcMax, 1);
		continue;
	}
	if (rows === null && b.height !== h) {
		console.log(`  ✖ ${key}  尺寸不一致 ${w}x${h} vs ${b.width}x${b.height}  ⇒ FAIL（尺寸不一致直接判红）`);
		pageResults.push({ key, verdict: 'FAIL', diffPixels: null, totalPixels: w * h, ratio: null, outside: null, entries: [], residual: null, reason: '尺寸不一致' });
		failLines.push(`尺寸不一致：${key} ${w}x${h} vs ${b.width}x${b.height}`);
		rcMax = Math.max(rcMax, 1);
		continue;
	}
	const hCmp = rows === null ? h : rows;

	// 清单页 → 校验 bbox 越界/重叠（rc 4）
	const alPage = AL?.pages?.[key] ?? null;
	let entries = null;
	if (alPage) {
		entries = alPage.entries.map((e) => ({ ...e, bbox: e.bbox, pairsRgb: e.pairs.map(([x, y]) => [rgb(x), rgb(y), `${x}→${y}`]) }));
		const bad = [];
		for (const e of entries) {
			const [x0, y0, bw, bh] = e.bbox;
			if (x0 + bw > w || y0 + bh > h) bad.push(`bbox 越界：${e.id} [${e.bbox}] 超出页面 ${w}x${h}`);
		}
		for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
			const p = entries[i].bbox, q = entries[j].bbox;
			if (p[0] < q[0] + q[2] && q[0] < p[0] + p[2] && p[1] < q[1] + q[3] && q[1] < p[1] + p[3]) bad.push(`bbox 重叠：${entries[i].id} × ${entries[j].id}`);
		}
		if (bad.length) die(4, [`清单 schema 不合法（${key} 几何）：`, ...bad.map((l) => `  · ${l}`)], judge);
	}

	// 掩码页 → 校验 bbox 越界（rc 4）并建归属表
	let maskOwner = null;
	let maskArea = 0;
	const maskPer = maskPage ? maskPage.masks.map(() => 0) : null;
	if (maskPage) {
		const bad = [];
		for (const m of maskPage.masks) {
			const [x0, y0, bw, bh] = m.bbox;
			if (x0 + bw > w || y0 + bh > h) bad.push(`掩码 bbox 越界：${m.id} [${m.bbox}] 超出页面 ${w}x${h}`);
			if (y0 >= hCmp) bad.push(`掩码 bbox 整块落在判据带外：${m.id} [${m.bbox}]（判据带 = 前 ${hCmp} 行，掩了也没用）`);
		}
		if (bad.length) die(4, [`拒用掩码（${key} 几何）：`, ...bad.map((l) => `  · ${l}`),
			`  （A 路裁后图 ${w}x${h}；bbox 越界说明掩码不是给这张图做的 —— 视口/基线变了要重做掩码）`], judge);
		maskOwner = new Int16Array(w * h).fill(-1);
		maskPage.masks.forEach((m, i) => {
			const [x0, y0, bw, bh] = m.bbox;
			for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) maskOwner[y * w + x] = i;
			maskArea += bw * bh;
		});
	}

	// 一遍循环：差异 + 包围盒 + 归属 + 色对命中（不碰 png.mjs）
	const total = w * hCmp;	// 判据带内像素（没有判据带时 = 整图）
	const owner = entries ? new Int16Array(total).fill(-1) : null;
	if (owner) entries.forEach((e, i) => {
		const [x0, y0, bw, bh] = e.bbox;
		for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) owner[y * w + x] = i;
	});
	const per = entries ? entries.map(() => ({ px: 0, res: 0, hits: new Map() })) : null;
	const img = opt.out ? new Uint8Array(total * 4) : null;
	let diff = 0, outside = 0, residual = 0, maskedHere = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
	for (let y = 0; y < hCmp; y++) {
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 4;
			const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
			const mi = maskOwner && d > TOL ? maskOwner[y * w + x] : -1;
			if (img) {
				// 差异图配色：红 = 判据内差异 / **黄 = 掩码吞掉的差异** / 半透明底 = 无差异
				if (d > TOL) { img[o] = mi >= 0 ? 255 : 255; img[o + 1] = mi >= 0 ? 210 : 0; img[o + 2] = 0; img[o + 3] = 255; }
				else { img[o] = a.data[o]; img[o + 1] = a.data[o + 1]; img[o + 2] = a.data[o + 2]; img[o + 3] = 40; }
			}
			if (d <= TOL) continue;
			if (mi >= 0) { maskedHere++; maskPer[mi]++; continue; }	// 掩码内：不计入 diff/清单外/残差
			diff++;
			if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
			if (!entries) continue;
			const i = owner[y * w + x];
			if (i < 0) { outside++; continue; }
			const s = per[i]; s.px++;
			let hit = false;
			const before = [a.data[o], a.data[o + 1], a.data[o + 2]], after = [b.data[o], b.data[o + 1], b.data[o + 2]];
			for (const [B, A, tag] of entries[i].pairsRgb) {
				if (close3(before, B) && close3(after, A)) { s.hits.set(tag, (s.hits.get(tag) ?? 0) + 1); hit = true; }
			}
			if (!hit) { s.res++; residual++; }
		}
	}
	if (img && opt.out) fs.writeFileSync(path.join(path.resolve(opt.out), `diff-${key}.png`), encodePng(w, hCmp, img));
	const bbox = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
	// 掩码面积闸（运行期）：吞掉的 px 超过 policy 上限 ⇒ 掩码长胖了，判红
	let maskOver = 0;
	if (maskPage && maskedHere > MASK.policy.maxMaskedPixelsPerPage) {
		maskOver = maskedHere - MASK.policy.maxMaskedPixelsPerPage;
		st.maskOverflow += maskOver;
	}

	// 判定
	let verdict = 'PASS';
	const why = [];
	const entryOut = [];
	if (!entries) {
		if (opt.strict || opt.thresholdN === undefined) verdict = diff === 0 ? 'PASS' : 'FAIL';
		else verdict = diff / total <= opt.thresholdN ? 'PASS' : 'FAIL';
		if (diff) why.push(`掩码外差异 ${diff} px（判据 ${judge}）`);
	} else {
		if (outside > 0) { verdict = 'FAIL'; why.push(`清单外差异 ${outside} px`); }
		for (const e of entries) {
			const s = per[entries.indexOf(e)];
			const declared = e.pairsRgb.map(([B, A, tag]) => tag);
			const hitPairs = declared.filter((t) => s.hits.has(t));
			const missingPairs = declared.filter((t) => !s.hits.has(t));
			const countOk = e.pixels === null ? true : s.px === e.pixels;
			const countJudge = e.pixels === null ? 'n/a' : `${s.px}/${e.pixels}`;
			st.entriesTotal++;
			let ok = missingPairs.length === 0 && countOk;
			if (!missingPairs.length && !countOk && opt['loose-count']) ok = true;
			if (ok) st.entriesOk++;
			if (missingPairs.length) { verdict = 'FAIL'; why.push(`条目 ${e.id} 声明色对未命中：${missingPairs.join(',')}（实际 ${s.px} px，命中 ${hitPairs.length}/${declared.length} 组）`); }
			if (!countOk) {
				const msg = `条目 ${e.id} 计数不符：声明 ${e.pixels} 实测 ${s.px}`;
				if (opt['loose-count']) why.push(`${msg}（--loose-count 只警告）`);
				else { verdict = 'FAIL'; why.push(msg); }
			}
			if (e.residual !== undefined && e.residual !== null && e.residual !== s.res) why.push(`条目 ${e.id} 残差声明 ${e.residual} 实测 ${s.res}（读数，不判红）`);
			entryOut.push({ id: e.id, pixels: s.px, declared: e.pixels, hitPairs, missingPairs, countJudge, residual: s.res });
		}
		if (opt['strict-color'] && residual > 0) { verdict = 'FAIL'; why.push(`strict-color 残差 ${residual}>0`); st.strictColorBad++; }
	}
	// 掩码面积闸（运行期）：吞掉的 px 超过 policy 上限 ⇒ 掩码长胖了，判红
	if (maskOver > 0) { verdict = 'FAIL'; why.push(`掩码吞掉 ${maskedHere} px 超过 policy.maxMaskedPixelsPerPage=${MASK.policy.maxMaskedPixelsPerPage}（超 ${maskOver} px）⇒ 掩码该重审`); }

	st.pages++; st.diff += diff; st.outside += outside; st.residual += residual; st.masked += maskedHere; st.maskArea += maskArea;
	if (verdict === 'FAIL') { rcMax = Math.max(rcMax, 1); for (const l of why) failLines.push(`${key}: ${l}`); }
	const box = bbox ? `  变化区域 ${bbox.w}x${bbox.h}@(${bbox.x},${bbox.y})` : '';
	const bandInfo = rows === null ? '' : `  判据带 ${hCmp}/${h} 行(${((hCmp / h) * 100).toFixed(1)}%)`;
	const mInfo = maskPage ? `  掩码吞 ${maskedHere} px/盖 ${maskArea} px（${maskPage.masks.length} 区）` : '';
	const line = entries
		? `  ${verdict === 'PASS' ? '✔' : '✖'} ${key}  差异 ${diff}/${total} = ${((diff / total) * 100).toFixed(3)}%  清单外 ${outside}  条目 ${per.filter((s, i) => { const e = entries[i]; const hit = e.pairsRgb.every(([, , t]) => s.hits.has(t)); return hit && (e.pixels === null || s.px === e.pixels); }).length}/${per.length} 命中  残差 ${residual}(${pct(residual, diff)}%)${box}${bandInfo}${mInfo}  ⇒ ${verdict}`
		: `  ${verdict === 'PASS' ? '✔' : '✖'} ${key}  ${maskPage ? '掩码外' : ''}差异像素 ${diff}/${total} = ${((diff / total) * 100).toFixed(3)}%${box}${bandInfo}${mInfo}  ⇒ ${verdict}`;
	console.log(line);
	if (rows !== null) console.log(`      · 判据带：只比前 ${hCmp} 行（数据区 y≥${hCmp} 不判）—— ${String(maskPage.compareReason).slice(0, 90)}…`);
	if (maskPage) console.log(`      · 明细：${maskPage.masks.map((m, i) => `${m.id} ${maskPer[i]}`).join(' / ')} px`);
	for (const l of why) console.log(`      · ${l}`);
	pageResults.push({ key, verdict, diffPixels: diff, totalPixels: total, ratio: diff / total, outside: entries ? outside : null, entries: entryOut, residual: entries ? residual : null, bbox, compareRows: rows, bandPixels: total, mask: maskPage ? { maskedPixels: maskedHere, maskArea, perMask: maskPage.masks.map((m, i) => ({ id: m.id, pixels: maskPer[i] })) } : null });
}

// ── 7. --dump-components（清单从哪来的工具，只读） ───────────────────────────
if (opt['dump-components']) {
	console.log('\n# 连通分量（8 邻接，判据同 TOL=6；topPairs = [改前色, 改后色, 像素数]）');
	for (const key of keys) {
		const bp = bPages.get(key), cp = cPages.get(key);
		const a = decodePng(fs.readFileSync(path.join(BASE_DIR, bp.file)));
		const b = decodePng(fs.readFileSync(path.join(CAND_DIR, cp.file)));
		if (a.width !== b.width) continue;
		const w = a.width, h = a.height;
		const mp = MASK?.pages?.[key];
		const rowCap = Number.isInteger(mp?.compareRows) ? mp.compareRows : h;
		const mask = new Uint8Array(w * h);
		for (let i = 0; i < w * Math.min(rowCap, h); i++) {
			const o = i * 4;
			if (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]) > TOL) mask[i] = 1;
		}
		// 有掩码件时，掩码区内的差异不进连通分量（否则"掩码外的分量"这一列失真）
		let skipped = 0;
		if (mp) for (const m of mp.masks) {
			const [mx0, my0, mw, mh] = m.bbox;
			if (mx0 + mw > w || my0 + mh > h) continue;
			for (let y = my0; y < my0 + mh; y++) for (let x = mx0; x < mx0 + mw; x++) {
				const i = y * w + x;
				if (mask[i]) skipped++;
				mask[i] = 0;
			}
		}
		if (mp) console.log(`# ${key}: 掩码区内的差异像素 ${skipped} 个不参与连通分量`);
		const seen = new Uint8Array(w * h);
		const comps = [];
		for (let i = 0; i < w * h; i++) {
			if (!mask[i] || seen[i]) continue;
			const stack = [i]; seen[i] = 1;
			let n = 0, cx0 = 1e9, cy0 = 1e9, cx1 = -1, cy1 = -1;
			const pc = new Map();
			while (stack.length) {
				const p = stack.pop(), y = (p / w) | 0, x = p - y * w;
				n++; if (x < cx0) cx0 = x; if (y < cy0) cy0 = y; if (x > cx1) cx1 = x; if (y > cy1) cy1 = y;
				const o = p * 4, t = hexAt(a.data, o) + '>' + hexAt(b.data, o);
				pc.set(t, (pc.get(t) ?? 0) + 1);
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const q = ny * w + nx;
					if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
				}
			}
			comps.push({ bbox: [cx0, cy0, cx1 - cx0 + 1, cy1 - cy0 + 1], pixels: n, topPairs: [...pc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 5) });
		}
		comps.sort((p, q) => q.pixels - p.pixels);
		console.log(JSON.stringify({ page: key, components: comps }));
	}
}

// ── 8. 汇总（永远最后一行） ──────────────────────────────────────────────────
if (failLines.length) {
	console.log('\n正文明细（rc≠0 必看）：');
	for (const l of failLines) console.log(`  ✖ ${l}`);
}
const rc = rcMax;
const summary = summaryLine(rc, judge);
console.log(`\n${summary}`);
if (opt.json) {
	const out = {
		baseline: BASE_ARG, candidate: CAND_DIR, theme: opt.theme ?? mb.theme ?? null,
		allowList: opt['allow-list'] ? path.resolve(opt['allow-list']) : null,
		mask: opt.mask ? path.resolve(opt.mask) : null,
		pages: pageResults,
		summary: { pages: st.pages, diffPixels: st.diff, outside: st.outside, entries: st.entriesTotal, entriesOk: st.entriesOk, residual: st.residual, missing: st.missing, masked: st.masked, maskArea: st.maskArea, maskOverflow: st.maskOverflow, rc },
	};
	fs.writeFileSync(path.resolve(opt.json), JSON.stringify(out, null, 2), 'utf8');
	console.log(`结果 JSON → ${path.resolve(opt.json)}`);
}
process.exit(rc);
