// @why: 編集経路・構文スコープ（関数・クラス・UIセレクタ・テスト）から自動的に当たり判定ボックス（ターゲット）を生成し、明示的@targets不要で仕様衝突判定を全自動発火させる
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
 * 構文シグネチャから現在のスコープ名を自動判定する正規表現群
 */
const SCOPE_PATTERNS = [
  // 1. 関数定義: function foo(...) / export function foo(...) / async function foo(...)
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z0-9_$]+)\s*\(/,
  // 2. 変数関数: const foo = (...) => / const foo = function(...)
  /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?function/,
  // 3. クラス定義: class Foo / export class Foo
  /^\s*(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/,
  // 4. クラスメソッド / オブジェクトメソッド: foo(...) { / async foo(...) {
  /^\s*(?:(?:public|private|protected|static|async)\s+)*([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
  // 5. テストフレームワーク: test('...', ...) / describe('...', ...) / it('...', ...)
  /^\s*(?:test|describe|it)\s*\(\s*['"`]([^'"`]+)['"`]/,
  // 6. HTMLタグ（IDまたはクラス付き）: <div id="foo"> / <button class="btn">
  /^\s*<([a-zA-Z0-9_-]+)(?:\s+[^>]*?(?:id=['"]([^'"]+)['"]|class=['"]([^'"]+)['"]))?[^>]*>/,
  // 7. CSS セレクタ: .btn-primary { / #login-box { / header {
  /^\s*([.#]?[a-zA-Z0-9_:-]+(?:\s*,\s*[.#]?[a-zA-Z0-9_:-]+)*)\s*\{/,
];

/**
 * 行テキストから構文スコープ名を抽出
 * @param {string} line 
 * @returns {string|null}
 */
export function extractScopeName(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) {
    return null;
  }

  // 1. 関数 / アロー関数
  let m = trimmed.match(SCOPE_PATTERNS[0]);
  if (m) return `${m[1]}()`;
  m = trimmed.match(SCOPE_PATTERNS[1]);
  if (m) return `${m[1]}()`;
  m = trimmed.match(SCOPE_PATTERNS[2]);
  if (m) return `${m[1]}()`;

  // 2. クラス
  m = trimmed.match(SCOPE_PATTERNS[3]);
  if (m) return `class ${m[1]}`;

  // 3. テスト
  m = trimmed.match(SCOPE_PATTERNS[5]);
  if (m) return `test("${m[1]}")`;

  // 4. クラスメソッド
  m = trimmed.match(SCOPE_PATTERNS[4]);
  if (m && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
    return `${m[1]}()`;
  }

  // 5. HTML タグ
  m = trimmed.match(SCOPE_PATTERNS[6]);
  if (m) {
    const tag = m[1];
    const id = m[2];
    const cls = m[3] ? m[3].split(' ')[0] : null;
    if (id) return `<${tag}#${id}>`;
    if (cls) return `<${tag}.${cls}>`;
    return `<${tag}>`;
  }

  // 6. CSS セレクタ
  m = trimmed.match(SCOPE_PATTERNS[7]);
  if (m && !trimmed.startsWith('@')) {
    return m[1].trim();
  }

  return null;
}

/**
 * 1ファイルをスキャンして仕様マーカーと編集経路（スコープ）を抽出
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
  const scopeStack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // BLOCK 構文の追跡
    const mOpen = line.match(EMBLEM_OPEN_RE);
    const mClose = line.match(EMBLEM_CLOSE_RE);
    if (mOpen) block = mOpen[1];
    else if (mClose) block = null;

    // 構文スコープの自動検出
    const detectedScope = extractScopeName(line);
    if (detectedScope) {
      scopeStack.push({ name: detectedScope, line: i + 1, depth: scopeStack.length });
      // 深すぎるスタックは3階層までに制限
      if (scopeStack.length > 3) scopeStack.shift();
    }

    const trimmed = line.trim();
    if (!COMMENT_LINE_RE.test(trimmed)) continue;

    const targetMatch = line.match(TARGET_TAG_RE);
    const explicitTarget = targetMatch ? targetMatch[1] : null;

    const reason = line.match(REASON_RE)?.[1].replace(/-->\s*$/, '').trim() ?? null;
    const tag = line.match(SPEC_TAG_RE)?.[1].replace(/-->\s*$/, '').trim() ?? null;
    if (!reason && !tag && !explicitTarget) continue;

    // ターゲットの決定優先順位:
    // 1. @targets: 明示指定
    // 2. BLOCK 構文
    // 3. 構文から自動抽出されたスコープ (例: "login()" や "class AuthService")
    let target = explicitTarget || block;
    if (!target && scopeStack.length > 0) {
      const currentScope = scopeStack[scopeStack.length - 1].name;
      target = `${relFile}#${currentScope}`;
    }

    hits.push({
      file: relFile,
      line: i + 1,
      block: target,
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
 * @why: 明示的な @targets だけでなく、自動抽出された構文スコープ（関数名/クラス名等）に基づいて衝突グループを自動生成する
 * @tags: SPEC
 * @param {Hit[]} hits 
 * @returns {Array<{ target: string, file: string, whys: Array<{ line: number, text: string }> }>}
 */
export function groupWhysByTarget(hits) {
  const groups = new Map();
  for (const h of hits) {
    if (!h.reason) continue;
    // block (明示 @targets, BLOCK, または自動構文スコープ) をターゲットとする
    const targetKey = h.block || (h.tags && h.tags !== 'SPEC' ? `${h.file}@${h.tags}` : null);
    if (!targetKey) continue;

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
