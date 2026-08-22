// @why: Keep Why を硬い不変項にするための決定論的 Presence ゲート。Git diff を検査し、コードが追加・変更されたのに @why 行が追加されていないファイルをオフライン・決定論的・ゼロコストで検出し物理ブロックする
// @tags: SPEC

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { COMMENT_LINE_RE, REASON_RE, EXT_SCAN } from './scan.js';

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * git diff を解析して、コード変更があるのに @why の追加がないファイルを決定論的に検出する
 * @param {Object} options
 * @param {string} [options.cwd] 作業ディレクトリ
 * @param {string} [options.base] 比較対象コミット (既定: HEAD または未コミット差分)
 * @param {string} [options.diffText] テスト/直接渡し用 diff 文字列
 * @returns {{ pass: boolean, totalFiles: number, violations: Array<{ file: string, addedCodeLines: number, whyLinesAdded: number, message: string }> }}
 */
export function checkWhyPresence(options = {}) {
  const cwd = options.cwd || process.cwd();
  let diff = options.diffText;

  if (diff == null) {
    // 1) 未コミット（ステージ＋未ステージ）の差分を取得
    diff = git(['diff', options.base || 'HEAD'], cwd);
    // HEAD がない初期リポジトリの場合はステージング差分
    if (diff == null || diff === '') {
      diff = git(['diff', '--cached'], cwd) || git(['diff'], cwd) || '';
    }
  }

  if (!diff || !diff.trim()) {
    return {
      pass: true,
      totalFiles: 0,
      violations: [],
      note: '検査対象の差分がありません（クリーン）',
    };
  }

  const files = parseDiffByFile(diff);
  const violations = [];

  for (const f of files) {
    const ext = path.extname(f.file);
    if (!EXT_SCAN.has(ext) && !f.file.endsWith('.yume.js')) {
      continue;
    }

    // 変更された行から、コード行と @why 行をカウント
    let addedCodeLines = 0;
    let whyLinesAdded = 0;

    for (const line of f.addedLines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // 空行は無視

      // コメント行でかつ @why マーカーを含むか
      if (COMMENT_LINE_RE.test(trimmed) && REASON_RE.test(trimmed)) {
        whyLinesAdded++;
      } else {
        // コメントのみの軽微な変更（@tags など）以外を実質コード行としてカウント
        addedCodeLines++;
      }
    }

    // コード行が追加・変更されているのに、@why が 0 件の場合は違反（FAIL）
    if (addedCodeLines > 0 && whyLinesAdded === 0) {
      violations.push({
        file: f.file,
        addedCodeLines,
        whyLinesAdded,
        message: `コード変更が ${addedCodeLines} 行あるのに、仕様の由来を示す // @why: コメントが追加されていません`,
      });
    }
  }

  return {
    pass: violations.length === 0,
    totalFiles: files.length,
    violations,
  };
}

/**
 * 簡易 Unified Diff パーサー
 */
function parseDiffByFile(diffText) {
  const lines = diffText.split('\n');
  const files = [];
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ');
      const bPath = parts[parts.length - 1] || '';
      const cleanPath = bPath.replace(/^[ab]\//, '');
      currentFile = { file: cleanPath, addedLines: [] };
      files.push(currentFile);
    } else if (line.startsWith('+++ ')) {
      if (currentFile && !currentFile.file) {
        currentFile.file = line.slice(4).replace(/^[ab]\//, '').trim();
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) {
        currentFile.addedLines.push(line.slice(1));
      }
    }
  }

  return files;
}
