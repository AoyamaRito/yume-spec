# yume-spec

// @why: Keep Why を硬い不変項にする Presence ゲート（決定論的・オフライン）、仕様整合性 Advisory（PASS/FAIL/SKIP 三分割）、および Web UI 健全性検査（yui）を統合
// @tags: SPEC

**AI に「仕様の why をコードの履歴に内蔵させる」規約と、その「存在ゲート（Presence）」・「仕様整合性（Advisory）」・「UI健全性」を自動で効かせる拡張パック。**

コード編集のたびに、**その変更の仕様上の由来（why）をコメントとしてコードに残す（Keep Why）** 規約を、AI が毎回確実に認知・実行するようにします。

> 思想の背景: yume-min / ai-desk の不変項「**Delete What, Keep Why**」と「**履歴は本体、最新値は派生**」。
> コード（what）は Scrap & Build で書き直しても、**なぜそうしたか（why）はコード内に残す**。そうすれば未来のどの AI（pi / grok / 別セッション）も、ファイルを開くだけで仕様の変遷を成層状に読める。

---

## 提供ツール（4つの感覚器とゲート）

| ツール / コマンド | 性質 | 何をする | 使うタイミング |
|---|---|---|---|
| **`yspec presence=true`** | 🔒 **硬い決定論ゲート** (オフライン・無料・即座) | `git diff` を検査し、**コード変更があるのに `// @why:` コメントが増えていないファイルを検知して物理ブロック** (exit 1) | コミット前・CI の物理ゲート（Keep Why の不変項強制） |
| **`yspec [path]`** | 👁️ **俯瞰** (read-only) | ソースに内蔵された `// @why:` / `// @tags: SPEC` を一気に俯瞰 | 仕様の由来や変遷を確認したい時 |
| **`yspec [path] check=true`** | 💡 **整合性 Advisory** (LLM セカンドオピニオン) | 同一ターゲット（`// @targets:` や `BLOCK`）内の新旧 @why 履歴を比較し、過去要件のデグレや論理矛盾の疑いを報告（PASS / FAIL / SKIP 三分割） | 大きな仕様変更時・方針転換の確認 |
| **`yui <path>`** | 📱 **UI 構造・健全性** (Playwright) | Web UI から**ロジカルグラフを自動抽出し、横スクロール・はみ出し・遮蔽・極小タップを検知** | Web UI 作成・編集時のレイアウト検証 |

---

## 1. Keep Why 不変項 Presence ゲート (`yspec presence=true`)

「コードに触れたのに why を書かなかったら落とす」という、**決定的・オフライン・フレークなし・依存ゼロ** の硬い物理ゲートです。

```bash
# 未コミット差分（または HEAD 差分）で @why 欠落がないか検査
yspec presence=true
```

- コード行（`.js`, `.ts`, `.html` 等）が追加・変更されているのに、その差分内に `// @why:` が 1 件もないファイルがあれば即座に `🚨 FAIL` として終了コード 1 でブロックします。

---

## 2. 仕様整合性 Advisory (`yspec check=true`)

同一ターゲット内の新旧仕様を軽量LLM（OpenRouter / OpenAI）に渡し、過去の再発防止策を意図せず破壊していないかをセカンドオピニオンとして検証します。

- 状態は **PASS（矛盾なし） / FAIL（矛盾警告） / SKIP（APIキー未設定または通信エラー）** に正確に三分割され、ネットワークエラーで CI を不当に落としたり、鍵なしで黙って緑に偽装することはありません。

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
