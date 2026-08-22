# yume-spec

// @why: yume-spec に仕様矛盾検知（Spec Collision Checker / yspec check=true）および Web UI 健全性検査ツール（yui）を統合
// @tags: SPEC

**AI に「仕様の why をコードの履歴に内蔵させる」規約と「仕様矛盾検知」「UI健全性検査」を、pi.dev に自動で効かせる拡張パック。**

コード編集のたびに、**その変更の仕様上の由来（why）をコメントとしてコードに残す**規約を、AI が毎回確実に認知・実行するようにします。内蔵された `@why` / `@tags:SPEC` / `@targets:` を**一気に俯瞰・矛盾判定**するツール `yspec`、git 履歴と同期した `yhist`、さらに Web UI のレイアウト崩れ・遮蔽を即時検知する `yui` を提供します。

> 思想の背景: yume-min / ai-desk の不変項「**Delete What, Keep Why**」と「**履歴は本体、最新値は派生**」。
> コード（what）は Scrap & Build で書き直しても、**なぜそうしたか（why）はコード内に残す**。そうすれば未来のどの AI（pi / grok / 別セッション）も、ファイルを開くだけで仕様の変遷を成層状に読める。

---

## 提供ツール（3つの感覚器）

| ツール | 何をする | 使うタイミング |
|---|---|---|
| **`yspec [path]`** | ソースに内蔵された `// @why:` / `// @tags: SPEC` を一気に俯瞰（read-only） | なぜこのコードになっているか、仕様の経緯を追いたい時 |
| **`yspec [path] check=true`** | **仕様の当たり判定（Spec Collision Check）**。同一ターゲット内の新旧@whyを軽量LLMで検証し、過去要件のデグレや論理矛盾を自動ブロック | 仕様変更時・コミット前のCIゲート |
| **`yhist <path>`** | 指定ファイルの **git 履歴を、各コミット時点のコードに内蔵された @why と共に time-travel** | 仕様の歴史的変遷を git と同期して遡りたい時 |
| **`yui <path>`** | Web UIから**ロジカルグラフを自動抽出し、はみ出し（overflow）や遮蔽（occlusion）などのUI破綻を即時検知** | Web UIの作成・編集時にレイアウトや操作性を検証する時 |

---

## 仕様の当たり判定（Spec Collision Checker）の使い方

コード内にターゲット（`// @targets: <モジュール名>` または `// >>> BLOCK <モジュール名>`）を記述し、その中で仕様の理由を積層します：

```javascript
// @targets: auth:session
// @why: セキュリティ保護のためトークン認証を必須化（不正ログイン再発防止）
// @why: 実装を簡略化するためトークン認証を全廃し未認証アクセスを許可
```

この状態で `yspec check=true` を実行すると、軽量LLM（OpenRouter / OpenAI）が新旧仕様の当たり判定を行い、過去の重要要件（セキュリティ・再発防止）を破壊している場合は `🚨 FAIL` として物理的にブロックします。

---

## Web UI E2E テストへの組み込み（snowball E2E）

各Webプロジェクトの `e2e.mjs` / `test.js` にて、1行でUI健全性を自動検証できます：

```javascript
import { assertUIHealthy } from 'yume-spec/ui';

// PC表示 (1280x800) のレイアウト崩れ・遮蔽・サイズ縮退ゼロを保証
await assertUIHealthy('index.html');

// モバイル表示 (390x844) の検証
await assertUIHealthy('index.html', { mobile: true });
```

---

## テスト実行

```bash
cd yume-spec && node test.mjs
```
