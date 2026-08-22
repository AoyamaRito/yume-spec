// @why: Spec Collision Packet 抽出器。外部LLM呼び出しを排し、同一ターゲット（@targets:/BLOCK）内の新旧@why仕様変遷をオフライン・決定論的・ゼロコストで抽出し、作業中のメインLLMが判断するための構造化レポートを生成する
// @tags: SPEC

/**
 * collision.js — Spec Collision Report Generator
 * 
 * 思想:
 * ツールは「事実（同一ターゲット内の新旧 @why 変遷）」を正確・決定論的に抽出して提示することに徹し、
 * 「意味・文脈・意図の整合性判断」は最大のコンテキストを持つ作業中LLM自身が行う。
 */

/**
 * ターゲットごとの仕様変遷を整理し、LLM判断用のレポートを生成する
 * @param {Array<{ target: string, file: string, whys: Array<{ line: number, text: string }> }>} groups 
 * @returns {{ hasMultiSpecs: boolean, totalTargets: number, multiSpecTargets: Array<{ target: string, file: string, count: number, whys: Array<{ line: number, text: string, isLatest: boolean }> }>, report: string }}
 */
export function extractCollisionReport(groups) {
  const multiSpecTargets = [];

  for (const g of groups) {
    // 2件以上の why が積層されているターゲットのみを抽出（変遷あり）
    if (g.whys.length > 1) {
      multiSpecTargets.push({
        target: g.target,
        file: g.file,
        count: g.whys.length,
        whys: g.whys.map((w, idx) => ({
          line: w.line,
          text: w.text,
          isLatest: idx === g.whys.length - 1,
        })),
      });
    }
  }

  const lines = [
    '====================================================',
    `📋 SPEC COLLISION REPORT (仕様変遷・整合性判断パケット)`,
    `   判定対象ターゲット: ${groups.length} 件 (仕様変遷あり: ${multiSpecTargets.length} 件)`,
    '====================================================',
  ];

  if (multiSpecTargets.length === 0) {
    lines.push('\n✨ 複数世代の仕様が積層しているターゲットはありません（全ターゲット単一仕様）。');
  } else {
    lines.push('\n💡 以下のターゲットで新旧の仕様（@why）が積層しています。');
    lines.push('   作業中LLMは、最新の仕様が過去の重要要件（セキュリティ・再発防止策）を意図せず破壊（デグレ）していないか確認してください:\n');

    multiSpecTargets.forEach((t, i) => {
      lines.push(`${i + 1}. [ターゲット: ${t.target}] (${t.file}) — ${t.count} 世代の仕様:`);
      t.whys.forEach((w, idx) => {
        const isLatest = w.isLatest;
        const prefix = idx === t.whys.length - 1 ? '   └─' : '   ├─';
        const tag = isLatest ? '🔥 [最新]' : `📜 [過去(版${idx + 1})]`;
        lines.push(`${prefix} ${tag} (L${w.line}) @why: ${w.text}`);
      });
      lines.push('');
    });
  }

  return {
    hasMultiSpecs: multiSpecTargets.length > 0,
    totalTargets: groups.length,
    multiSpecTargets,
    report: lines.join('\n'),
  };
}
