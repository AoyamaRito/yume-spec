// @why: yume-spec 内蔵の Web UI ロジカルグラフ抽出コア。ブラウザ内部でDOM/CSS/包含/スタック/遮蔽/A11yを走査し、横スクロール・はみ出し・遮蔽・極小タップなどの異常を数値判定する
// @tags: SPEC

export function extractUIGraph(options = {}) {
  const {
    checkOcclusion = true,
    checkTapTarget = true,
    checkOverflow = true,
    checkViewportOverflow = true,
    minTapSize = 24, // px
  } = options;

  let nextId = 1;
  const elementToId = new Map();
  const idToElement = new Map();

  function getNodeId(el) {
    if (!elementToId.has(el)) {
      const id = `node_${nextId++}`;
      elementToId.set(el, id);
      idToElement.set(id, el);
    }
    return elementToId.get(el);
  }

  function getSelector(el) {
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    if (el.id) return `#${el.id}`;
    
    let path = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(Boolean);
      if (classes.length > 0) {
        path += `.${classes.slice(0, 2).join('.')}`;
      }
    }
    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        path += `:nth-of-type(${index})`;
      }
    }
    return path;
  }

  // @why: 意図的なはみ出しや特殊UIを規約のエラー0件強制が潰さないよう、data-yui-ignore 属性(自身または祖先)でオプトアウト可能にする
  //       data-yui-ignore="overflow" のように特定コード指定も可能。
  // @tags: SPEC
  function isIgnored(el, anomalyCode) {
    if (typeof el.closest !== 'function') return false;
    const ignoreEl = el.closest('[data-yui-ignore]');
    if (!ignoreEl) return false;
    const val = ignoreEl.getAttribute('data-yui-ignore');
    if (!val || val === '' || val === 'true' || val === 'all') return true;
    const allowed = val.split(',').map(s => s.trim().toUpperCase());
    const code = anomalyCode.toUpperCase();
    return allowed.some(item => code === item || code.includes(item) || item.includes(code));
  }

  function isInteractive(el, style) {
    const tag = el.tagName.toLowerCase();
    if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true;
    if (tag === 'input' && el.type !== 'hidden') return true;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    if (el.hasAttribute('role')) {
      const role = el.getAttribute('role');
      if (['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'combobox', 'slider'].includes(role)) {
        return true;
      }
    }
    if (style && style.cursor === 'pointer') return true;
    if (el.onclick || el.hasAttribute('onclick')) return true;
    return false;
  }

  function createsStackingContext(el, style) {
    if (el === document.documentElement || el === document.body) return true;
    if (style.position !== 'static' && style.zIndex !== 'auto') return true;
    if (style.position === 'fixed' || style.position === 'sticky') return true;
    if (parseFloat(style.opacity) < 1) return true;
    if (style.transform && style.transform !== 'none') return true;
    if (style.filter && style.filter !== 'none') return true;
    if (style.perspective && style.perspective !== 'none') return true;
    if (style.clipPath && style.clipPath !== 'none') return true;
    if (style.mask && style.mask !== 'none') return true;
    if (style.isolation === 'isolate') return true;
    if (style.mixBlendMode && style.mixBlendMode !== 'normal') return true;
    if (style.willChange && /transform|opacity|filter|perspective/.test(style.willChange)) return true;
    return false;
  }

  function findContainingBlock(el, style) {
    if (style.position === 'static' || style.position === 'relative') {
      return el.parentElement || document.body;
    }
    if (style.position === 'absolute') {
      let cur = el.parentElement;
      while (cur && cur !== document.documentElement) {
        const s = window.getComputedStyle(cur);
        if (s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none') {
          return cur;
        }
        cur = cur.parentElement;
      }
      return document.body;
    }
    if (style.position === 'fixed') {
      let cur = el.parentElement;
      while (cur && cur !== document.documentElement) {
        const s = window.getComputedStyle(cur);
        if (s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || s.willChange === 'transform') {
          return cur;
        }
        cur = cur.parentElement;
      }
      return document.documentElement;
    }
    return el.parentElement || document.body;
  }

  const nodes = [];
  const edges = [];
  const anomalies = [];

  const rawElements = Array.from(document.querySelectorAll('*'));
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  // @why: モバイルUIバグの筆頭である「意図しないページの横スクロール・横揺れ」を検出する。
  // @tags: SPEC
  const docScrollWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0
  );
  if (checkViewportOverflow && docScrollWidth > viewportWidth + 2) {
    const leakPx = docScrollWidth - viewportWidth;
    // 画面外にはみ出ている要素を特定
    const leakers = [];
    for (const el of rawElements) {
      if (['script', 'style', 'head'].includes(el.tagName.toLowerCase())) continue;
      const r = el.getBoundingClientRect();
      if (r.right > viewportWidth + 2 && !isIgnored(el, 'VIEWPORT_HORIZONTAL_OVERFLOW')) {
        leakers.push({
          selector: getSelector(el),
          right: Math.round(r.right),
          width: Math.round(r.width),
        });
      }
    }

    const vpAnomaly = {
      code: 'VIEWPORT_HORIZONTAL_OVERFLOW',
      severity: 'error',
      nodeId: 'node_viewport',
      selector: 'document',
      message: `ページ全体の横スクロールが発生しています（スクロール幅: ${docScrollWidth}px > 画面幅: ${viewportWidth}px, はみ出し: +${leakPx}px）`,
      detail: {
        docScrollWidth,
        viewportWidth,
        leakPx,
        topLeakers: leakers.slice(0, 5),
      },
    };
    anomalies.push(vpAnomaly);
  }

  for (const el of rawElements) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'meta', 'link', 'template', 'head', 'title'].includes(tag)) {
      continue;
    }

    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const isHidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    const interactive = isInteractive(el, style);

    let directText = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        directText += child.textContent;
      }
    }
    directText = directText.trim().replace(/\s+/g, ' ');
    const textPreview = directText ? directText.slice(0, 30) : '';

    const nodeId = getNodeId(el);
    const selector = getSelector(el);

    const nodeData = {
      id: nodeId,
      tag,
      selector,
      role: el.getAttribute('role') || (interactive ? 'interactive' : null),
      text: textPreview || undefined,
      isInteractive: interactive,
      rect: {
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        w: Math.round(rect.width * 10) / 10,
        h: Math.round(rect.height * 10) / 10,
      },
      layout: {
        display: style.display,
        position: style.position,
        zIndex: style.zIndex,
        overflow: style.overflow,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
      },
      flags: {
        isHidden,
        createsStackingContext: createsStackingContext(el, style),
      },
      anomalies: [],
    };

    if (el.parentElement && el !== document.documentElement) {
      edges.push({
        type: 'dom_child',
        from: getNodeId(el.parentElement),
        to: nodeId,
      });
    }

    if (style.position === 'absolute' || style.position === 'fixed') {
      const cb = findContainingBlock(el, style);
      if (cb && cb !== el.parentElement) {
        edges.push({
          type: 'containing_block',
          from: getNodeId(cb),
          to: nodeId,
          desc: `position: ${style.position} jumps out of parent to ${getSelector(cb)}`,
        });
      }
    }

    if (el.hasAttribute('aria-controls')) {
      const targetId = el.getAttribute('aria-controls');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        edges.push({
          type: 'logical_controls',
          from: nodeId,
          to: getNodeId(targetEl),
          desc: `aria-controls="#${targetId}"`,
        });
      }
    }
    if (tag === 'label' && el.hasAttribute('for')) {
      const targetId = el.getAttribute('for');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        edges.push({
          type: 'logical_labels',
          from: nodeId,
          to: getNodeId(targetEl),
          desc: `label-for="#${targetId}"`,
        });
      }
    }

    // 異常検知
    if (!isHidden) {
      // 1. Zero size with content
      if (!isIgnored(el, 'ZERO_BOX_WITH_CONTENT')) {
        if ((rect.width === 0 || rect.height === 0) && (directText.length > 0 || interactive || el.children.length > 0)) {
          const anomaly = {
            code: 'ZERO_BOX_WITH_CONTENT',
            severity: 'warn',
            nodeId,
            selector,
            message: `要素の幅または高さが 0px です (w: ${rect.width}, h: ${rect.height}) が、内容が存在します`,
            detail: { text: textPreview, childrenCount: el.children.length },
          };
          nodeData.anomalies.push(anomaly);
          anomalies.push(anomaly);
        }
      }

      // 2. Tiny tap target (親がすでに十分なサイズのインタラクティブ要素である場合はノイズ防止でスキップ)
      if (checkTapTarget && interactive && (rect.width > 0 && rect.height > 0) && !isIgnored(el, 'TINY_TAP_TARGET')) {
        const parentInteractive = el.parentElement && isInteractive(el.parentElement, window.getComputedStyle(el.parentElement));
        const parentRect = parentInteractive ? el.parentElement.getBoundingClientRect() : null;
        const parentHasSize = parentRect && parentRect.width >= minTapSize && parentRect.height >= minTapSize;

        if (!parentHasSize && (rect.width < minTapSize || rect.height < minTapSize)) {
          const anomaly = {
            code: 'TINY_TAP_TARGET',
            severity: 'warn',
            nodeId,
            selector,
            message: `タップ/クリック領域が小さすぎます (${rect.width}x${rect.height}px < 最小推奨 ${minTapSize}px)`,
            detail: { rect: nodeData.rect },
          };
          nodeData.anomalies.push(anomaly);
          anomalies.push(anomaly);
        }
      }

      // 3. Overflow leak
      if (checkOverflow && el.parentElement && el.parentElement !== document.documentElement && !isIgnored(el, 'OVERFLOW_LEAK')) {
        const parentEl = el.parentElement;
        const parentStyle = window.getComputedStyle(parentEl);
        const parentRect = parentEl.getBoundingClientRect();

        if (style.position !== 'absolute' && style.position !== 'fixed' && parentRect.width > 0 && parentRect.height > 0) {
          const overflowRight = rect.right - parentRect.right;
          const overflowBottom = rect.bottom - parentRect.bottom;
          const overflowLeft = parentRect.left - rect.left;
          const overflowTop = parentRect.top - rect.top;

          const maxLeak = Math.max(overflowRight, overflowBottom, overflowLeft, overflowTop);
          if (maxLeak > 2) {
            const isClipping = ['hidden', 'clip', 'scroll', 'auto'].includes(parentStyle.overflow) ||
                               ['hidden', 'clip', 'scroll', 'auto'].includes(parentStyle.overflowX) ||
                               ['hidden', 'clip', 'scroll', 'auto'].includes(parentStyle.overflowY);
            
            if (!isClipping) {
              const anomaly = {
                code: 'OVERFLOW_LEAK',
                severity: 'error',
                nodeId,
                selector,
                message: `親要素 (${getSelector(parentEl)}) から +${Math.round(maxLeak)}px はみ出しています (親 overflow: ${parentStyle.overflow})`,
                detail: {
                  leakPx: Math.round(maxLeak),
                  parentSelector: getSelector(parentEl),
                  childRect: nodeData.rect,
                  parentRect: {
                    x: Math.round(parentRect.x * 10) / 10,
                    y: Math.round(parentRect.y * 10) / 10,
                    w: Math.round(parentRect.width * 10) / 10,
                    h: Math.round(parentRect.height * 10) / 10,
                  },
                },
              };
              nodeData.anomalies.push(anomaly);
              anomalies.push(anomaly);
            }
          }
        }
      }

      // 4. Occlusion
      if (checkOcclusion && interactive && rect.width > 0 && rect.height > 0 && !isIgnored(el, 'INTERACTION_OCCLUDED')) {
        const testPoints = [
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, name: 'center' },
          { x: rect.x + 4, y: rect.y + 4, name: 'top-left' },
          { x: rect.x + rect.width - 4, y: rect.y + rect.height - 4, name: 'bottom-right' },
        ];

        let occludedCount = 0;
        let occluderEl = null;

        for (const pt of testPoints) {
          if (pt.x >= 0 && pt.x <= viewportWidth && pt.y >= 0 && pt.y <= viewportHeight) {
            const topEl = document.elementFromPoint(pt.x, pt.y);
            // 自身、子孫、祖先以外の別系統要素が被さっている場合のみ遮蔽
            if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
              occludedCount++;
              occluderEl = topEl;
            }
          }
        }

        if (occludedCount >= 2 && occluderEl) {
          const occluderSelector = getSelector(occluderEl);
          const occluderId = getNodeId(occluderEl);
          const anomaly = {
            code: 'INTERACTION_OCCLUDED',
            severity: 'error',
            nodeId,
            selector,
            message: `操作可能な要素が上位の要素 (${occluderSelector}) に遮蔽されており、クリック/タップできません`,
            detail: {
              occluderSelector,
              occluderId,
              testPointsTested: testPoints.length,
              occludedPoints: occludedCount,
            },
          };
          nodeData.anomalies.push(anomaly);
          anomalies.push(anomaly);

          edges.push({
            type: 'occluded_by',
            from: nodeId,
            to: occluderId,
            desc: `occluded by ${occluderSelector}`,
          });
        }
      }

      // 5. Pointer events disabled
      if (interactive && style.pointerEvents === 'none' && !isIgnored(el, 'POINTER_EVENTS_DISABLED')) {
        const anomaly = {
          code: 'POINTER_EVENTS_DISABLED',
          severity: 'warn',
          nodeId,
          selector,
          message: `インタラクティブ要素ですが pointer-events: none が指定されており操作不能です`,
          detail: { pointerEvents: style.pointerEvents },
        };
        nodeData.anomalies.push(anomaly);
        anomalies.push(anomaly);
      }
    }

    nodes.push(nodeData);
  }

  return {
    viewport: { width: viewportWidth, height: viewportHeight },
    nodes,
    edges,
    anomalies,
    summary: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      interactiveCount: nodes.filter(n => n.isInteractive).length,
      anomalyCount: anomalies.length,
      errorCount: anomalies.filter(a => a.severity === 'error').length,
      warnCount: anomalies.filter(a => a.severity === 'warn').length,
      pass: anomalies.filter(a => a.severity === 'error').length === 0,
    },
  };
}
