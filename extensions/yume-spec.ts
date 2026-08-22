/**
 * yume-spec — 履歴に内蔵された「仕様の why」を一気に俯瞰する（yume-min / ai-desk 規約由来）
 *
 * 規約（ai-desk BIBLE:126「履歴は本体」/ :157「SPEEC を versions に埋め込み spec・impl 交互」）:
 *   AI はコードを編集するとき、その変更の仕様上の由来(why)を
 *   「コメント行」としてコードに内蔵せよ:
 *       // @why: 認証をトークン式に変更(ログイン失敗の再発防止)
 *       // @tags: SPEC
 *   Scrap & Build しても why コメントは消さない(Delete What, Keep Why)。
 *   すると未来のどのAIも「ファイルを開くだけで」仕様の変遷を成層状に読める。
 *
 * このツールは、その in-band な spec/why マーカーをファイル順・出現順に
 * 一気に返す =「仕様の変遷の俯瞰」。
 * read-only。既存ツール(git/read/bash)に何も足さず、上の規約だけを実体化する。
 *
 * Install:
 *   - pi パッケージ: pi install ./yume-spec
 *   - グローバルリンク: ln -s /path/to/yume-spec/extensions/yume-spec.ts ~/.pi/agent/extensions/
 *   - 有効化: pi で /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { scanFile, walkDir, groupWhysByTarget, render, type Hit } from "../scan.js";

// ---- git と同期した版履歴（並列ジャーナルは持たない）----
// git を履歴源とし、各コミット時のコードから @why/@tags を抽出して重ねる =
// 「仕様(why) + コード版」の time-travel を、git との単一真実源で実現。
function git(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"], // git の stderr は黙らせる（err は catch で握る）
		}).trim();
	} catch {
		return null;
	}
}

// その版のコードに内蔵された spec/why 行だけを取り出す（本文は返さない・軽い）
function specLinesFrom(text: string): string[] {
	const out: string[] = [];
	for (const l of text.split("\n")) {
		const t = l.trim();
		if (COMMENT_LINE_RE.test(t)) out.push("    " + t.slice(0, 160));
	}
	return out.slice(0, 8);
}

// ---- 自動認知：yume系プロジェクトで、規約を毎ターンシステムプロンプトに注入する ----
// @why: yume-min 履歴規約に加え、e2e snowball 検証規約(Evidence over Claims)、Web UI検証(yui)、および決定論的 Presence ゲート(yspec presence=true)を自動注入に追加。
//       モデル依存ゼロで毎ターン認知させ、デグレ防止・UI崩れ防止と自己完結検証を強制する。
// @tags: SPEC
const RULE = [
	"[yume-min history & verification rule / 規約]",
	"1. [why-in-band 規約] コード編集・作成時、仕様の由来(why)をコメントでコードに内蔵せよ（必須不変項）。",
	"   書式: `// @why: <仕様の由来>（人間の要求 or 設計判断）`  構造意図は `// @tags: SPEC` または `// @targets: <モジュール名>`",
	"   Scrap & Build でも @why コメントは消すな(Delete What, Keep Why)。過去を失わずappend積層。",
	"2. [snowball E2E & Evidence 規約]",
	"   機能を変更・追加したら、必ず e2e.mjs / test.js に snowball セクションを末尾追記し、最初から通しで全件PASSさせよ。",
	"   コード変更後は、`yspec presence=true` で @why 欠落ゼロを決定論的検証せよ。",
	"   Web UIを変更・作成した場合は、`yui` ツールでレイアウト崩れ・遮蔽エラー0件を検証せよ。",
	"   主張(Claims)ではなく、実機テストの全PASSログ(Evidence)のみを完了・報告の根拠とせよ。",
	"俯瞰: `yspec [path]`（仕様why俯瞰）, `yspec presence=true`（@why存在ゲート）, `yspec check=true`（仕様矛盾検査）, `yhist [path]`（版履歴）, `yui [path]`（UI健全性検査）",
	"[/yume-min 規約]",
].join("\n");
const YUME_SENTINEL = "yume-min 履歴規約";
let sentinelCache: { cwd: string; hit: boolean } | null = null;

// cwd から git ルート / 祖先へ遡って、規約センチネル入り AGENTS.md か .pi/yume-min マーカーを探す。
function isYumeProject(cwd: string): boolean {
	if (sentinelCache && sentinelCache.cwd === cwd) return sentinelCache.hit;
	let hit = false;
	let dir = cwd;
	const seen = new Set<string>();
	for (let i = 0; i < 8; i++) {
		if (seen.has(dir) || !dir) break;
		seen.add(dir);
		// 1) .pi/yume-min マーカー（明示オプトイン）
		for (const marker of [path.join(dir, ".pi", "yume-min"), path.join(dir, ".yume-min")]) {
			try { if (fs.statSync(marker).isFile()) { hit = true; break; } } catch {}
		}
		// 2) AGENTS.md に規約センチネル（自動オプトイン）
		if (!hit) {
			try {
				const s = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
				if (s.includes(YUME_SENTINEL)) hit = true;
			} catch {}
		}
		if (hit) break;
		const parent = path.dirname(dir);
		if (parent === dir) break; // ルート到達
		dir = parent;
	}
	sentinelCache = { cwd, hit };
	return hit;
}

// 内蔵 reason マーカーの抽出とターゲットグルーピングは ../scan.js に委譲
// @tags: SPEC

export default function (pi: ExtensionAPI) {
	// 自動認知：yume系プロジェクトのターンで、規約を毎回システムプロンプトに注入。
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isYumeProject(ctx.cwd)) return; // 無関係プロジェクトにはノイズを足さない
		return { systemPrompt: event.systemPrompt + "\n\n" + RULE };
	});

	pi.registerTool({
		name: "yspec",
		label: "Yume Spec overview & presence/collision checker",
		description:
			"yume-min -- ソースに内蔵された仕様のwhy（`// @why:` / `// @tags: SPEC` / `// @targets:`）をファイル順・出現順に一気に返す。`presence: true` でコード変更に対する @why の存在を決定論的検証（硬い物理ゲート）。`check: true` で同一ターゲット内の新旧仕様変遷パケットを抽出し、作業中LLMに整合性判断用レポートを提示する。",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "対象のファイル or ディレクトリ（省略時は作業ディレクトリ全体）。例: tatetate_v300/core.js",
				})
			),
			showRaw: Type.Optional(
				Type.Boolean({ description: "理由行でない @tags 付き行の生行も見せる（既定 false）" })
			),
			presence: Type.Optional(
				Type.Boolean({
					description: "【硬い不変項ゲート】コード変更があるのに @why コメントが追加されていないファイルを git diff から決定論的に検出しブロックする（既定 false）",
				})
			),
			check: Type.Optional(
				Type.Boolean({
					description: "【仕様変遷パケット抽出】同一ターゲット内の新旧@why仕様変遷を抽出し、作業中LLMが論理矛盾やデグレを判断するためのレポートを出力する（既定 false）",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;

			// @why: Keep Why を invariant にする決定論的 Presence ゲート。git diff を見て @why 欠落があれば即物理ブロック
			// @tags: SPEC
			if (params.presence) {
				const { checkWhyPresence } = await import("../presence.js");
				const presResult = checkWhyPresence({ cwd });

				const reportLines = [
					"====================================================",
					`🔒 SPEC PRESENCE GATE (Keep Why 不変項検証)`,
					`   Status: ${presResult.pass ? "✅ PASS (All changed files have @why)" : "🚨 FAIL (Missing @why in changed code)"}`,
					`   Total Changed Files: ${presResult.totalFiles}`,
					"====================================================",
				];

				if (presResult.violations.length === 0) {
					reportLines.push(presResult.note || "✨ すべてのコード変更に仕様の由来（// @why:）が正しく内蔵されています。");
				} else {
					presResult.violations.forEach((v, idx) => {
						reportLines.push(`\n${idx + 1}. 🚨 [MISSING_WHY] ${v.file}`);
						reportLines.push(`   詳細: ${v.message}`);
					});
				}

				return {
					content: [{ type: "text", text: reportLines.join("\n") }],
					details: { pass: presResult.pass, violations: presResult.violations },
				};
			}

			const target = params.path ?? ".";
			const absTarget = path.isAbsolute(target) ? target : path.resolve(cwd, target);
			const hits: Hit[] = [];
			let stat: fs.Stats;
			try {
				stat = fs.statSync(absTarget);
			} catch {
				return {
					content: [{ type: "text", text: `エラー: パスが見つかりません — ${target}` }],
					details: {},
				};
			}

			if (stat.isFile()) {
				const rel = path.relative(cwd, absTarget);
				scanFile(absTarget, rel || target, hits);
			} else if (stat.isDirectory()) {
				walkDir(absTarget, path.relative(cwd, absTarget) || ".", hits);
			}

			// @why: 仕様変遷・整合性判断パケット抽出（Spec Collision Report）。同一ターゲット内の新旧仕様を抽出し、作業中LLMに判断用レポートとして提示
			// @tags: SPEC
			if (params.check) {
				const { extractCollisionReport } = await import("../collision.js");
				const groups = groupWhysByTarget(hits);
				const collisionResult = extractCollisionReport(groups);

				return {
					content: [{ type: "text", text: collisionResult.report }],
					details: {
						hasMultiSpecs: collisionResult.hasMultiSpecs,
						totalTargets: collisionResult.totalTargets,
						multiSpecCount: collisionResult.multiSpecTargets.length,
						multiSpecTargets: collisionResult.multiSpecTargets,
					},
				};
			}

			const text = render(hits, params.showRaw ?? false);
			const n = hits.length;
			return {
				content: [{ type: "text", text: `spec/why マーカー ${n} 件（${stat.isDirectory() ? "ディレクトリ" : "ファイル"}）:\n\n${text}` }],
				details: { count: n },
			};
		},
	});

	// git と同期した仕様履歴の time-travel（read-only）。
	pi.registerTool({
		name: "yhist",
		label: "Yume spec history (git-synced)",
		description:
			"yume-min -- 指定ファイル/ディレクトリの git 履歴を、各コミット時点のコードに内蔵された@why/@tags:SPECと共に遡る（read-only）。ファイルなら「◆コミット 日付 件名」に続いてその版の@whyを表示。仕様+コードの変遷を一気に time-travel でき、git と同期（並列の版倉は作らない）。非git プロジェクトでは代わりに `yspec` を使う。",
		parameters: Type.Object({
			path: Type.String({ description: "git管理下のファイル（推奨） or ディレクトリ。例: tatetate_v300/core.js" }),
			limit: Type.Optional(
				Type.Number({ description: "遡るコミット数（既定20、最大100）", minimum: 1, maximum: 100 })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const target = path.resolve(cwd, params.path);
			const isFile = (() => { try { return fs.statSync(target).isFile(); } catch { return false; } })();
			// リポジトリ判定は対象自身のディレクトリ起点（ネストされた独立repo対応）
			const repoRoot = git(["rev-parse", "--show-toplevel"], isFile ? path.dirname(target) : target);
			if (!repoRoot || !repoRoot.trim()) {
				return {
					content: [{ type: "text", text: "git リポジトリではありません。`yspec [path]` で現状の@why俯瞰をどうぞ。" }],
					details: {},
				};
			}
			const repo = repoRoot.trim();
			const rel = path.relative(repo, target);
			const limit = params.limit ?? 20;

			const logArgs = ["log", "--format=%h%x09%ad%x09%s", "--date=short", "-n", String(limit)];
			if (isFile) logArgs.push("--follow");
			logArgs.push("--", rel);
			const log = git(logArgs, repo);
			if (!log || !log.trim()) {
				return { content: [{ type: "text", text: `履歴なし: ${params.path}` }], details: {} };
			}

			const commits = log.split("\n").filter(Boolean);
			const out: string[] = [`git履歴 ${commits.length} 件 ／ ${params.path}（@why/@tags を各コミットで抽出）:`];
			for (const line of commits) {
				const [short, date, subj] = line.split("\t");
				out.push("\n◆ " + short + "  " + date + "  " + (subj || ""));
				if (isFile) {
					const content = git(["show", `${short}:${rel}`], repo);
					if (content != null) for (const s of specLinesFrom(content)) out.push(s);
				}
			}
			return {
				content: [{ type: "text", text: out.join("\n") }],
				details: { count: commits.length },
			};
		},
	});

	// Web UI のロジカルグラフ・レイアウト崩れ・遮蔽検査（read-only）。
	pi.registerTool({
		name: "yui",
		label: "Yume UI Health & Graph inspector",
		description:
			"yume-min -- Web UI（HTMLファイルまたはURL）からロジカルグラフ（包含/スタック/遮蔽/A11y）を自動抽出し、はみ出し（overflow）・ボタン遮蔽（occlusion）・極小タップ領域・ゼロサイズ縮退などのレイアウト破綻を即時検出し合否判定する（read-only）。Web UIの作成・編集時に自律検証するために使う。",
		parameters: Type.Object({
			path: Type.String({ description: "対象のHTMLファイルパス（相対または絶対）またはURL。例: index.html または http://localhost:3000" }),
			mobile: Type.Optional(Type.Boolean({ description: "モバイル画面（390x844）でテストするか（既定 false: 1280x800）" })),
			format: Type.Optional(
				Type.String({
					description: "出力フォーマット: 'tree'（階層ツリー+異常マーク）, 'scan'（異常サマリーのみ）, 'mermaid'（グラフ図）, 'json'（完全データ）。既定: 'tree'",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const target = params.path;
			const isMobile = params.mobile ?? false;
			const format = params.format ?? "tree";

			try {
				const { runUIGraph, renderTree, renderAnomalies, renderMermaid } = await import("../ui/index.js");
				const graph = await runUIGraph(target, { mobile: isMobile, cwd });

				let outText = "";
				if (format === "json") {
					outText = JSON.stringify(graph, null, 2);
				} else if (format === "mermaid") {
					outText = renderMermaid(graph);
				} else if (format === "scan") {
					outText = renderAnomalies(graph);
				} else {
					// 既定: tree
					outText = renderTree(graph) + "\n\n" + renderAnomalies(graph);
				}

				return {
					content: [{ type: "text", text: outText }],
					details: {
						pass: graph.summary.pass,
						errors: graph.summary.errorCount,
						warnings: graph.summary.warnCount,
						nodes: graph.summary.totalNodes,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `yui 実行エラー: ${err.message}` }],
					details: { error: err.message },
				};
			}
		},
	});
}