# yume-spec

**AI に「仕様の why をコードの履歴に内蔵させる」規約を、pi.dev に自動で効かせる拡張パック。**

コード編集のたびに、**その変更の仕様上の由来（why）をコメントとしてコードに残す**規約を、AI が毎回確実に認知・実行するようにします。そして、内蔵された `@why` / `@tags:SPEC` を**ファイル順・出現順に一気に俯瞰**する read-only ツール `yspec` を追加します。

> 思想の背景: yume-min / ai-desk の不変項「**Delete What, Keep Why**」と「**履歴は本体、最新値は派生**」。
> コード（what）は Scrap & Build で書き直しても、**なぜそうしたか（why）はコード内に残す**。そうすれば未来のどの AI（pi / grok / 別セッション）も、ファイルを開くだけで仕様の変遷を成層状に読める。

---

## 何をするか（3つ、既存ツールには手を入れない）

1. **自動注入**: yume 系プロジェクトで **毎ターン**、システムプロンプトへ規約を注入（`before_agent_start`）。スキルと違い「AI が読もうと思わないと読まれない」問題が無く、**モデルの意志に依存せず確実に認知**します。
2. **`yspec` 俯瞰ツール**: ソースに内蔵された `// @why:` / `// @tags: SPEC` を、属する BLOCK と共に一気に返します（read-only・既存ツールと衝突しない）。
3. **`yhist` 仕様履歴（git と同期）**: 指定ファイルの **git 履歴を、各コミット時点のコードに内蔵された @why と共に time-travel** で返します。並列の版倉は持たず、**git を履歴源**としてそこに @why を重ねます（単一真実源を守る）。ネストされた独立リポジトリにも、対象自身の単位で正しく解決します。

---

## インストール

### 方法 A（もっとも簡単・単一ユーザ）

バイナリ不要。`extensions/yume-spec.ts` を1ファイルコピーするだけ：

```bash
cp extensions/yume-spec.ts ~/.pi/agent/extensions/   # global（全プロジェクト）
# もしくは project 限定: .pi/extensions/ に置く
```

このまま pi を開いて `/reload`。

### 方法 B（pi パッケージとして・チーム/配布）

```bash
# ローカルパス
pi install ./yume-spec
# or git（公開後）
pi install git:github.com/あなた/repo
# or npm（公開後）
pi install npm:yume-spec

# プロジェクト(.pi/settings.json)に書くなら
pi install -l ./yume-spec
```

チームの `.pi/settings.json` にパッケージを書けば、**プロジェクト起動時に他メンバーへ自動で入ります**。

この後も `/reload`。

---

## 使い方

```bash
/reload                          # 有効化

# 俯瞰（read-only）
yspec                            # 作業ディレクトリ全体の @why/@tags:SPEC を一括
yspec tatetate_v300/core.js      # 特定ファイル
yspec path/to/ --showRaw         # @tags のみの行の生文も表示

# 仕様履歴（git と同期・time-travel）
yhist tatetate_v300/core.js      # そのファイルの git 履歴を @why と共に遡る
yhist path/to/file --limit 50    # 遡るコミット数（既定20・最大100）
```

`yhist` は**各コミット時点のコードから内蔵 @why を抽出**して重ねます。@why 無しの古いコミットは件名行だけ表示されます（「仕様を書き始めたのはいつか」がわかる）。ネストされた独立 git リポジトリ内のファイルでも、対象自身のリポジトリを正しく使います。

書き方は、編集時にコメントとして内蔵するだけ（例: `examples/sample.js`）:

```js
// @why: 認証方式をセッション式 → トークン式に変更（不正ログイン再発防止）
// @tags: SPEC
function login(db, token) { ... }
```

---

## 有効化の対象（auto-inject が効くプロジェクト）

規約が**どのプロジェクトでも効く**ように、yume 系プロジェクトだけに限定しています（無関係な作業へノイズを足さないため）。どちらかでオプトイン：

| 方法 | 仕組み |
|---|---|
| **自動** | プロジェクトの `AGENTS.md` に `yume-min 履歴規約` という文字列が入っていれば有効 |
| **明示** | プロジェクト直下に `.pi/yume-min`（空で良い）か `.yume-min` ファイルを置く |

---

## 定着のさせ方（推奨）

ツールだけでなく、**各プロジェクトの AGENTS.md に規約を1節載せる**と定着しやすい：

```
## yume-min 履歴規約 (why-in-band)
- コードを編集するとき、変更の仕様上の由来をコメントで内蔵する: `// @why: <理由>`
- 構造レベルの意図は `// @tags: SPEC`
- Scrap & Build でも @why は消すな（Delete What, Keep Why）
- 俯瞰したいときは `yspec [path]`
```

この節が「自動オプトイン」の判定にも使われます。

---

## アンインストール

```bash
# pi パッケージ経由なら
pi remove yume-spec
# 手動コピー経由なら
rm ~/.pi/agent/extensions/yume-spec.ts
# 明示マーカーを足した場合
rm .pi/yume-min
```

その後 `/reload`。

---

## 制限（正直に）

- **読み取れるのは「既に @why が書かれたコード」だけ**。既存の履歴の無いコードには最初は空を返します。価値はこれから、編集のたびに蓄積されます。
- 1ターンあたり約230トークンを yume 系プロジェクトで消費します（確実な認知と引き換え）。
- **コード本体の版は git が履歴源**。本拡張はそこに @why を重ねて time-travel できるようにし（`yhist`）、git と役割分担・重複しません。非 git 領域では `yspec` の現状俯瞰だけが使えます。
- read-only。組み込みの `read`/`edit`/`bash` を置き換えません。

---

## LICENSE

MIT