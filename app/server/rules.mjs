// 猫角落 Corner · 确定性规则层
// 设计原则：
// 1. apply 在模型输出之后运行，负责「模型不能决定」的硬约束：预算、SKU 库、关键尺寸未知、遮挡保留物。
// 2. apply 是纯函数：不读文件、不发请求、不改入参；SKUS 在模块加载时读取一次。
// 3. 单位统一毫米入库（valueMm），厘米只用于展示（valueCm，1 位小数）。禁止像素反推厘米。
// 4. 永远不抛错：任何异常都回退为传入的 payload，保证服务端不会 500。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compact } from './evidence.mjs';

export const L0_DISCLAIMER = '这是方向预览，不是摆放结论；关键尺寸补齐前不能判断能不能放下。';
export const L1_DISCLAIMER = '以交付时的尺寸条件为准，落地前请现场确认。';
// 契约里的常量名
export const DISCLAIMER_L0 = L0_DISCLAIMER;
export const DISCLAIMER_L1 = L1_DISCLAIMER;

// 契约第 7 节：key 固定，不得增删改名
export const MEASUREMENT_SPECS = Object.freeze({
  corridorWidth: {
    key: 'corridorWidth',
    label: '通道净宽',
    endpoints: '最近的家具外沿 → 对面墙/家具最窄处',
    unit: 'cm',
    why: '低于 60cm 猫会绕行',
    hint: '量最窄处，别量最宽处',
    defaultUse: '判断通道是否还过得去',
    minCmV: 60
  },
  cornerWidthA: {
    key: 'cornerWidthA',
    label: '墙角 A 边长',
    endpoints: '沿主墙 → 墙面可用的长度',
    unit: 'cm',
    why: '决定猫窝最大宽度',
    hint: '从墙角量到最近的家具或门边',
    defaultUse: '决定最大宽度'
  },
  cornerWidthB: {
    key: 'cornerWidthB',
    label: '墙角 B 边长',
    endpoints: '沿侧墙 → 墙面可用的长度',
    unit: 'cm',
    why: '决定最大深度',
    hint: '从墙角量到最近的遮挡物',
    defaultUse: '决定最大深度'
  },
  freeDepth: {
    key: 'freeDepth',
    label: '可用进深',
    endpoints: '墙根 → 最近的障碍物/通道边',
    unit: 'cm',
    why: '决定猫窝进深上限',
    hint: '垂直墙面量，别斜着量',
    defaultUse: '决定进深'
  },
  obstructionH: {
    key: 'obstructionH',
    label: '遮挡物高度',
    endpoints: '该区域内最高的家具/物品 → 地面',
    unit: 'cm',
    why: '影响高低位方案',
    hint: '量区域内最高那件东西',
    defaultUse: '判断能否加高位'
  },
  ceilingFree: {
    key: 'ceilingFree',
    label: '上方净空',
    endpoints: '地面 → 正上方最近物体',
    unit: 'cm',
    why: '猫爬架高度上限',
    hint: '站在落点位上往上看',
    defaultUse: '限制猫爬架高度'
  },
  outletDist: {
    key: 'outletDist',
    label: '到最近插座',
    endpoints: '计划落点位 → 最近插座',
    unit: 'cm',
    why: '饮水机/电动砂盆要用',
    hint: '沿墙走线量',
    defaultUse: '判断能否接电'
  },
  doorSwing: {
    key: 'doorSwing',
    label: '门开合范围',
    endpoints: '门轴 → 门完全打开的外沿',
    unit: 'cm',
    why: '避免放在门口',
    hint: '把门完全打开再量',
    defaultUse: '排除门口区域'
  },
  windowDist: {
    key: 'windowDist',
    label: '到窗距离',
    endpoints: '落点位 → 最近窗台水平距离',
    unit: 'cm',
    why: '影响日照与观景',
    hint: '水平量到窗台',
    defaultUse: '判断日照与观景'
  }
});

export const MEASUREMENT_KEYS = Object.freeze(Object.keys(MEASUREMENT_SPECS));

// L1 地面方案必须的尺寸（缺一个都不能给「能放」）
export const FLOOR_REQUIRED_KEYS = Object.freeze(['corridorWidth', 'cornerWidthA', 'freeDepth']);
export const CORRIDOR_MIN_CMM = 600;

export const RADAR_SPECS = Object.freeze([
  { key: 'hide', label: '藏身感' },
  { key: 'path', label: '通道' },
  { key: 'sun', label: '日照' },
  { key: 'quiet', label: '安静' },
  { key: 'flow', label: '动线' }
]);

const SKUS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'skus.json');
// 模块加载时唯一的 I/O：读取 SKU 库（允许）
export const SKUS = Object.freeze(JSON.parse(fs.readFileSync(SKUS_FILE, 'utf8')));
export const SKU_BY_ID = new Map(SKUS.map((s) => [s.id, s]));

// 按品类确定地面摆放必须核对的尺寸；猫爬架额外需要净空（但当前 L1 直接阻断，见 checkFit）
const CATEGORY_REQUIREMENTS = Object.freeze({
  猫窝: { width: 'cornerWidthA', depth: 'freeDepth', height: null, install: 'floor' },
  猫抓板: { width: 'cornerWidthA', depth: 'freeDepth', height: null, install: 'floor' },
  猫砂盆: { width: 'cornerWidthA', depth: 'freeDepth', height: null, install: 'floor' },
  猫爬架: { width: 'cornerWidthA', depth: 'freeDepth', height: 'ceilingFree', install: 'wall' }
});

// ---------- V2 证据驱动常量 ----------

// 按体型估算体长（cm）；这是估算，不是实测，why 文案必须注明。
export const CAT_SIZE_BODY_CM = Object.freeze({ small: 40, medium: 45, large: 50 });

export const CATFIT_KEY_LABELS = Object.freeze({
  hide: '能藏的地方',
  resources: '资源是否分开',
  litter: '砂盆条件',
  scratch: '抓挠位置',
  vertical: '高处与栖架',
  climate: '温度/日照/风'
});

export const CATFIT_KEYS = Object.freeze(['hide', 'resources', 'litter', 'scratch', 'vertical', 'climate']);

export const APPLIANCE_LABELS = Object.freeze({ washer: '洗衣机', fridge: '冰箱', speaker: '音响' });

const EVIDENCE_FALLBACK_ID = 'EVIDENCE-GAP-NOUSE';
const CATFIT_WHY_MAX = 40;

const VERDICT_RANK = Object.freeze({ ok: 3, conditional: 2, not_supported: 1, insufficient: 0 });
const DEFAULT_AFTERCARE = Object.freeze({
  day7: '第 7 天看猫用不用：不用就把窝垫换成旧衣服，或把窝转个朝向再观察。',
  day14: '第 14 天还不用，先别加购。把窝挪到更安静的角落，再观察一周。'
});
const DEFAULT_RADAR_NOTE = '启发式参考，非实测';

// ---------- 小工具（不依赖入参，不做 I/O） ----------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round1 = (v) => Math.round(v * 10) / 10;
const shortLabel = (s, max = 10) => {
  const chars = Array.from(String(s || '候选位置').trim());
  return chars.slice(0, max).join('');
};

export function cmToMm(cm) {
  return isNum(cm) ? Math.round(cm * 10) : null;
}

export function mmToCm(mm) {
  return isNum(mm) ? round1(mm / 10) : null;
}

// 用户诉求里写了预算（"预算 300" / "300 元"）时，作为预算上限的兜底
export function budgetFromGoal(goal) {
  if (typeof goal !== 'string' || !goal.trim()) return null;
  const m = goal.match(/(?:预算|最多|不超过)\s*([0-9]{2,6})/) || goal.match(/([0-9]{2,6})\s*(?:元|块)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 50 && n <= 20000 ? n : null;
}

function minVerdict(a, b) {
  return VERDICT_RANK[a] <= VERDICT_RANK[b] ? a : b;
}

function measurementMap(session) {
  const src = session && session.measurements && typeof session.measurements === 'object' ? session.measurements : {};
  const out = {};
  for (const key of MEASUREMENT_KEYS) {
    const raw = src[key];
    if (raw == null) {
      out[key] = { known: false, mm: null, cm: null, skipped: false, estimate: false, rangeCm: null };
      continue;
    }
    if (isNum(raw)) {
      // 契约：入库一律毫米。数字按毫米处理。
      out[key] = { known: true, mm: Math.round(raw), cm: mmToCm(raw), skipped: false, estimate: false, rangeCm: null };
      continue;
    }
    if (typeof raw === 'object') {
      const mm = isNum(raw.valueMm) ? Math.round(raw.valueMm) : isNum(raw.valueCm) ? cmToMm(raw.valueCm) : null;
      const skipped = raw.skipped === true;
      const estimate = raw.estimate === true;
      const rangeCm =
        Array.isArray(raw.rangeCm) && raw.rangeCm.length === 2 && raw.rangeCm.every((v) => isNum(v))
          ? [Math.min(raw.rangeCm[0], raw.rangeCm[1]), Math.max(raw.rangeCm[0], raw.rangeCm[1])]
          : null;
      out[key] = {
        known: (mm != null || rangeCm != null) && !skipped,
        mm: skipped ? null : mm != null ? mm : rangeCm ? cmToMm(rangeCm[0]) : null,
        cm: skipped ? null : mm != null ? mmToCm(mm) : rangeCm ? rangeCm[0] : null,
        skipped,
        estimate,
        rangeCm
      };
      continue;
    }
    out[key] = { known: false, mm: null, cm: null, skipped: false, estimate: false, rangeCm: null };
  }
  return out;
}

function keepsOf(session) {
  const arr = session && session.profile && Array.isArray(session.profile.keep) ? session.profile.keep : [];
  return arr
    .map((k) => (typeof k === 'string' ? k : k && (k.name || k.label || k.title)))
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim())
    .slice(0, 5);
}

// ---------- V2：证据目录、env、catFit ----------

const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const sliceText = (value, max) => Array.from(String(value == null ? '' : value).replace(/\s+/g, ' ').trim()).slice(0, max).join('');

/** 依据字段一律从 evidence.mjs 取，不在 rules 里手写依据文案 */
function evidenceFields(id, honest = false) {
  let e = null;
  try {
    e = compact(id);
  } catch {
    e = null;
  }
  if (!e) {
    try {
      e = compact(EVIDENCE_FALLBACK_ID);
    } catch {
      e = null;
    }
  }
  return {
    basisId: e ? e.id : EVIDENCE_FALLBACK_ID,
    strength: e ? e.strength : 'weak',
    basisText: e ? e.claim : '',
    honest: honest === true || (e ? e.kind === 'experience' : false)
  };
}

function normalizeEnv(raw, profile = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    floorType: oneOf(src.floorType, ['wood', 'tile', 'carpet', 'unknown'], oneOf(profile.floorType, ['wood', 'tile', 'carpet', 'unknown'], 'unknown')),
    nearAppliance: Array.isArray(src.nearAppliance)
      ? src.nearAppliance.filter((a) => Object.prototype.hasOwnProperty.call(APPLIANCE_LABELS, a)).slice(0, 3)
      : [],
    nearFood: src.nearFood === true,
    draft: src.draft === true,
    sunlight: oneOf(src.sunlight, ['none', 'indirect', 'direct'], 'none'),
    wallExterior: src.wallExterior === true,
    note: sliceText(src.note, 60)
  };
}

/** 读取并收敛 L0 照片环境字段（模型只看照片能看出来的） */
export function applyEnv(session = {}) {
  const l0 = session && session.l0 && typeof session.l0 === 'object' ? session.l0 : {};
  return normalizeEnv(l0.env, (session && session.profile) || {});
}

function skuOfItem(item) {
  if (!item || typeof item !== 'object') return null;
  return item.sku ? SKU_BY_ID.get(item.sku) || null : null;
}

function categoryOfItem(item) {
  const sku = skuOfItem(item);
  if (sku && sku.category) return sku.category;
  const text = `${item.title || ''} ${(Array.isArray(item.tags) ? item.tags : []).join(' ')}`;
  if (/砂盆|厕所/.test(text)) return '猫砂盆';
  if (/抓板|猫抓/.test(text)) return '猫抓板';
  if (/爬架|跳台|栖架/.test(text)) return '猫爬架';
  return '猫窝';
}

function catFitTagsOf(item) {
  const sku = skuOfItem(item);
  return sku && Array.isArray(sku.catFitTags) ? sku.catFitTags : [];
}

function catFitItem(key, status, why, basisId, honest = false) {
  return {
    key,
    label: CATFIT_KEY_LABELS[key],
    status,
    why: sliceText(why, CATFIT_WHY_MAX),
    ...evidenceFields(basisId, honest)
  };
}

// 位置否决时的短阻断句（≤24 字），用于 headline「先别放：…」
function blockReasonFor(item, env) {
  if (item && item.key === 'litter' && item.basisId === 'LITTER_NEAR_APPLIANCE') {
    const labels = env.nearAppliance.map((a) => APPLIANCE_LABELS[a]).filter(Boolean).join('、') || '家电';
    return `旁边是${labels}，猫会不敢上厕所`;
  }
  if (item && /NEAR_FOOD/.test(item.basisId || '')) return '砂盆挨着食盆，猫会避开这个位置';
  return shortLabel(item && item.why ? item.why : '位置条件不支持', 24);
}

/**
 * V2 核心：按 AAFP/ISFM 五支柱拆成 6 个可判定项。verdict 由确定性规则计算，不由模型自评。
 * @returns {{verdict:'good'|'caution'|'poor'|'unknown', items:Array}}
 */
export function computeCatFit(payload = {}, session = {}) {
  const profile = (session && session.profile) || {};
  const env = applyEnv(session);
  const items = Array.isArray(payload.items) ? payload.items.filter((i) => i && typeof i === 'object') : [];
  const cats = Math.max(1, Math.round(isNum(profile.cats) ? profile.cats : 1));
  const multiCat = profile.multiCat === true || cats > 1;
  const catSize = oneOf(profile.catSize, ['small', 'medium', 'large'], 'medium');
  const bodyCm = CAT_SIZE_BODY_CM[catSize];
  const dir = chosenDirection(session);

  const pathText = [
    dir && dir.title,
    dir && dir.pitch,
    ...(Array.isArray(payload.annotations) ? payload.annotations.map((a) => `${(a && a.label) || ''} ${(a && a.note) || ''}`) : []),
    ...(Array.isArray(payload.checklist) ? payload.checklist.map((c) => c && c.text) : []),
    session && session.l0 && session.l0.scene && session.l0.scene.summary,
    ...(session && session.l0 && Array.isArray(session.l0.regions) ? session.l0.regions.map((r) => r && r.label) : []),
    payload.headline
  ]
    .filter((x) => typeof x === 'string' && x)
    .join(' ');

  const byCategory = (cat) => items.filter((it) => categoryOfItem(it) === cat);
  const litterItems = byCategory('猫砂盆');
  const scratchItems = items.filter((it) => categoryOfItem(it) === '猫抓板' || catFitTagsOf(it).includes('scratch'));
  const perchItems = items.filter((it) => categoryOfItem(it) === '猫爬架' || catFitTagsOf(it).includes('vertical'));
  const hidingItems = items.filter((it) => catFitTagsOf(it).includes('hiding') || catFitTagsOf(it).includes('enclosed') || /半包|全包|封闭/.test(it.title || ''));
  const restItems = items.filter(
    (it) => categoryOfItem(it) === '猫窝' || categoryOfItem(it) === '猫爬架' || catFitTagsOf(it).includes('rest') || catFitTagsOf(it).includes('hiding')
  );
  const categorySet = new Set(items.map((it) => categoryOfItem(it)));
  const planCategoryLabel =
    litterItems.length && !restItems.length && !scratchItems.length
      ? '砂盆'
      : scratchItems.length && !restItems.length && !litterItems.length
        ? '抓板'
        : perchItems.length && !restItems.length
          ? '高位方案'
          : '用品';

  // 1) hide：能藏的地方（关键项）；本方案不涉及休息点则标 na，不能套猫窝模板
  let hide;
  if (!items.length) {
    hide = catFitItem('hide', 'na', '这次方案还没定物品，先不做藏身判断', 'NA-RULE');
  } else if (!restItems.length) {
    hide = catFitItem('hide', 'na', `这次方案是${planCategoryLabel}，不涉及休息点`, 'NA-RULE');
  } else if (!hidingItems.length) {
    hide = catFitItem('hide', 'warn', '只有开放式垫子，没有三面遮挡，猫不会把它当藏身处', 'HIDING_ENCLOSURE');
  } else if (multiCat && hidingItems.length < cats) {
    hide = catFitItem('hide', 'warn', `多猫家庭这一处只算一个藏身处，建议至少 ${cats} 处分开摆`, 'HIDING_PLACE_COUNT');
  } else {
    hide = catFitItem('hide', 'pass', '半包结构三面遮挡，猫能缩进去闭眼睡，适应期也会更短', 'HIDING_BOX_EFFECT');
  }

  // 2) resources：资源是否分开；不涉及就 na
  let resources;
  if (!items.length) {
    resources = catFitItem('resources', 'na', '这次方案还没定物品，先不做资源判断', 'NA-RULE');
  } else if (litterItems.length && env.nearFood) {
    resources = catFitItem('resources', 'fail', '砂盆和食盆在同一角落，猫会避开这个厕所，可能转去沙发', 'LITTER_NEAR_FOOD');
  } else if (env.nearFood) {
    resources = catFitItem('resources', 'warn', '落点旁边就是食盆水碗，猫不会在吃饭的地方久待', 'LITTER_NEAR_FOOD');
  } else if (multiCat) {
    resources = catFitItem('resources', 'warn', '多猫家庭资源要分处，这一处只覆盖一个休息点', 'MULTICAT_SEPARATION');
  } else if (litterItems.length) {
    resources = catFitItem('resources', 'pass', '照片里落点没和食盆水碗挤在同一角落，资源是分开的', 'LITTER_NEAR_FOOD');
  } else {
    resources = catFitItem('resources', 'pass', '这个角落只做一个功能，照片里没看到水和食盆挤在一起', 'MULTICAT_SEPARATION');
  }

  // 3) litter：砂盆条件（关键项）；本方案不放砂盆 → na（不能虚假绿色）
  const applianceLabels = env.nearAppliance.map((a) => APPLIANCE_LABELS[a]).join('、');
  let litter;
  if (!litterItems.length) {
    litter = catFitItem('litter', 'na', '这次方案不涉及砂盆，换砂盆方案时再看', 'NA-RULE');
  } else if (applianceLabels) {
    litter = catFitItem('litter', 'fail', `落点旁边是${applianceLabels}，突然的响声会让猫不敢来上厕所`, 'LITTER_NEAR_APPLIANCE');
  } else {
    const litterItem = litterItems[0];
    const sku = skuOfItem(litterItem);
    const dims = litterItem.dimsCm || {};
    const boxLen = Math.max(isNum(dims.w) ? dims.w : 0, isNum(dims.d) ? dims.d : 0);
    const boxW = Math.min(isNum(dims.w) ? dims.w : 0, isNum(dims.d) ? dims.d : 0);
    const minLen = round1(bodyCm * 1.5);
    const minW = round1(bodyCm * 1.2);
    const covered = (sku && sku.covered === true) || /封闭|顶入/.test(litterItem.title || '');
    if (boxLen < minLen || boxW < minW) {
      litter = catFitItem('litter', 'warn', `按${catSize}猫体长约${bodyCm}cm估算，盆长至少 ${minLen}cm、宽 ${minW}cm；这个偏小`, 'LITTER_BOX_SIZE');
    } else if (covered) {
      litter = catFitItem('litter', 'warn', '有盖盆能遮味也会闷味，只在尺寸够且每天铲 2 次时用', 'LITTER_COVERED');
    } else {
      litter = catFitItem('litter', 'pass', `盆长 ${boxLen}cm 够${catSize}猫转身，开放式也方便每天铲`, 'LITTER_BOX_SIZE');
    }
  }

  // 4) scratch：抓挠位置（核心评分项，位置优先于尺寸）；本方案不含抓板 → na
  let scratch;
  if (!scratchItems.length) {
    scratch = catFitItem('scratch', 'na', '这次方案不涉及抓板，换抓板方案时再看', 'NA-RULE');
  } else {
    const scratchItem = scratchItems[0];
    const sku = skuOfItem(scratchItem);
    const orient = sku && sku.orient ? sku.orient : 'horizontal';
    const onPath = /门口|门边|通道|沙发|床边|窗|客厅|动线|路过|睡醒|电视柜/.test(pathText);
    const farCorner = /墙角|角落|阳台|储物|储藏|没人/.test(pathText);
    if (farCorner && !onPath) {
      scratch = catFitItem('scratch', 'warn', '抓板别塞进没人去的角落；猫只在每天路过的地方伸爪', 'SCRATCH_POST_LOCATION');
    } else if (onPath) {
      scratch = catFitItem('scratch', 'pass', '抓板放在沙发/门口这类动线上，猫路过就会顺手抓两下', 'SCRATCH_POST_LOCATION');
    } else {
      scratch = catFitItem('scratch', 'warn', '照片只能估动线，先放猫每天经过的位置，别放角落', 'SCRATCH_POST_LOCATION');
    }
    if (scratch.status === 'pass' && orient === 'horizontal') {
      scratch = catFitItem('scratch', 'warn', '只有水平瓦楞板，缺竖直面，猫没法把身体整个拉长', 'SCRATCH_POST_FORM');
    } else if (scratch.status === 'pass' && (orient === 'vertical' || orient === 'both')) {
      scratch = catFitItem('scratch', 'pass', '竖直麻绳面能让猫拉长身体并留气味，位置也在动线上', 'SCRATCH_POST_FORM');
    }
  }

  // 5) vertical：高处与栖架；本方案不含高位 → na
  let vertical;
  if (!perchItems.length) {
    vertical = catFitItem('vertical', 'na', '这次方案不涉及高位，先不做爬架判断', 'NA-RULE');
  } else {
    const perchItem = perchItems[0];
    const dims = perchItem.dimsCm || {};
    const platform = Math.max(isNum(dims.w) ? dims.w : 0, isNum(dims.d) ? dims.d : 0);
    if (perchItem.fit === 'blocked') {
      vertical = catFitItem('vertical', 'warn', '墙面固定和承重没确认，高位方案先不采用；落地款更稳', 'PERCH_SIZE');
    } else if (platform > 0 && platform < bodyCm) {
      vertical = catFitItem('vertical', 'warn', `按${catSize}猫体长约${bodyCm}cm估算，平台 ${platform}cm 摊不平`, 'PERCH_SIZE');
    } else {
      vertical = catFitItem('vertical', 'pass', `平台 ${platform}cm 够${catSize}猫摊平，靠墙半遮挡更稳`, 'PERCH_SIZE');
    }
  }

  // 6) climate：温度/日照/风
  let climate;
  const floor = env.floorType;
  if (floor === 'tile') {
    climate = catFitItem('climate', 'warn', '瓷砖地面凉，猫趴十分钟就换地方；垫一层隔热垫再放', 'DRAFT_AND_FLOOR');
  } else if (env.draft) {
    climate = catFitItem('climate', 'warn', '落点在风口，猫会挑没风的地方睡；先挡风再放窝', 'DRAFT_AND_FLOOR');
  } else if (floor === 'unknown') {
    climate = catFitItem('climate', 'unknown', '照片看不出地面材质和风，手摸一下地面温度再判断保暖', 'THERMAL_COMFORT');
  } else if (env.sunlight === 'direct') {
    climate = catFitItem('climate', 'pass', '有直射日照，这块地板更暖，猫会当暖炕；夏天注意西晒', 'SUNLIGHT_POSITION');
  } else if (profile.climate === 'cold' && env.sunlight === 'none') {
    climate = catFitItem('climate', 'warn', '猫的舒适温度比人高，这处没日照；加厚垫或移近暖气再试', 'THERMAL_COMFORT');
  } else {
    climate = catFitItem('climate', 'pass', '木地板/地毯比瓷砖暖，猫的舒适温度比人高，冬天再加厚垫', 'THERMAL_COMFORT');
  }

  const itemList = [hide, resources, litter, scratch, vertical, climate];
  const failCount = itemList.filter((i) => i.status === 'fail').length;
  const warnCount = itemList.filter((i) => i.status === 'warn').length;
  const passCount = itemList.filter((i) => i.status === 'pass').length;
  const keyUnknown = hide.status === 'unknown' || litter.status === 'unknown';
  let verdict = 'caution';
  if (failCount > 0) verdict = 'poor';
  else if (keyUnknown) verdict = 'unknown';
  else if (warnCount >= 2) verdict = 'caution';
  else if (passCount >= 4) verdict = 'good';
  return { verdict, items: itemList };
}

function isObservableSignal(text) {
  return typeof text === 'string' && /(\d+\s*天|三天|7 天|一周|次|没有主动|没有进去|停留|压痕|毛发)/.test(text);
}

function ensureBehavior(payload, catFit) {
  const raw = payload && payload.behavior && typeof payload.behavior === 'object' ? payload.behavior : {};
  const whyNotRaw = Array.isArray(raw.whyNot) ? raw.whyNot.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : [];
  const whyNot = whyNotRaw.length
    ? whyNotRaw.map((x) => sliceText(x, 40))
    : catFit.items.filter((i) => i.status === 'warn' || i.status === 'fail').slice(0, 3).map((i) => sliceText(i.why, 40));
  const scratch = catFit.items.find((i) => i.key === 'scratch');
  const hide = catFit.items.find((i) => i.key === 'hide');
  const likelyUse =
    typeof raw.likelyUse === 'string' && raw.likelyUse.trim()
      ? sliceText(raw.likelyUse, 40)
      : hide && hide.status === 'pass'
        ? '大概率会当成睡觉的藏身处，白天大部分时间待在里面'
        : scratch && scratch.status === 'pass'
          ? '更可能被当成磨爪点，睡不睡要看适应期'
          : '先当休息点试摆，前 3 天不用不算失败';
  // firstSign 必须是可观察信号，不能是「看猫喜不喜欢」
  const firstSign =
    typeof raw.firstSign === 'string' && raw.firstSign.trim() && isObservableSignal(raw.firstSign)
      ? sliceText(raw.firstSign, 40)
      : '第 3 天还没主动停留超过 10 秒，先别挪，等到第 7 天再判断';
  return { likelyUse, whyNot, firstSign };
}

const DEFAULT_OBSERVE = Object.freeze([
  {
    day: 1,
    title: '第 1 天',
    checks: ['把旧垫子或猫蹭过的布放进新位置，别洗掉气味', '看它是否愿意在新位置停留 10 秒以上']
  },
  {
    day: 3,
    title: '第 3 天',
    checks: ['3 天内不用不算失败：猫适应以天计，先别挪位置', '看窝垫上有没有压痕或毛']
  },
  {
    day: 7,
    title: '第 7 天',
    checks: ['主动使用 ≥2 次就保留；0 次就执行下面的 if-then', '拍照记录位置，确认没有挡路']
  }
]);

function ensureObserve(payload) {
  const saved = Array.isArray(payload && payload.observe) ? payload.observe.filter((o) => o && typeof o === 'object') : [];
  const out = DEFAULT_OBSERVE.map((def) => {
    const found = saved.find((o) => Number(o.day) === def.day);
    if (!found) return { day: def.day, title: def.title, checks: [...def.checks] };
    const checks = (Array.isArray(found.checks) ? found.checks : [])
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => sliceText(c, 40))
      .slice(0, 4);
    return { day: def.day, title: sliceText(found.title, 12) || def.title, checks };
  });
  const day1 = out.find((o) => o.day === 1);
  if (!day1.checks.some((c) => /气味|旧垫|擦/.test(c))) {
    day1.checks.unshift('把旧垫子或猫蹭过的布放进新位置，别洗掉气味');
  }
  // 第 1 天留一个二选一计划句（II-2：先做一次时间选择）
  if (!day1.checks.some((c) => /(今天|周末|周[一二三四五六日]).*(做|量|试|开始|去)/.test(c))) {
    day1.checks.push('今天做还是周末做？先选一个时间，再把窝挪到位');
  }
  day1.checks = day1.checks.slice(0, 4);
  const day3 = out.find((o) => o.day === 3);
  if (!day3.checks.some((c) => /(3\s*天|三天).*不算失败/.test(c))) {
    day3.checks.unshift('3 天内不用不算失败：猫适应以天计，先别挪位置');
  }
  day3.checks = day3.checks.slice(0, 4);
  const day7 = out.find((o) => o.day === 7);
  if (!day7.checks.some((c) => /主动使用.*(≥|>=|至少|2\s*次|次数)/.test(c))) {
    day7.checks.push('主动使用次数 ≥2 次就保留；0 次就执行 ifThen');
  }
  day7.checks = day7.checks.slice(0, 4);
  return out;
}

function isPlanSentence(text) {
  const len = Array.from(String(text || '')).length;
  return (
    len >= 8 &&
    len <= 40 &&
    !/[\d×≥≤<>/．.、-]$/.test(String(text || '').trim()) &&
    /(周[一二三四五六日末]|今天|明天|周末|工作日|上午|下午|晚上)/.test(text) &&
    /(去|到|在)(店里|商店|网上|家|客厅|房间|此处|现场|宠物店)/.test(text) &&
    /(≥|≤|>\s*\d|<\s*\d|\d+\s*cm|进深|宽度|长度|尺寸|净宽)/.test(text)
  );
}

const CATEGORY_SHORT = Object.freeze({ 猫窝: '猫窝', 猫砂盆: '猫砂盆', 猫抓板: '抓板', 猫爬架: '爬架' });

function makePlanSentence(items, constraints) {
  const item = items.find((i) => i.fit === 'ok') || items[0];
  const cat = item ? CATEGORY_SHORT[categoryOfItem(item)] || '用品' : '用品';
  const cond =
    constraints.find((c) => c.key === 'freeDepth' && isNum(c.valueCm)) ||
    constraints.find((c) => c.key === 'cornerWidthA' && isNum(c.valueCm)) ||
    constraints.find((c) => isNum(c.valueCm));
  const text = cond
    ? sliceText(`周六上午去店里，先看${cond.label}≥${cond.valueCm}cm 的${cat}`, 40)
    : sliceText(`周六上午去店里，先确认尺寸条件再选${cat}`, 40);
  return { id: 'c0', text, critical: true };
}

function validIfClause(s) {
  return typeof s === 'string' && s.length >= 4 && s.length <= 40 && /(\d+\s*(天|次|周|小时)|\d+%|出现|留下|没有|超过|连续|每天|一周|三天|七天|尿|抓痕|压痕|毛发)/.test(s);
}

function validThenClause(s) {
  return (
    typeof s === 'string' &&
    s.length >= 4 &&
    s.length <= 30 &&
    !/(多观察|注意一下|留意|再看看|多种|同时|并且|，|,|；|;)/.test(s) &&
    /(挪|换|移|加|放|撤|关|开|擦|洗|清|铲|垫|挡|调|收|买|量|拍|改|用)/.test(s)
  );
}

function ifThenCategory(item) {
  const text = `${(item && item.if) || ''} ${(item && item.then) || ''}`;
  if (/抓板|抓痕/.test(text)) return 'scratch';
  if (/砂盆|尿|厕所/.test(text)) return 'litter';
  if (/使用|主动|趴进|停留/.test(text)) return 'use';
  if (/进去|窝垫|窝/.test(text)) return 'hide';
  return 'use';
}

function ensureIfThen(payload, catFit) {
  const scratch = catFit.items.find((i) => i.key === 'scratch');
  const litter = catFit.items.find((i) => i.key === 'litter');
  const hide = catFit.items.find((i) => i.key === 'hide');
  const statusByCat = { scratch: scratch && scratch.status, litter: litter && litter.status, hide: hide && hide.status };
  const saved = [];
  for (const x of Array.isArray(payload && payload.ifThen) ? payload.ifThen.slice(0, 3) : []) {
    if (!x || !validIfClause(x.if) || !validThenClause(x.then)) continue;
    const cat = ifThenCategory(x);
    // 不涉及的项（na）不应该出现在 ifThen 里
    if (statusByCat[cat] === 'na') continue;
    if (saved.some((s) => ifThenCategory(s) === cat)) continue;
    saved.push({ if: x.if, then: x.then });
  }
  if (saved.length >= 2) return saved;
  const candidates = [];
  if (scratch && (scratch.status === 'warn' || scratch.status === 'fail')) candidates.push({ if: '7 天内抓板没有新的抓痕', then: '把抓板挪到沙发旁或门口' });
  if (litter && (litter.status === 'warn' || litter.status === 'fail')) candidates.push({ if: '砂盆外出现尿块或猫反复进出砂盆', then: '先把砂盆移到远离家电的位置' });
  if (hide && (hide.status === 'warn' || hide.status === 'fail')) candidates.push({ if: '7 天内猫一次都没主动进去', then: '把窝挪到有背靠的墙角' });
  candidates.push({ if: '7 天内猫一次都没主动使用', then: '把窝换到更安静的角落' });
  candidates.push({ if: '第 7 天窝垫上还没有压痕或毛', then: '把旧垫子换成猫睡过的' });
  const usedCats = new Set(saved.map((s) => ifThenCategory(s)));
  for (const c of candidates) {
    if (saved.length >= 3) break;
    const cat = ifThenCategory(c);
    if (usedCats.has(cat)) continue;
    usedCats.add(cat);
    saved.push(c);
  }
  return saved.slice(0, 3);
}

function usedMeasurementsOf(session) {
  const src = (session && session.measurements) || {};
  const out = [];
  for (const key of MEASUREMENT_KEYS) {
    const raw = src[key];
    if (!raw || typeof raw !== 'object') continue;
    if (raw.source !== 'user' || !isNum(raw.valueMm) || raw.skipped === true) continue;
    out.push({ key, label: MEASUREMENT_SPECS[key].label, valueCm: mmToCm(raw.valueMm) });
  }
  return out;
}

function litterCountAdvice(session) {
  const profile = (session && session.profile) || {};
  const cats = Math.max(1, Math.round(isNum(profile.cats) ? profile.cats : 1));
  const suggested = cats > 1 ? cats + 1 : 2;
  const e = evidenceFields('LITTER_BOX_COUNT', true);
  return {
    basisId: e.basisId,
    strength: e.strength,
    basisText: e.basisText,
    honest: true,
    status: 'warn',
    suggested,
    text: `单猫建议 2 个砂盆分两处；多猫按猫数+1（${suggested} 个）只是经验值，不是不合格判定。`
  };
}

function textOf(value) {
  try {
    return JSON.stringify(value == null ? '' : value);
  } catch {
    return '';
  }
}

function validBbox(bbox) {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every(isNum) &&
    bbox[2] > 0.005 &&
    bbox[3] > 0.005 &&
    bbox[0] >= 0 &&
    bbox[1] >= 0 &&
    bbox[0] + bbox[2] <= 1.001 &&
    bbox[1] + bbox[3] <= 1.001
  );
}

function fallbackBbox(index) {
  const slots = [
    [0.28, 0.52, 0.24, 0.22],
    [0.56, 0.5, 0.22, 0.2],
    [0.4, 0.58, 0.2, 0.18],
    [0.16, 0.58, 0.2, 0.18],
    [0.68, 0.56, 0.18, 0.18]
  ];
  return [...(slots[index % slots.length] || slots[0])];
}

function overlapRatio(a, b) {
  if (!validBbox(a) || !validBbox(b)) return 0;
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const area = Math.min(a[2] * a[3], b[2] * b[3]);
  return area > 0 ? inter / area : 0;
}

function compare(actual, op, target) {
  if (!isNum(actual) || !isNum(target)) return false;
  if (op === '>=') return actual >= target;
  if (op === '<=') return actual <= target;
  if (op === '>') return actual > target;
  if (op === '<') return actual < target;
  if (op === '==') return Math.abs(actual - target) < 0.05;
  return false;
}

// ---------- quality ----------

function applyQuality(payload, session) {
  const q = { ...payload };
  q.scene = { ...(payload.scene || {}) };
  q.issues = Array.isArray(payload.issues) ? payload.issues.filter((i) => i && typeof i === 'object').slice(0, 6) : [];

  const has = (code) => q.issues.some((i) => i.code === code);
  const add = (issue) => {
    if (!has(issue.code)) q.issues.push(issue);
  };

  const metrics = session && session.metrics && typeof session.metrics === 'object' ? session.metrics : {};
  if (isNum(metrics.brightness) && metrics.brightness < 45) {
    add({ code: 'dark', label: '过暗', impact: 'high', hint: '开灯或白天重拍，让地面和墙角都看得清', severity: 'block' });
  }
  if (isNum(metrics.sharpness) && metrics.sharpness < 35) {
    add({ code: 'blurry', label: '有点糊', impact: 'mid', hint: '端稳手机，点一下屏幕对焦再拍', severity: 'warn' });
  }
  if (isNum(metrics.width) && metrics.width < 640) {
    add({ code: 'other', label: '照片太小', impact: 'low', hint: '传一张没压缩过的原图', severity: 'warn' });
  }
  if (q.scene.indoor === false) {
    add({ code: 'not_indoor', label: '不像室内', impact: 'high', hint: '拍家里的角落，别拍室外', severity: 'block' });
  }
  if (q.scene.floorVisible === false) {
    add({ code: 'no_floor', label: '看不到地面', impact: 'high', hint: '退后半步，把地面和墙脚都拍进来', severity: 'block' });
  }
  if (q.scene.cornerVisible === false) {
    add({ code: 'too_close', label: '看不到墙角', impact: 'mid', hint: '把要找的那个墙角放进画面中间', severity: 'block' });
  }
  if (q.scene.obstruction === 'heavy') {
    add({ code: 'occluded', label: '遮挡太多', impact: 'high', hint: '把挡视线的箱子/椅子挪开再拍，或换个角度', severity: 'block' });
  }

  const hasBlock = q.issues.some((i) => i.severity === 'block');
  if (hasBlock) {
    q.status = 'retake';
    q.score = clamp(Math.round(isNum(q.score) ? Math.min(q.score, 55) : 45), 0, 100);
  } else {
    q.status = 'pass';
    q.score = clamp(Math.round(isNum(q.score) ? q.score : 80), 0, 100);
  }
  if (q.status === 'retake' && !q.issues.length) {
    q.issues.push({
      code: 'other',
      label: '信息不够',
      impact: 'high',
      hint: '重拍一张能看到地面、墙角和整体空间的照片',
      severity: 'block'
    });
    q.score = clamp(Math.min(q.score, 55), 0, 100);
  }
  if (!Array.isArray(q.issues)) q.issues = [];
  return q;
}

// ---------- l0 ----------

function applyL0(payload, session) {
  const p = { ...payload };
  p.scene = { ...(payload.scene || {}) };
  p.regions = Array.isArray(payload.regions) ? payload.regions.filter((r) => r && typeof r === 'object').slice(0, 5) : [];
  p.directions = Array.isArray(payload.directions) ? payload.directions.filter((d) => d && typeof d === 'object').slice(0, 3) : [];
  p.missing = Array.isArray(payload.missing) ? payload.missing.filter((m) => m && typeof m === 'object').slice(0, 5) : [];

  const ms = measurementMap(session);
  const measuredCount = MEASUREMENT_KEYS.filter((k) => ms[k].known).length;

  if (session && session.quality && session.quality.status === 'retake') {
    p.verdict = 'insufficient';
    p.verdictReason = '照片还看不清，先把照片拍清楚再判断。';
  }
  if (!p.directions.length) p.verdict = 'insufficient';

  // 没量任何尺寸时：方向置信度不能是 high，视觉上「ok」的区域降为 conditional
  if (measuredCount === 0) {
    for (const d of p.directions) {
      if (d.confidence === 'high') d.confidence = 'medium';
    }
    for (const r of p.regions) {
      if (r.verdict === 'ok') r.verdict = 'conditional';
    }
  }

  // 保留物：L0 阶段必须被显式提到，否则不算「已考虑硬约束」
  const keeps = keepsOf(session);
  if (keeps.length) {
    const allText = textOf([p.scene, p.verdictReason, p.regions, p.directions, p.missing, p.nextAction, p.heatmapNote]);
    for (const keep of keeps) {
      if (!allText.includes(keep)) {
        p.missing.push({
          key: 'obstructionH',
          label: `保留物「${shortLabel(keep, 8)}」的高度与能否挪动`,
          why: '保留物是硬约束，挪不动就要排除这个区域'
        });
        for (const d of p.directions) {
          if (d.confidence === 'high') d.confidence = 'medium';
        }
      }
    }
  }

  // missing 去重，最多 4 条
  const seenMissing = new Set();
  p.missing = p.missing.filter((m) => {
    const k = `${m.key || ''}|${m.label || ''}`;
    if (seenMissing.has(k)) return false;
    seenMissing.add(k);
    return true;
  }).slice(0, 4);

  if (p.verdict === 'continue' && !p.directions.length) p.verdict = 'insufficient';

  // V2：env（照片可见的环境事实）+ 只推荐 1 个方向
  p.env = normalizeEnv(payload.env, (session && session.profile) || {});
  const rec = payload.recommend && typeof payload.recommend === 'object' ? payload.recommend : {};
  const dirIds = new Set(p.directions.map((d) => d.id));
  p.recommend = {
    directionId: dirIds.has(rec.directionId) ? rec.directionId : p.directions[0] ? p.directions[0].id : null,
    why: sliceText(rec.why, 40) || '这个方向改动成本最低，先试它',
    alternativesNote:
      sliceText(rec.alternativesNote, 40) ||
      (p.directions.length > 1 ? `另外 ${p.directions.length - 1} 个方向也可以，但要先量同一组尺寸` : '')
  };
  // primaryPain=有味道：确定性优先推荐砂盆方向（模型偶尔会推荐复用箱/猫窝方向）
  const profile = (session && session.profile) || {};
  if (profile.primaryPain === '有味道') {
    const litterDir = p.directions.find((d) =>
      /砂盆|厕所|便盆/.test(
        [d.title, d.pitch, ...(Array.isArray(d.itemsPreview) ? d.itemsPreview.map((x) => (x && x.title) || '') : [])].join(' ')
      )
    );
    if (litterDir && litterDir.id !== p.recommend.directionId) {
      p.recommend = { ...p.recommend, directionId: litterDir.id, why: '有味道优先看砂盆方向：先把厕所位置理顺' };
    }
  }
  // 至少 1 个方向是「不花钱」的复用方向（PRODUCT-V2 硬要求）
  if (p.directions.length && !p.directions.some((d) => d.kit === 'reuse')) {
    const target = p.directions.find((d) => d.kit === 'mix') || p.directions[p.directions.length - 1];
    target.kit = 'reuse';
    if (!Array.isArray(target.itemsPreview)) target.itemsPreview = [];
    if (!target.itemsPreview.some((x) => x && x.type === 'reuse')) {
      target.itemsPreview = [{ title: '复用现有用品', type: 'reuse' }, ...target.itemsPreview].slice(0, 2);
    }
  }
  // V2.1：一句具体指认 + 一句专业边界
  p.recognition =
    sliceText(payload.recognition, 30) ||
    sliceText(`${p.scene.roomGuess || ''}${p.regions[0] ? '的' + p.regions[0].label : '的这个角落'}`, 30) ||
    '照片里的这个室内角落，地面和墙脚可见';
  p.boundary =
    sliceText(payload.boundary, 40) ||
    '照片看不出进深，这一步只能给方向，能不能放下要量过才算';
  return p;
}

// ---------- measure ----------

function questionFromSpec(key) {
  const spec = MEASUREMENT_SPECS[key];
  return {
    key,
    label: spec.label,
    endpoints: spec.endpoints,
    unit: 'cm',
    why: spec.why,
    hint: spec.hint,
    example: key === 'corridorWidth' ? '约 62' : '约 80',
    optional: false
  };
}

function chosenDirection(session) {
  const l0 = session && session.l0 ? session.l0 : null;
  const dirs = l0 && Array.isArray(l0.directions) ? l0.directions.filter((d) => d && typeof d === 'object') : [];
  if (!dirs.length) return null;
  const id =
    (session && (session.chosenDirectionId || session.selectedDirectionId || session.directionId)) ||
    (l0 && l0.recommend && l0.recommend.directionId) ||
    null;
  return dirs.find((d) => d.id === id) || dirs[0];
}

// 收敛集合：关键地面尺寸 + 当前方向第一步 + L0 缺失项。measure 只能问这些，问完就结束。
export function measureTargetKeys(session) {
  const target = new Set(FLOOR_REQUIRED_KEYS);
  const dir = chosenDirection(session);
  if (dir && Array.isArray(dir.firstMeasurements)) {
    for (const f of dir.firstMeasurements) {
      const key = f && (typeof f === 'string' ? f : f.key);
      if (MEASUREMENT_SPECS[key]) target.add(key);
    }
  }
  const l0 = session && session.l0 ? session.l0 : null;
  for (const m of l0 && Array.isArray(l0.missing) ? l0.missing : []) {
    if (m && MEASUREMENT_SPECS[m.key]) target.add(m.key);
  }
  return [...target];
}

function applyMeasure(payload, session) {
  const p = { ...payload };
  const ms = measurementMap(session);
  const attempted = new Set(MEASUREMENT_KEYS.filter((k) => ms[k].mm != null || ms[k].skipped));
  p.round = (session && Array.isArray(session.asks) ? session.asks.length : 0) + 1;

  // 用户已声明结束：直接收敛
  if (session && session.measureDone === true) {
    const targetKeys = measureTargetKeys(session);
    p.questions = [];
    p.remainingKeys = [];
    p.totalTargets = targetKeys.length;
    p.attemptedTargets = targetKeys.length;
    p.askNote = '关键尺寸已齐，可以出方案了。';
    return p;
  }

  const targetKeys = measureTargetKeys(session);
  const targetSet = new Set(targetKeys);

  // 只允许问 target 内、还没 attempted 的 key；模型问到范围外的题直接丢掉
  const questions = [];
  for (const q of Array.isArray(payload.questions) ? payload.questions : []) {
    if (!q || typeof q !== 'object' || !MEASUREMENT_SPECS[q.key]) continue;
    if (!targetSet.has(q.key) || attempted.has(q.key)) continue;
    if (questions.some((x) => x.key === q.key)) continue;
    questions.push({ ...q, unit: 'cm' });
    if (questions.length >= 2) break;
  }
  // 不足 2 题时，从 target 里补还没 attempted 的
  for (const key of targetKeys) {
    if (questions.length >= 2) break;
    if (attempted.has(key) || questions.some((q) => q.key === key)) continue;
    questions.push(questionFromSpec(key));
  }

  // 方案第一步要量的 key 不能标成可选
  const critical = new Set(FLOOR_REQUIRED_KEYS);
  const dir = chosenDirection(session);
  if (dir && Array.isArray(dir.firstMeasurements)) {
    for (const f of dir.firstMeasurements) {
      const key = f && (typeof f === 'string' ? f : f.key);
      if (MEASUREMENT_SPECS[key]) critical.add(key);
    }
  }
  for (const q of questions) {
    q.optional = critical.has(q.key) ? false : q.optional === true;
  }

  p.questions = questions.slice(0, 2);
  // 进度环分母 = target 中尚未 attempted 的 key（含本轮要问的），保证单调收敛
  p.remainingKeys = targetKeys.filter((k) => !attempted.has(k));
  // V2.1 真实进度：照片算 1 步，target 是剩余步数
  p.totalTargets = targetKeys.length;
  p.attemptedTargets = targetKeys.filter((k) => attempted.has(k)).length;
  p.askNote = p.questions.length
    ? (p.questions.length > 1 ? '这轮先量这两个就够。' : '这轮先量这一个就够。')
    : '关键尺寸已齐，可以出方案了。';
  return p;
}

// ---------- plan ----------

function checkFit(item, category, ms, sku) {
  const dims = item.dimsCm && typeof item.dimsCm === 'object' ? item.dimsCm : {};
  if (![dims.w, dims.d, dims.h].every((v) => isNum(v) && v > 0)) {
    return { fit: 'blocked', reason: 'dims_missing', note: '尺寸未记录；先量外径和占地，记录后再评估' };
  }
  if (sku && ((sku.tags || []).some((t) => /吸盘|窗台/.test(t)) || /窗台|吸盘/.test(item.title || ''))) {
    return { fit: 'blocked', reason: 'install', note: '需窗台/玻璃安装；有窗台进深和吸附条件才可行' };
  }
  if (category === '猫爬架') {
    return { fit: 'blocked', reason: 'wall', note: '墙面固定与承重未知；确认墙体和固定方式后再评估' };
  }

  const needW = Math.min(dims.w, dims.d); // 按可旋转 90° 估算
  const needD = Math.max(dims.w, dims.d);
  const missing = FLOOR_REQUIRED_KEYS.filter((k) => ms[k].mm == null);
  if (missing.length) {
    return {
      fit: 'blocked',
      reason: 'missing_measure',
      note: `还缺「${missing.map((k) => MEASUREMENT_SPECS[k].label).join('、')}」；补齐后按尺寸复算`
    };
  }
  // 通道 60cm 是经验值（PASSAGE_WIDTH），只做 warn 提示，不参与 fit 阻断，
  // 否则等于用一条无实证的阈值判「不合格」（见 docs/RESEARCH-CAT.md §3）。
  if (ms.cornerWidthA.mm < cmToMm(needW)) {
    return { fit: 'blocked', reason: 'width', note: `可用宽度 ${ms.cornerWidthA.cm}cm，小于需要的 ${needW}cm；需换宽度 ≤${ms.cornerWidthA.cm}cm 的款` };
  }
  if (ms.freeDepth.mm < cmToMm(needD)) {
    return { fit: 'blocked', reason: 'depth', note: `可用进深 ${ms.freeDepth.cm}cm，小于需要的 ${needD}cm；需换进深 ≤${ms.freeDepth.cm}cm 的款` };
  }
  return { fit: 'ok', reason: 'ok', note: `宽 ${needW}cm、深 ${needD}cm，通道剩 ${ms.corridorWidth.cm}cm` };
}

function constraintFor(key, op, valueCm, ms, basisId, why = '') {
  const entry = ms[key] || { cm: null, estimate: false, rangeCm: null };
  let actualCm = entry.cm;
  const estimate = entry.estimate === true;
  // 区间估计按保守端：>= 取区间下界，<= 取区间上界（契约 §2.11）
  if (estimate && Array.isArray(entry.rangeCm)) {
    actualCm = op === '<=' ? entry.rangeCm[1] : entry.rangeCm[0];
  }
  let status = actualCm == null ? 'unknown' : compare(actualCm, op, valueCm) ? 'pass' : 'fail';
  let note = actualCm == null ? '还没量，不能确认' : '';
  if (estimate && actualCm != null) note = `按 ${actualCm}cm 保守估算`;
  // PASSAGE_WIDTH 只是经验阈值：永远不给 fail，最多 warn，并标 honest
  if (basisId === 'PASSAGE_WIDTH' && status === 'fail') {
    status = 'warn';
    note = estimate && actualCm != null
      ? `按 ${actualCm}cm 保守估算；经验阈值：低于 60cm 只建议观察猫愿不愿意通过，不判不合格`
      : '经验阈值：低于 60cm 只建议观察猫愿不愿意通过，不判不合格';
  }
  return {
    key,
    label: MEASUREMENT_SPECS[key].label,
    op,
    valueCm,
    actualCm: actualCm == null ? null : round1(actualCm),
    status,
    note,
    why,
    estimate,
    ...evidenceFields(
      basisId,
      basisId === 'PASSAGE_WIDTH' || basisId === 'PERCH_SIZE' || basisId === 'LITTER_BOX_SIZE' || basisId === 'REST_SIZE_STRETCH'
    )
  };
}

// 尺寸阈值推导：只来自 MEASUREMENT_SPECS 字典 + CAT_SIZE_BODY_CM 体长倍数
const CAT_SPACE_MULTIPLIER = Object.freeze({
  猫砂盆: { name: '砂盆', width: 1.2, depth: 1.5 },
  猫窝: { name: '休息点', width: 0.6, depth: 1.0 },
  猫爬架: { name: '栖架', width: 0.6, depth: 1.0 },
  猫抓板: { name: '抓板', width: 0.4, depth: 0.8 }
});

function applyPlan(payload, session) {
  const p = { ...payload };
  const ms = measurementMap(session);
  const profile = (session && session.profile) || {};
  const env = applyEnv(session);
  const catSize = oneOf(profile.catSize, ['small', 'medium', 'large'], 'medium');
  const bodyCm = CAT_SIZE_BODY_CM[catSize];
  const budgetCap = isNum(profile.budget) && profile.budget > 0 ? profile.budget : budgetFromGoal(profile.goal);
  const l0 = session && session.l0 ? session.l0 : null;
  const l0Regions = l0 && Array.isArray(l0.regions) ? l0.regions.filter((r) => validBbox(r.bbox)).slice(0, 5) : [];

  // 1) SKU 库门禁 + 尺寸以库为准 + 逐项 fit（输出体积上限：items ≤4）
  const rawItems = Array.isArray(payload.items) ? payload.items.filter((i) => i && typeof i === 'object').slice(0, 4) : [];
  const items = [];
  const categories = new Map();
  const fitReasons = new Map();
  const blocked = Array.isArray(payload.blocked)
    ? payload.blocked.filter((b) => b && typeof b === 'object').slice(0, 4)
    : [];
  let est = 0;

  for (const raw of rawItems) {
    const item = { ...raw };
    const type = item.type === 'reuse' ? 'reuse' : 'new';
    item.type = type;
    let sku = null;
    if (type === 'new') {
      sku = SKU_BY_ID.get(item.sku);
      if (!sku) {
        blocked.push({ what: shortLabel(item.title || '库外型号', 14), reason: '型号不在核对库内，L1 不采用' });
        continue;
      }
      // 库内数据覆盖模型给的商品字段，避免货不对板
      item.title = sku.title;
      item.dimsCm = { ...sku.dimsCm };
      item.price = sku.price;
      item.tags = Array.isArray(sku.tags) ? [...sku.tags] : [];
      est += isNum(sku.price) ? sku.price : 0;
    } else {
      item.sku = null;
      item.price = 0;
      if (!item.dimsCm || typeof item.dimsCm !== 'object') item.dimsCm = { w: 0, d: 0, h: 0 };
    }
    const category = sku ? sku.category : '猫窝';
    const fit = checkFit(item, category, ms, sku);
    item.fit = fit.fit;
    item.fitNote = fit.note;
    item.confidence = ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : fit.fit === 'ok' ? 'medium' : 'low';
    categories.set(item.id, category);
    fitReasons.set(item.id, fit.reason);
    items.push(item);
  }

  // 2) 预算（新品合计，复用按 0 元）
  const budget = {
    cap: budgetCap,
    est: round1(est),
    status: budgetCap != null && est > budgetCap ? 'over' : 'within'
  };

  // 3) 约束：全部由实测值重算；阈值只来自字典 + 体长倍数（why 里写推导）
  const constraints = [];
  const needW = items.length ? Math.max(...items.map((i) => Math.min(i.dimsCm.w, i.dimsCm.d))) : 0;
  const needD = items.length ? Math.max(...items.map((i) => Math.max(i.dimsCm.w, i.dimsCm.d))) : 0;
  const catSet = new Set(items.map((i) => categories.get(i.id)));
  let spaceBasis = 'REST_SIZE_STRETCH';
  if (catSet.has('猫砂盆')) spaceBasis = 'LITTER_BOX_SIZE';
  else if (catSet.has('猫爬架')) spaceBasis = 'PERCH_SIZE';
  else if (catSet.has('猫抓板') && !catSet.has('猫窝')) spaceBasis = 'SCRATCH_POST_LOCATION';
  const spaceReqs = [...catSet].map((cat) => {
    const m = CAT_SPACE_MULTIPLIER[cat] || CAT_SPACE_MULTIPLIER['猫窝'];
    return { name: m.name, width: round1(bodyCm * m.width), depth: round1(bodyCm * m.depth), multW: m.width, multD: m.depth };
  });
  const bodyNeedW = spaceReqs.length ? Math.max(...spaceReqs.map((r) => r.width)) : 0;
  const bodyNeedD = spaceReqs.length ? Math.max(...spaceReqs.map((r) => r.depth)) : 0;
  const reqW = round1(Math.max(needW, bodyNeedW));
  const reqD = round1(Math.max(needD, bodyNeedD));
  const spaceWhyW = spaceReqs.length
    ? `${spaceReqs.map((r) => `${r.name}：${catSize} 体长 ${bodyCm}cm × ${r.multW} = ${r.width}cm`).join('；')}；商品最小边 ${needW}cm，取大 ${reqW}cm`
    : `按 ${catSize} 体长 ${bodyCm}cm × 0.6 估算`;
  const spaceWhyD = spaceReqs.length
    ? `${spaceReqs.map((r) => `${r.name}：${catSize} 体长 ${bodyCm}cm × ${r.multD} = ${r.depth}cm`).join('；')}；商品最大边 ${needD}cm，取大 ${reqD}cm`
    : `按 ${catSize} 体长 ${bodyCm}cm × 1.0 估算`;
  constraints.push(constraintFor('corridorWidth', '>=', MEASUREMENT_SPECS.corridorWidth.minCmV, ms, 'PASSAGE_WIDTH', '经验阈值 60cm（PASSAGE_WIDTH 查无实证，只做提醒）'));
  if (reqW > 0) constraints.push(constraintFor('cornerWidthA', '>=', reqW, ms, spaceBasis, spaceWhyW));
  if (reqD > 0) constraints.push(constraintFor('freeDepth', '>=', reqD, ms, spaceBasis, spaceWhyD));
  // 兜底：任何一个关键尺寸没量且没有对应约束，也要列为 unknown（不能因为模型没给 items 就丢掉缺失信息）
  for (const key of FLOOR_REQUIRED_KEYS) {
    if (constraints.some((c) => c.key === key)) continue;
    if (ms[key].mm != null) continue;
    constraints.push({
      key,
      label: MEASUREMENT_SPECS[key].label,
      op: '>=',
      valueCm: null,
      actualCm: null,
      status: 'unknown',
      note: '还没量，不能确认',
      why: '关键尺寸缺失，先量再算',
      estimate: false,
      ...evidenceFields(key === 'corridorWidth' ? 'PASSAGE_WIDTH' : 'REST_SIZE_STRETCH', key !== 'corridorWidth')
    });
  }

  // 4) 标注：必须是有语义的框（输出上限：annotations ≤3）；模型框与候选区重叠不足一半时吸附过去
  let annotations = Array.isArray(payload.annotations)
    ? payload.annotations.filter((a) => a && typeof a === 'object' && validBbox(a.bbox)).slice(0, 3)
    : [];
  if (!annotations.length && items.length) {
    annotations = items.slice(0, 3).map((it, idx) => ({
      id: String(idx + 1),
      label: shortLabel(it.title, 10),
      bbox: l0Regions.length ? [...l0Regions[idx % l0Regions.length].bbox] : fallbackBbox(idx),
      note: it.fit === 'ok' ? it.fitNote : '先按标注位置确认'
    }));
  }
  annotations = annotations.map((a, idx) => {
    const bbox = [...a.bbox];
    // 与 L0 候选区重叠不足一半 → 视为「乱框」，吸附到最匹配的候选区，保证框落在墙角/家具上
    const bestOverlap = l0Regions.reduce((max, r) => Math.max(max, overlapRatio(bbox, r.bbox)), 0);
    if (bestOverlap < 0.5 && l0Regions.length) {
      const name = String(a.label || '');
      const byName = l0Regions.find((r) => {
        const rl = String(r.label || '');
        return (name && (rl.includes(name) || name.includes(rl))) || (/窝/.test(name) && /窝/.test(rl)) || (/抓/.test(name) && /抓/.test(rl));
      });
      const target = byName || l0Regions[idx % l0Regions.length];
      bbox[0] = target.bbox[0];
      bbox[1] = target.bbox[1];
      bbox[2] = target.bbox[2];
      bbox[3] = target.bbox[3];
    }
    return {
      id: String(idx + 1),
      label: shortLabel(a.label || (items[idx] && items[idx].title) || '标注', 10),
      bbox,
      note: typeof a.note === 'string' ? a.note : ''
    };
  });

  // 3b) 遮挡修正：env.note / 标注提示落点有杂物时，freeDepth 不能凭用户数字直接 pass
  const obstructionText = [
    String(env.note || ''),
    ...annotations.map((a) => `${a.label || ''} ${a.note || ''}`),
    ...l0Regions.map((r) => `${r.label || ''} ${r.why || ''} ${r.risk || ''}`)
  ].join(' ');
  const hasObstruction = /杂物|遮挡|挡住|挡着|衣架|纸箱|堆|清空|清走|挪开|移开/.test(obstructionText);
  if (hasObstruction) {
    const freeDepthConstraint = constraints.find((c) => c.key === 'freeDepth');
    // 落点前有杂物时，量到的数字可能量到杂物为止：pass/fail 都不可靠，统一降为 warn 并提示清空复测
    if (freeDepthConstraint && (freeDepthConstraint.status === 'pass' || freeDepthConstraint.status === 'fail')) {
      const wasFail = freeDepthConstraint.status === 'fail';
      freeDepthConstraint.status = 'warn';
      freeDepthConstraint.note = wasFail
        ? `原测 ${freeDepthConstraint.actualCm}cm 可能被杂物占用；落点前有杂物，实际可用进深要清空后复测`
        : '落点前有杂物，实际可用进深要清空后复测';
    }
  }

  // 5) 清单与阻断：关键尺寸未知 → 阻断 + 现场补量
  let checklist = Array.isArray(payload.checklist)
    ? payload.checklist.filter((c) => c && typeof c === 'object' && typeof c.text === 'string').slice(0, 6)
    : [];
  const nextCheckId = () => {
    let n = checklist.length + 1;
    while (checklist.some((c) => c.id === `c${n}`)) n += 1;
    return `c${n}`;
  };

  const unknownCritical = constraints.filter((c) => FLOOR_REQUIRED_KEYS.includes(c.key) && c.status === 'unknown');
  for (const c of unknownCritical) {
    blocked.push({ what: `关键尺寸「${c.label}」`, reason: '还没量到，不能定摆放' });
    checklist.push({
      id: nextCheckId(),
      text: `现场补量「${c.label}」：${MEASUREMENT_SPECS[c.key].endpoints}`,
      critical: true
    });
  }

  if (budget.status === 'over') {
    blocked.push({
      what: `预算 ${budgetCap} 元`,
      reason: `候选合计约 ${budget.est} 元，超出 ${round1(budget.est - budgetCap)} 元`
    });
    checklist.push({
      id: nextCheckId(),
      text: `预算超了：先复用旧物或换更便宜的组合，别硬凑`,
      critical: false
    });
  }

  // 6) 保留物：必须被方案显式处理，否则降级
  const keeps = keepsOf(session);
  const unaddressedKeeps = [];
  if (keeps.length) {
    const allText = textOf([items, annotations, checklist, blocked, p.headline, p.constraints]);
    for (const keep of keeps) {
      if (!allText.includes(keep)) unaddressedKeeps.push(keep);
    }
  }
  for (const keep of unaddressedKeeps) {
    checklist.push({
      id: nextCheckId(),
      text: `保留物「${shortLabel(keep, 8)}」：能挪就先挪开，不能挪就换点位`,
      critical: true
    });
  }

  // 7) 编号 ↔ 清单一一对应（AC08）
  for (const a of annotations) {
    const marker = `#${a.id}`;
    const covered = checklist.some((c) => String(c.text).includes(marker) || String(c.text).includes(a.label));
    if (!covered) {
      checklist.push({
        id: nextCheckId(),
        text: `按标注 ${marker} 核对「${a.label}」的实际位置`,
        critical: false
      });
    }
  }

  // 8) 去重 + 截断
  const seenCheck = new Set();
  checklist = checklist
    .filter((c) => {
      const text = String(c.text || '').trim();
      if (!text || seenCheck.has(text)) return false;
      seenCheck.add(text);
      return true;
    })
    .slice(0, 6);

  // V2.1：清单第一条必须是「计划句」（时间 + 地点 + 一个可核对条件）
  if (!checklist.length || !isPlanSentence(checklist[0].text)) {
    const ps = makePlanSentence(items, constraints);
    checklist = [ps, ...checklist.filter((c) => !isPlanSentence(c.text))].slice(0, 6);
  }

  // 9a) catFit 先算出来：位置已经否决（fail）时，方案不能继续鼓励「可试放」
  const catFit = computeCatFit({ ...p, items, annotations, checklist, headline: p.headline }, session);
  const catFailItem =
    catFit.items.find((i) => i.key === 'litter' && i.status === 'fail') ||
    catFit.items.find((i) => i.status === 'fail') ||
    null;
  const movePlanText = [p.headline, ...annotations.map((a) => `${a.label || ''} ${a.note || ''}`)].join(' ');
  const isMovePlan =
    /(换位置方案|移到|移开|换到|远离)/.test(movePlanText) && /(洗衣机|冰箱|食盆|家电|噪音|原位|原地)/.test(movePlanText);
  if (catFailItem && !isMovePlan) {
    blocked.push({ what: `位置否决：${catFailItem.label}`, reason: catFailItem.why });
    checklist.splice(1, 0, {
      id: nextCheckId(),
      text: `这个位置先别放：${shortLabel(catFailItem.why, 26)}`,
      critical: true
    });
    checklist = checklist.slice(0, 6);
  }
  const seenBlocked = new Set();
  const blockedOut = blocked
    .filter((b) => b.what && b.reason)
    .filter((b) => {
      const k = `${b.what}|${b.reason}`;
      if (seenBlocked.has(k)) return false;
      seenBlocked.add(k);
      return true;
    })
    .slice(0, 4);

  // 9) verdict：先按硬规则压低；关键约束全过且商品 fit=ok 时，至少给 conditional（保证 L1 可交付）
  let cap = 'ok';
  let reuseOnlyMissing = false;
  const allBlocked = items.length > 0 && items.every((i) => i.fit === 'blocked');
  const reasons = new Set(items.map((i) => fitReasons.get(i.id)));
  const onlyReuse = items.length > 0 && items.every((i) => i.type === 'reuse');
  const onlyDimsMissing = [...reasons].every((r) => r === 'dims_missing' || r === 'missing_measure');
  if (unknownCritical.length) cap = minVerdict(cap, 'insufficient');
  if (!items.length) cap = minVerdict(cap, 'insufficient');
  if (allBlocked) {
    if (onlyReuse && onlyDimsMissing) {
      cap = minVerdict(cap, 'insufficient');
      reuseOnlyMissing = true;
    } else {
      cap = minVerdict(cap, 'not_supported');
    }
  }
  if (budget.status === 'over') cap = minVerdict(cap, 'conditional');
  if (unaddressedKeeps.length) cap = minVerdict(cap, 'conditional');
  if (session && session.quality && session.quality.status === 'retake') cap = minVerdict(cap, 'insufficient');
  if (session && session.quality && session.quality.scene && session.quality.scene.obstruction === 'heavy') {
    cap = minVerdict(cap, 'conditional');
  }
  // 位置否决（catFit fail）：核心品类位置不成立 → 最高 not_supported；若是换位置方案才允许 conditional
  if (catFailItem) cap = minVerdict(cap, isMovePlan ? 'conditional' : 'not_supported');
  const modelVerdict = ['ok', 'conditional', 'not_supported', 'insufficient'].includes(p.verdict) ? p.verdict : 'insufficient';
  let verdict = minVerdict(modelVerdict, cap);

  // 可交付下限：三个关键尺寸都有值且约束通过 + 至少一个商品 fit=ok + 预算不超 + 保留物已处理 + 照片合格
  const criticalConstraints = constraints.filter((c) => FLOOR_REQUIRED_KEYS.includes(c.key));
  const criticalOk =
    criticalConstraints.length === FLOOR_REQUIRED_KEYS.length &&
    criticalConstraints.every((c) => (c.key === 'corridorWidth' ? ['pass', 'warn'].includes(c.status) : ['pass', 'warn'].includes(c.status)));
  const someFitOk = items.some((i) => i.fit === 'ok');
  const photoOk = !(session && session.quality && session.quality.status === 'retake');
  const deliverable =
    criticalOk && someFitOk && budget.status !== 'over' && unaddressedKeeps.length === 0 && photoOk && !reuseOnlyMissing && !(catFailItem && !isMovePlan);
  if (deliverable && (verdict === 'insufficient' || verdict === 'not_supported')) verdict = 'conditional';
  p.verdict = verdict;

  // 10) headline 与 verdict 严格一致（不能一边不许放一边写「可以放」）
  let headline = typeof p.headline === 'string' ? p.headline.trim() : '';
  const placeWords = /(完全可以|可以放|能放|可换|能换|放得下|可行|没问题|推荐)/;
  const strongCondition = /(但|满足|才可|条件|若|如果|需要先|先看|先量)/;
  if (verdict === 'insufficient') {
    if (session && session.quality && session.quality.status === 'retake') {
      headline = '照片不合格，先重拍再定';
    } else if (unknownCritical.length) {
      headline = `还差「${unknownCritical.slice(0, 2).map((c) => c.label).join('、')}」没量，先别定`;
    } else if (reuseOnlyMissing) {
      headline = '先量现有物品的外径和占地，再定复用';
    } else if (!headline || placeWords.test(headline) || !/(还差|没量|缺|未量|先别|需先|量完)/.test(headline)) {
      headline = '关键尺寸没量全，先别定摆放';
    }
  } else if (verdict === 'not_supported') {
    const failed = constraints.find((c) => c.status === 'fail');
    if (catFailItem && !isMovePlan) {
      headline = `先别放：${blockReasonFor(catFailItem, env)}`;
    } else if (failed) {
      headline = `先别放：${failed.label}只有 ${failed.actualCm}cm，不够`;
    } else if (!headline || !/^(不可|不建议|先别|别|需换|当前条件不支持)/.test(headline)) {
      headline = '当前条件不支持，先别放';
    }
  } else if (verdict === 'conditional') {
    // conditional = 有条件可放：肯定词必须配一个条件；否则换成中性条件句
    if (isMovePlan && catFailItem) {
      headline = '换位置方案：别原地放，移到远离噪音或食盆的位置';
    } else if (!headline || /(完全可以|没问题|一定|还差|没量|缺|照片不合格)/.test(headline) || (placeWords.test(headline) && !strongCondition.test(headline))) {
      headline = '满足下列条件才可放，先看尺寸条件';
    }
  } else if (verdict === 'ok') {
    if (!headline || /^(不|别|先别)/.test(headline)) headline = '条件够，按尺寸选款';
  }
  if (!headline) {
    if (verdict === 'ok') headline = '条件够，按尺寸选款';
    else if (verdict === 'conditional') headline = '能放，但要先满足下面这些条件';
    else if (verdict === 'not_supported') headline = '当前条件不支持，先别放';
    else headline = '关键尺寸没量全，先别定摆放';
  }
  if (Array.from(headline).length > 30) headline = Array.from(headline).slice(0, 30).join('');

  // 11) 猫视角雷达：固定五维，0—5 整数，标注非实测
  const radarIn = Array.isArray(payload.radar) ? payload.radar : [];
  const radar = RADAR_SPECS.map((spec) => {
    const found = radarIn.find((r) => r && (r.key === spec.key || r.label === spec.label));
    const score = found && isNum(found.score) ? clamp(Math.round(found.score), 0, 5) : 3;
    const note = found && typeof found.note === 'string' && found.note.trim() ? found.note.trim() : DEFAULT_RADAR_NOTE;
    return { key: spec.key, label: spec.label, score, note };
  });

  // 12) 回访与免责
  const aftercareIn = payload.aftercare && typeof payload.aftercare === 'object' ? payload.aftercare : {};
  const aftercare = {
    day7: typeof aftercareIn.day7 === 'string' && aftercareIn.day7.trim() ? aftercareIn.day7.trim() : DEFAULT_AFTERCARE.day7,
    day14: typeof aftercareIn.day14 === 'string' && aftercareIn.day14.trim() ? aftercareIn.day14.trim() : DEFAULT_AFTERCARE.day14
  };

  p.budget = budget;
  p.annotations = annotations;
  p.items = items;
  p.constraints = constraints;
  p.checklist = checklist;
  p.blocked = blockedOut;
  p.radar = radar;
  p.aftercare = aftercare;
  p.headline = headline;
  p.disclaimer = L1_DISCLAIMER;

  // 13) V2：catFit（上面已算好，位置否决已参与 verdict）、行为预测、观察清单、if-then、归属、砂盆数量软建议
  p.catFit = catFit;
  p.behavior = ensureBehavior(payload, catFit);
  p.observe = ensureObserve(payload);
  p.ifThen = ensureIfThen(payload, catFit);
  p.usedMeasurements = usedMeasurementsOf(session);
  p.litterCount = litterCountAdvice(session);
  return p;
}

// ---------- ask（Lead 约定：{reply, verdict, pieces, missing}） ----------

const ASK_RANK = Object.freeze({ ok: 3, conditional: 2, blocked: 1, insufficient: 0 });

function applyAsk(payload, session) {
  const p = { ...payload };
  p.pieces = Array.isArray(payload.pieces) ? payload.pieces.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4) : [];
  p.missing = Array.isArray(payload.missing) ? payload.missing.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : [];

  const ms = measurementMap(session);
  const unknownCritical = FLOOR_REQUIRED_KEYS.filter((k) => ms[k].mm == null);
  let verdict = Object.prototype.hasOwnProperty.call(ASK_RANK, p.verdict) ? p.verdict : 'insufficient';

  // 没量关键尺寸 → 最多 conditional；照片不合格或没有点选 → insufficient
  let cap = 'ok';
  if (unknownCritical.length) cap = 'conditional';
  if (session && session.quality && session.quality.status === 'retake') cap = 'insufficient';
  if (!p.reply) verdict = 'insufficient';
  p.verdict = ASK_RANK[verdict] <= ASK_RANK[cap] ? verdict : cap;

  if (!p.pieces.length) {
    p.pieces.push(unknownCritical.length ? '照片能看到位置，但关键尺寸还没量' : '按照片能判断方向，具体尺寸还要现场确认');
  }
  if (!p.missing.length && unknownCritical.length) {
    p.missing = unknownCritical.map((k) => MEASUREMENT_SPECS[k].label).slice(0, 3);
  }
  return p;
}

function pickOf(session) {
  const cands = [session && session.pick, session && session.currentPick, session && session.pickPoint];
  if (session && Array.isArray(session.picks) && session.picks.length) cands.push(session.picks[session.picks.length - 1]);
  for (const c of cands) {
    if (c && isNum(c.nx) && isNum(c.ny)) return { nx: clamp(c.nx, 0, 1), ny: clamp(c.ny, 0, 1) };
  }
  return null;
}

function bboxAroundPick(pick) {
  const w = 0.16;
  const h = 0.16;
  return [clamp(pick.nx - w / 2, 0, 1 - w), clamp(pick.ny - h / 2, 0, 1 - h), w, h];
}

// ---------- 对外入口 ----------

export function apply(stage, payload, session = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  try {
    switch (stage) {
      case 'quality':
        return applyQuality(p, session);
      case 'l0':
        return applyL0(p, session);
      case 'measure':
        return applyMeasure(p, session);
      case 'plan':
        return applyPlan(p, session);
      case 'ask':
        return applyAsk(p, session);
      default:
        return p;
    }
  } catch {
    // 规则层永远不抛错：出问题就交给 normalize 的兜底结构
    return p;
  }
}

export const __internals = Object.freeze({ measurementMap, checkFit, keepsOf, validBbox });
