// 从 docs/RESEARCH-CAT.md 抽取 23 条判定规则 → app/server/data/evidence.json
import fs from 'node:fs';

const md = fs.readFileSync('docs/RESEARCH-CAT.md', 'utf8');
const block = md.split('```json')[1];
if (!block) throw new Error('没找到 JSON 块');
const jsonText = block.split('```')[0];
const rules = JSON.parse(jsonText);
console.log('parsed rules:', rules.length, 'ids:', rules.map((r) => r.id).join(','));

// 规则 id → 原始文献（URL 来自 RESEARCH-CAT.md 第 1 节证据总表）
const SRC = {
  LITTER_BOX_SIZE: { source: 'Carney et al. 2014, JFMS（AAFP/ISFM 排粪排尿指南）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11148882/', kind: 'guideline' },
  LITTER_BOX_COUNT: { source: 'Carney et al. 2014, JFMS（原文称 n+1 为 historical rule of thumb）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11148882/', kind: 'consensus' },
  LITTER_NEAR_APPLIANCE: { source: 'Carney et al. 2014, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11148882/', kind: 'guideline' },
  LITTER_NEAR_FOOD: { source: 'Carney et al. 2014, JFMS；Ellis et al. 2013, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11148882/', kind: 'guideline' },
  LITTER_BOX_ADJACENCY: { source: 'Carney et al. 2014, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11148882/', kind: 'guideline' },
  LITTER_SCOOP_FREQUENCY: { source: 'Padalino et al. 2023, JFMS（n=3,106 横断面）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10812005/', kind: 'study' },
  LITTER_COVERED: { source: 'Carney et al. 2014, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11148882/', kind: 'guideline' },
  HIDING_PLACE_COUNT: { source: 'Ellis et al. 2013, JFMS（AAFP/ISFM 环境需求指南）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/', kind: 'guideline' },
  HIDING_ENCLOSURE: { source: 'Ellis et al. 2013, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/', kind: 'guideline' },
  HIDING_BOX_EFFECT: { source: 'van der Leij et al. 2019, PLoS ONE（RCT, n=23）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6791553/', kind: 'study' },
  PERCH_SIZE: { source: 'Ellis et al. 2013, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/', kind: 'guideline' },
  PERCH_CONCEALMENT: { source: 'Taylor et al. 2022, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10845436/', kind: 'guideline' },
  SCRATCH_POST_LOCATION: { source: 'Demirbas et al. 2024, Front Vet Sci（n=1,211 问卷）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11251885/', kind: 'study' },
  SCRATCH_POST_FORM: { source: 'Ellis et al. 2013, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/', kind: 'guideline' },
  PASSAGE_WIDTH: { source: 'van der Leij et al. 2019, PLoS ONE（仅有躲藏箱入口实测，无通道宽度试验）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6791553/', kind: 'experience' },
  NEW_ITEM_SCENT: { source: 'Ellis et al. 2013, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/', kind: 'guideline' },
  ACCLIMATION_WINDOW: { source: 'van der Leij et al. 2019, PLoS ONE（RCT：有遮蔽 2 天稳定 vs 无遮蔽 9 天）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6791553/', kind: 'study' },
  LITTER_RELOCATION: { source: 'Carney et al. 2014, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11148882/', kind: 'guideline' },
  THERMAL_COMFORT: { source: 'Taylor et al. 2022, JFMS（等热区 30–38 ℃）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10845436/', kind: 'guideline' },
  DRAFT_AND_FLOOR: { source: 'Taylor et al. 2022, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10845436/', kind: 'guideline' },
  SUNLIGHT_POSITION: { source: 'Yaw et al. 2025, iScience（101 只猫，4 组光照，收容所情境）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC12182317/', kind: 'study' },
  MULTICAT_SEPARATION: { source: 'Ellis et al. 2013, JFMS', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/', kind: 'guideline' },
  PLAY_SEQUENCE: { source: 'Ellis et al. 2013, JFMS（指南只规定结构，未规定分钟数）', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/', kind: 'guideline' },
};

// 额外条目：用于 UI 展示的"承认不知道"
const extra = [
  {
    id: 'EVIDENCE-GAP-NOUSE',
    topic: '猫窝使用率',
    claim: '目前没有研究能排出「猫为什么不用新猫窝」的原因顺序，所以只能逐项排查，不能给排名。',
    strength: 'strong',
    kind: 'review',
    source: '文献检索未发现猫窝使用率的对照试验（2026-10 检索）',
    url: '',
    threshold: null,
    caveat: '这条本身就是一条结论：承认证据缺口，比编一个原因排序更诚实。',
  },
  {
    id: 'REST-QUALITY',
    topic: '休息点权重',
    claim: '家猫一天里真正活动的只占约 2.8%，大部分时间在躺卧——所以休息点的舒适度决定它的生活质量。',
    strength: 'moderate',
    kind: 'study',
    source: 'Smit et al. 2024, Sensors（28 只家猫，加速度计+机器学习）',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11053832/',
    threshold: { activeSharePct: 2.8 },
    caveat: '样本 28 只、新西兰家庭，外推到中国城市家庭需谨慎，但方向可信。',
  },
  {
    id: 'PLAY-DURATION-NO-EVIDENCE',
    topic: '陪玩时长',
    claim: '「每天陪玩 15 分钟」找不到对照试验支持；指南只规定玩耍要跑完捕猎全程，没规定时长。',
    strength: 'weak',
    kind: 'consensus',
    source: 'Ellis et al. 2013, JFMS；Demirbas et al. 2024 甚至发现玩耍时长与乱抓正相关',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/',
    threshold: null,
    caveat: '不要把分钟数写成科学结论，也不要用「多陪玩就不会乱抓」做承诺。',
  },
  {
    id: 'REST_SIZE_STRETCH',
    topic: '休息点尺寸',
    claim: '休息点要能让猫整个身体伸展开；「猫窝必须比猫大 2 倍」没有出处，只能做宽松判断。',
    strength: 'consensus',
    kind: 'guideline',
    source: 'Ellis et al. 2013, JFMS（栖架/休息点要够宽够长可伸展）；「2 倍体长」查无出处',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11383066/',
    threshold: { mustAllowFullStretch: true, minMultipleOfBodyLength: null },
    rule: '猫窝/休息点只需能完全容纳蜷卧或侧躺；不设倍数硬指标',
    caveat: '唯一有实验的倍数建议是砂盆 1.5 倍体长，且该倍数本身也是专家推荐值；猫窝不要套用。',
  },
  {
    id: 'NA-RULE',
    topic: '不涉及的功能',
    claim: '这次方案不涉及的功能，必须明确标「不涉及」，不能因为「没发现问题」就算通过。',
    strength: 'consensus',
    kind: 'consensus',
    source: '产品原则（诚实呈现，参见 RESEARCH-PSYCH UC-1/UC-2 与 RESEARCH-CAT §3 总原则）',
    url: '',
    threshold: null,
    caveat: '把「不涉及」算成 pass 会让 6 项里出现虚假的绿色，违背三态设计的初衷。',
  },
  {
    id: 'SCRATCH-PLAY-PARADOX',
    topic: '抓挠与活跃度',
    claim: '越活泼、玩得越久的猫，乱抓报告反而更多——所以「多陪玩就能解决乱抓」不成立。',
    strength: 'weak',
    kind: 'study',
    source: 'Demirbas et al. 2024, Front Vet Sci（n=1,211）',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11251885/',
    threshold: null,
    caveat: '横断面相关，可能是活跃猫本来就抓得多；不能据此判断位置好坏。',
  },
];

const items = [];
for (const r of rules) {
  const s = SRC[r.id];
  if (!s) {
    console.warn('⚠ 缺少来源映射:', r.id);
    continue;
  }
  items.push({
    id: r.id,
    topic: r.topic,
    claim: r.basisText || r.rule,
    strength: r.strength,
    kind: s.kind,
    source: s.source,
    url: s.url,
    threshold: r.thresholds || null,
    rule: r.rule,
    caveat: r.caveat || '',
  });
}
items.push(...extra);

const out = {
  version: 'v2.0 — 2026-10-24（来源：docs/RESEARCH-CAT.md）',
  items,
};
fs.writeFileSync('app/server/data/evidence.json', JSON.stringify(out, null, 2), 'utf8');
console.log('wrote items:', items.length);
console.log('strength dist:', items.reduce((a, i) => ((a[i.strength] = (a[i.strength] || 0) + 1), a), {}));
console.log('kind dist:', items.reduce((a, i) => ((a[i.kind] = (a[i.kind] || 0) + 1), a), {}));
console.log('missing url:', items.filter((i) => !i.url).map((i) => i.id));
