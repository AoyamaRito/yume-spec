// @why: yspec --check（仕様矛盾検知・Spec Collision Checker）。ターゲットごとの新旧 @why 履歴を軽量LLMに渡し、過去の重要要件（再発防止・セキュリティ）のデグレや論理矛盾をCIゲートとして自動検知・ブロックする
// @tags: SPEC

/**
 * collision.js — Spec Collision Checker
 * 
 * ゲーム開発の「当たり判定（コリジョン）」思想に基づき、
 * 同じターゲット（// @targets: xxx または // >>> BLOCK xxx）に属する
 * 複数の @why 仕様変遷を抽出し、軽量LLMで論理矛盾・デグレを自動判定する。
 */

/**
 * ターゲットごとの仕様矛盾を判定する
 * @param {Array<{ target: string, file: string, whys: Array<{ line: number, text: string }> }>} groups 
 * @param {Object} options 
 * @returns {Promise<{ pass: boolean, results: Array<{ target: string, status: 'PASS'|'FAIL', reason?: string }> }>}
 */
export async function checkSpecCollisions(groups, options = {}) {
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = options.baseUrl || process.env.OPENROUTER_BASE_URL || (process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1');
  const model = options.model || process.env.SPEC_CHECK_MODEL || (process.env.OPENROUTER_API_KEY ? 'google/gemini-2.0-flash-001' : 'gpt-4o-mini');

  const results = [];
  let allPass = true;

  for (const g of groups) {
    // why が1件以下のターゲットは衝突（変遷）がないのでスキップ
    if (g.whys.length <= 1) {
      results.push({ target: g.target, file: g.file, status: 'PASS', note: '単一仕様（変遷なし）' });
      continue;
    }

    // モック/テスト用インジェクション
    if (options.evaluator) {
      const res = await options.evaluator(g);
      results.push(res);
      if (res.status === 'FAIL') allPass = false;
      continue;
    }

    if (!apiKey) {
      results.push({
        target: g.target,
        file: g.file,
        status: 'PASS',
        note: 'APIキー未設定のためLLMチェックをスキップ（OPENROUTER_API_KEY または OPENAI_API_KEY を設定してください）',
      });
      continue;
    }

    // LLM プロンプト構築
    const historyText = g.whys.map((w, idx) => {
      const isLatest = idx === g.whys.length - 1;
      const tag = isLatest ? '[最新]' : `[過去(版${idx + 1})]`;
      return `${tag} (L${w.line}) @why: ${w.text}`;
    }).join('\n');

    const systemPrompt = [
      'あなたは仕様のヘルスチェッカー（Spec Collision Checker）です。',
      '提供されたターゲットごとの新旧仕様（@why）の変遷を読み、最新の仕様が過去の重要要件（セキュリティ、再発防止策、前提規約）を意図せず破壊（デグレ）したり、重大な論理矛盾を引き起こしていないか判定してください。',
      '',
      '判定規約:',
      '1. 意図的な前向きの機能追加・リファクタリング・パフォーマンス改善であれば「PASS」と出力してください。',
      '2. 過去に再発防止として導入された制約を理由なく撤廃していたり、論理的な自己矛盾がある場合は「FAIL: <簡潔な理由>」と出力してください。',
      '3. 出力の1行目は必ず「PASS」または「FAIL: <理由>」で始めてください。余計な解説文は不要です。',
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
        results.push({
          target: g.target,
          file: g.file,
          status: 'FAIL',
          reason: `LLM API Error (${resp.status}): ${errBody.slice(0, 200)}`,
        });
        allPass = false;
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
          reason: firstLine.replace(/^FAIL:?\s*/i, '') || '仕様矛盾が検出されました',
          raw: rawAnswer,
        });
        allPass = false;
      } else {
        results.push({
          target: g.target,
          file: g.file,
          status: 'PASS',
          raw: rawAnswer,
        });
      }
    } catch (err) {
      results.push({
        target: g.target,
        file: g.file,
        status: 'FAIL',
        reason: `LLM 接続失敗: ${err.message}`,
      });
      allPass = false;
    }
  }

  return {
    pass: allPass,
    totalGroups: groups.length,
    results,
  };
}
