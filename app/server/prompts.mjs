// 猫角落 Corner · 提示词与输出归一化
// 导出：buildRequest(stage, session) / normalize(stage, raw, session)
// 约定：图片由调用方注入 session.image.absPath（本地 jpg），本模块用 fs 读成 base64 dataURL。
// 本模块加载时无 I/O（只有被调用时才读图片文件）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEASUREMENT_SPECS,
  MEASUREMENT_KEYS,
  FLOOR_REQUIRED_KEYS,
  RADAR_SPECS,
  SKU_BY_ID,
  CAT_SIZE_BODY_CM,
  measureTargetKeys,
  L0_DISCLAIMER,
  L1_DISCLAIMER,
  budgetFromGoal
} from './rules.mjs';
import { allEvidence } from './evidence.mjs';

export { L0_DISCLAIMER, L1_DISCLAIMER };
export const DISCLAIMER_L0 = L0_DISCLAIMER;
export const DISCLAIMER_L1 = L1_DISCLAIMER;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGES = Object.freeze(['quality', 'l0', 'measure', 'plan', 'ask']);

// ---------- 文案清洗 ----------

const BANNED_WORDS = [
  ['赋能', '协助'],
  ['打造', '布置'],
  ['极致', '细致'],
  ['一站式', '整套'],
  ['完美', '合适'],
  ['绝对', '基本'],
  ['保证', '以现场确认为准'],
  ['一定能', '多数情况下能'],
  ['百分百', '多数情况下'],
  ['研究表明', ''],
  ['科学证明', ''],
  ['多陪玩就不会乱抓', '抓挠和玩耍的关系并不简单'],
  ['限时', ''],
  ['仅剩', ''],
  ['最后机会', ''],
  ['错过', '少了一次'],
  ['必须', '需要'],
  ['等于', '更容易变成'],
  ['100%', '多数情况下'],
  ['100％', '多数情况下']
];

// L0 / ask 段：只允许「有条件继续 / 当前条件不支持 / 信息不足」
// 负向前瞻/后顾：避免把「不能判断能不能放下」这类否定句误改
const L0_ASSERTIONS = [
  [/(?<![不未没法])完全可以|(?<![不未没法])完全可行|(?<![不未没法])可行/g, '可以继续评估'],
  [/(?<![不未没法否])放得下|(?<![不未没法否])能放下|(?<![不未没法否])放得进去|(?<![不未没法否])能放进去/g, '需要先量尺寸确认'],
  [/(?<![不未没法])一定(可以|能)/g, '需要先量尺寸确认'],
  [/推荐(购买|买)/g, '先看方向'],
  [/绝对/g, '以现场确认为准'],
  [/100%|100％/g, '以现场确认为准']
];

// L1 段：不能保证安全 / 不能保证猫会喜欢 / 不能代替现场确认
const L1_REPLACEMENTS = [
  [/保证安全/g, '落地前仍需现场确认安全'],
  [/保证猫(会)?喜欢/g, '猫是否喜欢要看现场'],
  [/代替现场确认/g, '仍需现场确认']
];

function cleanText(value, mode = 'default', maxChars = 80) {
  if (typeof value !== 'string') return '';
  let s = value
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  for (const [from, to] of BANNED_WORDS) s = s.split(from).join(to);
  if (mode === 'l0' || mode === 'ask') {
    for (const [re, to] of L0_ASSERTIONS) s = s.replace(re, to);
  }
  if (mode === 'plan') {
    for (const [re, to] of L1_REPLACEMENTS) s = s.replace(re, to);
  }
  s = s.replace(/^\s*[#>*\-·]+\s*/g, '').replace(/\*\*/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!s) return '';
  return Array.from(s).slice(0, maxChars).join('');
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const toInt = (v, fallback) => (isNum(v) ? Math.round(v) : fallback);
const toNum = (v, fallback) => (isNum(v) ? v : fallback);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const asBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

const REGION_SLOTS = [
  [0.28, 0.52, 0.24, 0.22],
  [0.56, 0.5, 0.22, 0.2],
  [0.4, 0.58, 0.2, 0.18],
  [0.16, 0.58, 0.2, 0.18],
  [0.68, 0.56, 0.18, 0.18]
];

function fallbackBbox(index) {
  return [...REGION_SLOTS[index % REGION_SLOTS.length]];
}

function sanitizeBbox(raw, fallback, image) {
  if (!Array.isArray(raw) || raw.length !== 4) return [...fallback];
  let vals = raw.map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN));
  if (!vals.every((v) => Number.isFinite(v))) return [...fallback];
  let [x, y, w, h] = vals;

  // 兜底：模型偶尔给像素坐标，这里尝试按原图尺寸归一化
  const imgW = image && isNum(image.width) && image.width > 0 ? image.width : 1000;
  const imgH = image && isNum(image.height) && image.height > 0 ? image.height : 1000;
  const pixelLike = Math.abs(x) > 1.2 || Math.abs(y) > 1.2 || Math.abs(w) > 1.2 || Math.abs(h) > 1.2;
  if (pixelLike) {
    x /= imgW;
    y /= imgH;
    w /= imgW;
    h /= imgH;
  }

  // 负宽高 / 交换
  if (w < 0) {
    x += w;
    w = Math.abs(w);
  }
  if (h < 0) {
    y += h;
    h = Math.abs(h);
  }
  if (!(w > 0) || !(h > 0)) return [...fallback];

  w = clamp(w, 0.04, 0.9);
  h = clamp(h, 0.04, 0.9);
  x = clamp(x, 0, 1 - w);
  y = clamp(y, 0, 1 - h);

  // 面积过大的框收紧（禁止整张图当热区），以中心为锚点
  const maxArea = 0.44;
  if (w * h > maxArea) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const k = Math.sqrt(maxArea / (w * h));
    w = Math.max(0.06, w * k);
    h = Math.max(0.06, h * k);
    x = clamp(cx - w / 2, 0, 1 - w);
    y = clamp(cy - h / 2, 0, 1 - h);
  }
  return [round4(x), round4(y), round4(w), round4(h)];
}

const round4 = (v) => Math.round(v * 10000) / 10000;

function parseRaw(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        const obj = JSON.parse(s.slice(first, last + 1));
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

// ---------- 阶段配置 ----------

const STAGE_CONFIG = Object.freeze({
  quality: { label: '正在读照片…', temperature: 0.1, maxTokens: 1600, thinking: { type: 'enabled' } },
  l0: { label: '正在看方向…', temperature: 0.25, maxTokens: 2000, thinking: { type: 'disabled' } },
  measure: { label: '正在排测量顺序…', temperature: 0.2, maxTokens: 600, thinking: { type: 'disabled' } },
  // plan 关思考：实测思考会把 reasoning 顶到 5000+ tokens（35s、偶发截断），
  // 关掉后 4—5s 且输出仍含条件/阻断；需要更谨慎时调用方可用 thinking:{type:'enabled',effort:'low'}
  plan: { label: '正在整理交付包…', temperature: 0.2, maxTokens: 6000, thinking: { type: 'disabled' } },
  ask: { label: '正在看你点的位置…', temperature: 0.3, maxTokens: 800, thinking: { type: 'disabled' } }
});

const SYSTEM_PROMPT = `你是「猫角落 Corner」的空间评估助手。用户拍下家里一个角落，想知道值不值得改、下一步量哪里、什么尺寸条件下能放。
你的输出会被程序直接 JSON.parse 后渲染成卡片，必须严格按字段返回。

【底线，违反即失败】
1. 照片只能看方向，不能证明「放得下」。L0 阶段禁止说：可行、能放下、放得下、保证、推荐买、绝对、一定、没问题。
2. 没量到的尺寸一律写 unknown 或放进 missing；不许猜尺寸，不许用像素反推厘米，不许把照片推断当实测。
3. 关键尺寸缺失时，结论只能是 insufficient 或 not_supported，不能给「应该可以」。这里的「关键尺寸」指 constraints 里实际用到的尺寸。
4. 商品只能从给定 SKU 库里选；库外型号不要编造，宁可给空 items + blocked。
5. 中文短句，具体，不卖货。禁用词：赋能、打造、极致、一站式、完美、绝对、保证、100%、限时、仅剩、最后机会、错过、必须、一定能、等于、研究表明、科学证明、多陪玩就不会乱抓。
6. 只输出一个 JSON 对象：不要 markdown 围栏，不要解释，不要注释、不要多余字段；字符串里禁止换行。
7. bbox 用 0—1 归一化 [x,y,w,h]（左上角 x,y，宽高 w,h）；必须真的框住你描述的位置（墙角/家具/候选区），面积约占画面 5%—30%，禁止用整张图或随便框；看不清就别编 bbox。
8. 不确定就写 unknown / insufficient。空值用 null，不要用 "-"、"暂无"、"待定"。
9. 不要写来源、作者、年份、URL、「研究表明」或任何引用——依据由程序从证据目录挂；你只负责按行为学判据推理这个位置。
10. 只写照片能看见的事实：看不出噪音家电、穿堂风、地面材质就写 unknown/false，禁止猜。
11. 文案一律用收益框架：说「这样放，猫更可能真的进去睡」；禁止恐吓、禁止愧疚、禁止损失框架（如「再不改猫会抑郁」「等于害它」）；禁止假精确置信度数字。
【输出前自查】字段齐全；枚举值合法；数字是数字；没有禁用词；没有 markdown。`;

function measurementDictText() {
  return MEASUREMENT_KEYS.map((key) => {
    const s = MEASUREMENT_SPECS[key];
    return `- ${key}：${s.label}（${s.endpoints}）${s.why ? `；${s.why}` : ''}`;
  }).join('\n');
}

/** 行为学判据摘要：只从证据目录取 claim，供模型推理；引用/来源一律由 rules 挂，模型不许写 */
function evidenceDigestText(limit = 20) {
  try {
    const c = allEvidence();
    const items = Array.isArray(c.items) ? c.items : [];
    return items
      .slice(0, limit)
      .map((e) => `- ${e.claim}（${e.strength}/${e.kind}）`)
      .join('\n');
  } catch {
    return '';
  }
}

const QUALITY_TASK = `【任务】判断这张照片能不能用来做空间判断。只做质检，不给摆放建议。
【检查项】过暗、模糊/抖动、遮挡（墙角或地面被挡）、看不到地面边界、不是室内、离墙角太近或太远。
【本地指标】上下文里如果给了 brightness（0—255 平均亮度）、sharpness（拉普拉斯方差，越高越清晰）或 analysisNote（客户端/运营备注），把它们当补充证据，不要复述数值。
【判定】任何 block 级问题 → status=retake；否则 pass。score 是 0—100 的整数。
【结构】只输出这个 JSON（字段一个不能少，枚举只能取列出的值）：
{"status":"pass|retake","score":0,"scene":{"indoor":true,"cornerVisible":true,"floorVisible":true,"obstruction":"none|some|heavy","note":"一句话"},"issues":[{"code":"dark|blurry|occluded|no_floor|not_indoor|too_close|other","label":"过暗","impact":"high|mid|low","hint":"怎么重拍","severity":"block|warn"}],"photoTip":"一句补拍建议"}`;

const L0_TASK = `【任务】只看照片，给「方向预览」（L0）。判断这个角落值不值得继续、下一步该量哪里。
【用户诉求】上下文里的 goal 是用户自己写的诉求（可能含预算、想放的东西、保留物）。方向必须围绕它；如果诉求里提到预算或「别动某件东西」，要在方向或风险里体现。
【必须做到】
- regions 1—5 个：每条是一个候选位置，bbox 紧贴照片里那块地面/墙角，不要框整张图。verdict 只能是 ok|conditional|blocked|unknown；没量尺寸时优先 conditional/unknown。
- directions 1—3 个：每个方向写清楚「放在哪、怎么放、第一步量什么」，语气只能是「有条件继续」。kit 只能是 new（买新）/reuse（复用旧物）/mix（混合）。
- 每个方向 firstMeasurements 从下面字典里选 1—2 个 key。地面摆放的方向必须包含 corridorWidth（通道净宽），再加一个与宽度/进深相关的项。
- missing 1—3 条：照片看不出来、又会影响结论的尺寸。
- verdict 只能是 continue（有条件继续）|not_supported（当前条件不支持）|insufficient（信息不足）。
- recognition：一句话指认照片里的具体位置与物件（≤30 字），要具体到「电视柜右侧那个墙角，旁边有个插座」，不能写「一个角落」。
- boundary：一句专业边界（≤40 字），说清这一步看不到什么，例如「照片里看不出进深，这一步只能给方向，能不能放下要量过才算」；不要写成免责声明口吻。
- directions 里至少 1 个方向必须是 kit:"reuse"（不花钱、复用现有用品）。
- recommend：只推荐 1 个 directionId（必须是 directions 里存在的 id），why ≤40 字说为什么这个改动成本最低，alternativesNote 一句话说明其它方向为什么先折叠。如果 profile.primaryPain 是「猫不进去」，优先推荐能直接改善遮蔽/位置的方向；「太乱占道」优先省地/复用方向；「有味道」优先砂盆相关方向，并且 directions 里至少 1 个方向必须与砂盆/厕所相关（例：此处放砂盆、复用现有盆做厕所），即使照片里还没看到砂盆。
- env：只写照片里能直接看出来的事实。floorType 木地板 wood/瓷砖 tile/地毯 carpet/看不出 unknown；nearAppliance 只列画面里看得见的噪音家电（washer 洗衣机、fridge 冰箱、speaker 音响），没有就 []；nearFood 只有看得到食盆水碗才 true；draft 只有明显对流的穿堂/风口才 true；sunlight 有直射阳光 direct、只有亮光 indirect、没有或看不出 none；wallExterior 只有落点明显贴外墙才 true。看不出就 false/unknown，禁止猜。
【行为学判据】位置好坏看：能否藏、资源是否分开、温度/日照/风、抓挠是否在日常动线、高处能否摊平；按这些推理，但不要写来源/作者/年份。
【禁止】任何「能放下/可行/保证/推荐买」的结论；不要写商品价格；不要推荐具体型号。
【测量字典】
${measurementDictText()}
【结构】只输出这个 JSON：
{"scene":{"summary":"一句话","roomGuess":"客厅","light":"medium|bright|dim","floor":"wood|tile|other"},"recognition":"电视柜右侧那个墙角，旁边有个插座","boundary":"照片里看不出进深，这一步只能给方向，能不能放下要量过才算","verdict":"continue|not_supported|insufficient","verdictReason":"一句话","regions":[{"id":"r1","label":"猫窝候选","bbox":[0.32,0.52,0.26,0.22],"verdict":"ok|conditional|blocked|unknown","why":"为什么","risk":"风险"}],"directions":[{"id":"d1","title":"靠右墙角放猫窝","pitch":"一句话方向","regionId":"r1","kit":"new|reuse|mix","itemsPreview":[{"title":"半包式猫窝","type":"new|reuse"}],"firstMeasurements":[{"key":"cornerWidthA","label":"墙角 A 边长","why":"决定最大宽度"}],"risk":"风险","confidence":"high|medium|low"}],"missing":[{"key":"corridorWidth","label":"通道净宽","why":"低于 60cm 猫会绕行"}],"nextAction":"先量什么","heatmapNote":"一句话解释热区","env":{"floorType":"wood|tile|carpet|unknown","nearAppliance":["washer|fridge|speaker"],"nearFood":false,"draft":false,"sunlight":"none|indirect|direct","wallExterior":false,"note":"一句话"},"recommend":{"directionId":"d1","why":"≤40字","alternativesNote":"一句话"}}`;

const MEASURE_TASK = `【任务】给用户下一轮的测量卡：每轮只问 1—2 项最关键、还没量的尺寸。不要一次问完。
【锁定方向】上下文 direction 是用户选中的方向（chosenDirectionId 优先，否则第一个方向），测量必须围绕它，不要换方向。
【选题】优先当前方向第一步必须量的（firstMeasurements）；已经量过或用户跳过的 key 不要再问。如果方向是地面摆放，还没量的 key 按这个顺序优先：corridorWidth → cornerWidthA → freeDepth，每轮最多 2 个。
【收敛】如果方向第一步和 missing 里的 key 都已量完，questions 和 remainingKeys 返回空数组 []，askNote 写「关键尺寸已齐，可以出方案了」。
【每题必须写清】端点（从哪到哪）、单位 cm、为什么量（给一个具体阈值或后果）、怎么量（量最窄处/垂直量）、example 给一个示例数值、optional 是否可跳过。
【remainingKeys】填还要量的 key（进度环分母），不要填本轮问的。
【结构】只输出这个 JSON：
{"round":1,"questions":[{"key":"corridorWidth","label":"通道净宽","endpoints":"最近的家具到对面墙","unit":"cm","why":"低于 60cm 猫会绕着走","hint":"量最窄处","example":"约 62","optional":false}],"remainingKeys":["freeDepth"],"askNote":"这轮只要这两个数就够了"}`;

const PLAN_TASK = `【任务】给「L1 交付包」：在已量尺寸、预算和保留物条件下，判断能不能放、放什么、还要现场确认什么。
【锁定方向】上下文 direction 是用户选中的方向（chosenDirectionId 优先，否则第一个方向），方案必须围绕它，不要换方向。
【用户诉求】上下文里 goal 是用户自己写的诉求（可能含预算、想放的东西、保留物），方案要回应它；与诉求无关的商品不要塞。
【硬规则】
- 商品只能从 SKU 库里选：items[].sku 必须用库里的 id；库外型号宁可不选，写进 blocked。
- 尺寸条件用 constraints 表达：op、valueCm、actualCm、status(pass|fail|unknown)。没量到的写 unknown，不许猜。
- 「关键尺寸」只有 corridorWidth、cornerWidthA、freeDepth 三个（地面方案必须）。这三个都有值且约束通过时，不要因为其它尺寸（cornerWidthB、doorSwing、上方净空、旧物尺寸等）没量就把整单 verdict 写成 insufficient；那些写进 checklist（非 critical）或对应候选的 blocked。
- verdict 判定顺序：关键尺寸缺 → insufficient；关键约束 fail → not_supported；关键约束都通过且选中商品 fit=ok → 至少 conditional（预算/保留物/附加条件没落实时用 conditional，全部落实可用 ok）；所有候选都 blocked → not_supported。
- 预算超了 → budget.status=over，verdict 最多 conditional。
- 保留物（keep）必须在 items 或 checklist 或 blocked 里被处理。
- 不能保证安全、不能保证猫会喜欢、不能代替现场确认。
- annotations 的编号要和 checklist 里的「#编号」一一对应；bbox 用 L0 regions 的框做锚点，不要乱框。
- items 的 fit 只能是 ok 或 blocked；不确定就 blocked。fit=blocked 时 fitNote 必须写清阻断原因 + 什么条件下可行。
- 输出要紧凑：items 最多 4 个、annotations 最多 3 个、checklist 最多 6 条、blocked 最多 4 条、constraints 最多 5 条；radar 每条 note ≤12 字；每段尽量一句，不要长篇。
- blocked 只写和当前方案直接相关的 2—4 条；不要为了展示 SKU 库而列无关商品。
- radar 五维（hide 藏身感 / path 通道 / sun 日照 / quiet 安静 / flow 动线）评分 0—5 整数，note 标「启发式参考，非实测」。
- 上下文里的尺寸单位都是 cm，你输出的 dimsCm 也用 cm。商品字段程序会以 SKU 库为准，仍请尽量填对。
- 位置判断必须用上上下文里的 env（照片看到的地面材质/噪音家电/食盆/风/日照/外墙）和 evidenceDigest（行为学判据）；但禁止写来源、作者、年份、URL、「研究表明」，引用由程序挂。
- behavior：likelyUse 一句预测猫会怎么用；whyNot 0—3 条「可能不用」的机制原因；firstSign 必须是可观察信号（如「三天内没有主动趴进去」），不能写「看猫喜不喜欢」。
- observe：固定第 1/3/7 天，每天 title + checks（2—4 条）；第 1 天要有一条二选一计划句（「今天做还是周末做？」）；第 3 天必须包含「3 天内不用不算失败」（猫适应以天计，有遮蔽约 2 天、无遮蔽约 9 天）；第 7 天的判定要可操作（主动使用次数 ≥2 次）。
- ifThen：2—3 条，超过 3 条就丢；if 必须是可观察事实（次数/天数/现象），then 必须是单一动作；禁止「多观察」「注意一下」「再去看看」这类空动作。
- checklist 第一条必须是「计划句」：时间 + 地点 + 一个可核对条件，例如「周六上午去店里，先看进深 ≥60cm 的方形窝」；其余条目是可勾选的具体动作。
- 叙述顺序：先讲尺寸条件，再讲商品；不要用损失框架或恐吓（「再不改猫会抑郁」这类禁止）。
【结构】只输出这个 JSON：
{"verdict":"ok|conditional|not_supported|insufficient","headline":"一句话结论（≤30字）","budget":{"cap":300,"est":259,"status":"within|over"},"annotations":[{"id":"1","label":"猫窝","bbox":[0.32,0.52,0.26,0.22],"note":"贴右墙，留 60cm 通道"}],"items":[{"id":"i1","type":"new|reuse","title":"半包式猫窝 45×40","sku":"SKU-001","dimsCm":{"w":45,"d":40,"h":38},"price":129,"why":"进深 40cm，通道剩 62cm","fit":"ok|blocked","fitNote":"","confidence":"high|medium|low","tags":["可拆洗"]}],"constraints":[{"key":"corridorWidth","label":"通道净宽","op":">=","valueCm":60,"actualCm":62,"status":"pass|fail|unknown","note":""}],"checklist":[{"id":"c1","text":"周六上午去店里，先看进深 ≥40cm 的方形窝","critical":true},{"id":"c2","text":"把电视柜右侧的绿植挪到窗边","critical":true}],"blocked":[{"what":"70cm 以上猫爬架","reason":"墙高与固定方式未知"}],"radar":[{"key":"hide","label":"藏身感","score":4,"note":"三面有围挡"}],"behavior":{"likelyUse":"大概率会当成睡觉的藏身处","whyNot":["离食盆太近，猫不会在进食区附近久待"],"firstSign":"三天内没有主动趴进去，先别挪，等到第 7 天再判断"},"observe":[{"day":1,"title":"第 1 天","checks":["把旧垫子放进去，别洗","今天做还是周末做？先选一个时间"]},{"day":3,"title":"第 3 天","checks":["3 天内不用不算失败，先别挪位置","有没有留下压痕或毛发"]},{"day":7,"title":"第 7 天","checks":["主动使用次数 ≥2 次就保留；0 次就执行 ifThen"]}],"ifThen":[{"if":"7 天内猫一次都没主动进去","then":"把窝移到离食盆更远的墙边"},{"if":"7 天内抓板没有新的抓痕","then":"把抓板挪到沙发旁或门口"}],"aftercare":{"day7":"猫不进窝的话，把窝垫换成旧衣服","day14":"还不进窝就换个更安静的角落"},"disclaimer":"${L1_DISCLAIMER}"}`;

const ASK_TASK = `【任务】用户点选了照片上的一个位置，可能附带一句话问题。只评估这个点位，不要扩展成整屋方案。
【必须】
- reply：一句话结论，≤40 字，说清「这里能不能继续看、还缺什么」。
- verdict：ok（这个点位可以做下一步）/conditional（有条件）/blocked（这个点位别放）/insufficient（照片信息不够）。没量关键尺寸时最多 conditional，不能给 ok。
- pieces：2—4 条短句，每条说一个具体理由或动作，要引用照片里看到的东西（墙角/家具/地面）和点位位置。
- missing：0—3 条，写还缺哪些尺寸或信息（中文短语，例如「通道净宽」）。
【禁止】没有尺寸就说能放；不要复述坐标；不要推荐具体型号。
【结构】只输出这个 JSON：
{"reply":"一句话结论","verdict":"ok|conditional|blocked|insufficient","pieces":["理由一","理由二"],"missing":["通道净宽"]}`;

// ---------- 上下文构造 ----------

function measurementsCm(session) {
  const src = session && session.measurements && typeof session.measurements === 'object' ? session.measurements : {};
  const out = [];
  const skipped = [];
  for (const key of MEASUREMENT_KEYS) {
    const raw = src[key];
    let valueCm = null;
    let isSkipped = false;
    if (isNum(raw)) valueCm = raw / 10;
    else if (raw && typeof raw === 'object') {
      isSkipped = raw.skipped === true;
      if (isNum(raw.valueCm)) valueCm = raw.valueCm;
      else if (isNum(raw.valueMm)) valueCm = raw.valueMm / 10;
    }
    if (valueCm != null && !isSkipped) out.push({ key, label: MEASUREMENT_SPECS[key].label, valueCm: Math.round(valueCm * 10) / 10 });
    else if (isSkipped) skipped.push({ key, label: MEASUREMENT_SPECS[key].label, skipped: true });
  }
  return { known: out, skipped };
}

function keepsOf(session) {
  const arr = session && session.profile && Array.isArray(session.profile.keep) ? session.profile.keep : [];
  return arr
    .map((k) => (typeof k === 'string' ? k : k && (k.name || k.label || k.title)))
    .filter((k) => typeof k === 'string' && k.trim())
    .slice(0, 5);
}

function chosenDirection(session) {
  const l0 = session && session.l0 ? session.l0 : null;
  const dirs = l0 && Array.isArray(l0.directions) ? l0.directions : [];
  if (!dirs.length) return null;
  const id =
    (session && (session.chosenDirectionId || session.selectedDirectionId || session.directionId)) ||
    (l0 && l0.recommend && l0.recommend.directionId) ||
    null;
  return dirs.find((d) => d && d.id === id) || dirs[0];
}

function pickOf(session) {
  const cands = [session && session.pick, session && session.currentPick, session && session.pickPoint];
  if (session && Array.isArray(session.picks) && session.picks.length) cands.push(session.picks[session.picks.length - 1]);
  for (const c of cands) {
    if (c && isNum(c.nx) && isNum(c.ny)) return { nx: clamp(c.nx, 0, 1), ny: clamp(c.ny, 0, 1) };
  }
  return null;
}

function horizontalWord(nx) {
  if (nx < 1 / 3) return '左侧';
  if (nx < 2 / 3) return '中间';
  return '右侧';
}

function verticalWord(ny) {
  if (ny < 1 / 3) return '上侧';
  if (ny < 2 / 3) return '中部';
  return '下侧';
}

function userQuestion(session) {
  const cands = [
    session && session.userText,
    session && session.askText,
    session && session.lastUserText,
    session && session.lastMessage,
    session && session.payload && session.payload.text,
    session && session.payload && session.payload.question
  ];
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 200);
  return '';
}

function buildContext(stage, session) {
  const profile = (session && session.profile) || {};
  const image = (session && session.image) || null;
  const quality = (session && session.quality) || null;
  const l0 = (session && session.l0) || null;
  const plan = (session && session.plan) || null;
  const measured = measurementsCm(session);

  const base = {
    goal: typeof profile.goal === 'string' ? profile.goal.slice(0, 80) : '',
    budgetYuan: isNum(profile.budget) ? profile.budget : budgetFromGoal(profile.goal),
    keep: keepsOf(session),
    cats: isNum(profile.cats) ? profile.cats : 1,
    catSize: oneOf(profile.catSize, ['small', 'medium', 'large'], 'medium'),
    catAge: oneOf(profile.catAge, ['kitten', 'adult', 'senior'], 'adult'),
    multiCat: profile.multiCat === true || (isNum(profile.cats) && profile.cats > 1),
    floorType: oneOf(profile.floorType, ['wood', 'tile', 'carpet', 'unknown'], 'unknown'),
    climate: oneOf(profile.climate, ['cold', 'mild', 'hot', 'unknown'], 'unknown'),
    primaryPain: oneOf(profile.primaryPain, ['猫不进去', '太乱占道', '有味道', '都还行'], '') || '',
    photo: image && isNum(image.width) && isNum(image.height) ? `${image.width}×${image.height}` : null,
    analysisNote: typeof session.analysisNote === 'string' && session.analysisNote.trim() ? session.analysisNote.trim().slice(0, 200) : null,
    metrics: session && session.metrics && typeof session.metrics === 'object'
      ? {
          brightness: toNum(session.metrics.brightness, null),
          contrast: toNum(session.metrics.contrast, null),
          sharpness: toNum(session.metrics.sharpness, null),
          width: toInt(session.metrics.width, null),
          height: toInt(session.metrics.height, null)
        }
      : null
  };

  if (stage === 'quality') {
    return { ...base, stageNote: '只做质检，不给摆放建议' };
  }

  const qualitySlim = quality
    ? {
        status: quality.status,
        score: quality.score,
        scene: quality.scene,
        issues: Array.isArray(quality.issues) ? quality.issues.slice(0, 4).map((i) => ({ code: i.code, label: i.label, severity: i.severity, hint: i.hint })) : []
      }
    : null;

  if (stage === 'l0') {
    return { ...base, quality: qualitySlim };
  }

  if (stage === 'measure') {
    const dir = chosenDirection(session);
    return {
      ...base,
      quality: qualitySlim,
      l0Verdict: l0 ? l0.verdict : null,
      direction: dir
        ? {
            id: dir.id,
            title: dir.title,
            pitch: dir.pitch,
            firstMeasurements: dir.firstMeasurements,
            risk: dir.risk
          }
        : null,
      l0Missing: l0 && Array.isArray(l0.missing) ? l0.missing.slice(0, 4) : [],
      measured: measured.known,
      skipped: measured.skipped,
      askedRounds: session && Array.isArray(session.asks) ? session.asks.length : 0
    };
  }

  if (stage === 'plan') {
    const dir = chosenDirection(session);
    const regions = l0 && Array.isArray(l0.regions)
      ? l0.regions.slice(0, 5).map((r) => ({ id: r.id, label: r.label, bbox: r.bbox, verdict: r.verdict, why: r.why }))
      : [];
    const skuCatalog = Array.from(SKU_BY_ID.values()).map((s) => ({
      id: s.id,
      title: s.title,
      category: s.category,
      dimsCm: s.dimsCm,
      price: s.price,
      tags: s.tags,
      materials: s.materials,
      unknowns: s.unknowns
    }));
    return {
      ...base,
      quality: qualitySlim,
      l0Verdict: l0 ? l0.verdict : null,
      env: l0 && l0.env ? l0.env : null,
      evidenceDigest: evidenceDigestText(20),
      catBodyCm: CAT_SIZE_BODY_CM[oneOf(profile.catSize, ['small', 'medium', 'large'], 'medium')],
      direction: dir
        ? {
            id: dir.id,
            title: dir.title,
            pitch: dir.pitch,
            kit: dir.kit,
            itemsPreview: dir.itemsPreview,
            firstMeasurements: dir.firstMeasurements,
            risk: dir.risk
          }
        : null,
      regions,
      measured: measured.known,
      skipped: measured.skipped,
      missingKeys: FLOOR_REQUIRED_KEYS.filter((k) => !measured.known.some((m) => m.key === k)),
      measurementDict: MEASUREMENT_KEYS.map((k) => ({ key: k, label: MEASUREMENT_SPECS[k].label, endpoints: MEASUREMENT_SPECS[k].endpoints })),
      skuCatalog
    };
  }

  // ask
  const pick = pickOf(session);
  const picks = (Array.isArray(session && session.picks) ? session.picks : [])
    .filter((x) => x && isNum(x.nx) && isNum(x.ny))
    .slice(-8)
    .map((x) => ({
      nx: Math.round(clamp(x.nx, 0, 1) * 1000) / 1000,
      ny: Math.round(clamp(x.ny, 0, 1) * 1000) / 1000,
      where: `${horizontalWord(x.nx)}${verticalWord(x.ny)}`,
      note: typeof x.note === 'string' ? x.note.slice(0, 80) : ''
    }));
  return {
    ...base,
    quality: qualitySlim,
    l0: l0
      ? {
          verdict: l0.verdict,
          scene: l0.scene,
          verdictReason: l0.verdictReason,
          regions: Array.isArray(l0.regions) ? l0.regions.slice(0, 4) : [],
          direction: chosenDirection(session)
        }
      : null,
    pick: pick
      ? {
          nx: Math.round(pick.nx * 1000) / 1000,
          ny: Math.round(pick.ny * 1000) / 1000,
          where: `${horizontalWord(pick.nx)}${verticalWord(pick.ny)}`,
          sentence: `用户最新在画面横向约 ${Math.round(pick.nx * 100)}%、纵向约 ${Math.round(pick.ny * 100)}% 的位置（${horizontalWord(pick.nx)}${verticalWord(pick.ny)}）点了一下`
        }
      : null,
    picks,
    question: userQuestion(session),
    measured: measured.known,
    plan: plan ? { verdict: plan.verdict, headline: plan.headline } : null
  };
}

function readImageDataUrl(session) {
  const img = session && session.image;
  if (!img || typeof img !== 'object') return null;
  const candidates = [];
  if (typeof img.absPath === 'string' && img.absPath) candidates.push(img.absPath);
  if (typeof img.path === 'string' && img.path) candidates.push(img.path);
  if (typeof img.imageId === 'string' && img.imageId) {
    const name = img.imageId.endsWith('.jpg') ? img.imageId : `${img.imageId}.jpg`;
    candidates.push(path.join(ROOT, 'app', 'data', 'uploads', name));
  }
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const buf = fs.readFileSync(candidate);
      if (buf && buf.length) return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
      // 读不到就当没有图：仍然返回纯文本请求，不让服务端 500
    }
  }
  return null;
}

const STAGE_TASK_TEXT = Object.freeze({
  quality: QUALITY_TASK,
  l0: L0_TASK,
  measure: MEASURE_TASK,
  plan: PLAN_TASK,
  ask: ASK_TASK
});

/**
 * 构造 DeepSeek 兼容请求。
 * @returns {{messages:Array, temperature:number, maxTokens:number, thinking:object, label:string, response_format:object}}
 */
export function buildRequest(stage, session = {}) {
  const key = STAGES.includes(stage) ? stage : 'l0';
  const cfg = STAGE_CONFIG[key];
  const context = buildContext(key, session);
  const imageUrl = readImageDataUrl(session);
  let stageHint;
  if (key === 'ask') {
    const pickSentence = context.pick ? context.pick.sentence : '用户没有点选具体位置，只问了摆放问题';
    stageHint = `【本次会话上下文】\n${JSON.stringify(context)}\n${pickSentence}。请只针对这个点位回答，pieces 里要提到画面中的具体参照物。`;
  } else if (key === 'measure' && session && session.measureDone === true) {
    stageHint = `【本次会话上下文】\n${JSON.stringify(context)}\n【重要】用户已声明测量结束（measureDone=true）：questions 和 remainingKeys 都返回空数组 []，askNote 写「尺寸已齐，可以直接生成方案。」`;
  } else {
    stageHint = `【本次会话上下文】\n${JSON.stringify(context)}`;
  }

  const text = `${STAGE_TASK_TEXT[key]}\n\n${stageHint}`;
  const userContent = [{ type: 'text', text }];
  if (imageUrl) {
    userContent.push({ type: 'image_url', image_url: { url: imageUrl } });
    userContent[0].text += '\n\n【照片】见下方图片。所有 bbox 都以这张照片为坐标系，左上角为 (0,0)。';
  } else {
    userContent[0].text += '\n\n【注意】没有拿到照片文件。只能基于上下文做保守判断，位置类字段用 null 或 unknown。';
  }

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent }
    ],
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    thinking: { ...cfg.thinking },
    label: cfg.label,
    response_format: { type: 'json_object' }
  };
}

// ---------- normalize：质量 / L0 / measure / plan / ask ----------

// V2 小结构：env / behavior / observe / ifThen
function normalizeEnvInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    floorType: oneOf(src.floorType, ['wood', 'tile', 'carpet', 'unknown'], 'unknown'),
    nearAppliance: Array.isArray(src.nearAppliance) ? src.nearAppliance.filter((a) => ['washer', 'fridge', 'speaker'].includes(a)).slice(0, 3) : [],
    nearFood: asBool(src.nearFood, false),
    draft: asBool(src.draft, false),
    sunlight: oneOf(src.sunlight, ['none', 'indirect', 'direct'], 'none'),
    wallExterior: asBool(src.wallExterior, false),
    note: cleanText(src.note, 'l0', 60)
  };
}

function normalizeBehaviorInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const whyNot = Array.isArray(src.whyNot)
    ? src.whyNot
        .filter((x) => typeof x === 'string' && x.trim())
        .slice(0, 3)
        .map((x) => cleanText(x, 'l0', 40))
        .filter(Boolean)
    : [];
  const firstSign = cleanText(src.firstSign, 'l0', 40);
  const firstSignOk = /(\d+\s*天|三天|7\s*天|一周|次|没有主动|没有进去|停留|压痕|毛发)/.test(firstSign);
  return {
    likelyUse: cleanText(src.likelyUse, 'l0', 40),
    whyNot,
    firstSign: firstSignOk ? firstSign : ''
  };
}

function validIfText(s) {
  return typeof s === 'string' && s.length >= 4 && s.length <= 40 && /(\d+\s*(天|次|周|小时)|\d+%|出现|留下|没有|超过|连续|每天|一周|三天|七天|尿|抓痕|压痕|毛发)/.test(s);
}

function validThenText(s) {
  return (
    typeof s === 'string' &&
    s.length >= 4 &&
    s.length <= 30 &&
    !/(多观察|注意一下|留意|再看看|多种|同时|并且|，|,|；|;)/.test(s) &&
    /(挪|换|移|加|放|撤|关|开|擦|洗|清|铲|垫|挡|调|收|买|量|拍|改|用)/.test(s)
  );
}

function normalizeObserveInput(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const o of src.slice(0, 3)) {
    if (!o || typeof o !== 'object') continue;
    const day = toInt(o.day, null);
    if (![1, 3, 7].includes(day) || out.some((x) => x.day === day)) continue;
    const checks = (Array.isArray(o.checks) ? o.checks : [])
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => cleanText(c, 'plan', 40))
      .filter(Boolean)
      .slice(0, 4);
    out.push({ day, title: cleanText(o.title, 'plan', 12) || `第 ${day} 天`, checks });
  }
  for (const day of [1, 3, 7]) {
    if (!out.some((o) => o.day === day)) out.push({ day, title: `第 ${day} 天`, checks: [] });
  }
  out.sort((a, b) => a.day - b.day);
  const day1 = out.find((o) => o.day === 1);
  if (!day1.checks.some((c) => /气味|旧垫|擦/.test(c))) day1.checks.unshift('把旧垫子或猫蹭过的布放进新位置，别洗掉气味');
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

function normalizeIfThenInput(raw) {
  const out = [];
  for (const x of Array.isArray(raw) ? raw.slice(0, 3) : []) {
    if (!x || typeof x !== 'object') continue;
    const ifText = cleanText(x.if, 'plan', 40);
    const thenText = cleanText(x.then, 'plan', 30);
    if (!validIfText(ifText) || !validThenText(thenText)) continue;
    if (out.some((o) => o.if === ifText)) continue;
    out.push({ if: ifText, then: thenText });
  }
  return out;
}

function isPlanSentenceText(text) {
  const s = String(text || '');
  const len = Array.from(s).length;
  return (
    len >= 8 &&
    len <= 40 &&
    !/[\d×≥≤<>/．.、-]$/.test(s.trim()) &&
    /(周[一二三四五六日末]|今天|明天|周末|工作日|上午|下午|晚上)/.test(s) &&
    /(去|到|在)(店里|商店|网上|家|客厅|房间|此处|现场|宠物店)/.test(s) &&
    /(≥|≤|>\s*\d|<\s*\d|\d+\s*cm|进深|宽度|长度|尺寸|净宽)/.test(s)
  );
}

function buildPlanSentence(items, constraints) {
  const item = items.find((i) => i.fit === 'ok') || items[0];
  const sku = item && item.sku ? SKU_BY_ID.get(item.sku) : null;
  const catMap = { 猫窝: '猫窝', 猫砂盆: '猫砂盆', 猫抓板: '抓板', 猫爬架: '爬架' };
  const cat = sku
    ? catMap[sku.category] || '用品'
    : item && /砂盆/.test(item.title)
      ? '猫砂盆'
      : item && /抓板/.test(item.title)
        ? '抓板'
        : '用品';
  const cond =
    constraints.find((c) => c.key === 'freeDepth' && isNum(c.valueCm)) ||
    constraints.find((c) => c.key === 'cornerWidthA' && isNum(c.valueCm)) ||
    constraints.find((c) => isNum(c.valueCm));
  const text = cond
    ? `周六上午去店里，先看${cond.label}≥${cond.valueCm}cm 的${cat}`
    : `周六上午去店里，先确认尺寸条件再选${cat}`;
  return { id: 'c0', text: Array.from(text).slice(0, 40).join(''), critical: true };
}

function normalizeQuality(raw, session) {
  const r = parseRaw(raw);
  const sceneIn = r.scene && typeof r.scene === 'object' ? r.scene : {};
  const scene = {
    indoor: asBool(sceneIn.indoor, true),
    cornerVisible: asBool(sceneIn.cornerVisible, true),
    floorVisible: asBool(sceneIn.floorVisible, true),
    obstruction: oneOf(sceneIn.obstruction, ['none', 'some', 'heavy'], 'some'),
    note: cleanText(sceneIn.note, 'plan', 60)
  };

  const issues = [];
  const seen = new Set();
  for (const item of Array.isArray(r.issues) ? r.issues.slice(0, 6) : []) {
    if (!item || typeof item !== 'object') continue;
    const code = oneOf(item.code, ['dark', 'blurry', 'occluded', 'no_floor', 'not_indoor', 'too_close', 'other'], 'other');
    if (seen.has(code)) continue;
    seen.add(code);
    issues.push({
      code,
      label: cleanText(item.label, 'plan', 12) || '照片问题',
      impact: oneOf(item.impact, ['high', 'mid', 'low'], 'mid'),
      hint: cleanText(item.hint, 'plan', 40) || '重拍一张更清楚的照片',
      severity: oneOf(item.severity, ['block', 'warn'], 'warn')
    });
  }

  let status = oneOf(r.status, ['pass', 'retake'], issues.some((i) => i.severity === 'block') ? 'retake' : 'pass');
  if (issues.some((i) => i.severity === 'block')) status = 'retake';
  let score = clamp(toInt(r.score, status === 'pass' ? 78 : 42), 0, 100);
  if (status === 'retake') {
    score = Math.min(score, 55);
    if (!issues.length) {
      issues.push({
        code: 'other',
        label: '信息不够',
        impact: 'high',
        hint: '重拍一张能看到地面、墙角和整体空间的照片',
        severity: 'block'
      });
    }
  }
  return {
    status,
    score,
    scene,
    issues,
    photoTip: cleanText(r.photoTip, 'plan', 50) || (status === 'retake' ? '退后半步，把地面和墙角放进同一张照片再拍。' : '照片够用，可以继续看方向。')
  };
}

function normalizeL0(raw, session) {
  const r = parseRaw(raw);
  const image = session && session.image;
  const sceneIn = r.scene && typeof r.scene === 'object' ? r.scene : {};
  const scene = {
    summary: cleanText(sceneIn.summary, 'l0', 50) || '照片里能看到一个室内角落。',
    roomGuess: cleanText(sceneIn.roomGuess, 'l0', 10) || '不确定',
    light: oneOf(sceneIn.light, ['medium', 'bright', 'dim'], 'medium'),
    floor: oneOf(sceneIn.floor, ['wood', 'tile', 'other'], 'other')
  };

  const regions = [];
  const regionInput = Array.isArray(r.regions) ? r.regions.slice(0, 5) : [];
  regionInput.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    regions.push({
      id: `r${regions.length + 1}`,
      label: cleanText(item.label, 'l0', 12) || `候选区 ${regions.length + 1}`,
      bbox: sanitizeBbox(item.bbox, fallbackBbox(idx), image),
      verdict: oneOf(item.verdict, ['ok', 'conditional', 'blocked', 'unknown'], 'unknown'),
      why: cleanText(item.why, 'l0', 50) || '照片能看到这块位置，但尺寸还没量',
      risk: cleanText(item.risk, 'l0', 40) || '没量尺寸前不能判断能不能放下'
    });
  });
  const regionIds = new Set(regions.map((r2) => r2.id));

  const directions = [];
  const directionInput = Array.isArray(r.directions) ? r.directions.slice(0, 3) : [];
  directionInput.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const previews = [];
    for (const p of Array.isArray(item.itemsPreview) ? item.itemsPreview.slice(0, 2) : []) {
      if (!p) continue;
      if (typeof p === 'string') previews.push({ title: cleanText(p, 'l0', 14), type: 'new' });
      else if (typeof p === 'object') {
        previews.push({ title: cleanText(p.title, 'l0', 14) || '待选物品', type: oneOf(p.type, ['new', 'reuse'], 'new') });
      }
    }
    const first = [];
    for (const f of Array.isArray(item.firstMeasurements) ? item.firstMeasurements.slice(0, 2) : []) {
      const key = f && (typeof f === 'string' ? f : f.key);
      if (!MEASUREMENT_SPECS[key]) continue;
      if (first.some((x) => x.key === key)) continue;
      first.push({
        key,
        label: MEASUREMENT_SPECS[key].label,
        why: cleanText(f && f.why, 'l0', 30) || MEASUREMENT_SPECS[key].why
      });
    }
    if (!first.length) {
      first.push(
        { key: 'cornerWidthA', label: MEASUREMENT_SPECS.cornerWidthA.label, why: MEASUREMENT_SPECS.cornerWidthA.why },
        { key: 'freeDepth', label: MEASUREMENT_SPECS.freeDepth.label, why: MEASUREMENT_SPECS.freeDepth.why }
      );
    }
    const regionId = typeof item.regionId === 'string' && regionIds.has(item.regionId) ? item.regionId : null;
    directions.push({
      id: `d${directions.length + 1}`,
      title: cleanText(item.title, 'l0', 14) || `方向 ${directions.length + 1}`,
      pitch: cleanText(item.pitch, 'l0', 60) || '先确认这块位置能用的范围，再决定放什么。',
      regionId,
      kit: oneOf(item.kit, ['new', 'reuse', 'mix'], 'mix'),
      itemsPreview: previews,
      firstMeasurements: first,
      risk: cleanText(item.risk, 'l0', 40) || '尺寸没量，先别买。',
      confidence: oneOf(item.confidence, ['high', 'medium', 'low'], 'low')
    });
  });

  if (!directions.length) {
    directions.push({
      id: 'd1',
      title: '先确认这个角落能不能用',
      pitch: '照片只能看方向，先把可用宽度和进深量出来。',
      regionId: regions[0] ? regions[0].id : null,
      kit: 'mix',
      itemsPreview: [],
      firstMeasurements: [
        { key: 'cornerWidthA', label: MEASUREMENT_SPECS.cornerWidthA.label, why: MEASUREMENT_SPECS.cornerWidthA.why },
        { key: 'freeDepth', label: MEASUREMENT_SPECS.freeDepth.label, why: MEASUREMENT_SPECS.freeDepth.why }
      ],
      risk: '尺寸没量，先别买。',
      confidence: 'low'
    });
  }

  const missing = [];
  const seenMissing = new Set();
  for (const m of Array.isArray(r.missing) ? r.missing.slice(0, 4) : []) {
    const key = m && (typeof m === 'string' ? m : m.key);
    if (!MEASUREMENT_SPECS[key] || seenMissing.has(key)) continue;
    seenMissing.add(key);
    missing.push({ key, label: MEASUREMENT_SPECS[key].label, why: cleanText(m && m.why, 'l0', 40) || MEASUREMENT_SPECS[key].why });
  }
  if (!missing.length) {
    for (const f of directions[0].firstMeasurements) {
      if (missing.length >= 3) break;
      if (seenMissing.has(f.key)) continue;
      seenMissing.add(f.key);
      missing.push({ key: f.key, label: f.label, why: f.why });
    }
  }

  const dirIds = new Set(directions.map((d) => d.id));
  const recIn = r.recommend && typeof r.recommend === 'object' ? r.recommend : {};
  const recommend = {
    directionId: dirIds.has(recIn.directionId) ? recIn.directionId : directions[0] ? directions[0].id : null,
    why: cleanText(recIn.why, 'l0', 40) || '这个方向改动成本最低，先试它',
    alternativesNote:
      cleanText(recIn.alternativesNote, 'l0', 40) ||
      (directions.length > 1 ? `另外 ${directions.length - 1} 个方向也可以，但要先量同一组尺寸` : '')
  };

  const cheapRecognition = `${scene.roomGuess && scene.roomGuess !== '不确定' ? scene.roomGuess : ''}${regions[0] ? '的' + regions[0].label : ''}`;
  const recognition =
    cleanText(r.recognition, 'l0', 30) ||
    (Array.from(cheapRecognition).length >= 6 ? cheapRecognition : cleanText(scene.summary, 'l0', 30)) ||
    '照片里的这个室内角落，地面和墙脚可见';
  const boundary =
    cleanText(r.boundary, 'l0', 40) ||
    '照片里看不出进深，这一步只能给方向，能不能放下要量过才算';

  return {
    scene,
    recognition,
    boundary,
    verdict: oneOf(r.verdict, ['continue', 'not_supported', 'insufficient'], directions.length ? 'continue' : 'insufficient'),
    verdictReason: cleanText(r.verdictReason, 'l0', 60) || '照片能看出方向，但关键尺寸还没量，先别定摆放。',
    regions,
    directions: directions.slice(0, 3),
    missing: missing.slice(0, 4),
    nextAction: cleanText(r.nextAction, 'l0', 50) || `先量${missing[0] ? missing[0].label : '通道净宽'}，再决定放什么。`,
    heatmapNote: cleanText(r.heatmapNote, 'l0', 40) || '热区只是候选位置，不代表能放下。',
    env: normalizeEnvInput(r.env),
    recommend,
    disclaimer: L0_DISCLAIMER
  };
}

function normalizeMeasure(raw, session) {
  const r = parseRaw(raw);
  const round = Math.max(1, toInt(r.round, (session && Array.isArray(session.asks) ? session.asks.length : 0) + 1));
  // Lead 约定：measureDone=true 表示测量结束，允许空 questions
  if (session && session.measureDone === true) {
    const targetKeys = measureTargetKeys(session);
    return { round, questions: [], remainingKeys: [], totalTargets: targetKeys.length, attemptedTargets: targetKeys.length, askNote: '尺寸已齐，可以直接生成方案。' };
  }
  const measured = new Set();
  const src = session && session.measurements && typeof session.measurements === 'object' ? session.measurements : {};
  for (const key of MEASUREMENT_KEYS) {
    const v = src[key];
    if (isNum(v) || (v && typeof v === 'object' && (v.skipped === true || isNum(v.valueMm) || isNum(v.valueCm)))) measured.add(key);
  }

  const questions = [];
  const seen = new Set();
  for (const q of Array.isArray(r.questions) ? r.questions.slice(0, 2) : []) {
    const key = q && (typeof q === 'string' ? q : q.key);
    if (!MEASUREMENT_SPECS[key] || seen.has(key)) continue;
    seen.add(key);
    const spec = MEASUREMENT_SPECS[key];
    questions.push({
      key,
      label: cleanText(q.label, 'default', 12) || spec.label,
      endpoints: cleanText(q.endpoints, 'default', 40) || spec.endpoints,
      unit: 'cm',
      why: cleanText(q.why, 'default', 40) || spec.why,
      hint: cleanText(q.hint, 'default', 30) || spec.hint,
      example: cleanText(q.example, 'default', 12) || (key === 'corridorWidth' ? '约 62' : '约 80'),
      optional: asBool(q.optional, false)
    });
  }
  if (!questions.length) {
    for (const key of MEASUREMENT_KEYS) {
      if (questions.length >= 2) break;
      if (measured.has(key)) continue;
      const spec = MEASUREMENT_SPECS[key];
      questions.push({
        key,
        label: spec.label,
        endpoints: spec.endpoints,
        unit: 'cm',
        why: spec.why,
        hint: spec.hint,
        example: key === 'corridorWidth' ? '约 62' : '约 80',
        optional: false
      });
    }
  }

  const remainingKeys = [];
  for (const k of Array.isArray(r.remainingKeys) ? r.remainingKeys : []) {
    if (MEASUREMENT_SPECS[k] && !questions.some((q) => q.key === k) && !measured.has(k) && !remainingKeys.includes(k)) remainingKeys.push(k);
  }
  if (!remainingKeys.length) {
    for (const k of MEASUREMENT_KEYS) {
      if (remainingKeys.length >= 8) break;
      if (questions.some((q) => q.key === k) || measured.has(k)) continue;
      remainingKeys.push(k);
    }
  }

  const targetKeys = measureTargetKeys(session);
  const attemptedTargets = targetKeys.filter((k) => measured.has(k)).length;

  return {
    round,
    questions: questions.slice(0, 2),
    remainingKeys,
    totalTargets: targetKeys.length,
    attemptedTargets,
    askNote: cleanText(r.askNote, 'default', 40) || (questions.length > 1 ? '这轮先量这两个就够。' : '这轮先量这一个就够。')
  };
}

function normalizePlan(raw, session) {
  const r = parseRaw(raw);
  const image = session && session.image;
  const profile = (session && session.profile) || {};
  const cap = isNum(profile.budget) && profile.budget > 0
    ? profile.budget
    : budgetFromGoal(profile.goal) != null
      ? budgetFromGoal(profile.goal)
      : isNum(r.budget && r.budget.cap)
        ? r.budget.cap
        : null;
  const est = isNum(r.budget && r.budget.est) ? Math.max(0, r.budget.est) : 0;
  const budget = {
    cap,
    est: Math.round(est * 10) / 10,
    status: cap != null && est > cap ? 'over' : 'within'
  };

  const annotations = [];
  const annSeen = new Set();
  for (const a of Array.isArray(r.annotations) ? r.annotations.slice(0, 3) : []) {
    if (!a || typeof a !== 'object') continue;
    const id = typeof a.id === 'number' ? String(a.id) : typeof a.id === 'string' && a.id.trim() ? a.id.trim().slice(0, 4) : String(annotations.length + 1);
    if (annSeen.has(id)) continue;
    annSeen.add(id);
    annotations.push({
      id,
      label: cleanText(a.label, 'plan', 12) || `标注 ${annotations.length + 1}`,
      bbox: sanitizeBbox(a.bbox, fallbackBbox(annotations.length), image),
      note: cleanText(a.note, 'plan', 24)
    });
  }

  const items = [];
  const itemSeen = new Set();
  for (const item of Array.isArray(r.items) ? r.items.slice(0, 4) : []) {
    if (!item || typeof item !== 'object') continue;
    const type = oneOf(item.type, ['new', 'reuse'], 'new');
    const skuId = typeof item.sku === 'string' ? item.sku.trim() : null;
    const sku = type === 'new' && skuId ? SKU_BY_ID.get(skuId) : null;
    const dimsIn = item.dimsCm && typeof item.dimsCm === 'object' ? item.dimsCm : {};
    const dims = {
      w: toNum(dimsIn.w, sku ? sku.dimsCm.w : 0),
      d: toNum(dimsIn.d, sku ? sku.dimsCm.d : 0),
      h: toNum(dimsIn.h, sku ? sku.dimsCm.h : 0)
    };
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 8) : `i${items.length + 1}`;
    if (itemSeen.has(id)) id = `i${items.length + 1}`;
    itemSeen.add(id);
    const fit = oneOf(item.fit, ['ok', 'blocked'], 'blocked');
    const fitNote = cleanText(item.fitNote, 'plan', 50);
    items.push({
      id,
      type,
      title: sku ? sku.title : cleanText(item.title, 'plan', 20) || (type === 'reuse' ? '复用旧物' : '待选物品'),
      sku: sku ? sku.id : type === 'reuse' ? null : skuId,
      dimsCm: dims,
      price: type === 'reuse' ? 0 : sku ? sku.price : toNum(item.price, 0),
      why: cleanText(item.why, 'plan', 40),
      fit: sku ? fit : type === 'reuse' ? fit : 'blocked',
      fitNote: sku || type === 'reuse'
        ? fitNote || (fit === 'blocked' ? '尺寸或现场条件未确认；补齐后再评估' : '')
        : '库外型号已拦截',
      confidence: oneOf(item.confidence, ['high', 'medium', 'low'], 'low'),
      tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string').slice(0, 3).map((t) => cleanText(t, 'plan', 8)) : sku ? sku.tags.slice(0, 3) : []
    });
  }

  const constraints = [];
  const consSeen = new Set();
  for (const c of Array.isArray(r.constraints) ? r.constraints.slice(0, 5) : []) {
    const key = c && (typeof c === 'string' ? c : c.key);
    if (!MEASUREMENT_SPECS[key] || consSeen.has(key)) continue;
    consSeen.add(key);
    const op = oneOf(c.op, ['>=', '<=', '>', '<', '=='], '>=');
    const valueCm = toNum(c.valueCm, null);
    const actualCm = isNum(c.actualCm) ? c.actualCm : null;
    let status = oneOf(c.status, ['pass', 'warn', 'fail', 'unknown'], 'unknown');
    if (actualCm == null || valueCm == null) status = 'unknown';
    constraints.push({
      key,
      label: MEASUREMENT_SPECS[key].label,
      op,
      valueCm: valueCm == null ? null : Math.round(valueCm * 10) / 10,
      actualCm: actualCm == null ? null : Math.round(actualCm * 10) / 10,
      status,
      note: cleanText(c.note, 'plan', 40)
    });
  }

  let checklist = [];
  const checkSeen = new Set();
  for (const c of Array.isArray(r.checklist) ? r.checklist.slice(0, 6) : []) {
    if (!c || typeof c !== 'object') continue;
    const text = cleanText(c.text, 'plan', 60);
    if (!text || checkSeen.has(text)) continue;
    checkSeen.add(text);
    checklist.push({
      id: typeof c.id === 'string' && c.id.trim() ? c.id.trim().slice(0, 4) : `c${checklist.length + 1}`,
      text,
      critical: asBool(c.critical, false)
    });
  }
  if (!checklist.length) {
    checklist.push({ id: 'c1', text: '现场按标注核对实际尺寸和墙脚，确认能摆再下单。', critical: true });
  }
  // V2.1：checklist[0] 必须是计划句；太泛/超长/截断在数字单位里 → 用分句重建
  if (!isPlanSentenceText(checklist[0] && checklist[0].text)) {
    const ps = buildPlanSentence(items, constraints);
    checklist = [ps, ...checklist.filter((c) => String(c.text) !== ps.text)].slice(0, 6);
  }

  const blocked = [];
  const blockedSeen = new Set();
  for (const b of Array.isArray(r.blocked) ? r.blocked.slice(0, 4) : []) {
    if (!b || typeof b !== 'object') continue;
    const what = cleanText(b.what, 'plan', 20);
    const reason = cleanText(b.reason, 'plan', 50);
    if (!what || !reason || blockedSeen.has(what)) continue;
    blockedSeen.add(what);
    blocked.push({ what, reason });
  }

  const radarIn = Array.isArray(r.radar) ? r.radar : [];
  const radar = RADAR_SPECS.map((spec) => {
    const found = radarIn.find((x) => x && (x.key === spec.key || x.label === spec.label));
    return {
      key: spec.key,
      label: spec.label,
      score: clamp(toInt(found && found.score, 3), 0, 5),
      note: cleanText(found && found.note, 'plan', 12) || '启发式参考，非实测'
    };
  });

  const aftercareIn = r.aftercare && typeof r.aftercare === 'object' ? r.aftercare : {};
  const aftercare = {
    day7: cleanText(aftercareIn.day7, 'plan', 60) || '第 7 天看猫用不用：不用就把窝垫换成旧衣服。',
    day14: cleanText(aftercareIn.day14, 'plan', 60) || '第 14 天还不用，先别加购，把窝挪到更安静的角落。'
  };

  // 产品底线：关键尺寸未知 / 预算超 / 照片不合格时，normalize 也不允许返回 ok
  let verdict = oneOf(r.verdict, ['ok', 'conditional', 'not_supported', 'insufficient'], 'insufficient');
  const knownKeys = measurementsCm(session).known.map((m) => m.key);
  const criticalUnknown = FLOOR_REQUIRED_KEYS.filter((k) => !knownKeys.includes(k));
  if (criticalUnknown.length) verdict = 'insufficient';
  if (cap != null && est > cap && verdict === 'ok') verdict = 'conditional';
  if (session && session.quality && session.quality.status === 'retake') verdict = 'insufficient';

  // headline 必须与 verdict 一致（Lead 要求在 normalize 层就拦住「不许放却写可以放」）
  let headline = cleanText(r.headline, 'plan', 30);
  const placeWords = /(完全可以|可以放|能放|可换|能换|放得下|可行|没问题|推荐)/;
  if (verdict === 'insufficient') {
    if (session && session.quality && session.quality.status === 'retake') {
      headline = '照片不合格，先重拍再定';
    } else if (criticalUnknown.length) {
      headline = `还差「${criticalUnknown.slice(0, 2).map((k) => MEASUREMENT_SPECS[k].label).join('、')}」没量，先别定`;
    } else if (!headline || placeWords.test(headline)) {
      headline = '关键尺寸没量全，先别定摆放';
    }
  } else if (verdict === 'not_supported') {
    const failed = constraints.find((c) => c.status === 'fail');
    if (failed) {
      headline = `先别放：${failed.label}只有 ${failed.actualCm}cm，不够`;
    } else if (!headline || placeWords.test(headline)) {
      headline = '当前条件不支持，先别放';
    }
  } else if (verdict === 'conditional') {
    // conditional = 有条件可放：肯定词必须配一个条件；否则换成中性条件句
    const strongCondition = /(但|满足|才可|条件|若|如果|需要先|先看|先量)/;
    if (!headline || /(完全可以|没问题|一定|还差|没量|缺|照片不合格)/.test(headline) || (placeWords.test(headline) && !strongCondition.test(headline))) {
      headline = '满足下列条件才可放，先看尺寸条件';
    }
  }
  if (!headline) {
    if (verdict === 'ok') headline = '条件够，按尺寸选款';
    else if (verdict === 'conditional') headline = '能放，但要先满足下面这些条件';
    else if (verdict === 'not_supported') headline = '当前条件不支持，先别放';
    else headline = '关键尺寸没量全，先别定摆放';
  }
  if (Array.from(headline).length > 30) headline = Array.from(headline).slice(0, 30).join('');

  return {
    verdict,
    headline,
    budget,
    annotations,
    items,
    constraints,
    checklist,
    blocked,
    radar,
    aftercare,
    behavior: normalizeBehaviorInput(r.behavior),
    observe: normalizeObserveInput(r.observe),
    ifThen: normalizeIfThenInput(r.ifThen),
    disclaimer: L1_DISCLAIMER
  };
}

function normalizeAsk(raw, session) {
  const r = parseRaw(raw);
  const pick = pickOf(session);

  // Lead 约定的 ask 结构：{reply, verdict, pieces, missing}
  let verdict = oneOf(r.verdict, ['ok', 'conditional', 'blocked', 'insufficient'], 'insufficient');
  const known = new Set(measurementsCm(session).known.map((m) => m.key));
  const criticalUnknown = FLOOR_REQUIRED_KEYS.filter((k) => !known.has(k));
  if (criticalUnknown.length && verdict === 'ok') verdict = 'conditional';
  if (session && session.quality && session.quality.status === 'retake') verdict = 'insufficient';

  const pieces = [];
  for (const p of Array.isArray(r.pieces) ? r.pieces.slice(0, 4) : []) {
    const text = cleanText(typeof p === 'string' ? p : p && (p.text || p.note), 'l0', 40);
    if (text) pieces.push(text);
  }
  if (!pieces.length && r.region && typeof r.region === 'object') {
    const why = cleanText(r.region.why, 'l0', 40);
    const risk = cleanText(r.region.risk, 'l0', 40);
    if (why) pieces.push(why);
    if (risk) pieces.push(risk);
  }
  if (!pieces.length) {
    if (pick) pieces.push(`这个位置在画面${horizontalWord(pick.nx)}${verticalWord(pick.ny)}`);
    pieces.push(criticalUnknown.length ? '关键尺寸还没量，先别定放什么' : '方向能看，具体尺寸还要现场确认');
  }

  const missing = [];
  for (const m of Array.isArray(r.missing) ? r.missing.slice(0, 3) : []) {
    if (typeof m === 'string') {
      const text = cleanText(m, 'l0', 16);
      if (text) missing.push(text);
      continue;
    }
    if (m && typeof m === 'object') {
      const key = m.key && MEASUREMENT_SPECS[m.key] ? m.key : null;
      const text = cleanText(key ? MEASUREMENT_SPECS[key].label : m.label, 'l0', 16);
      if (text) missing.push(text);
    }
  }
  if (!missing.length && criticalUnknown.length) {
    for (const k of criticalUnknown) {
      if (missing.length >= 3) break;
      missing.push(MEASUREMENT_SPECS[k].label);
    }
  }

  return {
    reply: cleanText(r.reply, 'l0', 60) || (pick ? '这个位置能看方向，但还没量尺寸，先量通道和墙角。' : '先说你在这里想放什么，我再按照片看方向。'),
    verdict,
    pieces: pieces.slice(0, 4),
    missing: missing.slice(0, 3)
  };
}

/**
 * 结构补全 + 强校验 + 禁用词清洗 + 免责文案注入。绝不抛错，永远返回契约结构。
 * @param {'quality'|'l0'|'measure'|'plan'|'ask'} stage
 * @param {object|string} raw 模型原始输出（对象或字符串）
 * @param {object} session
 */
export function normalize(stage, raw, session = {}) {
  try {
    switch (stage) {
      case 'quality':
        return normalizeQuality(raw, session);
      case 'measure':
        return normalizeMeasure(raw, session);
      case 'plan':
        return normalizePlan(raw, session);
      case 'ask':
        return normalizeAsk(raw, session);
      case 'l0':
      default:
        return normalizeL0(raw, session);
    }
  } catch {
    // 极端情况下也要返回可渲染的结构
    if (stage === 'quality') {
      return normalizeQuality({}, session);
    }
    if (stage === 'measure') {
      return normalizeMeasure({}, session);
    }
    if (stage === 'plan') {
      return normalizePlan({}, session);
    }
    if (stage === 'ask') {
      return normalizeAsk({}, session);
    }
    return normalizeL0({}, session);
  }
}

export const __internals = Object.freeze({
  parseRaw,
  cleanText,
  sanitizeBbox,
  buildContext,
  SYSTEM_PROMPT,
  STAGE_TASK_TEXT,
  STAGES
});
