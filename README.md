# yume-spec

// @why: Keep Why を硬い不変項にする Presence ゲート（決定論的・オフライン）、編集経路からの自動スコープ生成（Auto Hitbox）、および Web UI 健全性検査（yui）を統合
// @tags: SPEC

**AI に「仕様の why をコードの履歴に内蔵させる」規約と、その「存在ゲート（Presence）」・「自動コライダー（Auto Scope）」・「UI健全性」を自動で効かせる拡張パック。**

コード編集のたびに、**その変更の仕様上の由来（why）をコメントとしてコードに残す（Keep Why）** 規約を、AI が毎回確実に認知・実行するようにします。

> 思想の背景: yume-min / ai-desk の不変項「**Delete What, Keep Why**」と「**履歴は本体、最新値は派生**」。
> コード（what）は Scrap & Build で書き直しても、**なぜそうしたか（why）はコード内に残す**。そうすれば未来のどの AI（pi / grok / 別セッション）も、ファイルを開くだけで仕様の変遷を成層状に読める。

---

## 提供ツール（4つの感覚器とゲート）

| ツール / コマンド | 性質 | 何をする | 使うタイミング |
|---|---|---|---|
| **`yspec presence=true`** | 🔒 **硬い決定論ゲート** (オフライン・無料・即座) | `git diff` を検査し、**コード変更があるのに `// @why:` コメントが増えていないファイルを検知して物理ブロック** (exit 1) | コミット前・CI の物理ゲート（Keep Why の不変項強制） |
| **`yspec [path]`** | 👁️ **俯瞰** (read-only) | ソースに内蔵された `// @why:` / `// @tags: SPEC` を一気に俯瞰 | 仕様の由来や変遷を確認したい時 |
| **`yspec [path] check=true`** | 🎯 **仕様の当たり判定（自動コライダー）** | 編集経路・構文スコープ（関数名・クラス名等）からターゲットを自動特定し、新旧 @why 変遷パケットを抽出（作業中LLMが矛盾を判断） | 仕様変更時・デグレ確認 |
| **`yui <path>`** | 📱 **UI 構造・健全性** (Playwright) | Web UI から**ロジカルグラフを自動抽出し、横スクロール・はみ出し・遮蔽・極小タップを検知** | Web UI 作成・編集時のレイアウト検証 |

---

## 1. Keep Why 不変項 Presence ゲート (`yspec presence=true`)

「コードに触れたのに why を書かなかったら落とす」という、**決定的・オフライン・フレークなし・依存ゼロ** の硬い物理ゲートです。

```bash
# 未コミット差分（または HEAD 差分）で @why 欠落がないか検査
yspec presence=true
```

---

## 2. 自動コライダーによる仕様の当たり判定 (`yspec check=true`)

**明示的な `@targets:` 記法を覚える必要はありません。**
コード内の関数定義（`loginUser()`）、クラス名（`PaymentProcessor`）、UIセレクタ（`#login-modal`）などから**自動的に衝突ボックス（ターゲット）を生成**します。

```javascript
export async function loginUser(username, password) {
  // @why: 不正ログイン防止のためトークン認証を必須化
  // @why: 開発環境のテスト簡略化のため未認証アクセスを許可
  return { token: 'mock-token' };
}
```

この状態で `yspec check=true` を叩くだけで、自動的に `loginUser()` スコープ内の仕様変遷パケットが抽出され、作業中のAIが「過去のセキュリティ要件を破壊していませんか？」と気づきを返します。

---

## 3. Web UI E2E テストへの組み込み (`yui` / `assertUIHealthy`)

各 Web プロジェクトの `e2e.mjs` / `test.js` にて、1行で UI 健全性を自動検証できます：

```javascript
import { assertUIHealthy } from 'yume-spec/ui';

// PC 表示 (1280x800) のレイアウト崩れ・横スクロール・遮蔽ゼロを保証
await assertUIHealthy('index.html');

// モバイル表示 (390x844) の検証
await assertUIHealthy('index.html', { mobile: true });
```

---

## テスト実行

```bash
cd yume-spec && node test.mjs
```
