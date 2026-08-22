// @why: yspec のファイルスキャン・マーカー抽出およびターゲットグルーピング（Spec Collision Check用）のコアロジック
// @tags: SPEC

import fs from 'node:fs';
import path from 'node:path';

// @why: 文字列リテラルや説明文内の「@why」誤検知を防ぐため、コメント接頭辞（//, *, #, <!--, --）直後のマーカーのみを対象にする
// @tags: SPEC
export const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|#|<!--|--)\s*@(why|spec|tags|targets?)\b/i;
export const REASON_RE = /@(?:why|spec)\s*:\s*(.+)$/i;
export const SPEC_TAG_RE = /@tags\s*:\s*([^\s,，]+)/i;
export const TARGET_TAG_RE = /@targets?\s*:\s*([^\s,，]+)/i;
export const SRC_RE = /@src\s*:\s*([^\n]+)$/i;

// yume エンブレム境界（所属 BLOCK id の追跡に使用）
export const EMBLEM_OPEN_RE = /^\s*(?:\/\/|#|\*)\s*(?:>>>\s+)?BLOCK\s+(\S+)/;
export const EMBLEM_CLOSE_RE = /^\s*(?:\/\/|#|\*)\s*<<<\s*\/?BLOCK/;

export const EXT_SCAN = new Set([".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".md", ".py", ".go", ".rs", ".rb", ".html", ".yume.js"]);

/**
 * @typedef {Object} Hit
 * @property {string} file
 * @property {number} line
 * @property {string|null} block
 * @property {string} tags
 * @property {string|null} reason
 * @property {string} raw
 */

/**
 * 1ファイルをスキャンして仕様マーカーを抽出
 * @param {string} absFile 
 * @param {string} relFile 
 * @param {Hit[]} hits 
 */
export function scanFile(absFile, relFile, hits) {
  let text;
  try {
    text = fs.readFileSync(absFile, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mOpen = line.match(EMBLEM_OPEN_RE);
    const mClose = line.match(EMBLEM_CLOSE_RE);
    if (mOpen) block = mOpen[1];
    else if (mClose) block = null;

    const trimmed = line.trim();
    if (!COMMENT_LINE_RE.test(trimmed)) continue;

    const targetMatch = line.match(TARGET_TAG_RE);
    const explicitTarget = targetMatch ? targetMatch[1] : null;

    const reason = line.match(REASON_RE)?.[1].replace(/-->\s*$/, '').trim() ?? null;
    const tag = line.match(SPEC_TAG_RE)?.[1].replace(/-->\s*$/, '').trim() ?? null;
    if (!reason && !tag && !explicitTarget) continue;

    hits.push({
      file: relFile,
      line: i + 1,
      block: explicitTarget || block,
      tags: tag ?? '',
      reason,
      raw: trimmed.slice(0, 200),
    });
  }
}

/**
 * ディレクトリを再帰走査
 * @param {string} absDir 
 * @param {string} relBase 
 * @param {Hit[]} hits 
 */
export function walkDir(absDir, relBase, hits) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.yume' || e.name.startsWith('.')) continue;
    const abs = path.join(absDir, e.name);
    const rel = path.join(relBase, e.name);
    if (e.isDirectory()) walkDir(abs, rel, hits);
    else if (EXT_SCAN.has(path.extname(e.name)) || e.name.endsWith('.yume.js')) scanFile(abs, rel, hits);
  }
}

/**
 * 仕様マーカーをターゲットごとにグルーピング（Spec Collision Check用）
 * @param {Hit[]} hits 
 * @returns {Array<{ target: string, file: string, whys: Array<{ line: number, text: string }> }>}
 */
export function groupWhysByTarget(hits) {
  const groups = new Map();
  for (const h of hits) {
    if (!h.reason) continue;
    const targetKey = h.block || (h.tags && h.tags !== 'SPEC' ? h.tags : h.file);
    if (!groups.has(targetKey)) {
      groups.set(targetKey, { target: targetKey, file: h.file, whys: [] });
    }
    groups.get(targetKey).whys.push({ line: h.line, text: h.reason });
  }
  return Array.from(groups.values());
}

/**
 * 俯瞰テキストの整形
 * @param {Hit[]} hits 
 * @param {boolean} showRaw 
 * @returns {string}
 */
export function render(hits, showRaw = false) {
  if (hits.length === 0) {
    return '（仕様/why マーカーが見つかりません。編集時は `// @why: <理由>` か `// @tags: SPEC` をコメントで内蔵してください）';
  }
  const out = hits.map((h) => {
    const where = h.block ? `[target:${h.block}]` : '';
    const tag = h.tags ? `@tags:${h.tags} ` : '';
    const reason = h.reason ? `@why: ${h.reason}` : '';
    const raw = showRaw && h.reason === null ? `\n        ↳ ${h.raw}` : '';
    return `${h.file}:${h.line}  ${where} ${tag}${reason}${raw}`;
  });
  return out.join('\n');
}
