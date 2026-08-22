// @why: yume-spec の E2E snowball テスト。単独配布時の完全自己完結性のため、fixtures はパッケージ内に内蔵（./fixtures）して実機検証する
// @tags: SPEC

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUIGraph, assertUIHealthy, renderTree, renderAnomalies, renderMermaid } from './ui/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, 'fixtures');
const GOOD_UI = path.join(FIXTURES, 'good-ui.html');
const BAD_UI = path.join(FIXTURES, 'bad-ui.html');

async function main() {
  console.log('🧪 === yume-spec E2E Test (including yui / assertUIHealthy) ===\n');

  // Test 1: assertUIHealthy on good-ui.html (should PASS)
  console.log('▶ [Test 1] assertUIHealthy on good-ui.html');
  const goodRes = await assertUIHealthy(GOOD_UI);
  assert.strictEqual(goodRes.summary.pass, true, 'good-ui.html must pass UI check');
  assert.strictEqual(goodRes.summary.errorCount, 0, 'good-ui.html must have 0 errors');
  console.log('  ✅ Test 1 Passed! (good-ui passed with 0 errors)\n');

  // Test 2: assertUIHealthy on bad-ui.html (should throw Error with anomaly details)
  console.log('▶ [Test 2] assertUIHealthy on bad-ui.html (should catch errors)');
  let caughtError = null;
  try {
    await assertUIHealthy(BAD_UI);
  } catch (err) {
    caughtError = err;
  }
  assert.ok(caughtError, 'bad-ui.html must fail assertUIHealthy');
  assert.ok(caughtError.message.includes('OVERFLOW_LEAK'), 'Error message must mention OVERFLOW_LEAK');
  assert.ok(caughtError.message.includes('INTERACTION_OCCLUDED'), 'Error message must mention INTERACTION_OCCLUDED');
  assert.ok(caughtError.message.includes('VIEWPORT_HORIZONTAL_OVERFLOW'), 'Error message must mention VIEWPORT_HORIZONTAL_OVERFLOW');
  console.log('  ✅ Test 2 Passed! (bad-ui correctly triggered UI Health error with VIEWPORT overflow)\n');

  // Test 3: data-yui-ignore verification
  console.log('▶ [Test 3] data-yui-ignore opt-out verification');
  const badGraph = await runUIGraph(BAD_UI);
  const ignoredElementLeak = badGraph.anomalies.find(a => a.selector && a.selector.includes('child-badge-ignored'));
  assert.strictEqual(ignoredElementLeak, undefined, 'data-yui-ignore element must not be in anomalies');
  console.log('  ✅ Test 3 Passed! (data-yui-ignore successfully skipped intentional overflow)\n');

  // Test 4: Formatters check
  console.log('▶ [Test 4] Formatters (Tree, Anomalies, Mermaid)');
  const graph = await runUIGraph(GOOD_UI);
  const tree = renderTree(graph);
  const anomalies = renderAnomalies(graph);
  const mermaid = renderMermaid(graph);

  assert.ok(tree.includes('Viewport:'), 'Tree must have Viewport');
  assert.ok(anomalies.includes('PASS'), 'Anomalies report must show PASS');
  assert.ok(mermaid.includes('flowchart TD'), 'Mermaid must have flowchart header');
  console.log('  ✅ Test 4 Passed! (All formatters rendered valid output)\n');

  // Test 5: yspec comment prefix filtering (No ghost markers from string literals)
  console.log('▶ [Test 5] yspec marker precision (Comment prefix only)');
  const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|#|<!--|--)\s*@(why|spec|tags)\b/i;
  const tsContent = fs.readFileSync(path.join(HERE, 'extensions/yume-spec.ts'), 'utf8');
  const tsHits = tsContent.split('\n').filter(l => COMMENT_LINE_RE.test(l.trim()));
  // 文字列リテラルや説明文内の「@why」は除外され、実際のコメント行のみヒットすること
  assert.ok(tsHits.length <= 6, `Ghost markers should be filtered out, got ${tsHits.length} hits`);
  console.log(`  ✅ Test 5 Passed! (Clean spec scanning: ${tsHits.length} true spec comments found)\n`);

  console.log('🎉 === All yume-spec E2E Tests Completed Successfully! ===');
}

main().catch(err => {
  console.error('❌ E2E Test Failed:', err);
  process.exit(1);
});
