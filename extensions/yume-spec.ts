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
 * Install: ~/.pi/agent/extensions/yume-spec.ts (global) → pi で /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

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
		if (REASON_RE.test(t)) out.push("    " + t.slice(0, 160));
		else if (SPEC_TAG_RE.test(t)) out.push("    " + t.slice(0, 160));
	}
	return out.slice(0, 8);
}

// ---- 自動認知：yume系プロジェクトで、規約を毎ターンシステムプロンプトに注入する ----
// （スキルはプログレッシブ開示で「読もうとしないと読まれない」。
//   ここは before_agent_start で確実に毎回立ち、モデル依存ゼロで認知させる。）
const RULE = [
	"[yume-min history rule / 規約]",
	"コードを編集・新規作成するとき、その変更の仕様上の由来(why)をコメントでコードに内蔵せよ。",
	"  書式: `// @why: <仕様の由来>（人間の要求 or 設計判断）`  構造意図は `// @tags: SPEC`",
	"Scrap & Build でも @why コメントは絶対に消すな(Delete What, Keep Why)。",
	"履歴は上書きせずappend。これで未来のどのAIもファイルを開くだけで仕様の変遷を読める。",
	"俯瞰: 必要なら `yspec [path]` ツールで全 @why/@tags:SPEC を一気に返せる。",
	"[/yume-min history rule]",
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

// 内蔵 reason マーカー（コメント行に書く）
// - @why:     仕様変更の理由（人間の要求 or AIの設計判断）
// - @spec:    仕様・意図の明示
// - @tags: SPEC  アーキテクチャ上の仕様タグ（ai-desk の // @tags: SPEC に相当）
const REASON_RE = /@(?:why|spec)\s*:\s*(.+)$/i;
const SPEC_TAG_RE = /@tags\s*:\s*([^\s,，]+)/i;
const SRC_RE = /@src\s*:\s*([^\n]+)$/i;

// yume エンブレム境界（所属 BLOCK id の追跡に使用）
const EMBLEM_OPEN_RE = /^\s*(?:\/\/|#|\*)\s*(?:>>>\s+)?BLOCK\s+(\S+)/;
const EMBLEM_CLOSE_RE = /^\s*(?:\/\/|#|\*)\s*<<<\s*\/?BLOCK/;

const EXT_SCAN = new Set([".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".md", ".py", ".go", ".rs", ".rb", ".yume.js"]);

interface Hit {
	file: string; // 相対パス（cwd 基準）
	line: number;
	block: string | null; // 属する BLOCK id
	tags: string;
	reason: string | null;
	raw: string;
}

function scanFile(absFile: string, relFile: string, hits: Hit[]): void {
	let text: string;
	try {
		text = fs.readFileSync(absFile, "utf8");
	} catch {
		return;
	}
	const lines = text.split("\n");
	let block: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const mOpen = line.match(EMBLEM_OPEN_RE);
		const mClose = line.match(EMBLEM_CLOSE_RE);
		if (mOpen) block = mOpen[1];
		else if (mClose) block = null;

		const reason = line.match(REASON_RE)?.[1].trim() ?? null;
		const tag = line.match(SPEC_TAG_RE)?.[1] ?? null;
		if (!reason && !tag) continue;
		hits.push({
			file: relFile,
			line: i + 1,
			block,
			tags: tag ?? "",
			reason,
			raw: line.trim().slice(0, 200),
		});
	}
}

function walkDir(absDir: string, relBase: string, hits: Hit[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(absDir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const e of entries) {
		if (e.name === "node_modules" || e.name === ".git" || e.name === ".yume" || e.name.startsWith(".")) continue;
		const abs = path.join(absDir, e.name);
		const rel = path.join(relBase, e.name);
		if (e.isDirectory()) walkDir(abs, rel, hits);
		else if (EXT_SCAN.has(path.extname(e.name)) || e.name.endsWith(".yume.js")) scanFile(abs, rel, hits);
	}
}

function render(hits: Hit[], showRaw: boolean): string {
	if (hits.length === 0) {
		return "（仕様/why マーカーが見つかりません。編集時は `// @why: <理由>` か `// @tags: SPEC` をコメントで内蔵してください）";
	}
	const out = hits.map((h) => {
		const where = h.block ? `[block:${h.block}]` : "";
		const tag = h.tags ? `@tags:${h.tags} ` : "";
		const reason = h.reason ? `@why: ${h.reason}` : "";
		const raw = showRaw && h.reason === null ? `\n        ↳ ${h.raw}` : "";
		return `${h.file}:${h.line}  ${where} ${tag}${reason}${raw}`;
	});
	return out.join("\n");
}

export default function (pi: ExtensionAPI) {
	// 自動認知：yume系プロジェクトのターンで、規約を毎回システムプロンプトに注入。
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isYumeProject(ctx.cwd)) return; // 無関係プロジェクトにはノイズを足さない
		return { systemPrompt: event.systemPrompt + "\n\n" + RULE };
	});

	pi.registerTool({
		name: "yspec",
		label: "Yume Spec overview",
		description:
			"yume-min -- ソースに内蔵された仕様のwhy（`// @why:` / `// @tags: SPEC`）をファイル順・出現順に一気に返す。単一エンブレムや複数ファイル全体の仕様の変遷を見渡すための俯瞰（read-only）。「なぜこのコードはこうなっているか」を追いたい・仕様変更の履歴を確認したいときに使う。",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "対象のファイル or ディレクトリ（省略時は作業ディレクトリ全体）。例: tatetate_v300/core.js",
				})
			),
			showRaw: Type.Optional(
				Type.Boolean({ description: "理由行でない @tags 付き行の生行も見せる（既定 false）" })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
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
}