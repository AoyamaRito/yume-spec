// @why: yume-spec の E2E snowball テスト。UI健全性(yui), 幽霊マーカー防止, 決定的Presenceゲート(presence), および状態三分割Spec Collision Checkerを実機検証する
// @tags: SPEC

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUIGraph, assertUIHealthy, renderTree, renderAnomalies, renderMermaid, findChromiumPath } from './ui/index.js';
import { checkSpecCollisions } from './collision.js';
import { checkWhyPresence } from './presence.js';
import { scanFile, groupWhysByTarget, COMMENT_LINE_RE } from './scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, 'fixtures');
const GOOD_UI = path.join(FIXTURES, 'good-ui.html');
const BAD_UI = path.join(FIXTURES, 'bad-ui.html');

async function main() {
  console.log('🧪 === yume-spec E2E Test Suite ===\n');

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

  // Test 6: Deterministic Presence Gate (Keep Why 不変項検証)
  console.log('▶ [Test 6] Deterministic Presence Gate (checkWhyPresence)');
  // 6a: 変更があるのに @why がない diff → 確実に FAIL
  const badDiff = `
diff --git a/app.js b/app.js
--- a/app.js
+++ b/app.js
@@ -10,3 +10,4 @@
+function calculateTotal(price, tax) { return price * (1 + tax); }
`;
  const presFailRes = checkWhyPresence({ diffText: badDiff });
  assert.strictEqual(presFailRes.pass, false, 'Diff without @why must FAIL presence gate');
  assert.strictEqual(presFailRes.violations.length, 1);
  assert.strictEqual(presFailRes.violations[0].file, 'app.js');
  console.log('  ✅ 6a Passed! (Missing @why was deterministically caught and blocked)');

  // 6b: コード変更に @why が付いている diff → 確実に PASS
  const goodDiff = `
diff --git a/app.js b/app.js
--- a/app.js
+++ b/app.js
@@ -10,3 +10,5 @@
+// @why: 消費税率の計算ロジックを共通化
+function calculateTotal(price, tax) { return price * (1 + tax); }
`;
  const presPassRes = checkWhyPresence({ diffText: goodDiff });
  assert.strictEqual(presPassRes.pass, true, 'Diff with @why must PASS presence gate');
  assert.strictEqual(presPassRes.violations.length, 0);
  console.log('  ✅ 6b Passed! (Valid code change with @why passed presence gate)');

  // 6c: クリーン状態
  const cleanRes = checkWhyPresence({ diffText: '' });
  assert.strictEqual(cleanRes.pass, true, 'Empty diff must PASS');
  console.log('  ✅ 6c Passed! (Clean diff passed)\n');

  // Test 7: Spec Collision Advisory (3-state: PASS / FAIL / SKIP)
  console.log('▶ [Test 7] Spec Collision Advisory (3-state PASS / FAIL / SKIP)');
  // 7a: 正常進化 (PASS)
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
  const collPassRes = await checkSpecCollisions(passGroups, {
    evaluator: async (g) => ({ target: g.target, file: g.file, status: 'PASS' }),
  });
  assert.strictEqual(collPassRes.pass, true);
  assert.strictEqual(collPassRes.summary.passCount, 1);
  assert.strictEqual(collPassRes.summary.failCount, 0);
  console.log('  ✅ 7a Passed! (Evolution -> PASS)');

  // 7b: 矛盾・デグレ (FAIL)
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
  const collFailRes = await checkSpecCollisions(failGroups, {
    evaluator: async (g) => ({
      target: g.target,
      file: g.file,
      status: 'FAIL',
      reason: '過去の脆弱性防止要件（トークン認証必須化）を破壊しています',
    }),
  });
  assert.strictEqual(collFailRes.pass, false);
  assert.strictEqual(collFailRes.summary.failCount, 1);
  console.log('  ✅ 7b Passed! (Contradiction -> FAIL)');

  // 7c: APIキーなし / ネットワーク例外時の偽装防止 (SKIP)
  const skipGroups = [
    {
      target: 'ui:theme',
      file: 'theme.js',
      whys: [{ line: 1, text: 'ダークテーマ' }, { line: 2, text: 'ハイコントラスト' }],
    },
  ];
  const collSkipRes = await checkSpecCollisions(skipGroups, {
    apiKey: null, // 明示的にキーなし
  });
  assert.strictEqual(collSkipRes.summary.skipCount, 1, 'Missing API key must be SKIP, not silently PASS');
  assert.strictEqual(collSkipRes.results[0].status, 'SKIP');
  console.log('  ✅ 7c Passed! (Missing key -> SKIP accurately reported, no silent green)');

  // Test 8: Cross-platform Chromium finder check
  console.log('\n▶ [Test 8] Cross-platform Chromium finder');
  const exe = findChromiumPath();
  assert.ok(exe, 'Chromium executable must be found on this platform');
  console.log(`  ✅ Test 8 Passed! (Found Chromium: ${exe})\n`);

  console.log('🎉 === All yume-spec E2E Tests Completed Successfully! ===');
}

main().catch(err => {
  console.error('❌ E2E Test Failed:', err);
  process.exit(1);
});
