// @why: Spec Collision Checker（仕様整合性のセカンドオピニオン・Advisory）。状態を明確に PASS / FAIL / SKIP に三分割し、API未設定やネットワーク例外を偽の緑や赤にせず正確に報告する
// @tags: SPEC

/**
 * collision.js — Spec Collision Checker (Advisory)
 * 
 * 同じターゲット（// @targets: xxx または // >>> BLOCK xxx）に属する
 * 複数の @why 仕様変遷を抽出し、軽量LLMで論理矛盾・デグレの疑いをアドバイザリとして報告する。
 * 
 * 状態の三分割:
 * - PASS: 判定成功・仕様変遷に矛盾なし
 * - FAIL: 判定成功・過去の再発防止要件の破壊や論理矛盾を検出（Advisory警告）
 * - SKIP: APIキー未設定、またはネットワーク/レート制限により判定不能（判定失敗をPASS/FAILと偽装しない）
 */

/**
 * ターゲットごとの仕様矛盾を判定する
 * @param {Array<{ target: string, file: string, whys: Array<{ line: number, text: string }> }>} groups 
 * @param {Object} options 
 * @returns {Promise<{ pass: boolean, summary: { total: number, passCount: number, failCount: number, skipCount: number }, results: Array<{ target: string, file: string, status: 'PASS'|'FAIL'|'SKIP', reason?: string, note?: string }> }>}
 */
export async function checkSpecCollisions(groups, options = {}) {
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl || process.env.OPENROUTER_BASE_URL || (process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1');
  const model = options.model || process.env.SPEC_CHECK_MODEL || (process.env.OPENROUTER_API_KEY ? 'google/gemini-2.0-flash-001' : 'gpt-4o-mini');

  const results = [];
  let failCount = 0;
  let passCount = 0;
  let skipCount = 0;

  for (const g of groups) {
    // why が1件以下のターゲットは変遷がないのでスキップ（正常完了）
    if (g.whys.length <= 1) {
      results.push({ target: g.target, file: g.file, status: 'PASS', note: '単一仕様（変遷なし）' });
      passCount++;
      continue;
    }

    // モック/テスト用インジェクション
    if (options.evaluator) {
      const res = await options.evaluator(g);
      results.push(res);
      if (res.status === 'FAIL') failCount++;
      else if (res.status === 'SKIP') skipCount++;
      else passCount++;
      continue;
    }

    // APIキーがない場合は PASS と偽装せず、明確に SKIP とする
    if (!apiKey) {
      results.push({
        target: g.target,
        file: g.file,
        status: 'SKIP',
        note: 'APIキー未設定のためLLMアドバイザリをスキップ (OPENROUTER_API_KEY または OPENAI_API_KEY を設定してください)',
      });
      skipCount++;
      continue;
    }

    // LLM プロンプト構築
    const historyText = g.whys.map((w, idx) => {
      const isLatest = idx === g.whys.length - 1;
      const tag = isLatest ? '[最新]' : `[過去(版${idx + 1})]`;
      return `${tag} (L${w.line}) @why: ${w.text}`;
    }).join('\n');

    const systemPrompt = [
      'あなたは仕様のセカンドオピニオン（Spec Collision Advisory）です。',
      '提供されたターゲットごとの新旧仕様（@why）の変遷を読み、最新の仕様が過去の重要要件（セキュリティ、再発防止策、前提規約）を意図せず破壊（デグレ）したり、重大な論理矛盾を引き起こしていないか判定してください。',
      '',
      '判定規約:',
      '1. 意図的な前向きの機能追加・リファクタリング・パフォーマンス改善であれば「PASS」と出力してください。',
      '2. 過去に再発防止として導入された制約を理由なく撤廃していたり、論理的な自己矛盾がある場合は「FAIL: <簡潔な理由>」と出力してください。',
      '3. 出力の1行目は必ず「PASS」または「FAIL: <理由>」で始めてください。',
    ].join('\n');

    const userPrompt = `【対象ターゲット: ${g.target}】 (${g.file})\n仕様変遷履歴:\n${historyText}`;

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        // ネットワーク/クォータエラーは FAIL（仕様破壊）と偽装せず、SKIP として扱う
        results.push({
          target: g.target,
          file: g.file,
          status: 'SKIP',
          note: `LLM API 通信失敗 (${resp.status}): ${errBody.slice(0, 150)}`,
        });
        skipCount++;
        continue;
      }

      const data = await resp.json();
      const rawAnswer = data.choices?.[0]?.message?.content?.trim() || '';
      const firstLine = rawAnswer.split('\n')[0].trim();

      if (firstLine.toUpperCase().startsWith('FAIL')) {
        results.push({
          target: g.target,
          file: g.file,
          status: 'FAIL',
          reason: firstLine.replace(/^FAIL:?\s*/i, '') || '仕様矛盾の疑いがあります',
          raw: rawAnswer,
        });
        failCount++;
      } else {
        results.push({
          target: g.target,
          file: g.file,
          status: 'PASS',
          raw: rawAnswer,
        });
        passCount++;
      }
    } catch (err) {
      // ネットワーク例外も SKIP として安全に報告
      results.push({
        target: g.target,
        file: g.file,
        status: 'SKIP',
        note: `LLM 接続例外: ${err.message}`,
      });
      skipCount++;
    }
  }

  return {
    pass: failCount === 0,
    summary: {
      total: groups.length,
      passCount,
      failCount,
      skipCount,
    },
    results,
  };
}
