#!/usr/bin/env node
// dsh-butler-panel/_test/visual-baseline/allow-list-lint.mjs
//
// V31-020 · 允许差异清单的**只读**体检器：schema + 与卡 A §3 逐字对账。
//
// 为什么要它：清单的色对**不是本鱼编的**，是从 `docs\交付报告-V31-018-卡A-令牌与别名化-20261030.md §3`
// 那张「改前字面量 → 改后（亮态）/（暗态）」表抄下来的。抄错了没人看得出来（机器只会按错的色对判），
// 所以必须有一件机械器具把「清单里的色对集合」和「卡 A §3 的色对集合」逐字比一遍。
//
// 取数规则（写死，不靠猜）：
//   · 表行格式：| 位置 | 改前字面量 | 改后（亮态） | 改后（暗态） | 来源 |
//   · 取「改前」列与「改后（暗态）」列；亮态列不参与（本清单是暗态冻结件）
//   · 改前一格里用 `/` 分隔的**双值行**（圆点 idle `#6b7280 / #8a8a8a`）⇒ 拆成两条各取一值
//   · 改前是 `rgba(...)` 的行（按钮 hover 底）⇒ **不参与机器对账**，计入「人工核对」1 条
//
// 用法：
//   node allow-list-lint.mjs --file "%VB%\allow-lists\v31-018-dark.json" --colors-from "<工作区>/docs/交付报告-V31-018-卡A-令牌与别名化-20261030.md"
// rc：0 = 全对账；2 = 用法错；3 = 文件缺失；4 = schema 不合规 / 色对不一致
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const FILE = arg('file'), COLORS = arg('colors-from');
if (!FILE || !COLORS) { console.error('用法: node allow-list-lint.mjs --file <清单json> --colors-from <卡A交付报告md>'); process.exit(2); }
if (!fs.existsSync(FILE)) { console.error(`清单文件不存在：${path.resolve(FILE)}`); process.exit(3); }
if (!fs.existsSync(COLORS)) { console.error(`色值来源文件不存在：${path.resolve(COLORS)}`); process.exit(3); }

const PAGES = ['butler-overview', 'butler-tasks', 'butler-assets', 'eco-bundles', 'eco-skills', 'eco-upgrades'];
const HEX = /^#[0-9a-f]{6}$/;
const problems = [];

// ── 1. schema（与 visual-diff 的清单校验同口径，任一条不过 ⇒ rc 4） ──────────────
let al;
try { al = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error(`清单 schema 不合法：JSON 解析失败 ${e.message}`); process.exit(4); }
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
if (al.schemaVersion !== 1) problems.push('schemaVersion 必须 = 1');
if (!isStr(al.id) || al.id !== path.basename(FILE, '.json')) problems.push(`id 必须等于文件名（${path.basename(FILE, '.json')}）`);
if (!isStr(al.title)) problems.push('title 必须非空');
if (!isStr(al.source)) problems.push('顶层 source 必须非空');
if (!isStr(al.appliesTo?.baselineTag)) problems.push('appliesTo.baselineTag 必须非空');
if (al.appliesTo?.theme && !['dark', 'light'].includes(al.appliesTo.theme)) problems.push('appliesTo.theme 只认 dark/light');
if (!al.pages || typeof al.pages !== 'object') problems.push('pages 必须是对象');
let entryCount = 0, pageCount = 0;
const declared = new Set();
for (const [k, pg] of Object.entries(al.pages ?? {})) {
	if (!PAGES.includes(k)) { problems.push(`清单页不存在：${k}`); continue; }
	pageCount++;
	const ids = new Set(), b2a = new Map();
	for (const e of pg.entries ?? []) {
		entryCount++;
		const tag = `${k}.${e?.id ?? '?'}`;
		if (!isStr(e?.id) || ids.has(e?.id)) problems.push(`${tag}: id 缺失或页内重复`);
		ids.add(e?.id);
		if (!Array.isArray(e?.bbox) || e.bbox.length !== 4 || !e.bbox.every((v) => Number.isInteger(v) && v >= 0)) problems.push(`${tag}: bbox 必须是 4 个非负整数`);
		if (!Array.isArray(e?.pairs) || !e.pairs.length) problems.push(`${tag}: pairs 至少 1 组`);
		if (!(Number.isInteger(e?.pixels) && e.pixels > 0)) problems.push(`${tag}: pixels 必须是正整数`);
		if (!isStr(e?.reason)) problems.push(`${tag}: reason 必须非空`);
		if (!isStr(e?.source)) problems.push(`${tag}: source 必须非空`);
		for (const pr of e?.pairs ?? []) {
			if (!Array.isArray(pr) || pr.length !== 2 || !pr.every((v) => HEX.test(v))) { problems.push(`${tag}: 色对必须是两个小写 #rrggbb`); continue; }
			const prev = b2a.get(pr[0]);
			if (prev && prev !== pr[1]) problems.push(`${tag}: 同页 before ${pr[0]} 对应两个 after`);
			b2a.set(pr[0], pr[1]);
			declared.add(`${pr[0]}→${pr[1]}`);
		}
	}
}
if (problems.length) { console.error('清单 schema 不合法：'); for (const p of problems) console.error(`  · ${p}`); console.error(`汇总：schema 不合规 ${problems.length} 条 · rc=4`); process.exit(4); }

// ── 2. 从卡 A §3 的表格里取色对 ──────────────────────────────────────────────
const md = fs.readFileSync(COLORS, 'utf8').split(/\r?\n/);
const start = md.findIndex((l) => /^##\s*3\./.test(l));
if (start < 0) { console.error('色值来源里找不到「## 3.」节'); process.exit(3); }
const rows = [];
for (let i = start + 1; i < md.length; i++) {
	const l = md[i];
	if (/^##\s/.test(l)) break;
	if (!l.trim().startsWith('|')) continue;
	const cells = l.split('|').slice(1, -1).map((c) => c.trim());
	if (cells.length < 5) continue;
	if (/^-{2,}/.test(cells[0].replace(/[\s:]/g, '')) || cells[0] === '位置') continue;
	rows.push(cells);
}
if (!rows.length) { console.error('§3 表格里没取到数据行'); process.exit(3); }
const fromTable = new Set();
const manual = [];
for (const c of rows) {
	const raw = c[1].replace(/`/g, '').trim();
	const dark = c[3].replace(/`/g, '').trim();
	if (/^rgba?\(/i.test(raw) || !HEX.test(dark)) { manual.push(`${c[0]}（${raw} → ${dark}）`); continue; }
	for (const b of raw.split('/').map((v) => v.trim()).filter(Boolean)) {
		if (!HEX.test(b)) { manual.push(`${c[0]}（${raw} → ${dark}）`); continue; }
		fromTable.add(`${b}→${dark}`);
	}
}

// ── 3. 逐字对账 ────────────────────────────────────────────────────────────
const lack = [...fromTable].filter((p) => !declared.has(p));
const extra = [...declared].filter((p) => !fromTable.has(p));
const okN = fromTable.size - lack.length;
console.log(`清单 ${path.basename(FILE)}：schema ok · ${pageCount} 页 · ${entryCount} 条 · 声明 ${declared.size} 组色对`);
console.log(`色值来源 ${path.basename(COLORS)} §3：${rows.length} 行 → 机检 ${fromTable.size} 组 + 人工核对 ${manual.length} 条（${manual.join(' / ') || '无'}）`);
if (lack.length) console.log(`  缺：${lack.join(', ')}`);
if (extra.length) console.log(`  多：${extra.join(', ')}`);
console.log(`汇总：色组 ${okN}/${fromTable.size} 逐字一致 · 缺 ${lack.length} · 多 ${extra.length} · 人工核对 ${manual.length} 条${manual.length ? `（${manual.map((m) => m.split('（')[0]).join('/')}）` : ''} · 条目 ${entryCount} · schema ok · rc=${lack.length || extra.length ? 4 : 0}`);
process.exit(lack.length || extra.length ? 4 : 0);
