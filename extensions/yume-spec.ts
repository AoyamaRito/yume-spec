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
 *   - 単一ファイルコピー: cp extensions/yume-spec.ts ~/.pi/agent/extensions/
 *   - 有効化: pi で /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ---- git と同期した版履歴（並列ジャーナルは持たない）----
function git(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

// ---- 内蔵 reason マーカー（コメント行に書く）----
// @why: 文字列リテラルや説明文内の「@why」誤検知を防ぐため、コメント接頭辞（//, *, #, <!--, --）直後のマーカーのみを対象にする
// @tags: SPEC
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|#|<!--|--)\s*@(why|spec|tags|targets?)\b/i;
const REASON_RE = /@(?:why|spec)\s*:\s*(.+)$/i;
const SPEC_TAG_RE = /@tags\s*:\s*([^\s,，]+)/i;
const TARGET_TAG_RE = /@targets?\s*:\s*([^\s,，]+)/i;

// yume エンブレム境界（所属 BLOCK id の追跡に使用）
const EMBLEM_OPEN_RE = /^\s*(?:\/\/|#|\*)\s*(?:>>>\s+)?BLOCK\s+(\S+)/;
const EMBLEM_CLOSE_RE = /^\s*(?:\/\/|#|\*)\s*<<<\s*\/?BLOCK/;

const EXT_SCAN = new Set([".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".md", ".py", ".go", ".rs", ".rb", ".html", ".yume.js"]);

/**
 * 構文シグネチャから現在のスコープ名を自動判定する正規表現群
 */
const SCOPE_PATTERNS = [
	/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z0-9_$]+)\s*\(/,
	/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/,
	/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?function/,
	/^\s*(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/,
	/^\s*(?:(?:public|private|protected|static|async)\s+)*([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
	/^\s*(?:test|describe|it)\s*\(\s*['"`]([^'"`]+)['"`]/,
	/^\s*<([a-zA-Z0-9_-]+)(?:\s+[^>]*?(?:id=['"]([^'"]+)['"]|class=['"]([^'"]+)['"]))?[^>]*>/,
	/^\s*([.#]?[a-zA-Z0-9_:-]+(?:\s*,\s*[.#]?[a-zA-Z0-9_:-]+)*)\s*\{/,
];

function extractScopeName(line: string): string | null {
	const trimmed = line.trim();
	if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--")) return null;

	let m = trimmed.match(SCOPE_PATTERNS[0]);
	if (m) return `${m[1]}()`;
	m = trimmed.match(SCOPE_PATTERNS[1]);
	if (m) return `${m[1]}()`;
	m = trimmed.match(SCOPE_PATTERNS[2]);
	if (m) return `${m[1]}()`;
	m = trimmed.match(SCOPE_PATTERNS[3]);
	if (m) return `class ${m[1]}`;
	m = trimmed.match(SCOPE_PATTERNS[5]);
	if (m) return `test("${m[1]}")`;
	m = trimmed.match(SCOPE_PATTERNS[4]);
	if (m && !["if", "for", "while", "switch", "catch"].includes(m[1])) return `${m[1]}()`;
	m = trimmed.match(SCOPE_PATTERNS[6]);
	if (m) {
		const tag = m[1];
		const id = m[2];
		const cls = m[3] ? m[3].split(" ")[0] : null;
		if (id) return `<${tag}#${id}>`;
		if (cls) return `<${tag}.${cls}>`;
		return `<${tag}>`;
	}
	m = trimmed.match(SCOPE_PATTERNS[7]);
	if (m && !trimmed.startsWith("@")) return m[1].trim();

	return null;
}

export interface Hit {
	file: string;
	line: number;
	block: string | null;
	tags: string;
	reason: string | null;
	raw: string;
}

export function scanFile(absFile: string, relFile: string, hits: Hit[]): void {
	let text: string;
	try {
		text = fs.readFileSync(absFile, "utf8");
	} catch {
		return;
	}
	const lines = text.split("\n");
	let block: string | null = null;
	const scopeStack: Array<{ name: string; line: number }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const mOpen = line.match(EMBLEM_OPEN_RE);
		const mClose = line.match(EMBLEM_CLOSE_RE);
		if (mOpen) block = mOpen[1];
		else if (mClose) block = null;

		const detectedScope = extractScopeName(line);
		if (detectedScope) {
			scopeStack.push({ name: detectedScope, line: i + 1 });
			if (scopeStack.length > 3) scopeStack.shift();
		}

		const trimmed = line.trim();
		if (!COMMENT_LINE_RE.test(trimmed)) continue;

		const targetMatch = line.match(TARGET_TAG_RE);
		const explicitTarget = targetMatch ? targetMatch[1] : null;

		const reason = line.match(REASON_RE)?.[1].replace(/-->\s*$/, "").trim() ?? null;
		const tag = line.match(SPEC_TAG_RE)?.[1].replace(/-->\s*$/, "").trim() ?? null;
		if (!reason && !tag && !explicitTarget) continue;

		let target = explicitTarget || block;
		if (!target && scopeStack.length > 0) {
			const currentScope = scopeStack[scopeStack.length - 1].name;
			target = `${relFile}#${currentScope}`;
		}

		hits.push({
			file: relFile,
			line: i + 1,
			block: target,
			tags: tag ?? "",
			reason,
			raw: trimmed.slice(0, 200),
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

export function groupWhysByTarget(hits: Hit[]) {
	const groups = new Map<string, { target: string; file: string; whys: Array<{ line: number; text: string }> }>();
	for (const h of hits) {
		if (!h.reason) continue;
		const targetKey = h.block || (h.tags && h.tags !== "SPEC" ? `${h.file}@${h.tags}` : null);
		if (!targetKey) continue;

		if (!groups.has(targetKey)) {
			groups.set(targetKey, { target: targetKey, file: h.file, whys: [] });
		}
		groups.get(targetKey)!.whys.push({ line: h.line, text: h.reason });
	}
	return Array.from(groups.values());
}

function render(hits: Hit[], showRaw: boolean): string {
	if (hits.length === 0) {
		return "（仕様/why マーカーが見つかりません。編集時は `// @why: <理由>` か `// @tags: SPEC` をコメントで内蔵してください）";
	}
	const out = hits.map((h) => {
		const where = h.block ? `[target:${h.block}]` : "";
		const tag = h.tags ? `@tags:${h.tags} ` : "";
		const reason = h.reason ? `@why: ${h.reason}` : "";
		const raw = showRaw && h.reason === null ? `\n        ↳ ${h.raw}` : "";
		return `${h.file}:${h.line}  ${where} ${tag}${reason}${raw}`;
	});
	return out.join("\n");
}

function specLinesFrom(text: string): string[] {
	const out: string[] = [];
	for (const l of text.split("\n")) {
		const t = l.trim();
		if (COMMENT_LINE_RE.test(t)) out.push("    " + t.slice(0, 160));
	}
	return out.slice(0, 8);
}

// @why: 決定論的 Presence ゲートのインライン実装
// @tags: SPEC
function checkWhyPresenceInline(cwd: string) {
	let diff = git(["diff", "HEAD"], cwd);
	if (diff == null || diff === "") {
		diff = git(["diff", "--cached"], cwd) || git(["diff"], cwd) || "";
	}
	if (!diff || !diff.trim()) {
		return { pass: true, totalFiles: 0, violations: [], note: "検査対象の差分がありません（クリーン）" };
	}

	const lines = diff.split("\n");
	const files: Array<{ file: string; addedLines: string[] }> = [];
	let currentFile: { file: string; addedLines: string[] } | null = null;

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			const parts = line.split(" ");
			const bPath = parts[parts.length - 1] || "";
			const cleanPath = bPath.replace(/^[ab]\//, "");
			currentFile = { file: cleanPath, addedLines: [] };
			files.push(currentFile);
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			if (currentFile) currentFile.addedLines.push(line.slice(1));
		}
	}

	const violations: Array<{ file: string; message: string }> = [];
	for (const f of files) {
		const ext = path.extname(f.file);
		if (!EXT_SCAN.has(ext) && !f.file.endsWith(".yume.js")) continue;

		let addedCodeLines = 0;
		let whyLinesAdded = 0;
		for (const line of f.addedLines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (COMMENT_LINE_RE.test(trimmed) && REASON_RE.test(trimmed)) {
				whyLinesAdded++;
			} else {
				addedCodeLines++;
			}
		}

		if (addedCodeLines > 0 && whyLinesAdded === 0) {
			violations.push({
				file: f.file,
				message: `コード変更が ${addedCodeLines} 行あるのに、仕様の由来を示す // @why: コメントが追加されていません`,
			});
		}
	}

	return { pass: violations.length === 0, totalFiles: files.length, violations };
}

// @why: Spec Collision Report 生成のインライン実装
// @tags: SPEC
function extractCollisionReportInline(groups: Array<{ target: string; file: string; whys: Array<{ line: number; text: string }> }>) {
	const multiSpecTargets: Array<{ target: string; file: string; count: number; whys: Array<{ line: number; text: string; isLatest: boolean }> }> = [];
	for (const g of groups) {
		if (g.whys.length > 1) {
			multiSpecTargets.push({
				target: g.target,
				file: g.file,
				count: g.whys.length,
				whys: g.whys.map((w, idx) => ({
					line: w.line,
					text: w.text,
					isLatest: idx === g.whys.length - 1,
				})),
			});
		}
	}

	const lines = [
		"====================================================",
		`📋 SPEC COLLISION REPORT (仕様変遷・整合性判断パケット)`,
		`   判定対象ターゲット: ${groups.length} 件 (仕様変遷あり: ${multiSpecTargets.length} 件)`,
		"====================================================",
	];

	if (multiSpecTargets.length === 0) {
		lines.push("\n✨ 複数世代の仕様が積層しているターゲットはありません（全ターゲット単一仕様）。");
	} else {
		lines.push("\n💡 以下のターゲットで新旧の仕様（@why）が積層しています。");
		lines.push("   作業中LLMは、最新の仕様が過去の重要要件（セキュリティ・再発防止策）を意図せず破壊（デグレ）していないか確認してください:\n");

		multiSpecTargets.forEach((t, i) => {
			lines.push(`${i + 1}. [ターゲット: ${t.target}] (${t.file}) — ${t.count} 世代の仕様:`);
			t.whys.forEach((w, idx) => {
				const isLatest = w.isLatest;
				const prefix = idx === t.whys.length - 1 ? "   └─" : "   ├─";
				const tag = isLatest ? "🔥 [最新]" : `📜 [過去(版${idx + 1})]`;
				lines.push(`${prefix} ${tag} (L${w.line}) @why: ${w.text}`);
			});
			lines.push("");
		});
	}

	return {
		hasMultiSpecs: multiSpecTargets.length > 0,
		totalTargets: groups.length,
		multiSpecTargets,
		report: lines.join("\n"),
	};
}

// ---- 自動認知：yume系プロジェクトで、規約を毎ターンシステムプロンプトに注入する ----
// @why: yume-min 履歴規約に加え、e2e snowball 検証規約(Evidence over Claims)、Web UI検証(yui)、および決定論的 Presence ゲート(yspec presence=true)を自動注入に追加。
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

function isYumeProject(cwd: string): boolean {
	if (sentinelCache && sentinelCache.cwd === cwd) return sentinelCache.hit;
	let hit = false;
	let dir = cwd;
	const seen = new Set<string>();
	for (let i = 0; i < 8; i++) {
		if (seen.has(dir) || !dir) break;
		seen.add(dir);
		for (const marker of [path.join(dir, ".pi", "yume-min"), path.join(dir, ".yume-min")]) {
			try { if (fs.statSync(marker).isFile()) { hit = true; break; } } catch {}
		}
		if (!hit) {
			try {
				const s = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
				if (s.includes(YUME_SENTINEL)) hit = true;
			} catch {}
		}
		if (hit) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	sentinelCache = { cwd, hit };
	return hit;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isYumeProject(ctx.cwd)) return;
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

			// 1. Presence Gate
			if (params.presence) {
				const presResult = checkWhyPresenceInline(cwd);
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

			// 2. Spec Collision Check
			if (params.check) {
				const groups = groupWhysByTarget(hits);
				const collisionResult = extractCollisionReportInline(groups);

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
				// 実体パスから ui/index.js を安全に探索して動的インポート
				let uiModule: any = null;
				const candPaths = [
					path.resolve(cwd, "yume-spec/ui/index.js"),
					path.resolve(cwd, "ui/index.js"),
					path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui/index.js"),
					path.resolve(fs.realpathSync(fileURLToPath(import.meta.url)), "../../ui/index.js"),
				];
				for (const cand of candPaths) {
					if (fs.existsSync(cand)) {
						uiModule = await import(`file://${cand}`);
						break;
					}
				}

				if (!uiModule) {
					return {
						content: [{ type: "text", text: "yui 実行エラー: yume-spec/ui/index.js が見つかりません。リポジトリ全体を保持するか npm/git 経由でインストールしてください。" }],
						details: { error: "MODULE_NOT_FOUND" },
					};
				}

				const { runUIGraph, renderTree, renderAnomalies, renderMermaid } = uiModule;
				const graph = await runUIGraph(target, { mobile: isMobile, cwd });

				let outText = "";
				if (format === "json") {
					outText = JSON.stringify(graph, null, 2);
				} else if (format === "mermaid") {
					outText = renderMermaid(graph);
				} else if (format === "scan") {
					outText = renderAnomalies(graph);
				} else {
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
