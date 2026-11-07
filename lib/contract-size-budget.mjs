// dsh-butler-panel / lib/contract-size-budget.mjs
// 📜 契约片体量判据（**单一真源**：verify-after-restart.mjs 与 _test/test-contract-size-ratio.mjs 共用同一公式）
//
// 背景（2026-09-15 卡「契约片假红」）：
//   原断言是**硬编码绝对值** `c1.bytes > 100 * 1024`。persona 瘦身（L1：注入文本 55,718 → 32,031 字符）
//   连带契约片从 ~127 KB 瘦到 ~85.8 KB → verify 出现 1 项既有红（不是回归，是阈值过期）。
//   契约片 = persona 全文的 JSON 载体（每条带 title/summary/full），体量由 persona 规模决定
//   → **任何绝对值阈值都会随 persona 涨瘦而过期**，改回硬编码等于再埋一颗定时炸弹。
//
// 判据（相对下限）：契约片字节 ≥ 基数 × 比值，基数优先取 persona 正文，取不到再降级取源文件。
//   · **首选基数 = persona 正文 UTF-8 字节**（响应里 contract.file → 本机读同一文件 → extractPersonaText）
//     实测（2026-09-15 生产 3080）：契约片 85,772 B / 正文 57,605 B = **1.489**
//     → 比值取 1.1，余量 ~35%。
//     正文基数为什么稳：契约片 ≈ 正文 × (1 + 摘要/标题重复) + JSON 结构，**与 persona 绝对规模基本无关**；
//     而且 persona 越小，结构开销占比越高 → 比率反而更高（单测三档实测 1.59 / 1.47 / 1.44）
//     ⇒ **persona 再瘦也不会假红**，只会因「真实退化」（解析截断/条目丢失）而红。
//   · **降级基数 = persona 源文件字节**（响应 contract.bytes）：实测比率 1.194 → 比值取 0.9。
//     ⚠️ 该基数含文件里 persona 之外的部分（本机实测固定开销 14,239 B），persona 缩到当前的 ~37% 以下会偏紧，
//        故只在读不到正文时降级使用（如 file 不可读）。
//   · 规模跟随与根因复现证据：_test/test-contract-size-ratio.mjs（三档 persona 副本，含旧 100 KB 判据对照）。
//
// 归属：**CLI 自检侧专用**。宿主运行时不 import 本文件，故**不入 deploy.mjs 的实体拷贝清单**。

/** 契约片 ≥ persona **正文**字节 × 该比值（首选判据）。 */
export const CONTRACT_SHARD_MIN_RATIO_BODY = 1.1;
/** 契约片 ≥ persona **源文件**字节 × 该比值（降级判据，见头部说明）。 */
export const CONTRACT_SHARD_MIN_RATIO_FILE = 0.9;
/**
 * 基数**不可得**下限：低于此值才判定「读不到 persona」→ 降级/报红。
 * ⚠️ 这不是「persona 太小」的门槛：persona 变小是正常编辑（L1 就砍了 43%），判据必须跟着缩放而不是报红。
 */
export const CONTRACT_MIN_BODY_BYTES = 2 * 1024;
/** 源文件基数不可得下限（同上下限，用于降级路径）。 */
export const CONTRACT_MIN_FILE_BYTES = 2 * 1024;
/** 实测比率基准（2026-09-15，供 reason 与单测对照；不参与判定）。 */
export const CONTRACT_SHARD_RATIO_MEASURED = Object.freeze({ body: 1.49, file: 1.19 });

const num = (v) => Math.max(0, Number(v) || 0);

/**
 * 选基数并算契约片字节相对下限。
 * @param {{bodyBytes?:number, fileBytes?:number}} [sizes] 正文 UTF-8 字节（首选）/ 源文件字节（降级）
 * @returns {{min:number, basis:'body'|'file'|null, base:number, ratio:number|null}}
 */
export function contractShardMinBytes(sizes = {}) {
  const body = num(sizes.bodyBytes);
  const file = num(sizes.fileBytes);
  if (body >= CONTRACT_MIN_BODY_BYTES) {
    return { min: Math.ceil(body * CONTRACT_SHARD_MIN_RATIO_BODY), basis: 'body', base: body, ratio: CONTRACT_SHARD_MIN_RATIO_BODY };
  }
  if (file >= CONTRACT_MIN_FILE_BYTES) {
    return { min: Math.ceil(file * CONTRACT_SHARD_MIN_RATIO_FILE), basis: 'file', base: file, ratio: CONTRACT_SHARD_MIN_RATIO_FILE };
  }
  return { min: 0, basis: null, base: Math.max(body, file), ratio: null };
}

/**
 * 判定契约片体量是否达标（相对判据 + 基数守卫）。
 * @param {number} shardBytes 契约片响应体字节（UTF-8）
 * @param {{bodyBytes?:number, fileBytes?:number}} [sizes] 见 contractShardMinBytes
 * @returns {{ok:boolean, basis:'body'|'file'|null, min:number, base:number, ratio:number|null, reason:string}}
 */
export function judgeContractShardSize(shardBytes, sizes = {}) {
  const bytes = num(shardBytes);
  const { min, basis, base, ratio } = contractShardMinBytes(sizes);
  if (!basis) {
    return {
      ok: false, basis, min, base, ratio,
      reason: `契约片基数不可得：persona 正文 ${num(sizes.bodyBytes)} B < ${CONTRACT_MIN_BODY_BYTES} B 且源文件 ${num(sizes.fileBytes)} B < ${CONTRACT_MIN_FILE_BYTES} B → 判据不成立，直红`,
    };
  }
  const label = basis === 'body' ? 'persona 正文字节' : 'persona 源文件字节';
  const got = base ? +(bytes / base).toFixed(4) : null;
  if (bytes < min) {
    return {
      ok: false, basis, min, base, ratio,
      reason: `契约片 ${bytes} B < ${label} ${base} B × ${ratio} = ${min} B（实得比率 ${got ?? '-'}）`,
    };
  }
  return {
    ok: true, basis, min, base, ratio,
    reason: `契约片 ${bytes} B ≥ ${label} ${base} B × ${ratio} = ${min} B（实得比率 ${(bytes / base).toFixed(3)}，实测基准 ${CONTRACT_SHARD_RATIO_MEASURED[basis]}，基数=${basis === 'body' ? '正文' : '源文件降级'}）`,
  };
}
