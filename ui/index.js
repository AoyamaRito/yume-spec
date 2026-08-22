// @why: yume-spec の UI 健全性検証モジュール。E2Eテストでの assertUIHealthy 提供および pi の yui ツール実行ロジック
// @tags: SPEC

import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { extractUIGraph } from './extractor.js';

export { extractUIGraph };

// @why: MacだけでなくLinux(CI環境)・Windows・システムChromeパスまで網羅し、環境依存なく動作するクロスプラットフォーム検出
// @tags: SPEC
export function findChromiumPath() {
  // 1. 環境変数オーバーライド
  for (const envKey of ['UI_GRAPH_CHROME', 'WEBQA_CHROME', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH']) {
    if (process.env[envKey] && existsSync(process.env[envKey])) return process.env[envKey];
  }

  // 2. Playwright キャッシュ探索 (Mac, Linux, Windows)
  const home = homedir();
  const cacheCandidates = [
    path.join(home, 'Library/Caches/ms-playwright'), // macOS
    path.join(home, '.cache/ms-playwright'),        // Linux
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null, // Windows
  ].filter(Boolean);

  for (const cache of cacheCandidates) {
    if (!existsSync(cache)) continue;
    for (const prefix of ['chromium_headless_shell-', 'chromium-']) {
      const dirs = readdirSync(cache).filter(d => d.startsWith(prefix)).sort();
      for (const d of dirs.reverse()) {
        const cands = [
          path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
          path.join(cache, d, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
          path.join(cache, d, 'chrome-mac', 'Chromium'),
          path.join(cache, d, 'chromium', 'chrome-mac', 'Chromium'),
          path.join(cache, d, 'chrome-linux', 'chrome'),
          path.join(cache, d, 'chrome-headless-shell-linux', 'chrome-headless-shell'),
          path.join(cache, d, 'chrome-win', 'chrome.exe'),
          path.join(cache, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        ];
        for (const cand of cands) {
          if (existsSync(cand)) return cand;
        }
      }
    }
  }

  // 3. システム標準パス探索
  const systemPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of systemPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

/* ---------- グラフ抽出実行 ---------- */
export async function runUIGraph(targetUrlOrPath, options = {}) {
  const exe = options.executablePath || findChromiumPath();
  if (!exe) {
    throw new Error('Chromium実行ファイルが見つかりません。WEBQA_CHROME または ms-playwright が必要です');
  }

  const isMobile = options.mobile || false;
  const width = options.width || (isMobile ? 390 : 1280);
  const height = options.height || (isMobile ? 844 : 800);

  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });

  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: isMobile ? 2 : 1,
      isMobile,
      hasTouch: isMobile,
    });

    let url = targetUrlOrPath;
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
      const cwd = options.cwd || process.cwd();
      const absPath = path.isAbsolute(url) ? url : path.resolve(cwd, url);
      url = `file://${absPath}`;
    }

    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const waitMs = options.wait ?? 300;
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    const result = await page.evaluate(extractUIGraph, options);
    result.target = targetUrlOrPath;
    return result;
  } finally {
    await browser.close();
  }
}

/* ---------- E2E テスト用ヘルパー (snowball E2E 対応) ---------- */
export async function assertUIHealthy(targetUrlOrPath, options = {}) {
  const res = await runUIGraph(targetUrlOrPath, options);
  if (!res.summary.pass) {
    const errReport = renderAnomalies(res);
    throw new Error(`UI Health Check Failed for ${targetUrlOrPath}:\n${errReport}`);
  }
  return res;
}

/* ---------- フォーマッター ---------- */
export function renderTree(graph) {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const childMap = new Map();
  for (const edge of graph.edges.filter(e => e.type === 'dom_child')) {
    if (!childMap.has(edge.from)) childMap.set(edge.from, []);
    childMap.get(edge.from).push(edge.to);
  }

  const rootNodes = graph.nodes.filter(n => !graph.edges.some(e => e.type === 'dom_child' && e.to === n.id));

  const lines = [];
  lines.push(`📱 Viewport: ${graph.viewport.width}x${graph.viewport.height} | Nodes: ${graph.summary.totalNodes} | Edges: ${graph.summary.totalEdges}`);
  lines.push('');

  function printNode(nodeId, prefix = '', isLast = true) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const marker = isLast ? '└── ' : '├── ';
    let label = `${node.selector}`;
    if (node.text) label += ` "${node.text}"`;
    label += ` [${node.rect.x},${node.rect.y} ${node.rect.w}x${node.rect.h}]`;

    if (node.layout.position !== 'static') label += ` [pos:${node.layout.position}]`;
    if (node.layout.display.includes('flex') || node.layout.display.includes('grid')) {
      label += ` [${node.layout.display}]`;
    }

    const errors = node.anomalies.filter(a => a.severity === 'error');
    const warns = node.anomalies.filter(a => a.severity === 'warn');
    if (errors.length > 0) label += ` 🚨 ${errors.map(e => e.code).join(',')}`;
    if (warns.length > 0) label += ` ⚠️ ${warns.map(w => w.code).join(',')}`;

    lines.push(`${prefix}${marker}${label}`);

    const children = childMap.get(nodeId) || [];
    const nextPrefix = prefix + (isLast ? '    ' : '│   ');
    children.forEach((childId, idx) => {
      printNode(childId, nextPrefix, idx === children.length - 1);
    });
  }

  for (let i = 0; i < rootNodes.length; i++) {
    printNode(rootNodes[i].id, '', i === rootNodes.length - 1);
  }

  return lines.join('\n');
}

export function renderAnomalies(graph) {
  const lines = [];
  lines.push('====================================================');
  lines.push(`🔍 UI HEALTH ANOMALY REPORT: ${graph.target || 'target'}`);
  lines.push(`   Status: ${graph.summary.pass ? '✅ PASS (No blocking errors)' : '❌ FAIL (Errors found)'}`);
  lines.push(`   Errors: ${graph.summary.errorCount} | Warnings: ${graph.summary.warnCount}`);
  lines.push('====================================================');

  if (graph.anomalies.length === 0) {
    lines.push('✨ レイアウト破綻・遮蔽・サイズ異常などの問題は検出されませんでした。');
    return lines.join('\n');
  }

  graph.anomalies.forEach((a, i) => {
    const icon = a.severity === 'error' ? '🚨 [ERROR]' : '⚠️ [WARN]';
    lines.push(`\n${i + 1}. ${icon} ${a.code} on \`${a.selector}\` (${a.nodeId})`);
    lines.push(`   理由: ${a.message}`);
    lines.push(`   詳細: ${JSON.stringify(a.detail)}`);
  });

  return lines.join('\n');
}

export function renderMermaid(graph) {
  const lines = ['flowchart TD'];
  
  for (const n of graph.nodes) {
    let text = n.selector;
    if (n.text) text += `\\n"${n.text}"`;
    text += `\\n(${n.rect.w}x${n.rect.h})`;

    if (n.anomalies.some(a => a.severity === 'error')) {
      lines.push(`  ${n.id}["🚨 ${text}"]:::errorNode`);
    } else if (n.isInteractive) {
      lines.push(`  ${n.id}["🔘 ${text}"]:::interactiveNode`);
    } else {
      lines.push(`  ${n.id}["${text}"]`);
    }
  }

  for (const e of graph.edges) {
    if (e.type === 'dom_child') {
      lines.push(`  ${e.from} --> ${e.to}`);
    } else if (e.type === 'containing_block') {
      lines.push(`  ${e.from} -. cb .-> ${e.to}`);
    } else if (e.type === 'occluded_by') {
      lines.push(`  ${e.from} ==>|OCCLUDED BY| ${e.to}`);
    } else if (e.type.startsWith('logical_')) {
      lines.push(`  ${e.from} -. ${e.type} .-> ${e.to}`);
    }
  }

  lines.push('  classDef errorNode fill:#ffdddd,stroke:#ff0000,stroke-width:2px;');
  lines.push('  classDef interactiveNode fill:#e1f5fe,stroke:#0288d1,stroke-width:2px;');

  return lines.join('\n');
}
