// dsh-butler-panel / lib/write-scope.mjs —— 「面板写口」的 (path, method) 粒度扫描 + 文档表比对
//
// ⚠️ **本文件是 method 粒度写口扫描的唯一定义方**（施工卡 ①-2 / 控制室口径包 P-1）。
//   消费者约定（全局交叉审核 2026-09-17 §3.6-X1 / §6.2-A1 · ②包 §18.3-X1）：
//     · ② 包的跨表校验器（`registry-audit.mjs`）**只能 import 本库**，不许另造一套 register/method 扫描；
//     · 本库落地前，② 对「面板写口」子域一律判 `unavailable`（不许自己扫、不许判绿）；
//     · `_test/verify-routes.mjs` 是**另一件事**（webserver 路由按 (kind,path) 去重检查，不解析 method），
//       与本库职责不重叠，不算"第二份实现"。
//
// 为什么必须解析 handler 内的 `req.method`（而不是读 register 的 opts）：
//   `dsh-host-webserver` 的路由表按 (kind, path) 去重、**不含 HTTP method**（`register` 命中即 throw
//   `duplicate route`）⇒ `lib/index.js` 里 `/restart`、`/audit-off` 两个端点是**单 handler 内按
//   req.method 分发**的，opts 里**没有** `method` 字段。照 opts 读只能数出 13 个 path、数不出方法集，
//   "8 个写口"这个数就复现不出来（会假绿：文档表与源码"零差集"却漏掉一半写口）。
//
// 判据纪律：**解析不出来 = 判「不可用」，不判过**（fail-closed）。任何一处 register / handler /
//   API_PREFIX / 文档表解析失败，`ok:false` + 具体原因，调用方必须按"不可用"处理（退出码 3 口径）。
//
// 零副作用：本库**只做文本解析**（纯函数）。读文件的两个薄封装（scanSourceFile / readDocTable）只读不写，
//   且路径一律由调用方注入 —— 本库不猜生产路径、不 import 插件目录外的相对路径（deploy.mjs 门禁①）。
//
// 已知局限（如实写明，不假装完备）：
//   ① 掩码器**不识别正则字面量**：正则里若出现**不成对**的花括号（`/\{/` 之类）会带歪括号配平 ——
//      `source-braces-unbalanced` 自检把那种情形显式判"不可用"（fail-closed），不会静默给出错清单；
//   ② 只认两种 path 形态（`${API_PREFIX}/x` 模板串 / 字符串字面量）；其它形态判"不可用"，不做猜测式解释；
//   ③ 只验"都归级"（零差集），**不验"归级对不对"**（分级语义靠人工抽查，见 ①包 §6 表 3）。

/** 允许出现的 HTTP 方法字面量（其余一律判不可用，不猜）。 */
export const METHOD_VALUES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** 文档表锚点（机械校验器只读锚点区间内的 (path, method) 表，见 docs\大管家-开关矩阵与放行判据-20260913.md）。 */
export const TABLE_BEGIN = '<!-- write-scope-table:begin -->';
export const TABLE_END = '<!-- write-scope-table:end -->';

/** 「写口」的口径定义（施工方案 §4 的 D-h 裁决）：**带 POST 的端点数（path 去重）**。 */
export const WRITE_METHOD = 'POST';

// ───────────────────────── 基础工具 ─────────────────────────

/**
 * 把注释与字符串内容替换成等长空格（**保持长度与索引对齐**），返回掩码文本。
 * 用途：在掩码上做结构定位（括号配平 / register 边界），在原文上读字面量。
 * 必须做的原因：源码里存在含花括号的字符串（如 `hint: 'token 仅允许 [A-Za-z0-9_-]{1,80}'`），
 *   不掩码就会被括号配平算歪 → handler 边界切错 → 端点数与 method 集全错（假绿/假红）。
 */
export function maskCode(text) {
  // ⚠️ **必须用 `split('')`（按 UTF-16 单元）而不是 `[...text]`（按码点）**：
  //   `blank(k)` 用 `text[k]` 判换行、却写 `out[k]` —— 两者必须共用**同一套下标**。
  //   展开运算符会把星平面字符（emoji 等代理对）收成一个元素 ⇒ 之后的 k 与 text[k] 错位，
  //   且 `out` 会被意外撑长 ⇒ 掩码与原文长度不再相等、全文件结构定位整体偏移。
  //   2026-10-09 实测事故（卡「冲刺600·批4-1」）：index.js 注释里加了一个 🐋，
  //   转发定义 `ctx.webServer.register(opts)` 就被解析成 `(opts` ⇒ 扫描器判「不可用」、
  //   写口表零差集测试当场变红（根因不在写口，在掩码）。
  const out = text.split('');
  const n = text.length;
  let i = 0;
  const blank = (k) => { if (k < n && text[k] !== '\n') out[k] = ' '; };

  // 扫描一段被引号包裹的字面量（从开引号的下一位开始）；返回闭引号之后的下标。
  function scanQuoted(start, quote) {
    let j = start;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') { blank(j); blank(j + 1); j += 2; continue; }
      if (ch === quote) { blank(j); return j + 1; }
      blank(j); j++;
    }
    return j;
  }
  // 扫描模板串 `${...}` 表达式（含嵌套引号/模板/注释）；返回表达式配平后的下一位。
  function scanExpression(start) {
    let j = start; let depth = 1;
    while (j < n && depth > 0) {
      const ch = text[j];
      if (ch === '/' && text[j + 1] === '/') { while (j < n && text[j] !== '\n') { blank(j); j++; } continue; }
      if (ch === '/' && text[j + 1] === '*') {
        blank(j); blank(j + 1); j += 2;
        while (j < n && !(text[j] === '*' && text[j + 1] === '/')) { blank(j); j++; }
        blank(j); blank(j + 1); j += 2; continue;
      }
      if (ch === "'" || ch === '"') { blank(j); j = scanQuoted(j + 1, ch); continue; }
      if (ch === '`') { blank(j); j = scanTemplate(j + 1); continue; }
      if (ch === '{') { blank(j); depth++; j++; continue; }
      if (ch === '}') { blank(j); depth--; j++; continue; }
      blank(j); j++;
    }
    return j;
  }
  // 扫描模板串体（开引号的下一位开始）；返回闭反引号之后的下一位。
  function scanTemplate(start) {
    let j = start;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') { blank(j); blank(j + 1); j += 2; continue; }
      if (ch === '`') { blank(j); return j + 1; }
      if (ch === '$' && text[j + 1] === '{') { blank(j); blank(j + 1); j = scanExpression(j + 2); continue; }
      blank(j); j++;
    }
    return j;
  }

  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') { blank(i); i++; } continue; }
    if (c === '/' && text[i + 1] === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { blank(i); i++; }
      blank(i); blank(i + 1); i += 2; continue;
    }
    if (c === "'" || c === '"') { blank(i); i = scanQuoted(i + 1, c); continue; }
    if (c === '`') { blank(i); i = scanTemplate(i + 1); continue; }
    i++;
  }
  return out.join('');
}

/** 从 `open`（掩码文本上的 `{` 下标）配平到对应 `}`；返回其下标，找不到返回 -1。 */
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 行号（1 基），给报告用。 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

// ───────────────────────── 源码侧：API_PREFIX ─────────────────────────

/** 从 `lib/state.js` 源码文本解析 `export const API_PREFIX = '<值>'`；解析不出判不可用。 */
export function parseApiPrefix(stateSource) {
  if (typeof stateSource !== 'string' || !stateSource) return { ok: false, reason: 'state-source-empty' };
  const m = stateSource.match(/export\s+const\s+API_PREFIX\s*=\s*(['"])([^'"]+)\1/);
  if (!m) return { ok: false, reason: 'api-prefix-not-found' };
  const value = m[2];
  if (!value.startsWith('/')) return { ok: false, reason: `api-prefix-not-absolute:${value}` };
  return { ok: true, value };
}

// ───────────────────────── 源码侧：扫描 ─────────────────────────

/**
 * 扫描面板源码文本，得到 (path, method) 粒度端点清单。
 * @param {string} sourceText 面板 `lib/index.js` 全文
 * @param {{apiPrefix?: string, sourceLabel?: string}} [opts] apiPrefix 缺省时按 `undefined` 判不可用
 * @returns {{ok:boolean, unavailableReasons:string[], endpoints:Array, pairs:string[], counts:object, diagnostics:object}}
 */
export function scanWriteScopes(sourceText, opts = {}) {
  const unavailableReasons = [];
  const endpoints = [];
  const skippedCalls = [];
  const label = opts.sourceLabel ?? '(source)';
  const apiPrefix = opts.apiPrefix;

  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    return {
      ok: false, unavailableReasons: ['source-empty'], endpoints: [], pairs: [],
      counts: { registers: 0, writePaths: 0, getOnlyPaths: 0, pairs: 0, unavailableEndpoints: 0 },
      diagnostics: { sourceLabel: label, skippedCalls }
    };
  }
  if (typeof apiPrefix !== 'string' || !apiPrefix.startsWith('/')) {
    unavailableReasons.push('api-prefix-unavailable');
  }

  const masked = maskCode(sourceText);
  // 掩码后全文件花括号必须配平。已知局限：掩码不识别正则字面量 ⇒ 若正则里出现**不成对**的花括号
  //   （`/\{/` 之类），配平会被带歪。这条自检把那种情形**显式判不可用**（fail-closed），
  //   绝不静默给出一个"看起来对"的端点清单。
  const openCount = (masked.match(/\{/g) ?? []).length;
  const closeCount = (masked.match(/\}/g) ?? []).length;
  if (openCount !== closeCount) unavailableReasons.push(`source-braces-unbalanced:${openCount}/${closeCount}`);

  const callRe = /\bregister\s*\(/g;
  let m;
  while ((m = callRe.exec(masked)) !== null) {
    const openParen = m.index + m[0].length - 1;
    let j = openParen + 1;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    if (masked[j] !== '{') {
      // 非对象字面量形态（典型：`const register = (opts) => disposers.push(ctx.webServer.register(opts))` 的转发）。
      // 只接受「单个标识符参数」——其它形态静态解析不了，判不可用（不猜）。
      const closeParen = sourceText.indexOf(')', openParen + 1);
      const argText = sourceText.slice(openParen + 1, closeParen < 0 ? openParen + 1 : closeParen).trim();
      const identifierOnly = /^[A-Za-z_$][\w$]*$/.test(argText);
      skippedCalls.push({ line: lineOf(sourceText, m.index), argText, identifierOnly });
      if (!identifierOnly) unavailableReasons.push(`register-call-not-parseable@L${lineOf(sourceText, m.index)}:${argText.slice(0, 40)}`);
      continue;
    }
    const closeBrace = matchBrace(masked, j);
    if (closeBrace < 0) {
      unavailableReasons.push(`register-object-unbalanced@L${lineOf(sourceText, m.index)}`);
      continue;
    }
    const optRaw = sourceText.slice(j, closeBrace + 1);
    const optMasked = masked.slice(j, closeBrace + 1);
    const optLine = lineOf(sourceText, j);

    // ⚠️ 口径：**结构位置用掩码（optMasked）定位、字面量值用原文（optRaw）读取**——
    //   掩码把字符串/模板串内容换成了空格，从掩码里读值必然读到空（`path: \`${API_PREFIX}/restart\`` 会变空格）。
    const valueAfter = (fieldRe) => {
      const at = optMasked.search(fieldRe);
      if (at < 0) return null;
      const colon = optRaw.slice(at).indexOf(':');
      return colon < 0 ? null : optRaw.slice(at + colon + 1);
    };

    const kindRaw = valueAfter(/\bkind\s*:/);
    const kindM = kindRaw ? kindRaw.match(/^\s*(['"])([^'"]+)\1/) : null;
    const kind = kindM ? kindM[2] : null;

    // ── path ──
    let pathValue = null; let pathReason = null;
    const afterColon = valueAfter(/\bpath\s*:/);
    if (afterColon === null) {
      pathReason = 'path-missing';
    } else {
      const tpl = afterColon.match(/^\s*`\$\{\s*API_PREFIX\s*\}([^`]*)`/);
      if (tpl) {
        pathValue = apiPrefix ? `${apiPrefix}${tpl[1]}` : null;
        if (!apiPrefix) pathReason = 'api-prefix-unavailable';
      } else {
        const lit = afterColon.match(/^\s*(['"])([^'"]+)\1/);
        if (lit) pathValue = lit[2];
        else pathReason = 'path-form-unsupported';
      }
    }

    // ── handler 体 ──
    let handlerBody = null; let handlerLine = null; let handlerReason = null;
    const hIdx = optMasked.search(/\bhandler\s*:/);
    if (hIdx < 0) {
      handlerReason = 'handler-missing';
    } else {
      const afterH = optMasked.slice(hIdx + optMasked.slice(hIdx).indexOf(':') + 1);
      const arrow = afterH.indexOf('=>');
      const braceRel = afterH.indexOf('{');
      const fnRel = afterH.search(/\bfunction\b/);
      if (braceRel < 0 || (arrow >= 0 && braceRel < arrow) || (arrow < 0 && fnRel < 0)) {
        // 非块体 handler（`handler: someFn` / `=> writeJson(...)`）⇒ 静态解析不了
        handlerReason = 'handler-body-not-block';
      } else {
        // ⚠️ hIdx / braceRel 都是**相对 optMasked**的偏移 ⇒ 换算成全局下标时必须加上 j（register 对象起点）。
        const absBrace = j + hIdx + optMasked.slice(hIdx).indexOf(':') + 1 + braceRel;
        const absClose = matchBrace(masked, absBrace);
        if (absClose < 0) handlerReason = 'handler-body-unbalanced';
        else {
          handlerBody = sourceText.slice(absBrace, absClose + 1);
          handlerLine = lineOf(sourceText, absBrace);
        }
      }
    }

    // ── 端点级结论 ──
    const ep = {
      path: pathValue, kind, line: optLine, handlerLine,
      methods: [], methodsSource: null, dependencies: [], parseable: true, reason: null
    };
    if (pathReason) { ep.parseable = false; ep.reason = pathReason; }
    else if (handlerReason) { ep.parseable = false; ep.reason = handlerReason; }
    else {
      const eq = new Set(); const neq = new Set();
      const methodRe = /(?:req\s*\.\s*method\s*(===|!==|==|!=)\s*(['"])([A-Za-z]+)\2)|(?:((['"])([A-Za-z]+)\5)\s*(===|!==|==|!=)\s*req\s*\.\s*method)/g;
      let mm;
      while ((mm = methodRe.exec(handlerBody)) !== null) {
        const op = mm[1] ?? mm[7];
        const value = (mm[3] ?? mm[6]).toUpperCase();
        (op === '===' || op === '==' ? eq : neq).add(value);
      }
      const all = new Set([...eq, ...neq]);
      const bad = [...all].filter((v) => !METHOD_VALUES.includes(v));
      if (bad.length) { ep.parseable = false; ep.reason = `unknown-method-literal:${bad.join(',')}`; }
      else if (eq.size) { ep.methods = [...eq].sort(); ep.methodsSource = 'branch'; }
      else if (neq.size) { ep.methods = [...neq].sort(); ep.methodsSource = 'guard'; }
      else { ep.parseable = false; ep.reason = 'no-req-method-comparison'; }
      if (!ep.parseable) {
        // handler 里连 `req.method` 都没出现 ⇒ 依赖外部函数判定，静态不可知（不猜）
        if (ep.reason === 'no-req-method-comparison' && !/\breq\s*\.\s*method\b/.test(handlerBody)) ep.reason = 'req-method-absent';
      }
    }
    if (!ep.parseable) unavailableReasons.push(`${ep.path ?? pathReason ?? 'unknown-path'}@L${optLine}:${ep.reason}`);
    endpoints.push(ep);
  }

  if (!endpoints.length) unavailableReasons.push('no-register-found');

  // 同一 path 注册两次 = webserver 会抛 `duplicate route`（(kind, path) 去重、不含 method）⇒ 判不可用。
  // ⚠️ 键**只取 path**（不拼行号）：拼上行号会让"同 path 不同 register"比较不相等而漏检。
  const paths = endpoints.map((e) => e.path ?? '?').sort();
  const dups = paths.filter((v, idx) => idx > 0 && paths[idx - 1] === v);
  if (dups.length) unavailableReasons.push(`duplicate-endpoint:${[...new Set(dups)].join(',')}`);

  const pairs = [];
  let writePaths = 0; let getOnlyPaths = 0; let unavailableEndpoints = 0;
  for (const e of endpoints) {
    if (!e.parseable) { unavailableEndpoints++; continue; }
    for (const meth of e.methods) pairs.push(`${meth} ${e.path}`);
    if (e.methods.includes(WRITE_METHOD)) writePaths++;
    else if (e.methods.length === 1 && e.methods[0] === 'GET') getOnlyPaths++;
  }
  pairs.sort();

  return {
    ok: unavailableReasons.length === 0,
    unavailableReasons,
    endpoints,
    pairs,
    counts: {
      registers: endpoints.length,
      writePaths,
      getOnlyPaths,
      pairs: pairs.length,
      unavailableEndpoints
    },
    diagnostics: { sourceLabel: label, skippedCalls }
  };
}

// ───────────────────────── 文档侧：解析写口表 ─────────────────────────

/**
 * 解析文档中锚点区间内的 (path, method) 表。
 * 过标：三级单元格（端点 / 方法 / 级）任一缺失或形态非法 ⇒ `ok:false`（判不可用，不判过）。
 */
export function parseWriteScopeTable(docText) {
  const unavailableReasons = [];
  const rows = [];
  if (typeof docText !== 'string' || !docText.trim()) {
    return { ok: false, unavailableReasons: ['doc-empty'], rows, pairs: [], counts: { rows: 0, tiers: {} } };
  }
  const b = docText.indexOf(TABLE_BEGIN);
  const e = docText.indexOf(TABLE_END);
  if (b < 0 || e < 0 || e < b) {
    return { ok: false, unavailableReasons: ['table-anchor-missing'], rows, pairs: [], counts: { rows: 0, tiers: {} } };
  }
  const seg = docText.slice(b + TABLE_BEGIN.length, e);
  const lines = seg.split(/\r?\n/);
  let headerSeen = false;
  let dataStarted = false;
  // 区间内的「非表格插注」：**空行 / `>` 引用块不算表格终止**（2026-10-10 修，卡「冲刺600 · 写口校验器注位冲突」）。
  //   成因：活文档按六包纪律 A 类「就地加订正注」会在**数据行之间**插 `>` 注 ⇒ 旧实现（遇第一个非 `|`
  //   行即 break）把注之后的写口行全丢在区间外 ⇒ 行数偏少 + 零差集假红（真问题被噪声掩盖，
  //   见 `docs\交付报告-冲刺600-补测线-20261009.md` §6.1）。
  //   容忍面**故意收窄**：只认空行与 `>` 行（既有订正注形态）；其它非表格行仍按「表格已结束」处理（break），
  //   避免把 end 锚点之外的另一张表/正文吞进来。被接受的行仍逐行过合法性校验（path 绝对 / 方法白名单 /
  //   级取值 / 重复行）⇒ 混入无关表只会判「不可用」或判红，**不会假绿**（fail-closed 不变）。
  const isAnnotationLine = (l) => l === '' || l.startsWith('>');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) { if (dataStarted && !isAnnotationLine(line)) break; continue; }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!headerSeen) {
      if (cells.some((c) => c.includes('端点')) && cells.some((c) => c.includes('方法'))) {
        headerSeen = true;
        if (cells.length < 3) unavailableReasons.push('table-header-too-few-columns');
      }
      continue;
    }
    if (/^[\s|:-]+$/.test(line)) continue; // 分隔行
    dataStarted = true;
    const clean = (v) => String(v ?? '').replace(/`/g, '').replace(/\*\*/g, '').trim();
    const path = clean(cells[0]);
    const methodRaw = clean(cells[1]).toUpperCase().replace(/[^A-Z]/g, '');
    const tierRaw = clean(cells[2]);
    const tier = (tierRaw.match(/^(A|B|C\+|C⁺|C|D)/) ?? [null])[0];
    const row = { line: i + 1, path, method: methodRaw, tier, raw: cells, ok: true, reason: null };
    if (cells.length < 3) { row.ok = false; row.reason = 'row-too-few-columns'; }
    else if (!path.startsWith('/')) { row.ok = false; row.reason = `path-not-absolute:${path}`; }
    else if (!METHOD_VALUES.includes(methodRaw)) { row.ok = false; row.reason = `method-invalid:${cells[1]}`; }
    else if (!tier) { row.ok = false; row.reason = `tier-invalid:${tierRaw}`; }
    if (!row.ok) unavailableReasons.push(`${path || '?'}@row${i + 1}:${row.reason}`);
    rows.push(row);
  }
  if (!headerSeen) unavailableReasons.push('table-header-not-found');
  if (headerSeen && !rows.length) unavailableReasons.push('table-no-data-rows');

  const pairs = [];
  const tiers = {};
  for (const r of rows) {
    if (!r.ok) continue;
    tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
    pairs.push(`${r.method} ${r.path}`);
  }
  const sorted = [...pairs].sort();
  const dupP = sorted.filter((v, i) => i > 0 && sorted[i - 1] === v);
  if (dupP.length) unavailableReasons.push(`duplicate-row:${[...new Set(dupP)].join(',')}`);

  return {
    ok: unavailableReasons.length === 0,
    unavailableReasons,
    rows,
    pairs: sorted,
    counts: { rows: rows.length, tiers }
  };
}

// ───────────────────────── 比对 ─────────────────────────

/**
 * 源码扫描结果 ↔ 文档表 零差集比对。
 * @returns {{ok:boolean, missingInDoc:string[], extraInDoc:string[], unavailable:boolean}}
 */
export function diffScope(scan, table) {
  const unavailable = !scan?.ok || !table?.ok;
  const src = new Set(scan?.pairs ?? []);
  const doc = new Set(table?.pairs ?? []);
  const missingInDoc = [...src].filter((p) => !doc.has(p)).sort();
  const extraInDoc = [...doc].filter((p) => !src.has(p)).sort();
  return {
    ok: !unavailable && missingInDoc.length === 0 && extraInDoc.length === 0,
    missingInDoc, extraInDoc, unavailable
  };
}

// ───────────────────────── 只读薄封装（路径由调用方注入） ─────────────────────────

/** 只读一个面板源码文件并扫描（`stateSourcePath` 用于解析 API_PREFIX；缺省则判不可用）。 */
export function scanSourceFile(fsMod, sourcePath, stateSourcePath) {
  const out = { ok: false, unavailableReasons: [], endpoints: [], pairs: [], counts: { registers: 0, writePaths: 0, getOnlyPaths: 0, pairs: 0, unavailableEndpoints: 0 }, diagnostics: { sourceLabel: sourcePath, skippedCalls: [] } };
  let src;
  let stateSrc = null;
  try { src = fsMod.readFileSync(sourcePath, 'utf8'); } catch (err) { out.unavailableReasons.push(`source-read-failed:${err?.code ?? err?.message ?? err}`); return out; }
  const prefix = stateSourcePath
    ? (() => { try { stateSrc = fsMod.readFileSync(stateSourcePath, 'utf8'); } catch { return { ok: false, reason: 'state-read-failed' }; } return parseApiPrefix(stateSrc); })()
    : { ok: false, reason: 'state-source-not-provided' };
  if (!prefix.ok) out.unavailableReasons.push(prefix.reason);
  const scan = scanWriteScopes(src, { apiPrefix: prefix.value, sourceLabel: sourcePath });
  scan.unavailableReasons = [...new Set([...out.unavailableReasons, ...scan.unavailableReasons])];
  scan.ok = scan.unavailableReasons.length === 0;
  return scan;
}

/** 只读文档并解析表。 */
export function readDocTable(fsMod, docPath) {
  let txt;
  try { txt = fsMod.readFileSync(docPath, 'utf8'); } catch (err) {
    return { ok: false, unavailableReasons: [`doc-read-failed:${err?.code ?? err?.message ?? err}`], rows: [], pairs: [], counts: { rows: 0, tiers: {} } };
  }
  return parseWriteScopeTable(txt);
}
