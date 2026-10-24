// share.js — /s/<token> 家庭分享页入口（独立只读页，移动优先）。
// 结构由 share.html 提供：root[data-state] + #share-loading / #share-invalid / #share-content。
import { fetchShareView, vote, respondShare } from './api.js';
import { prepareShareThumb } from './image-utils.js';

const VOTE_LABELS = { yes: '支持', unsure: '犹豫', no: '反对' };
// 同一时刻只允许一个表单编辑：展开回应表单时收起投票输入，点投票按钮时收起回应表单
let collapseRespondFormUi = null;

/** 收起所有目标卡的输入区（可保留一张）；默认投票只显示按钮+统计 */
function collapseAllVoteInputs(exceptBlock) {
  document.querySelectorAll('#share-vote .vote-block').forEach((block) => {
    if (exceptBlock && block === exceptBlock) return;
    block.classList.remove('is-voting');
    block.querySelectorAll('.vote-fields, .vote-submit').forEach((node) => {
      node.hidden = true;
    });
  });
}
const DECISION_TEXT = {
  ok: '可以放',
  conditional: '有条件可放',
  not_supported: '现在不建议放',
  insufficient: '还差关键数字',
  blocked: '不建议放',
};
const DECISION_TONE = {
  ok: 'pass',
  conditional: 'warn',
  not_supported: 'fail',
  insufficient: 'warn',
  blocked: 'fail',
};
const CATFIT_SVG = {
  pass: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.2 4.8 8.8 9.8 3.4"/></svg>',
  warn: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v5M6 9.4v.01"/></svg>',
  fail: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>',
  unknown: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.3 4.3a1.8 1.8 0 1 1 2.4 1.7c-.4.2-.7.6-.7 1v.3M6 9.4v.01"/></svg>',
  // 不涉及：这次方案没用这项功能，不能算「通过」（NA-RULE）
  na: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6"/></svg>',
};
const CATFIT_STATUS_TEXT = { pass: '通过', warn: '注意', fail: '不满足', unknown: '未知', na: '不涉及' };
const CONSTRAINT_STATUS = {
  pass: { glyph: '✅', text: '通过', cls: 'status-pass' },
  warn: { glyph: '⚠️', text: '偏紧', cls: 'status-unknown' },
  fail: { glyph: '❌', text: '不满足', cls: 'status-fail' },
  unknown: { glyph: '⚠️', text: '待确认', cls: 'status-unknown' },
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function tokenFromLocation() {
  const match = /^\/s\/([^/?#]+)/.exec(String(window.location.pathname || ''));
  if (match) return decodeURIComponent(match[1]);
  return String(new URLSearchParams(window.location.search).get('token') || '');
}

function voteId() {
  let id = '';
  try {
    id = window.localStorage.getItem('corner.voteId') || '';
  } catch {
    id = '';
  }
  if (!id) {
    id = 'v_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
    try {
      window.localStorage.setItem('corner.voteId', id);
    } catch {
      /* 隐私模式忽略 */
    }
  }
  return id;
}

function hoursLeft(expiresAt) {
  const end = Date.parse(expiresAt || '');
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - Date.now()) / 3600000));
}

/* ------------------------------------------------------------- 状态切换 */

function showState(state) {
  const root = document.getElementById('share-root');
  if (root) root.dataset.state = state;
  const loading = document.getElementById('share-loading');
  const invalid = document.getElementById('share-invalid');
  const content = document.getElementById('share-content');
  if (loading) loading.hidden = state !== 'loading';
  if (invalid) invalid.hidden = state !== 'expired' && state !== 'invalid';
  if (content) content.hidden = state !== 'ready';
}

function showInvalid(state, title, detail) {
  showState(state);
  const invalid = document.getElementById('share-invalid');
  if (!invalid) return;
  const heading = invalid.querySelector('h1');
  const text = invalid.querySelector('p');
  if (heading) heading.textContent = title;
  if (text) text.textContent = detail;
}

/* ------------------------------------------------------------- 渲染 */

function renderDecision(view) {
  const banner = document.getElementById('share-decision');
  if (!banner) return;
  banner.textContent = '';
  const decision = DECISION_TONE[view.decision] ? view.decision : 'insufficient';
  banner.dataset.tone = DECISION_TONE[decision] || 'warn';
  banner.dataset.decision = decision;
  banner.append(el('span', 'decision-label', view.decisionLabel || DECISION_TEXT[decision] || '信息不足'));
  banner.append(el('p', 'decision-headline', view.headline || '先看下面的尺寸条件'));
  const reason = view.boundary || view.recognition || '';
  if (reason) banner.append(el('p', 'decision-reason', reason));
}

function renderPhoto(view) {
  const wrap = document.getElementById('share-photo-wrap');
  if (!wrap) return;
  wrap.textContent = '';
  if (!view.photoUrl) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const img = document.createElement('img');
  img.className = 'share-photo';
  img.id = 'share-photo';
  img.alt = '这个角落的照片与标注';
  img.src = view.photoUrl;
  img.onload = () => {
    if (img.naturalWidth && img.naturalHeight) {
      img.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
      img.style.objectFit = 'contain';
    }
  };
  wrap.append(img);

  const annotations = Array.isArray(view.annotations) ? view.annotations.filter((item) => item && Array.isArray(item.bbox)) : [];
  if (annotations.length) {
    const hotspots = el('div', 'share-hotspots');
    const legend = el('div', 'share-photo-legend');
    legend.id = 'share-photo-legend';
    annotations.forEach((annotation, index) => {
      const box = el('div', 'share-hotspot');
      box.dataset.status = annotation.status || annotation.verdict || 'conditional';
      box.style.left = Number(annotation.bbox[0]) * 100 + '%';
      box.style.top = Number(annotation.bbox[1]) * 100 + '%';
      box.style.width = Number(annotation.bbox[2]) * 100 + '%';
      box.style.height = Number(annotation.bbox[3]) * 100 + '%';
      box.append(el('span', 'share-hotspot-num', String(index + 1)));
      hotspots.append(box);

      const chip = el('span', 'share-legend-item');
      chip.dataset.status = annotation.status || annotation.verdict || 'conditional';
      chip.append(el('span', 'share-legend-num', String(index + 1)));
      chip.append(document.createTextNode(annotation.label || '标注'));
      legend.append(chip);
    });
    wrap.append(hotspots, legend);
  }
}

function renderCatFit(catFit) {
  const host = document.getElementById('share-catfit');
  if (!host) return;
  host.textContent = '';
  const items = catFit && Array.isArray(catFit.items) ? catFit.items.filter(Boolean) : [];
  if (!items.length) {
    host.append(el('p', 'share-section-note', '这次没有位置判断数据。'));
    return;
  }
  const list = el('div', 'catfit-list');
  items.forEach((item) => {
    const status = CATFIT_SVG[item.status] ? item.status : 'unknown';
    const row = el('div', 'catfit-item');
    row.dataset.status = status;
    const icon = el('span', 'catfit-status');
    icon.innerHTML = CATFIT_SVG[status]; // 纯静态 SVG
    row.append(icon);
    const main = el('div', 'catfit-main');
    const label = el('div', 'catfit-label', item.label || item.key || '检查项');
    label.append(el('span', 'item-tag', CATFIT_STATUS_TEXT[status] || '未知'));
    main.append(label);
    if (item.why) main.append(el('p', 'catfit-why', item.why));
    row.append(main);
    list.append(row);
  });
  host.append(list);
}

function renderConstraints(constraints) {
  const host = document.getElementById('share-constraints');
  if (!host) return;
  host.textContent = '';
  const list = Array.isArray(constraints) ? constraints.filter(Boolean) : [];
  if (!list.length) {
    host.append(el('p', 'share-section-note', '这次没有可计算的尺寸条件。'));
    return;
  }
  const wrap = el('div', 'constraint-list');
  list.forEach((constraint) => {
    const status = CONSTRAINT_STATUS[constraint.status] || CONSTRAINT_STATUS.unknown;
    const row = el('div', 'constraint');
    row.dataset.status = CONSTRAINT_STATUS[constraint.status] ? constraint.status : 'unknown';
    row.append(el('span', 'c-label', constraint.label || constraint.key || '条件'));
    const parts = [`${constraint.op || '>='} ${Number(constraint.valueCm) || 0}cm`];
    if (constraint.actualCm != null) parts.push(`实测 ${constraint.actualCm}cm`);
    row.append(el('span', 'c-value', parts.join(' · ')));
    row.append(el('span', 'c-status ' + status.cls, `${status.glyph} ${status.text}`));
    wrap.append(row);
  });
  host.append(wrap);
}

function renderItems(items) {
  const host = document.getElementById('share-items');
  if (!host) return;
  host.textContent = '';
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) {
    host.append(el('p', 'share-section-note', '这次没有推荐具体商品，先按尺寸条件调整现有布置。'));
    return;
  }
  const wrap = el('div', 'item-list');
  list.forEach((item) => {
    const row = el('div', 'item-row' + (item.type === 'reuse' ? ' is-reuse' : ''));
    const main = el('div', 'item-main');
    const top = el('div', 'item-top');
    top.append(el('span', 'item-title', item.title || '猫用品'));
    if (item.fit) {
      top.append(el('span', item.fit === 'ok' ? 'fit-ok' : 'fit-blocked', item.fit === 'ok' ? '尺寸够' : '放不下'));
    }
    if (item.price != null) top.append(el('span', 'item-price', '¥' + item.price));
    main.append(top);
    const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
    if (tags.length) {
      const tagRow = el('div', 'item-tags');
      tags.forEach((tag) => tagRow.append(el('span', 'item-tag', tag)));
      main.append(tagRow);
    }
    row.append(main);
    wrap.append(row);
  });
  host.append(wrap);
}

function voteBlock(target, token) {
  const block = el('div', 'vote-block');
  block.dataset.targetId = target.id == null ? '' : String(target.id);
  const title = el('h3', 'vote-title', target.label || '这个方案');
  block.append(title);

  const counts = {
    yes: Number(target.support) || 0,
    unsure: Number(target.unsure) || 0,
    no: Number(target.oppose) || 0,
  };
  const countsEl = el('p', 'vote-counts');
  block.append(countsEl);
  const refreshCounts = () => {
    countsEl.textContent = `支持 ${counts.yes} · 犹豫 ${counts.unsure} · 反对 ${counts.no}`;
  };
  refreshCounts();

  const actions = el('div', 'vote-actions');
  let selected = '';
  const buttons = ['yes', 'unsure', 'no'].map((choice) => {
    const btn = el('button', 'vote-btn', VOTE_LABELS[choice]);
    btn.type = 'button';
    btn.dataset.vote = choice;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const alreadyOpen = block.classList.contains('is-voting') && selected === choice;
      if (alreadyOpen) {
        block.classList.remove('is-voting');
        fields.hidden = true;
        submit.hidden = true;
        return;
      }
      selected = choice;
      buttons.forEach((other) => other.setAttribute('aria-pressed', other === btn ? 'true' : 'false'));
      done.hidden = true;
      collapseAllVoteInputs(block);
      block.classList.add('is-voting');
      fields.hidden = false;
      submit.hidden = false;
      if (typeof collapseRespondFormUi === 'function') collapseRespondFormUi();
    });
    actions.append(btn);
    return btn;
  });
  block.append(actions);

  const fields = el('div', 'vote-fields');
  fields.hidden = true;
  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'vote-note';
  note.maxLength = 40;
  note.placeholder = '一句话留言（选填，40 字内）';
  note.setAttribute('aria-label', '一句话留言');
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'vote-name';
  name.maxLength = 12;
  name.placeholder = '昵称（选填，默认匿名）';
  name.setAttribute('aria-label', '昵称');
  fields.append(note, name);
  block.append(fields);

  const submit = el('button', 'vote-submit', '告诉 TA 我的意见');
  submit.type = 'button';
  submit.hidden = true;
  const done = el('p', 'vote-done');
  done.hidden = true;

  submit.addEventListener('click', async () => {
    if (!selected) {
      done.hidden = false;
      done.textContent = '先选一个态度（支持 / 犹豫 / 反对）';
      return;
    }
    const previous = selected;
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = '发送中…';
    try {
      const res = await vote(token, {
        targetId: target.id,
        targetType: target.type || 'item',
        vote: selected,
        note: note.value.trim().slice(0, 40),
        name: name.value.trim().slice(0, 12),
        voteId: voteId(),
      });
      // 用服务端返回的最新 targets 就地刷新计数，家人立刻看到票数变化
      if (res && Array.isArray(res.targets)) {
        const fresh = res.targets.find((t) => String(t.id) === String(target.id));
        if (fresh) {
          counts.yes = Number(fresh.support) || 0;
          counts.unsure = Number(fresh.unsure) || 0;
          counts.no = Number(fresh.oppose) || 0;
          refreshCounts();
        }
      }
      done.hidden = false;
      done.textContent = '已告诉 TA 你的意见';
      submit.textContent = '已发送，可改选';
      // 重新标定选中态（同一 target 以最后一次为准）
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vote === selected)));
      if (previous) counts[previous] = Math.max(0, counts[previous] - 0);
    } catch (err) {
      submit.textContent = original;
      done.hidden = false;
      done.textContent = (err && err.message) || '发送失败，稍后再试';
    } finally {
      submit.disabled = false;
      if (submit.textContent === '发送中…') submit.textContent = original;
    }
  });

  block.append(submit, done);
  return block;
}

function renderVotes(view) {
  const host = document.getElementById('share-vote');
  if (!host) return;
  host.textContent = '';
  const targets = Array.isArray(view.targets) ? view.targets.filter(Boolean) : [];
  if (!targets.length) {
    host.append(el('p', 'share-section-note', '这张卡片没有需要投票的方案。'));
    return;
  }
  targets.forEach((target) => host.append(voteBlock(target, view.token)));
}

/* ------------------------------------------------------------- V4 我能做什么 */

const RESPOND_ACTIONS = {
  measure: {
    label: '我周末来量',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2v12M11.8 2v12M4.2 4.4h7.6M4.2 7.4h7.6M4.2 10.4h7.6"/></svg>',
  },
  photo: {
    label: '我拍了现场照',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="4.4" width="12" height="9" rx="2"/><circle cx="8" cy="8.9" r="2.6"/><path d="M5.6 4.4 6.6 2.6h2.8l1 1.8"/></svg>',
  },
  disagree: {
    label: '这个位置我不同意',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M4.2 11.8 11.8 4.2"/></svg>',
  },
  agree: {
    label: '就按这个来',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.2 8.4 3.2 3.2 6.4-7.2"/></svg>',
  },
};

function deviceId() {
  let id = '';
  try {
    id = window.localStorage.getItem('corner.deviceId') || '';
  } catch {
    id = '';
  }
  if (!id) {
    id = 'd_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
    try {
      window.localStorage.setItem('corner.deviceId', id);
    } catch {
      /* 隐私模式忽略 */
    }
  }
  return id;
}

function renderResponds(view) {
  const voteHost = document.getElementById('share-vote');
  const content = document.getElementById('share-content');
  if (!content) return;
  const section = el('section', 'share-section respond-section');
  section.append(el('h2', 'share-section-title', '我能做什么（选一个就行，不用登录）'));

  const block = el('div', 'respond-block');
  // 标题下 12px 直接是按钮；未展开时不留空块/分隔线
  block.style.marginTop = '12px';
  block.style.paddingTop = '0';
  block.style.borderTop = '0';
  const actionsRow = el('div', 'respond-actions');
  const form = el('div', 'respond-form');
  form.hidden = true;
  form.style.display = 'none';
  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'respond-note';
  note.maxLength = 40;
  note.placeholder = '一句话留言（选填，40 字内）';
  note.setAttribute('aria-label', '一句话留言');
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'respond-name';
  name.maxLength = 12;
  name.placeholder = '昵称（选填，默认匿名）';
  name.setAttribute('aria-label', '昵称');

  const photoFields = el('div', 'respond-photo-fields');
  photoFields.hidden = true;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.className = 'respond-file';
  fileInput.setAttribute('aria-label', '选择现场照片');
  const consentLabel = el('label', 'respond-consent');
  const consent = document.createElement('input');
  consent.type = 'checkbox';
  consent.className = 'respond-consent-check';
  consentLabel.append(consent, document.createTextNode(' 这张照片会发给设置这个角落的人'));
  const preview = document.createElement('img');
  preview.className = 'respond-preview';
  preview.alt = '现场照预览';
  preview.hidden = true;
  photoFields.append(fileInput, consentLabel, preview);

  const submit = el('button', 'btn btn-primary respond-submit', '发送');
  submit.type = 'button';
  const error = el('p', 'respond-error');
  error.hidden = true;
  const done = el('p', 'respond-done');
  done.hidden = true;
  form.append(note, name, photoFields, submit, error);
  block.append(actionsRow, form, done);
  block.append(el('p', 'respond-foot', '你回的这些只会发给设置这个角落的人，不会公开。'));
  section.append(block);
  const anchorSection = voteHost && voteHost.closest('section');
  if (anchorSection && anchorSection.parentNode) anchorSection.insertAdjacentElement('afterend', section);
  else {
    const foot = content.querySelector('.share-foot');
    if (foot) content.insertBefore(section, foot);
    else content.append(section);
  }

  let selectedAction = '';
  let file = null;
  let sending = false;
  const buttons = {};

  /** 同一时刻只编辑一个表单：回应展开时收起投票输入，反之亦然 */
  const setVoteInputsCollapsed = () => {
    collapseAllVoteInputs();
  };
  const showRespondForm = () => {
    form.hidden = false;
    form.style.display = 'flex';
  };
  const hideRespondForm = () => {
    form.hidden = true;
    form.style.display = 'none';
  };
  collapseRespondFormUi = () => {
    hideRespondForm();
  };

  const updateSubmit = () => {
    submit.disabled = sending || (selectedAction === 'photo' && (!file || !consent.checked));
  };

  const showError = (text) => {
    error.hidden = !text;
    error.textContent = text || '';
  };

  const selectAction = (action) => {
    selectedAction = action;
    Object.keys(buttons).forEach((key) => {
      const active = key === action;
      buttons[key].setAttribute('aria-pressed', active ? 'true' : 'false');
      buttons[key].classList.toggle('is-selected', active);
    });
    setVoteInputsCollapsed();
    showRespondForm();
    photoFields.hidden = action !== 'photo';
    done.hidden = true;
    showError('');
    updateSubmit();
    note.focus();
  };

  Object.keys(RESPOND_ACTIONS).forEach((action) => {
    const meta = RESPOND_ACTIONS[action];
    const btn = el('button', 'respond-btn');
    btn.type = 'button';
    btn.dataset.action = action;
    btn.setAttribute('aria-pressed', 'false');
    btn.insertAdjacentHTML('afterbegin', meta.svg);
    btn.append(document.createTextNode(meta.label));
    btn.addEventListener('click', () => selectAction(action));
    buttons[action] = btn;
    actionsRow.append(btn);
  });

  // 刷新恢复：服务端按 deviceId 标出 mine，用最后一条 mine 恢复已选态 + 预填
  const mineResponds = Array.isArray(view.responds)
    ? view.responds.filter((item) => item && item.mine && RESPOND_ACTIONS[item.action])
    : [];
  const mine = mineResponds.slice(-1)[0];
  if (mine) {
    selectedAction = mine.action;
    Object.keys(buttons).forEach((key) => {
      const active = key === selectedAction;
      buttons[key].setAttribute('aria-pressed', active ? 'true' : 'false');
      buttons[key].classList.toggle('is-selected', active);
    });
    if (mine.note) note.value = String(mine.note).slice(0, 40);
    if (mine.name) name.value = String(mine.name).slice(0, 12);
    done.hidden = false;
    done.textContent = `${RESPOND_ACTIONS[selectedAction].label} · 已告诉 TA`;
  }

  fileInput.addEventListener('change', () => {
    file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    if (preview.src) URL.revokeObjectURL(preview.src);
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
    }
    updateSubmit();
  });
  consent.addEventListener('change', updateSubmit);

  submit.addEventListener('click', async () => {
    if (!selectedAction || sending) return;
    if (selectedAction === 'photo' && !file) {
      showError('先选一张现场照');
      return;
    }
    if (selectedAction === 'photo' && !consent.checked) {
      showError('先勾选「这张照片会发给设置这个角落的人」');
      return;
    }
    sending = true;
    const original = submit.textContent;
    submit.textContent = '发送中…';
    updateSubmit();
    showError('');
    try {
      let photoDataUrl = '';
      if (selectedAction === 'photo' && file) {
        const thumb = await prepareShareThumb(file);
        photoDataUrl = thumb && thumb.dataUrl ? thumb.dataUrl : '';
      }
      const res = await respondShare(view.token, {
        action: selectedAction,
        note: note.value.trim().slice(0, 40),
        name: name.value.trim().slice(0, 12),
        deviceId: deviceId(),
        consent: selectedAction === 'photo' ? true : false,
        photoDataUrl,
      });
      const label = (RESPOND_ACTIONS[selectedAction] || {}).label || '回应';
      done.hidden = false;
      done.textContent = `${label} · 已告诉 TA`;
      hideRespondForm();
      if (res && res.respondCount != null) {
        done.dataset.count = String(res.respondCount);
      }
    } catch (err) {
      showError((err && err.message) || '发送失败，稍后再试');
    } finally {
      sending = false;
      submit.textContent = original;
      updateSubmit();
    }
  });
}

function renderReady(view) {
  showState('ready');
  const title = document.getElementById('share-title');
  if (title) title.textContent = view.title || '家里的一个角落';
  const owner = document.getElementById('share-owner');
  if (owner) owner.textContent = view.ownerLabel || '家的角落';
  const created = document.getElementById('share-created');
  if (created && view.createdAt) {
    const date = new Date(view.createdAt);
    if (!Number.isNaN(date.getTime())) created.textContent = date.toLocaleDateString('zh-CN');
  }
  const left = hoursLeft(view.expiresAt);
  const expiry = document.getElementById('share-expiry');
  if (expiry) expiry.textContent = left == null ? '24' : String(left);
  const disclaimer = document.getElementById('share-disclaimer');
  if (disclaimer && view.disclaimer) disclaimer.textContent = view.disclaimer;

  renderDecision(view);
  renderPhoto(view);
  renderCatFit(view.catFit);
  renderConstraints(view.constraints);
  renderItems(view.items);
  renderVotes(view);
  renderResponds(view);
}

/* ------------------------------------------------------------- 启动 */

async function boot() {
  showState('loading');
  const token = tokenFromLocation();
  if (!token) {
    showInvalid('invalid', '链接无效', '这个链接缺少分享码，向家里人重新要一个吧。');
    return;
  }
  let view;
  try {
    view = await fetchShareView(token, { deviceId: deviceId() });
  } catch (err) {
    const status = Number(err && err.status);
    if (status === 410) {
      showInvalid('expired', '链接已失效', '分享已过期或被主人撤销了。让家人重新生成一次链接就行。');
    } else if (status === 404) {
      showInvalid('invalid', '链接已失效', '这个分享不存在，可能已经被撤销。让家人重新生成一次链接就行。');
    } else {
      showInvalid('invalid', '打不开这张卡片', (err && err.message) || '稍后再试一次。');
    }
    return;
  }
  if (!view || typeof view !== 'object') {
    showInvalid('invalid', '链接无效', '没有拿到分享内容。');
    return;
  }
  const left = hoursLeft(view.expiresAt);
  if (left === 0 && view.expiresAt) {
    showInvalid('expired', '链接已失效', '分享已过期。让家人重新生成一次链接就行。');
    return;
  }
  view.token = view.token || token;
  renderReady(view);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
