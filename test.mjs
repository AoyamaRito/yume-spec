// @why: yume-spec の E2E snowball テスト。UI健全性(yui), 幽霊マーカー防止, および仕様矛盾検知(Spec Collision Checker)を実機検証する
// @tags: SPEC

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUIGraph, assertUIHealthy, renderTree, renderAnomalies, renderMermaid } from './ui/index.js';
import { checkSpecCollisions } from './collision.js';
import { scanFile, groupWhysByTarget, COMMENT_LINE_RE } from './scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, 'fixtures');
const GOOD_UI = path.join(FIXTURES, 'good-ui.html');
const BAD_UI = path.join(FIXTURES, 'bad-ui.html');

async function main() {
  console.log('🧪 === yume-spec E2E Test (including yui, yspec-check / Collision Checker) ===\n');

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
  const tsContent = fs.readFileSync(path.join(HERE, 'scan.js'), 'utf8');
  const tsHits = tsContent.split('\n').filter(l => COMMENT_LINE_RE.test(l.trim()));
  assert.ok(tsHits.length <= 8, `Ghost markers should be filtered out, got ${tsHits.length} hits`);
  console.log(`  ✅ Test 5 Passed! (Clean spec scanning: ${tsHits.length} true spec comments found)\n`);

  // Test 6: Spec Collision Checker (Target grouping & Contradiction Detection)
  console.log('▶ [Test 6] Spec Collision Checker (Target grouping & Contradiction)');
  const sampleHits = [];
  scanFile(path.join(HERE, 'examples/sample.js'), 'examples/sample.js', sampleHits);
  const targetGroups = groupWhysByTarget(sampleHits);
  assert.ok(targetGroups.length >= 2, 'Should group sample whys by block/target');

  const authGroup = targetGroups.find(g => g.target === 'app:auth');
  assert.ok(authGroup, 'Target app:auth must exist');
  assert.ok(authGroup.whys.length >= 1, 'app:auth must contain why lines');

  // Evaluator Simulation: 正常な仕様進化 (PASS)
  const passGroups = [
    {
      target: 'db:cache',
      file: 'cache.js',
      whys: [
        { line: 10, text: '初期メモリキャッシュを導入' },
        { line: 25, text: 'メモリ肥大化防止のためTTLとLRU破棄ロジックを追加' },
      ],
    },
  ];
  const passRes = await checkSpecCollisions(passGroups, {
    evaluator: async (g) => ({ target: g.target, file: g.file, status: 'PASS' }),
  });
  assert.strictEqual(passRes.pass, true, 'Valid evolution must PASS');

  // Evaluator Simulation: 矛盾・デグレ (FAIL)
  const failGroups = [
    {
      target: 'security:auth',
      file: 'auth.js',
      whys: [
        { line: 5, text: '不正ログイン脆弱性CVE-1234防止のためトークン認証を必須化' },
        { line: 40, text: 'テストが面倒なためトークン認証を全廃し未認証アクセスを許可' },
      ],
    },
  ];
  const failRes = await checkSpecCollisions(failGroups, {
    evaluator: async (g) => ({
      target: g.target,
      file: g.file,
      status: 'FAIL',
      reason: '過去の脆弱性防止要件（トークン認証必須化）を破壊しています',
    }),
  });
  assert.strictEqual(failRes.pass, false, 'Contradictory / regression specs must FAIL');
  assert.strictEqual(failRes.results[0].status, 'FAIL');
  assert.ok(failRes.results[0].reason.includes('脆弱性防止要件'), 'Reason must explain regression');

  console.log('  ✅ Test 6 Passed! (Spec Collision Checker correctly detects regressions and groupings)\n');

  console.log('🎉 === All yume-spec E2E Tests Completed Successfully! ===');
}

main().catch(err => {
  console.error('❌ E2E Test Failed:', err);
  process.exit(1);
});
