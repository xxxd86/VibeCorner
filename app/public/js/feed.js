// feed.js — 会话流渲染（流式）。所有动态文本用 textContent / text node，禁止 innerHTML 拼用户/AI 内容。
// DOM 结构遵循 CONTRACT §4；class 对齐 ui-shell 的 components.css / screens.css。

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function feedEl() {
  return document.getElementById('feed');
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function scrollToEnd() {
  const feed = feedEl();
  if (!feed) return;
  const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
  const tick = () => {
    try {
      feed.scrollTo({ top: feed.scrollHeight, behavior });
    } catch {
      feed.scrollTop = feed.scrollHeight;
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
  else tick();
}

export function clearFeed() {
  const feed = feedEl();
  if (feed) feed.textContent = '';
}

/* ------------------------------------------------------------------ 欢迎态 */

// 纯静态示例插画（不含任何用户/AI 文本，innerHTML 安全）
const EXAMPLE_ART = {
  corner: `<svg viewBox="0 0 96 68" fill="none" aria-hidden="true">
    <path d="M22 55V12M22 55h64" stroke="currentColor" stroke-opacity=".28" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M22 19 84 29" stroke="currentColor" stroke-opacity=".14" stroke-width="1.2" stroke-dasharray="2 5" stroke-linecap="round"/>
    <path d="M47 31 73 27.5 77 44.5 50 49Z" fill="var(--accent)" fill-opacity=".08" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="4 4" stroke-linejoin="round"/>
    <circle cx="43.5" cy="23" r="6.2" fill="var(--accent)"/>
    <text x="43.5" y="25.8" text-anchor="middle" font-size="8" font-family="ui-monospace,Consolas,monospace" fill="#FFF8F3">1</text>
  </svg>`,
  windowWall: `<svg viewBox="0 0 96 68" fill="none" aria-hidden="true">
    <rect x="28" y="9" width="40" height="34" rx="2.2" stroke="currentColor" stroke-opacity=".4" stroke-width="1.4"/>
    <path d="M48 9v34M28 26h40" stroke="currentColor" stroke-opacity=".2" stroke-width="1.1"/>
    <path d="M77 13 81 9M80 21h5M73 8v-4" stroke="var(--accent)" stroke-opacity=".85" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M22 58h52" stroke="currentColor" stroke-opacity=".3" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M22 54v8M74 54v8" stroke="currentColor" stroke-opacity=".4" stroke-width="1.2" stroke-linecap="round"/>
    <text x="48" y="52" text-anchor="middle" font-size="8.5" font-family="ui-monospace,Consolas,monospace" fill="currentColor" opacity=".55">1.2 m</text>
  </svg>`,
  litter: `<svg viewBox="0 0 96 68" fill="none" aria-hidden="true">
    <path d="M20 36h42l-5 18H25z" stroke="currentColor" stroke-opacity=".45" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M25 43h32" stroke="currentColor" stroke-opacity=".16" stroke-width="1.1"/>
    <path d="M24 21c6-6 16-6 22 0" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="3 4"/>
    <circle cx="73" cy="50" r="1.5" fill="currentColor" fill-opacity=".45"/>
    <circle cx="80" cy="43" r="1.2" fill="currentColor" fill-opacity=".35"/>
    <circle cx="68" cy="58" r="1.1" fill="currentColor" fill-opacity=".3"/>
    <circle cx="85" cy="54" r="1" fill="currentColor" fill-opacity=".25"/>
    <circle cx="76" cy="59" r=".9" fill="currentColor" fill-opacity=".22"/>
  </svg>`,
};

const ARROW_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5"/></svg>';

const EXAMPLE_CARDS = [
  {
    example: '电视柜右侧墙角',
    title: '电视柜右侧墙角',
    sub: '宽 1.2m · 可放 55cm 窝，也有 0 元方案',
    art: EXAMPLE_ART.corner,
  },
  {
    example: '窗边 1.2 米空墙',
    title: '窗边 1.2 米空墙',
    sub: '可放 60cm 爬架，也有 0 元方案',
    art: EXAMPLE_ART.windowWall,
  },
  {
    example: '猫砂盆总被踢砂',
    title: '猫砂盆总被踢砂',
    sub: '换个落点就好，0 元方案优先',
    art: EXAMPLE_ART.litter,
  },
];

function makeExampleCard(item) {
  const btn = el('button', 'example-card');
  btn.type = 'button';
  btn.dataset.example = item.example;
  const art = el('span', 'ex-art');
  art.setAttribute('aria-hidden', 'true');
  art.innerHTML = item.art; // 纯静态 SVG
  const title = el('span', 'ex-title', item.title);
  const sub = el('span', 'ex-sub', item.sub);
  const arrow = el('span');
  arrow.innerHTML = ARROW_SVG;
  const arrowSvg = arrow.firstElementChild;
  if (arrowSvg) {
    arrowSvg.setAttribute('class', 'ex-arrow');
    btn.append(art, title, sub, arrowSvg);
  } else {
    btn.append(art, title, sub);
  }
  btn.addEventListener('click', () => {
    try {
      document.dispatchEvent(new CustomEvent('corner:example', { detail: { text: item.example } }));
    } catch {
      /* ignore */
    }
  });
  return btn;
}

export function addWelcome() {
  const feed = feedEl();
  if (!feed) return;
  const section = el('section', 'welcome');
  section.setAttribute('aria-labelledby', 'welcome-title');

  const eyebrow = el('div', 'welcome-eyebrow');
  const mark = el('span', 'brand-mark', 'corner.');
  const rule = el('span', 'eyebrow-rule');
  rule.setAttribute('aria-hidden', 'true');
  eyebrow.append(mark, rule, el('span', 'eyebrow-text', '空间判断，不靠猜'));

  const title = el('h2', 'welcome-title');
  title.id = 'welcome-title';
  title.append(
    document.createTextNode('先看清这个角落，'),
    document.createElement('br'),
    document.createTextNode('再决定'),
    el('span', 'mark', '怎么改'),
    document.createTextNode('。')
  );

  const lede = el(
    'p',
    'welcome-lede',
    '拍一张角落 → 看清能怎么改 → 量 2 个尺寸，拿到能带去店里的清单。'
  );

  const steps = el('ol', 'welcome-steps');
  [
    ['01', '拍一张角落'],
    ['02', '看清能怎么改'],
    ['03', '量 2 个尺寸，拿到清单'],
  ].forEach(([num, text]) => {
    const li = document.createElement('li');
    li.append(el('span', 'step-num mono', num), el('span', 'step-text', text));
    steps.append(li);
  });

  const exampleBlock = el('div', 'example-block');
  const exHead = el('div', 'ex-head');
  exHead.append(el('span', 'ex-label', '从一个常见的角落开始'), el('span', 'ex-hint', '选一个，或直接拍照'));
  const grid = el('div', 'example-grid');
  EXAMPLE_CARDS.forEach((item) => grid.append(makeExampleCard(item)));
  exampleBlock.append(exHead, grid);

  // 不买也行：0 元方案和买新品同权（DF-2，禁止愧疚/损失框架）
  const keep = el('p', 'welcome-keep', '不买也行 —— 0 元方案和买新品同权展示，且排在前面。');

  // 三条原则小字（与 index.html 静态首屏一致）
  const trust = el('div', 'welcome-trust');
  ['关键尺寸缺失不下结论', '0 元复用优先', '先量，再买'].forEach((text) => {
    trust.append(el('span', null, text));
  });

  section.append(eyebrow, title, lede, steps, exampleBlock, keep, trust);
  feed.append(section);
  scrollToEnd();
}

/* ------------------------------------------------------------------ 用户 / AI */

export function addUser(text, { thumbUrl } = {}) {
  const feed = feedEl();
  if (!feed) return null;
  const item = el('div', 'feed-item user');
  const bubble = el('div', 'user-bubble');
  if (thumbUrl) {
    const img = document.createElement('img');
    img.className = 'user-thumb';
    img.src = thumbUrl;
    img.alt = '上传的角落照片';
    img.loading = 'lazy';
    bubble.append(img);
  }
  if (text) {
    if (bubble.childNodes.length) bubble.append(document.createElement('br'));
    bubble.append(document.createTextNode(text));
  }
  if (!bubble.childNodes.length) return null;
  item.append(bubble);
  feed.append(item);
  scrollToEnd();
  return item;
}

function noopHandle() {
  return {
    el: null,
    setStage() {},
    setReasoning() {},
    appendText() {},
    setText() {},
    addCard() {},
    done() {},
  };
}

/**
 * 创建一条 AI 消息，返回渐进披露句柄。
 * {el, setStage(label), setReasoning(delta), appendText(delta), setText(t), addCard(el), done()}
 */
export function addAI() {
  const feed = feedEl();
  if (!feed) return noopHandle();

  const item = el('div', 'feed-item ai');

  // 思考折叠区：先出思考时展开，正文出现后自动收起（Muse 式渐进披露）
  const think = document.createElement('details');
  think.className = 'think';
  think.hidden = true;
  const summary = document.createElement('summary');
  summary.textContent = '展开思考';
  const thinkBody = el('div', 'think-body');
  think.append(summary, thinkBody);

  const stageLine = el('div', 'ai-stage');
  stageLine.hidden = true;

  const body = el('div', 'ai-body');
  const stream = el('div', 'stream');
  body.append(stream);

  const cards = el('div', 'cards');
  item.append(think, stageLine, body, cards);
  feed.append(item);

  let textStarted = false;
  // 流式思考合批：plan 阶段可能推 ~2000 条 reasoning，逐条写 DOM 会卡死。
  const REASONING_LIMIT = 4000;
  let reasoningText = '';
  let reasoningBuffer = '';
  let reasoningTimer = null;

  function flushReasoning() {
    reasoningTimer = null;
    if (!reasoningBuffer) return;
    reasoningText = (reasoningText + reasoningBuffer).slice(-REASONING_LIMIT);
    reasoningBuffer = '';
    if (think.hidden) think.hidden = false;
    thinkBody.textContent = reasoningText;
    if (!textStarted) think.open = true; // 思考先展开
    scrollToEnd();
  }

  function scheduleReasoningFlush() {
    if (reasoningTimer != null) return;
    reasoningTimer = setTimeout(flushReasoning, 100);
  }

  function cancelReasoningTimer() {
    if (reasoningTimer != null) {
      clearTimeout(reasoningTimer);
      reasoningTimer = null;
    }
  }

  function setStreaming(on) {
    stream.classList.toggle('is-streaming', on);
    body.classList.toggle('is-streaming', on);
  }

  const handle = {
    el: item,
    setStage(label) {
      const text = String(label == null ? '' : label).trim();
      if (!text) {
        stageLine.hidden = true;
        return;
      }
      stageLine.hidden = false;
      stageLine.textContent = text;
      scrollToEnd();
    },
    setReasoning(delta) {
      const text = String(delta == null ? '' : delta);
      if (!text) return;
      reasoningBuffer += text;
      scheduleReasoningFlush();
    },
    appendText(delta) {
      const text = String(delta == null ? '' : delta);
      if (!text) return;
      cancelReasoningTimer();
      flushReasoning();
      if (!textStarted) {
        textStarted = true;
        setStreaming(true);
      }
      stream.append(document.createTextNode(text));
      if (!think.hidden && think.open) think.open = false; // 正文出现 → 思考自动折叠
      scrollToEnd();
    },
    setText(t) {
      cancelReasoningTimer();
      flushReasoning();
      textStarted = true;
      setStreaming(false);
      stream.textContent = String(t == null ? '' : t);
      if (!think.hidden && think.open) think.open = false;
      scrollToEnd();
    },
    addCard(cardEl) {
      if (cardEl) cards.append(cardEl);
      scrollToEnd();
    },
    done() {
      cancelReasoningTimer();
      flushReasoning();
      setStreaming(false);
      stageLine.hidden = true;
      if (!stream.textContent.trim() && !stream.querySelector('img,svg')) body.hidden = true;
      scrollToEnd();
    },
  };
  scrollToEnd();
  return handle;
}

/** 没有气泡，只插卡片（阻断卡 / 交付卡） */
export function addCardOnly(cardEl) {
  if (!cardEl) return null;
  const feed = feedEl();
  if (!feed) return null;
  const item = el('div', 'feed-item ai');
  const cards = el('div', 'cards');
  cards.append(cardEl);
  item.append(cards);
  feed.append(item);
  scrollToEnd();
  return item;
}
