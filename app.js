'use strict';

/* ---------- 資料 ---------- */
const KEY = 'fitlog.v1';
const DEFAULT = {
  profile: { sex: 'm', age: 30, height: 170, activity: 1.55, rest: 90, unit: 'kg' },
  body: [],      // {id, date, weight, bodyfat, waist, chest, arm, hip, thigh}
  workouts: [],  // {id, date, planDay?, exercises:[{name, target?, feel?, pain?, sets:[{w, r, done}]}]}
  customEx: [],
  plan: null,    // {id, name, summary, days:[{name, focus, exercises:[{name, sets, repMin, repMax, rest, startWeight, inc, note}]}], nutrition, client, nextDay, source}
  coachForm: { goal: '', exp: '', days: '', mins: '', equip: '', limits: '', extra: '' }, // 免費模式的問卷
};
let S = load();

function normalize(d) {
  const { chat, chatCtx, aiUsage, ...rest } = d; // 舊版付費 AI 對話的欄位，不再使用
  return { ...structuredClone(DEFAULT), ...rest, coachForm: { ...DEFAULT.coachForm, ...(d.coachForm || {}) }, profile: { ...DEFAULT.profile, ...(d.profile || {}) } };
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { console.warn(e); }
  return structuredClone(DEFAULT);
}
let saveTimer, dirty = false;
function save() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}
function saveNow(force) {
  clearTimeout(saveTimer);
  if (!dirty && force !== true) return; // 沒改過就不寫，避免蓋掉其他分頁的資料
  try { localStorage.setItem(KEY, JSON.stringify(S)); dirty = false; }
  catch (e) { toast('儲存失敗：' + e.message); }
}
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* ---------- 工具 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const fmt = (n, d = 1) => n == null ? '—' : (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('zh-TW', { maximumFractionDigits: d });
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const today = () => isoDate(new Date());
const daysAgo = n => isoDate(new Date(Date.now() - n * 864e5));
function dateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const wk = '日一二三四五六'[dt.getDay()];
  if (iso === today()) return `今天 (${wk})`;
  return `${m}/${d} (${wk})${y !== new Date().getFullYear() ? ' ' + y : ''}`;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 公式 ---------- */
const F = {
  e1rm(w, r) { // Epley / Brzycki 平均
    if (!w || !r) return null;
    if (r === 1) return w;
    const epley = w * (1 + r / 30);
    const brzycki = r < 37 ? w * 36 / (37 - r) : epley;
    return (epley + brzycki) / 2;
  },
  epley: (w, r) => r === 1 ? w : w * (1 + r / 30),
  brzycki: (w, r) => r === 1 ? w : w * 36 / (37 - r),
  lombardi: (w, r) => w * Math.pow(r, 0.1),
  bmi: (kg, cm) => kg / Math.pow(cm / 100, 2),
  bmiCat(b) { // 衛福部國健署標準
    if (b < 18.5) return ['體重過輕', 'warn'];
    if (b < 24) return ['健康體位', ''];
    if (b < 27) return ['過重', 'warn'];
    if (b < 30) return ['輕度肥胖', 'danger'];
    if (b < 35) return ['中度肥胖', 'danger'];
    return ['重度肥胖', 'danger'];
  },
  bmr: (sex, kg, cm, age) => 10 * kg + 6.25 * cm - 5 * age + (sex === 'f' ? -161 : 5), // Mifflin-St Jeor
  katch: (kg, bf) => 370 + 21.6 * kg * (1 - bf / 100), // Katch-McArdle，有體脂時較準
};
const ACTIVITY = [
  [1.2, '久坐', '幾乎不運動'],
  [1.375, '輕度', '每週運動 1–3 天'],
  [1.55, '中度', '每週運動 3–5 天'],
  [1.725, '高度', '每週運動 6–7 天'],
  [1.9, '非常高', '體力勞動 + 每天訓練'],
];
const METRICS = [
  ['weight', '體重', 'kg'],
  ['bodyfat', '體脂', '%'],
  ['waist', '腰圍', 'cm'],
  ['chest', '胸圍', 'cm'],
  ['arm', '臂圍', 'cm'],
  ['hip', '臀圍', 'cm'],
  ['thigh', '大腿圍', 'cm'],
];
function latest(key) {
  const e = S.body.filter(b => b[key] != null).sort((a, b) => b.date.localeCompare(a.date))[0];
  return e ? e[key] : null;
}
function energy() { // 依最新體重算 BMI / BMR / TDEE
  const p = S.profile, kg = latest('weight'), bf = latest('bodyfat');
  if (!kg) return null;
  const bmrK = bf != null ? F.katch(kg, bf) : null;
  const bmr = bmrK ?? F.bmr(p.sex, kg, p.height, p.age);
  return { kg, bf, bmi: F.bmi(kg, p.height), bmr, katch: !!bmrK, tdee: bmr * p.activity };
}

/* ---------- 動作庫：部位 → 細項 → 動作 ---------- */
const EX_TREE = {
  '胸': {
    '上胸': ['上斜槓鈴臥推', '上斜啞鈴臥推', '上斜啞鈴飛鳥', '低位繩索夾胸'],
    '中胸': ['槓鈴臥推', '啞鈴臥推', '機械胸推', '伏地挺身'],
    '下胸': ['雙槓撐體', '下斜臥推', '高位繩索夾胸'],
    '孤立': ['蝴蝶機夾胸', '啞鈴飛鳥', '繩索夾胸'],
  },
  '背': {
    '背闊（寬度）': ['引體向上', '滑輪下拉', '窄握下拉', '直臂下拉'],
    '中背（厚度）': ['槓鈴划船', '啞鈴單臂划船', '坐姿划船', 'T 槓划船', '胸靠划船'],
    '下背': ['硬舉', '背伸展', '早安式'],
  },
  '腿': {
    '股四頭': ['槓鈴深蹲', '高腳杯深蹲', '前蹲舉', '腿推機', '哈克深蹲', '腿伸展'],
    '腿後側': ['羅馬尼亞硬舉', '腿彎舉', '單腳羅馬尼亞硬舉'],
    '臀': ['臀推', '保加利亞分腿蹲', '弓箭步', '臀橋', '髖外展機'],
    '小腿': ['站姿提踵', '坐姿提踵'],
  },
  '肩': {
    '前束': ['站姿肩推', '啞鈴肩推', '機械肩推', '前平舉'],
    '中束': ['側平舉', '繩索側平舉', '直立划船'],
    '後束': ['反向飛鳥', '臉拉', '反向蝴蝶機'],
  },
  '手臂': {
    '二頭': ['槓鈴彎舉', '啞鈴彎舉', '錘式彎舉', '上斜啞鈴彎舉', '繩索彎舉'],
    '三頭': ['三頭下壓', '過頭三頭伸展', '窄握臥推', '仰臥三頭伸展'],
    '前臂': ['腕彎舉', '農夫走路'],
  },
  '核心': {
    '腹直肌': ['捲腹', '懸垂舉腿', '健腹輪'],
    '腹斜肌': ['俄羅斯轉體', '側棒式', '繩索伐木'],
    '穩定（秒數）': ['棒式', '死蟲式', '鳥狗式'],
  },
};
const PARTS = Object.keys(EX_TREE);
const EX_INFO = {};
for (const [part, subs] of Object.entries(EX_TREE))
  for (const [sub, list] of Object.entries(subs))
    for (const n of list) EX_INFO[n] = { part, sub };
const BODYWEIGHT = new Set(['伏地挺身', '雙槓撐體', '引體向上', '背伸展', '捲腹', '懸垂舉腿', '健腹輪', '側棒式', '棒式', '死蟲式', '鳥狗式', '臀橋']);
const isBW = n => BODYWEIGHT.has(n);
const partOf = n => EX_INFO[n]?.part || null;
function incFor(n) { // 每次加重幅度
  if (/深蹲|硬舉|腿推|臀推|哈克/.test(n) && !/單腳|高腳杯/.test(n)) return 5;
  if (/啞鈴|側平舉|飛鳥|彎舉|前平舉|三頭|高腳杯|單腳|提踵/.test(n)) return 2;
  return 2.5;
}
const repUnit = n => /秒/.test(EX_INFO[n]?.sub || '') ? '秒' : '下';
const roundW = (x, inc) => { const step = inc >= 2.5 ? 2.5 : 1; return Math.max(0, Math.round(x / step) * step); };

/* ---------- 疼痛／代償提示 ---------- */
const PAIN_AREAS = ['肩膀', '手肘', '手腕', '下背', '膝蓋', '髖部', '頸部', '其他'];
const COMP_TIPS = {
  '胸': {
    '肩膀': '推胸時肩膀痛，常見是肩胛沒收緊下沉、或下放太深讓前三角代償。手肘內收約 45°、握距縮窄一點、控制下放深度。',
    '手肘': '握距過窄或手肘外開過大會壓迫手肘，調整握距、手腕疊在手肘正上方。',
    '手腕': '手腕過度後折。讓槓落在掌根、手腕打直，必要時用護腕。',
  },
  '背': {
    '手肘': '划船／下拉時手肘不適，常是二頭和前臂出力太多。想像用「手肘」往後帶，可用拉力帶。',
    '下背': '划船時下背痠代表軀幹在借力。降重、核心鎖緊、保持脊椎中立。',
    '肩膀': '下拉時肩膀前側不適，常是聳肩或拉得太後面。先把肩胛往下壓再拉。',
  },
  '腿': {
    '膝蓋': '深蹲膝蓋痛常見膝蓋內夾或重心太前。膝蓋對齊腳尖方向、重心放腳掌中段。',
    '下背': '腿部動作下背不適，常是蹲太深時骨盆後捲或核心沒撐住。縮小活動度、先練核心穩定。',
    '髖部': '髖前側夾擠感，試著把站距加寬、腳尖略外開。',
  },
  '肩': {
    '下背': '推舉時下背痛代表腰椎過度後仰借力。夾臀、收腹，或改坐姿有靠背的版本。',
    '頸部': '側平舉／推舉時頸部緊，常是斜方肌代償聳肩。降重、肩膀遠離耳朵。',
    '手肘': '手肘不要完全鎖死，控制離心速度。',
  },
  '手臂': {
    '下背': '彎舉時身體在晃動借力。降重，背靠牆做。',
    '手腕': '改用 EZ 槓或錘式握法減少手腕壓力。',
    '手肘': '手肘疼痛先降重、避免最後幾下爆發甩起來。',
  },
  '核心': {
    '下背': '做腹部動作下背痛，代表腰椎離開地面或髖屈肌代償。先改成較簡單的版本，下背貼地。',
    '頸部': '捲腹時不要用手拉頭，下巴與胸口保持一個拳頭距離。',
  },
};
function compTip(name, area) {
  const part = partOf(name);
  const tip = part && COMP_TIPS[part]?.[area];
  return tip || '出現疼痛先停止這個動作；若是關節刺痛、麻或持續幾天沒改善，請就醫。';
}

/* ---------- 歷史查詢 ---------- */
function sessionsOf(name, beforeDate, n = 3) {
  const out = [];
  const ws = S.workouts.filter(w => w.date < beforeDate).sort((a, b) => b.date.localeCompare(a.date));
  for (const w of ws) {
    const ex = w.exercises.find(e => e.name === name);
    if (!ex) continue;
    const sets = ex.sets.filter(s => s.w != null && s.r && s.done !== false);
    if (!sets.length) continue;
    out.push({ date: w.date, sets, feel: ex.feel || 'ok', pain: ex.pain || '' });
    if (out.length >= n) break;
  }
  return out;
}
function lastPerformance(name, beforeDate) {
  const ws = S.workouts.filter(w => w.date < beforeDate).sort((a, b) => b.date.localeCompare(a.date));
  for (const w of ws) {
    const ex = w.exercises.find(e => e.name === name);
    if (ex) {
      const sets = ex.sets.filter(s => s.w != null && s.r);
      if (sets.length) return { date: w.date, sets };
    }
  }
  return null;
}
function bestE1rm(name) {
  let best = null;
  for (const w of S.workouts) for (const e of w.exercises) if (e.name === name)
    for (const s of e.sets) { if (s.done === false) continue; const v = F.e1rm(s.w, s.r); if (v && (!best || v > best.v)) best = { v, date: w.date, w: s.w, r: s.r }; }
  return best;
}
function volume(w) {
  let v = 0, sets = 0;
  for (const e of w.exercises) for (const s of e.sets) if (s.w != null && s.r && s.done) { v += s.w * s.r; sets++; }
  return { v, sets };
}

/* ---------- 漸進式超負荷規則 ----------
   雙重漸進：在次數區間內先加次數，每組都達上限再加重。
   回饋：輕鬆 → 加兩級；吃力 → 達標也先維持；動作跑掉 → 退一級；疼痛 → 減 10%。
   連續兩次未達下限 → 減 10% 重新累積。徒手動作以次數、組數進步。 */
const FEELS = [['easy', '輕鬆'], ['ok', '剛好'], ['hard', '吃力'], ['form', '動作跑掉'], ['pain', '疼痛']];
const FEEL_LABEL = Object.fromEntries(FEELS);

function suggestNext(pe, beforeDate) {
  const inc = pe.inc || incFor(pe.name);
  const u = repUnit(pe.name);
  const hist = sessionsOf(pe.name, beforeDate, 2);
  const last = hist[0];
  // 徒手：動作庫標記、課表加重幅度為 0，或上次都是 0 kg 的自訂動作
  const bw = isBW(pe.name) || pe.inc === 0 || (!EX_INFO[pe.name] && !!last && last.sets.every(s => !s.w));
  const t = { sets: pe.sets, reps: pe.repMin, weight: bw ? 0 : (pe.startWeight > 0 ? pe.startWeight : null), kind: 'start', reason: '' };

  if (!last) {
    t.reason = bw ? `第一次：徒手，${pe.repMin}–${pe.repMax} ${u}，動作標準優先`
      : t.weight ? `第一次：從 ${fmt(t.weight)} kg 開始，動作標準優先`
      : `第一次：選一個能標準做 ${pe.repMax} ${u}、還留 2–3 ${u}餘力的重量`;
    return t;
  }

  const W = Math.max(...last.sets.map(s => s.w || 0));
  const work = last.sets.filter(s => (s.w || 0) >= W - 0.01);
  const minR = Math.min(...work.map(s => s.r));
  const hitMax = work.filter(s => s.r >= pe.repMax).length >= pe.sets;
  const extraSets = work.filter(s => s.r >= pe.repMin).length > pe.sets;
  const below = work.filter(s => s.r < pe.repMin).length >= Math.ceil(pe.sets / 2);
  t.weight = W;

  if (last.feel === 'pain') {
    t.kind = 'down';
    if (bw) t.reps = Math.max(pe.repMin, minR - 2); else { t.weight = roundW(W * 0.9, inc); t.reps = pe.repMin; }
    t.reason = `上次${last.pain ? last.pain : ''}疼痛 → ${bw ? '減少次數' : `減重約 10%（${fmt(W)}→${fmt(t.weight)} kg）`}。${compTip(pe.name, last.pain)}`;
    return t;
  }
  if (last.feel === 'form') {
    t.kind = 'down';
    if (bw) t.reps = Math.max(pe.repMin, minR - 1); else t.weight = roundW(Math.max(0, W - inc), inc);
    t.reps = Math.max(t.reps, pe.repMin);
    t.reason = `上次動作跑掉 → ${bw ? '少做一點' : `退一級（${fmt(t.weight)} kg）`}，先把動作做穩再進步`;
    return t;
  }
  if (below) {
    const prev = hist[1];
    const prevW = prev ? Math.max(...prev.sets.map(s => s.w || 0)) : null;
    const prevBelow = prev && prev.sets.filter(s => (s.w || 0) >= W - 0.01 && s.r < pe.repMin).length >= Math.ceil(pe.sets / 2);
    if (!bw && prevW === W && prevBelow) {
      t.kind = 'down'; t.weight = roundW(W * 0.9, inc);
      t.reason = `連續兩次沒做到 ${pe.repMin} ${u} → 減重約 10% 重新累積（停滯期很正常）`;
    } else {
      t.kind = 'hold';
      t.reason = `上次沒做到 ${pe.repMin} ${u} → 維持重量再挑戰一次`;
    }
    return t;
  }
  if (hitMax || extraSets) {
    if (last.feel === 'hard') {
      t.kind = 'hold'; t.reps = pe.repMax;
      t.reason = '上次達標但吃力 → 同重量再做一次，穩了再加重';
      return t;
    }
    if (bw) {
      t.kind = 'up'; t.reps = pe.repMax; t.sets = Math.min(Math.max(work.length, pe.sets) + 1, pe.sets + 2);
      t.reason = t.sets > Math.max(work.length, pe.sets) ? `每組都達 ${pe.repMax} ${u} → 多加一組` : '組數已到上限 → 可以考慮加負重或換進階版本';
      return t;
    }
    const steps = last.feel === 'easy' ? 2 : 1;
    t.kind = 'up'; t.weight = roundW(W + inc * steps, inc); t.reps = pe.repMin;
    t.reason = `上次${extraSets ? '多做了組數' : `每組都達 ${pe.repMax} ${u}`}${steps > 1 ? '且輕鬆' : ''} → 加 ${fmt(t.weight - W)} kg`;
    return t;
  }
  t.kind = 'hold';
  t.reps = Math.min(pe.repMax, minR + 1);
  t.reason = bw ? `目標每組 ${t.reps} ${u}（每組都到 ${pe.repMax} ${u}就加一組）` : `同重量，目標每組 ${t.reps} ${u}（每組都到 ${pe.repMax} ${u}就加重）`;
  return t;
}

/* ---------- 課表範本 ---------- */
const ex = (name, sets, repMin, repMax, rest, note = '') => ({ name, sets, repMin, repMax, rest, startWeight: 0, inc: incFor(name), note });
const TEMPLATES = [
  {
    name: '新手全身 A/B（每週 3 天）',
    summary: '兩份全身課表輪流做，例如週一 A、週三 B、週五 A。每個動作先求標準，App 會依你的紀錄自動加重。',
    days: [
      { name: 'A 全身', focus: '深蹲、推、拉', exercises: [
        ex('高腳杯深蹲', 3, 8, 12, 90, '胸口挺直，膝蓋對齊腳尖'),
        ex('機械胸推', 3, 8, 12, 90, '肩胛收緊，手肘約 45°'),
        ex('滑輪下拉', 3, 8, 12, 90, '先沉肩再拉到上胸'),
        ex('啞鈴肩推', 2, 10, 12, 75),
        ex('棒式', 3, 30, 45, 60, '次數欄填秒數'),
      ] },
      { name: 'B 全身', focus: '髖鉸鏈、推、拉', exercises: [
        ex('腿推機', 3, 10, 12, 90, '下背貼緊椅背'),
        ex('坐姿划船', 3, 8, 12, 90, '挺胸，用手肘往後帶'),
        ex('上斜啞鈴臥推', 3, 8, 12, 90),
        ex('羅馬尼亞硬舉', 3, 8, 10, 120, '臀部往後推，背打直'),
        ex('側平舉', 2, 12, 15, 60, '肩膀遠離耳朵'),
      ] },
    ],
  },
  {
    name: '上下半身分化（每週 4 天）',
    summary: '上肢、下肢各兩天，例如一、二、四、五。適合有 3 個月以上訓練經驗。',
    days: [
      { name: '上肢 A', focus: '胸背主力', exercises: [
        ex('槓鈴臥推', 4, 6, 8, 150), ex('槓鈴划船', 4, 6, 8, 120), ex('啞鈴肩推', 3, 8, 12, 90),
        ex('滑輪下拉', 3, 10, 12, 90), ex('三頭下壓', 2, 12, 15, 60),
      ] },
      { name: '下肢 A', focus: '深蹲主力', exercises: [
        ex('槓鈴深蹲', 4, 6, 8, 180), ex('羅馬尼亞硬舉', 3, 8, 10, 120), ex('腿推機', 3, 10, 12, 90),
        ex('腿彎舉', 3, 10, 12, 75), ex('站姿提踵', 3, 12, 15, 60),
      ] },
      { name: '上肢 B', focus: '肩與手臂', exercises: [
        ex('上斜啞鈴臥推', 4, 8, 10, 120), ex('引體向上', 4, 6, 10, 120), ex('側平舉', 3, 12, 15, 60),
        ex('坐姿划船', 3, 10, 12, 90), ex('啞鈴彎舉', 3, 10, 12, 60),
      ] },
      { name: '下肢 B', focus: '硬舉與臀', exercises: [
        ex('硬舉', 3, 5, 5, 180, '每次都從地板重新開始'), ex('保加利亞分腿蹲', 3, 8, 10, 90), ex('腿伸展', 3, 12, 15, 60),
        ex('臀推', 3, 8, 12, 90), ex('懸垂舉腿', 3, 10, 15, 60),
      ] },
    ],
  },
];
function applyPlan(plan) {
  S.plan = { id: uid(), createdAt: today(), nextDay: 0, nutrition: null, client: null, source: 'template', ...plan };
  save();
}

/* ---------- 導覽 ---------- */
let tab = 'workout';
const TITLES = { workout: '訓練', body: '身體數據', coach: 'AI 教練', calc: '計算', settings: '個人與資料' };
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
function go(t) {
  tab = t;
  try { sessionStorage.setItem('fitlog.tab', t); } catch (e) {}
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('section.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + t));
  $('#title').textContent = TITLES[t];
  render();
  window.scrollTo(0, 0);
}
function render() {
  ({ workout: renderWorkout, body: renderBody, coach: renderCoach, calc: renderCalc, settings: renderSettings })[tab]();
}
document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go); });

/* ---------- 訓練 ---------- */
let editingId = null; // 正在編輯的過去訓練

function currentWorkout() {
  if (editingId) return S.workouts.find(w => w.id === editingId) || null;
  return S.workouts.find(w => w.date === today()) || null;
}

function startPlanDay(idx) {
  const day = S.plan.days[idx];
  const date = today();
  const w = { id: uid(), date, planDay: { planId: S.plan.id, idx, name: day.name }, exercises: [] };
  for (const pe of day.exercises) {
    const t = suggestNext(pe, date);
    w.exercises.push({
      name: pe.name,
      target: { sets: t.sets, repMin: pe.repMin, repMax: pe.repMax, rest: pe.rest, weight: t.weight, reps: t.reps, kind: t.kind, reason: t.reason, note: pe.note || '' },
      sets: Array.from({ length: t.sets }, () => ({ w: t.weight, r: t.reps, done: false })),
    });
  }
  S.workouts.push(w);
  S.plan.nextDay = (idx + 1) % S.plan.days.length;
  editingId = null;
  save(); renderWorkout();
}

function planStartCard() {
  if (!S.plan) {
    return `<div class="card" style="text-align:center;padding:24px 16px">
      <div style="font-size:18px;font-weight:700;margin-bottom:4px">今天還沒有訓練紀錄</div>
      <div class="muted small" style="margin-bottom:16px">有課表的話，動作、組數、次數、重量都會自動帶好</div>
      <button class="primary big block" data-go="coach">讓 AI 教練幫我排課表</button>
      <div class="grid2" style="margin-top:10px">
        <button data-act="templates">套用範本課表</button>
        <button data-act="start">自由訓練</button>
      </div>
    </div>`;
  }
  const p = S.plan, nd = p.nextDay % p.days.length, day = p.days[nd];
  return `<div class="card">
    <div class="row"><div class="small muted">目前課表</div><div class="spacer"></div><button class="link small" data-act="view-plan">查看課表</button></div>
    <div style="font-weight:700;margin-bottom:10px">${esc(p.name)}</div>
    <button class="primary big block" data-act="start-day" data-idx="${nd}">開始 ${esc(day.name)}</button>
    <div class="small muted" style="margin:6px 2px 10px">${esc(day.exercises.map(e => e.name).join('、'))}</div>
    <div class="chips wrap">${p.days.map((d, i) => i === nd ? '' : `<button class="chip" data-act="start-day" data-idx="${i}">改做 ${esc(d.name)}</button>`).join('')}
      <button class="chip" data-act="start">自由訓練</button></div>
  </div>`;
}

function renderWorkout() {
  const el = $('#v-workout');
  const w = currentWorkout();
  $('#subtitle').textContent = w ? dateLabel(w.date) + (w.planDay ? ' · ' + w.planDay.name : '') : dateLabel(today());
  let h = '';

  if (!w) h += planStartCard();
  else {
    if (editingId && w.date !== today()) {
      h += `<div class="card row"><div><b>正在編輯 ${dateLabel(w.date)}</b></div><div class="spacer"></div>
        <button data-act="back-today">回到今天</button></div>`;
    }
    const vol = volume(w);
    h += `<div class="row" style="margin:0 4px 12px">
      <div class="stat"><span class="v num" id="vol-sets">${vol.sets}</span><span class="l">完成組數</span></div>
      <div style="width:24px"></div>
      <div class="stat"><span class="v num" id="vol-kg">${fmt(vol.v, 0)}<span class="u">kg</span></span><span class="l">總訓練量</span></div>
      <div class="spacer"></div>
      <input type="date" value="${w.date}" data-act="wdate" style="width:auto;min-height:40px" aria-label="訓練日期">
    </div>`;

    if (!w.exercises.length) h += `<div class="empty">按下方「新增動作」開始</div>`;
    w.exercises.forEach((ex, ei) => h += exerciseCard(w, ex, ei));
    h += `<button class="primary big block" data-act="add-ex">＋ 新增動作</button>`;
  }

  const hist = S.workouts.filter(x => !w || x.id !== w.id).sort((a, b) => b.date.localeCompare(a.date));
  h += `<h2>訓練歷史</h2>`;
  if (!hist.length) h += `<div class="card empty">還沒有過去的紀錄</div>`;
  else {
    h += `<div class="card" style="padding:4px 14px">`;
    hist.slice(0, 60).forEach(x => {
      const v = volume(x);
      const flags = x.exercises.filter(e => e.feel === 'pain' || e.feel === 'form').length;
      h += `<div class="list-item" data-act="open-w" data-id="${x.id}" style="cursor:pointer">
        <div style="min-width:0">
          <div><b>${dateLabel(x.date)}</b>${x.planDay ? ` <span class="small muted">${esc(x.planDay.name)}</span>` : ''}${flags ? ' <span class="badge warn">有回饋</span>' : ''}</div>
          <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.exercises.map(e => e.name).join('、') || '（無動作）')}</div>
        </div><div class="spacer"></div>
        <div class="small muted num" style="text-align:right;flex:none">${v.sets} 組<br>${fmt(v.v, 0)} kg</div>
      </div>`;
    });
    h += `</div>`;
  }
  el.innerHTML = h;
}

function exerciseCard(w, ex, ei) {
  const last = lastPerformance(ex.name, w.date);
  const best = bestE1rm(ex.name);
  const t = ex.target;
  const bw = isBW(ex.name);
  let meta = '';
  if (t) meta = `目標 ${t.sets}×${t.repMin === t.repMax ? t.repMin : t.repMin + '–' + t.repMax}${bw ? '' : t.weight != null ? ` @ ${fmt(t.weight)} kg` : ''} · 休息 ${t.rest} 秒`;
  else meta = last ? '上次 ' + last.sets.map(s => `${fmt(s.w)}×${s.r}`).join('、') : '第一次做這個動作';
  if (best) meta += ` · 最佳 1RM ≈ <b>${fmt(best.v)}</b>`;
  let h = `<div class="card" data-ei="${ei}">
    <div class="ex-head">
      <span class="name">${esc(ex.name)}</span><div class="spacer"></div>
      <button class="icon ghost" data-act="ex-menu" data-ei="${ei}" aria-label="動作選項">⋯</button>
    </div>
    <div class="ex-meta">${meta}</div>`;
  if (t && t.reason) h += `<div class="ex-reason ${t.kind}">${esc(t.reason)}${t.note ? `<div class="muted" style="margin-top:4px">要點：${esc(t.note)}</div>` : ''}</div>`;
  h += `<div class="set-head"><span>組</span><span>${bw ? '負重 kg' : '重量 kg'}</span><span>次數</span><span></span></div>`;
  ex.sets.forEach((s, si) => {
    const ph = last && last.sets[si] ? last.sets[si] : (last ? last.sets[last.sets.length - 1] : null);
    h += `<div class="set-row ${s.done ? 'done' : ''}" data-ei="${ei}" data-si="${si}">
      <span class="idx num">${si + 1}</span>
      <input class="num" inputmode="decimal" enterkeyhint="next" value="${s.w ?? ''}" placeholder="${ph ? fmt(ph.w) : bw ? '0' : ''}" data-f="w" aria-label="第 ${si + 1} 組重量">
      <input class="num" inputmode="numeric" enterkeyhint="done" value="${s.r ?? ''}" placeholder="${ph ? ph.r : ''}" data-f="r" aria-label="第 ${si + 1} 組次數">
      <button class="chk" data-act="done" aria-label="完成此組">✓</button>
    </div>`;
  });
  h += `<button class="block" data-act="add-set" data-ei="${ei}">＋ 新增一組</button>
    <div class="feel"><span class="small muted">感覺</span>
      ${FEELS.map(([k, l]) => `<button class="chip ${ex.feel === k ? 'on' + (k === 'pain' ? ' danger' : k === 'form' || k === 'hard' ? ' warn' : '') : ''}" data-act="feel" data-ei="${ei}" data-feel="${k}">${l}${k === 'pain' && ex.feel === 'pain' && ex.pain ? '：' + esc(ex.pain) : ''}</button>`).join('')}
    </div>
  </div>`;
  return h;
}

$('#v-workout').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const w = currentWorkout();
  if (act === 'start') {
    S.workouts.push({ id: uid(), date: today(), exercises: [] });
    editingId = null; save(); renderWorkout(); openExPicker();
  } else if (act === 'start-day') startPlanDay(+b.dataset.idx);
  else if (act === 'templates') openTemplates();
  else if (act === 'view-plan') openPlanSheet();
  else if (act === 'add-ex') openExPicker();
  else if (act === 'add-set') {
    const ex = w.exercises[+b.dataset.ei];
    const prev = ex.sets[ex.sets.length - 1];
    ex.sets.push({ w: prev ? prev.w : null, r: prev ? prev.r : null, done: false });
    save(); renderWorkout();
  } else if (act === 'done') {
    const row = b.closest('.set-row');
    const ex = w.exercises[+row.dataset.ei];
    const s = ex.sets[+row.dataset.si];
    // 空白時沿用 placeholder（上次的數字）
    if (s.w == null) { const p = num(row.querySelector('[data-f=w]').placeholder); if (p != null) s.w = p; else if (isBW(ex.name)) s.w = 0; }
    if (!s.r) { const p = num(row.querySelector('[data-f=r]').placeholder); if (p != null) s.r = p; }
    if (s.w == null || !s.r) { toast('請先填重量和次數'); return; }
    s.done = !s.done;
    save(); renderWorkout();
    if (s.done) { startRest(ex.target?.rest || S.profile.rest); if (navigator.vibrate) navigator.vibrate(30); }
  } else if (act === 'feel') {
    const ex = w.exercises[+b.dataset.ei];
    const f = b.dataset.feel;
    if (f === 'pain') { pickPain(ex); return; }
    ex.feel = ex.feel === f ? null : f; ex.pain = '';
    save(); renderWorkout();
    if (f === 'form') toast('下次這個動作會自動退一級重量');
  } else if (act === 'ex-menu') exMenu(+b.dataset.ei);
  else if (act === 'open-w') { editingId = b.dataset.id; renderWorkout(); window.scrollTo(0, 0); }
  else if (act === 'back-today') { editingId = null; renderWorkout(); }
});
$('#v-workout').addEventListener('input', e => {
  const inp = e.target;
  const w = currentWorkout();
  if (inp.dataset.act === 'wdate') return;
  const row = inp.closest('.set-row');
  if (!row || !w) return;
  const s = w.exercises[+row.dataset.ei].sets[+row.dataset.si];
  const v = num(inp.value);
  if (inp.dataset.f === 'w') s.w = v; else s.r = v == null ? null : Math.round(v);
  save(); updVolume();
});
$('#v-workout').addEventListener('change', e => {
  if (e.target.dataset.act === 'wdate' && e.target.value) {
    const w = currentWorkout();
    w.date = e.target.value;
    if (w.date !== today()) editingId = w.id;
    save(); renderWorkout();
  }
});
function updVolume() { // 不重繪，避免打字時鍵盤被收起
  const w = currentWorkout(); if (!w) return;
  const v = volume(w);
  const a = $('#vol-sets'), b = $('#vol-kg');
  if (a) a.textContent = v.sets;
  if (b) b.firstChild.textContent = fmt(v.v, 0);
}

function pickPain(ex) {
  openSheet(`<h3>哪裡不舒服？</h3>
    <div class="small muted" style="margin-bottom:10px">「${esc(ex.name)}」下次會自動減重 10%，並提示可能的代償原因。</div>
    <div class="chips wrap">${PAIN_AREAS.map(a => `<button class="chip ${ex.pain === a ? 'on danger' : ''}" data-area="${a}">${a}</button>`).join('')}</div>
    <div id="pain-tip" class="ex-reason down" style="margin-top:12px;display:none"></div>
    <div class="grid2" style="margin-top:12px">
      <button data-clear>取消疼痛標記</button>
      <button class="primary" data-ok disabled>確定</button>
    </div>`, sh => {
    let area = ex.pain || '';
    const showTip = () => {
      const tip = sh.querySelector('#pain-tip');
      tip.style.display = area ? 'block' : 'none';
      tip.textContent = area ? compTip(ex.name, area) : '';
      sh.querySelector('[data-ok]').disabled = !area;
    };
    showTip();
    sh.addEventListener('click', e => {
      const a = e.target.closest('[data-area]');
      if (a) {
        area = a.dataset.area;
        sh.querySelectorAll('[data-area]').forEach(c => c.className = 'chip' + (c.dataset.area === area ? ' on danger' : ''));
        showTip();
      } else if (e.target.closest('[data-ok]')) {
        ex.feel = 'pain'; ex.pain = area; save(); closeSheet(); renderWorkout();
      } else if (e.target.closest('[data-clear]')) {
        if (ex.feel === 'pain') { ex.feel = null; ex.pain = ''; save(); }
        closeSheet(); renderWorkout();
      }
    });
  });
}

function exMenu(ei) {
  const w = currentWorkout();
  const ex = w.exercises[ei];
  openSheet(`<h3>${esc(ex.name)}</h3>
    <button class="block" data-m="hist" style="margin-bottom:8px">查看此動作歷史</button>
    <button class="block" data-m="up" style="margin-bottom:8px" ${ei === 0 ? 'disabled' : ''}>上移</button>
    <button class="block" data-m="pop" style="margin-bottom:8px" ${ex.sets.length ? '' : 'disabled'}>刪除最後一組</button>
    <button class="block danger" data-m="del" style="margin-bottom:8px">刪除這個動作</button>
    <button class="block danger ghost" data-m="delw">刪除整次訓練</button>`, sh => {
    sh.addEventListener('click', e => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      if (m === 'hist') { exHistory(ex.name); return; }
      if (m === 'up') [w.exercises[ei - 1], w.exercises[ei]] = [w.exercises[ei], w.exercises[ei - 1]];
      if (m === 'pop') ex.sets.pop();
      if (m === 'del') { if (!confirm(`刪除「${ex.name}」？`)) return; w.exercises.splice(ei, 1); }
      if (m === 'delw') {
        if (!confirm(`刪除 ${dateLabel(w.date)} 的整次訓練？`)) return;
        S.workouts = S.workouts.filter(x => x !== w); editingId = null;
      }
      save(); closeSheet(); renderWorkout();
    });
  });
}

function exHistory(name) {
  const rows = [];
  S.workouts.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(w => {
    const ex = w.exercises.find(e => e.name === name);
    if (!ex) return;
    const sets = ex.sets.filter(s => s.w != null && s.r);
    if (!sets.length) return;
    const top = Math.max(...sets.map(s => F.e1rm(s.w, s.r) || 0));
    rows.push({ date: w.date, sets, top, feel: ex.feel, pain: ex.pain });
  });
  const pts = rows.filter(r => r.top).reverse().map(r => ({ x: r.date, y: r.top }));
  openSheet(`<h3>${esc(name)}</h3>
    ${isBW(name) ? '' : `<div class="small muted">每次訓練的估算 1RM</div><div class="chart">${chartSvg(pts, 'kg')}</div>`}
    ${rows.map(r => `<div class="list-item"><div><b>${dateLabel(r.date)}</b>${r.feel && r.feel !== 'ok' ? ` <span class="badge ${r.feel === 'pain' ? 'danger' : r.feel === 'easy' ? '' : 'warn'}">${FEEL_LABEL[r.feel]}${r.pain ? '：' + esc(r.pain) : ''}</span>` : ''}
      <div class="small muted num">${r.sets.map(s => `${fmt(s.w)}×${s.r}`).join('　')}</div></div>
      <div class="spacer"></div><div class="num" style="flex:none">${r.top ? fmt(r.top) + ' kg' : ''}</div></div>`).join('') || '<div class="empty">沒有資料</div>'}
    <button class="block" data-close style="margin-top:12px">關閉</button>`, sh => {
    sh.querySelector('[data-close]').onclick = closeSheet;
  });
}

/* 新增動作：部位 → 細項 → 動作 */
let pickerPart = null;
function openExPicker() {
  const recent = [];
  S.workouts.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(w => w.exercises.forEach(e => { if (!recent.includes(e.name)) recent.push(e.name); }));
  const tabs = [...(recent.length ? ['最近'] : []), ...PARTS, ...(S.customEx.length ? ['自訂'] : [])];
  if (!pickerPart || !tabs.includes(pickerPart)) pickerPart = tabs[0];
  const btn = n => `<button class="ex-btn" data-name="${esc(n)}">${esc(n)}</button>`;
  const body = q => {
    if (q) {
      const all = [...new Set([...Object.keys(EX_INFO), ...S.customEx, ...recent])];
      const hit = all.filter(n => n.toLowerCase().includes(q.toLowerCase()));
      return `<div class="ex-grid">${hit.map(btn).join('')}</div>
        ${hit.includes(q) ? '' : `<button class="block" data-name="${esc(q)}" style="margin-top:10px">＋ 新增自訂動作「${esc(q)}」</button>`}`;
    }
    if (pickerPart === '最近') return `<div class="ex-grid">${recent.slice(0, 12).map(btn).join('')}</div>`;
    if (pickerPart === '自訂') return `<div class="ex-grid">${S.customEx.map(btn).join('')}</div>`;
    return Object.entries(EX_TREE[pickerPart]).map(([sub, list]) =>
      `<div class="pick-group">${esc(sub)}</div><div class="ex-grid">${list.map(btn).join('')}</div>`).join('');
  };
  openSheet(`<div class="sheet-head">
      <h3>新增動作</h3>
      <input id="ex-q" placeholder="搜尋，或輸入新動作名稱" autocomplete="off" enterkeyhint="search">
      <div class="chips" id="ex-tabs" style="margin-top:10px">${tabs.map(t => `<button class="chip ${t === pickerPart ? 'on' : ''}" data-part="${t}">${t}</button>`).join('')}</div>
    </div>
    <div id="ex-list" style="margin-top:6px">${body('')}</div>`, sh => {
    const q = sh.querySelector('#ex-q');
    const list = sh.querySelector('#ex-list');
    q.addEventListener('input', () => list.innerHTML = body(q.value.trim()));
    q.addEventListener('keydown', e => { if (e.key === 'Enter' && q.value.trim()) add(q.value); });
    sh.addEventListener('click', e => {
      const p = e.target.closest('[data-part]');
      if (p) {
        pickerPart = p.dataset.part; q.value = '';
        sh.querySelectorAll('[data-part]').forEach(c => c.classList.toggle('on', c.dataset.part === pickerPart));
        list.innerHTML = body('');
        return;
      }
      const n = e.target.closest('[data-name]');
      if (n) add(n.dataset.name);
    });
    function add(name) {
      name = name.trim(); if (!name) return;
      if (!EX_INFO[name] && !S.customEx.includes(name)) S.customEx.push(name);
      const w = currentWorkout();
      const last = lastPerformance(name, w.date);
      const n = last ? last.sets.length : 3;
      w.exercises.push({ name, sets: Array.from({ length: n }, () => ({ w: null, r: null, done: false })) });
      save(); closeSheet(); renderWorkout();
      setTimeout(() => { const cards = document.querySelectorAll('#v-workout .card[data-ei]'); cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50);
    }
  });
}

/* 課表檢視 */
function planHtml(p, compact) {
  return p.days.map((d, i) => `<div class="plan-day">
    <b>${esc(d.name)}${d.focus ? ` <span class="small muted" style="font-weight:400">${esc(d.focus)}</span>` : ''}</b>
    ${d.exercises.map(e => `<div class="plan-ex"><span>${esc(e.name)}</span><span class="s num">${e.sets}×${e.repMin === e.repMax ? e.repMin : e.repMin + '–' + e.repMax}${!compact && e.startWeight > 0 ? ` · ${fmt(e.startWeight)}kg` : ''} · 休${e.rest}s</span></div>`).join('')}
  </div>`).join('');
}
function openPlanSheet() {
  const p = S.plan;
  const n = p.nutrition;
  openSheet(`<h3>${esc(p.name)}</h3>
    ${p.summary ? `<div class="small" style="margin-bottom:6px">${esc(p.summary)}</div>` : ''}
    ${planHtml(p)}
    ${n ? `<div class="ex-reason" style="margin-top:14px"><b>每日營養目標</b><br>${n.calories} kcal · 蛋白質 ${n.protein_g} g · 碳水 ${n.carbs_g} g · 脂肪 ${n.fat_g} g${n.tips ? `<div class="muted" style="margin-top:4px">${esc(n.tips)}</div>` : ''}</div>` : ''}
    <div class="grid2" style="margin-top:16px">
      <button data-go-coach>請 AI 調整</button>
      <button data-tpl>換範本</button>
    </div>
    <button class="block danger ghost" data-del style="margin-top:8px">刪除課表</button>`, sh => {
    sh.addEventListener('click', e => {
      if (e.target.closest('[data-go-coach]')) { closeSheet(); go('coach'); }
      else if (e.target.closest('[data-tpl]')) openTemplates();
      else if (e.target.closest('[data-del]')) {
        if (!confirm('刪除目前課表？訓練紀錄會保留。')) return;
        S.plan = null; save(); closeSheet(); render();
      }
    });
  });
}
function openTemplates() {
  openSheet(`<h3>範本課表</h3>
    ${TEMPLATES.map((t, i) => `<div class="card">
      <b>${esc(t.name)}</b><div class="small muted" style="margin:4px 0 6px">${esc(t.summary)}</div>
      ${planHtml(t, true)}
      <button class="primary block" data-tpl="${i}" style="margin-top:12px">套用</button>
    </div>`).join('')}
    <div class="small muted">想要依你的目標、時間、器材量身排？到「教練」分頁問 AI。</div>`, sh => {
    sh.addEventListener('click', e => {
      const b = e.target.closest('[data-tpl]');
      if (!b) return;
      if (S.plan && !confirm('取代目前課表？')) return;
      const t = structuredClone(TEMPLATES[+b.dataset.tpl]);
      applyPlan(t);
      closeSheet(); toast('已套用：' + t.name); render();
    });
  });
}

/* ---------- 休息計時 ---------- */
let restEnd = 0, restTick = null, restBeeped = false;
function startRest(sec) {
  restEnd = Date.now() + sec * 1000; restBeeped = false;
  $('#rest').classList.add('show');
  document.body.classList.add('resting');
  clearInterval(restTick); restTick = setInterval(updRest, 250); updRest();
}
function updRest() {
  const left = Math.round((restEnd - Date.now()) / 1000);
  const a = Math.abs(left);
  $('#rest-t').textContent = (left < 0 ? '+' : '') + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  $('#rest').classList.toggle('over', left <= 0);
  $('#rest-l').textContent = left <= 0 ? '該下一組了' : '休息中';
  if (left <= 0 && !restBeeped) {
    restBeeped = true;
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    beep();
  }
}
function stopRest() { clearInterval(restTick); $('#rest').classList.remove('show'); document.body.classList.remove('resting'); }
$('#rest-plus').onclick = () => { restEnd += 30000; if (restEnd > Date.now()) restBeeped = false; updRest(); };
$('#rest-minus').onclick = () => { restEnd -= 15000; updRest(); };
$('#rest-skip').onclick = stopRest;
let actx;
function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    [0, .25].forEach(t => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(.2, actx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + t + .2);
      o.start(actx.currentTime + t); o.stop(actx.currentTime + t + .2);
    });
  } catch (e) {}
}

/* ---------- 身體數據 ---------- */
let bodyMetric = 'weight', bodyRange = 90;
function renderBody() {
  const el = $('#v-body');
  $('#subtitle').textContent = S.body.length ? `${S.body.length} 筆紀錄` : '';
  const t = today();
  const existing = S.body.find(b => b.date === t);
  let h = `<div class="card">
    <div class="row" style="margin-bottom:10px"><b>記錄</b><div class="spacer"></div>
      <input type="date" id="b-date" value="${t}" style="width:auto;min-height:40px"></div>
    <div class="grid2" id="b-form">
      ${METRICS.map(([k, l, u]) => `<label class="field"><span>${l} (${u})</span>
        <input class="num" inputmode="decimal" data-k="${k}" value="${existing && existing[k] != null ? existing[k] : ''}" placeholder="${latest(k) ?? ''}"></label>`).join('')}
    </div>
    <button class="primary block" id="b-save" style="margin-top:12px">儲存</button>
    <div class="small muted" style="margin-top:6px">只填需要的欄位即可；同一天再存會更新該天資料。</div>
  </div>`;

  const pts = S.body.filter(b => b[bodyMetric] != null).sort((a, b) => a.date.localeCompare(b.date));
  const cutoff = bodyRange ? daysAgo(bodyRange) : '';
  const shown = pts.filter(p => p.date >= cutoff).map(p => ({ x: p.date, y: p[bodyMetric] }));
  const unit = METRICS.find(m => m[0] === bodyMetric)[2];
  let delta = '';
  if (shown.length >= 2) {
    const d = shown[shown.length - 1].y - shown[0].y;
    delta = `<span class="badge num" style="white-space:nowrap">${d > 0 ? '+' : ''}${fmt(d)} ${unit}</span>`;
  }
  h += `<h2>趨勢</h2><div class="card">
    <div class="chips">${METRICS.map(([k, l]) => `<button class="chip ${k === bodyMetric ? 'on' : ''}" data-metric="${k}">${l}</button>`).join('')}</div>
    <div class="row" style="margin:4px 0 6px">
      <div class="stat"><span class="v num">${shown.length ? fmt(shown[shown.length - 1].y) : '—'}<span class="u">${unit}</span></span></div>
      ${delta}
    </div>
    <div class="row" style="margin-bottom:4px">
      <div class="chips" style="padding:0">${[[30, '30天'], [90, '90天'], [365, '1年'], [0, '全部']].map(([d, l]) => `<button class="chip ${d === bodyRange ? 'on' : ''}" data-range="${d}">${l}</button>`).join('')}</div>
    </div>
    <div class="chart">${chartSvg(shown, unit)}</div>
  </div>`;

  const list = S.body.slice().sort((a, b) => b.date.localeCompare(a.date));
  h += `<h2>紀錄</h2>`;
  if (!list.length) h += `<div class="card empty">還沒有身體數據</div>`;
  else h += `<div class="card" style="padding:4px 14px">${list.slice(0, 100).map(b => `<div class="list-item">
      <div style="min-width:0"><b>${dateLabel(b.date)}</b>
      <div class="small muted num">${METRICS.filter(([k]) => b[k] != null).map(([k, l, u]) => `${l} ${fmt(b[k])}${u}`).join(' · ')}</div></div>
      <div class="spacer"></div><button class="icon ghost danger" data-del="${b.id}" aria-label="刪除">✕</button></div>`).join('')}</div>`;
  el.innerHTML = h;
}
$('#v-body').addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'b-save') {
    const date = $('#b-date').value || today();
    const vals = {};
    document.querySelectorAll('#b-form input').forEach(i => { const v = num(i.value); if (v != null) vals[i.dataset.k] = v; });
    if (!Object.keys(vals).length) { toast('至少填一個欄位'); return; }
    const rec = S.body.find(b => b.date === date);
    if (rec) Object.assign(rec, vals); else S.body.push({ id: uid(), date, ...vals });
    save(); toast('已儲存'); renderBody();
  } else if (t.dataset.metric) { bodyMetric = t.dataset.metric; renderBody(); }
  else if (t.dataset.range != null) { bodyRange = +t.dataset.range; renderBody(); }
  else if (t.dataset.del) {
    if (!confirm('刪除這筆紀錄？')) return;
    S.body = S.body.filter(b => b.id !== t.dataset.del); save(); renderBody();
  }
});
$('#v-body').addEventListener('change', e => {
  if (e.target.id !== 'b-date') return;
  const rec = S.body.find(b => b.date === e.target.value);
  document.querySelectorAll('#b-form input').forEach(i => i.value = rec && rec[i.dataset.k] != null ? rec[i.dataset.k] : '');
});

function chartSvg(pts, unit) {
  if (pts.length < 2) return `<div class="empty small">${pts.length ? '再多一筆就能畫出趨勢' : '沒有資料'}</div>`;
  const W = 340, H = 170, pl = 6, pr = 6, pt = 18, pb = 22;
  const toT = s => new Date(s).getTime();
  const xs = pts.map(p => toT(p.x)), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs); let x1 = Math.max(...xs); if (x0 === x1) x1 = x0 + 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.15 || 1; y0 -= pad; y1 += pad;
  const X = t => pl + (t - x0) / (x1 - x0) * (W - pl - pr);
  const Y = v => pt + (1 - (v - y0) / (y1 - y0)) * (H - pt - pb);
  const P = pts.map((p, i) => [X(xs[i]), Y(p.y)]);
  const line = P.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const area = `${P[0][0]},${H - pb} ${line} ${P[P.length - 1][0]},${H - pb}`;
  const iMax = ys.indexOf(Math.max(...ys)), iMin = ys.indexOf(Math.min(...ys));
  const lbl = (i, above) => {
    const [x, y] = P[i];
    const anchor = x < 30 ? 'start' : x > W - 30 ? 'end' : 'middle';
    return `<text x="${x}" y="${above ? y - 7 : y + 15}" text-anchor="${anchor}" class="num">${fmt(ys[i])}</text>`;
  };
  const md = s => { const [, m, d] = s.split('-'); return `${+m}/${+d}`; };
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="趨勢圖，單位 ${unit}">
    <line class="axis" x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}"/>
    <polygon class="area" points="${area}"/>
    <polyline class="line" points="${line}"/>
    ${P.length <= 40 ? P.map(p => `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="3.5"/>`).join('') : ''}
    ${lbl(iMax, true)}${iMin !== iMax ? lbl(iMin, false) : ''}
    <text x="${pl}" y="${H - 5}">${md(pts[0].x)}</text>
    <text x="${W - pr}" y="${H - 5}" text-anchor="end">${md(pts[pts.length - 1].x)}</text>
  </svg>`;
}

/* ---------- 計算 ---------- */
let calcW = '', calcR = '';
function renderCalc() {
  const el = $('#v-calc');
  const p = S.profile;
  const en = energy();
  $('#subtitle').textContent = en ? `使用最新體重 ${fmt(en.kg)} kg` : '';
  let h = `<h2>1RM 最大肌力估算</h2><div class="card">
    <div class="grid2">
      <label class="field"><span>重量 (kg)</span><input class="num" id="c-w" inputmode="decimal" value="${calcW}" placeholder="例如 80"></label>
      <label class="field"><span>次數</span><input class="num" id="c-r" inputmode="numeric" value="${calcR}" placeholder="例如 6"></label>
    </div>
    <div id="c-out"></div>
  </div>`;

  h += `<h2>BMI · BMR · TDEE</h2>`;
  if (!en) {
    h += `<div class="card empty">先到「身體」分頁記錄體重<br><button class="primary" data-go="body" style="margin-top:12px">去記錄體重</button></div>`;
  } else {
    const [cat, cls] = F.bmiCat(en.bmi);
    const lo = 18.5 * (p.height / 100) ** 2, hi = 24 * (p.height / 100) ** 2;
    const lbm = en.bf != null ? en.kg * (1 - en.bf / 100) : null;
    const n = S.plan?.nutrition;
    h += `<div class="card">
      <div class="grid2">
        <div class="stat"><span class="l">BMI</span><span class="v num">${fmt(en.bmi)}</span><span><span class="badge ${cls}">${cat}</span></span></div>
        <div class="stat"><span class="l">健康體重範圍</span><span class="v num" style="font-size:22px">${fmt(lo)}–${fmt(hi)}<span class="u">kg</span></span></div>
      </div>
    </div>
    <div class="card">
      <div class="grid2">
        <div class="stat"><span class="l">基礎代謝 BMR</span><span class="v num">${fmt(en.bmr, 0)}<span class="u">kcal</span></span>
          <span class="small muted">${en.katch ? 'Katch-McArdle（依體脂）' : 'Mifflin-St Jeor'}</span></div>
        <div class="stat"><span class="l">每日總消耗 TDEE</span><span class="v num">${fmt(en.tdee, 0)}<span class="u">kcal</span></span>
          <span class="small muted">活動係數 ×${p.activity}</span></div>
      </div>
      ${lbm ? `<div class="small muted" style="margin-top:10px">除脂體重 ${fmt(lbm)} kg · 體脂重 ${fmt(en.kg - lbm)} kg</div>` : ''}
    </div>
    ${n ? `<div class="card plan-card"><b>AI 教練建議</b>
      <div class="num" style="margin-top:6px">${n.calories} kcal · 蛋白質 ${n.protein_g} g · 碳水 ${n.carbs_g} g · 脂肪 ${n.fat_g} g</div>
      ${n.tips ? `<div class="small muted" style="margin-top:6px">${esc(n.tips)}</div>` : ''}</div>` : ''}
    <div class="card">
      <b>每日熱量目標（公式估算）</b>
      <table class="pct" style="margin-top:6px">
        <tr><th>目標</th><th>熱量</th><th>蛋白質</th></tr>
        <tr><td>減脂 (−20%)</td><td class="num">${fmt(en.tdee * .8, 0)} kcal</td><td class="num">${fmt(en.kg * 2, 0)} g</td></tr>
        <tr><td>微減脂 (−10%)</td><td class="num">${fmt(en.tdee * .9, 0)} kcal</td><td class="num">${fmt(en.kg * 1.8, 0)} g</td></tr>
        <tr><td>維持</td><td class="num">${fmt(en.tdee, 0)} kcal</td><td class="num">${fmt(en.kg * 1.6, 0)} g</td></tr>
        <tr><td>增肌 (+10%)</td><td class="num">${fmt(en.tdee * 1.1, 0)} kcal</td><td class="num">${fmt(en.kg * 1.8, 0)} g</td></tr>
      </table>
      <div class="small muted" style="margin-top:8px">蛋白質以每公斤體重 1.6–2.0 g 估算。</div>
    </div>`;
  }
  h += `<div class="card row"><div class="small muted">身高 ${p.height} cm · ${p.age} 歲 · ${p.sex === 'f' ? '女' : '男'} · ${ACTIVITY.find(a => a[0] === p.activity)?.[1] ?? ''}活動量</div>
    <div class="spacer"></div><button data-go="settings" style="flex:none">修改</button></div>`;
  el.innerHTML = h;
  upd1rm();
}
function upd1rm() {
  const w = num(calcW), r = num(calcR);
  const out = $('#c-out');
  if (!out) return;
  if (!w || !r || r < 1) { out.innerHTML = `<div class="small muted" style="margin-top:10px">輸入做得到的重量和次數（建議 2–10 下最準）</div>`; return; }
  if (r > 20) { out.innerHTML = `<div class="small" style="margin-top:10px;color:var(--warn)">超過 20 下估算誤差很大，請用較重的重量測試</div>`; return; }
  const rr = Math.round(r);
  const est = F.e1rm(w, rr);
  const pcts = [100, 95, 90, 85, 80, 75, 70, 65, 60, 50];
  const reps = { 100: 1, 95: 2, 90: 4, 85: 6, 80: 8, 75: 10, 70: 12, 65: 15, 60: 18, 50: 25 };
  out.innerHTML = `<div class="row" style="margin:14px 0 4px">
      <div class="stat"><span class="l">估算 1RM</span><span class="v num" style="font-size:36px;color:var(--accent)">${fmt(est)}<span class="u">kg</span></span></div>
    </div>
    <div class="small muted num">Epley ${fmt(F.epley(w, rr))} · Brzycki ${fmt(F.brzycki(w, rr))} · Lombardi ${fmt(F.lombardi(w, rr))}</div>
    <table class="pct" style="margin-top:10px">
      <tr><th>% 1RM</th><th>重量</th><th>約可做</th></tr>
      ${pcts.map(pc => `<tr><td>${pc}%</td><td class="num"><b>${fmt(Math.round(est * pc / 100 / 2.5) * 2.5)}</b> kg</td><td class="num muted">${reps[pc]} 下</td></tr>`).join('')}
    </table>
    <div class="small muted" style="margin-top:6px">重量已四捨五入到 2.5 kg（槓片可組合的最小單位）。</div>`;
}
$('#v-calc').addEventListener('input', e => {
  if (e.target.id === 'c-w') calcW = e.target.value;
  if (e.target.id === 'c-r') calcR = e.target.value;
  upd1rm();
});

/* ---------- 設定 ---------- */
function renderSettings() {
  const p = S.profile;
  $('#subtitle').textContent = '';
  $('#v-settings').innerHTML = `<h2>個人資料</h2><div class="card" id="prof">
    <div class="grid3">
      <label class="field"><span>性別</span><select data-p="sex"><option value="m" ${p.sex === 'm' ? 'selected' : ''}>男</option><option value="f" ${p.sex === 'f' ? 'selected' : ''}>女</option></select></label>
      <label class="field"><span>年齡</span><input class="num" inputmode="numeric" data-p="age" value="${p.age}"></label>
      <label class="field"><span>身高 cm</span><input class="num" inputmode="decimal" data-p="height" value="${p.height}"></label>
    </div>
    <label class="field" style="margin-top:10px"><span>活動量</span><select data-p="activity">
      ${ACTIVITY.map(([v, l, d]) => `<option value="${v}" ${v === p.activity ? 'selected' : ''}>${l}：${d}</option>`).join('')}
    </select></label>
    <label class="field" style="margin-top:10px"><span>預設休息時間（自由訓練用；課表動作依課表）</span><select data-p="rest">
      ${[45, 60, 90, 120, 150, 180, 240].map(s => `<option value="${s}" ${s === p.rest ? 'selected' : ''}>${s >= 60 ? Math.floor(s / 60) + ' 分' + (s % 60 ? ' ' + s % 60 + ' 秒' : '') : s + ' 秒'}</option>`).join('')}
    </select></label>
  </div>


  <h2>資料備份</h2><div class="card">
    <div class="small muted" style="margin-bottom:10px">資料只存在這支手機的瀏覽器裡。換手機或清除瀏覽器資料前，請先匯出備份。</div>
    <div class="grid2">
      <button id="exp">匯出備份</button>
      <button id="imp">匯入備份</button>
    </div>
    <input type="file" id="imp-file" accept="application/json,.json" hidden>
    <div class="small muted" style="margin-top:10px">目前：${S.workouts.length} 次訓練 · ${S.body.length} 筆身體數據${S.plan ? ' · 1 份課表' : ''}</div>
  </div>

  <h2>危險區</h2><div class="card">
    <button class="block danger" id="wipe">清除所有資料</button>
  </div>`;
}
$('#v-settings').addEventListener('change', async e => {
  const k = e.target.dataset.p;
  if (k) {
    const v = k === 'sex' ? e.target.value : num(e.target.value);
    if (v == null) return;
    S.profile[k] = v; save(); toast('已更新');
    return;
  }
  if (e.target.id !== 'imp-file' || !e.target.files[0]) return;
  try {
    const d = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(d.workouts) || !Array.isArray(d.body)) throw new Error('格式不符');
    if (!confirm(`匯入 ${d.workouts.length} 次訓練、${d.body.length} 筆身體數據？目前資料會被取代。`)) return;
    S = normalize(d);
    saveNow(true); toast('匯入完成'); renderSettings();
  } catch (err) { toast('匯入失敗：' + err.message); }
  e.target.value = '';
});
$('#v-settings').addEventListener('click', e => {
  const id = e.target.id;
  if (id === 'exp') {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `健身紀錄備份-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (id === 'imp') $('#imp-file').click();
  else if (id === 'wipe') {
    if (!confirm('確定清除所有訓練、身體數據與課表？此動作無法復原。')) return;
    if (!confirm('再確認一次：真的要全部刪除？')) return;
    S = structuredClone(DEFAULT); saveNow(true); toast('已清除'); renderSettings();
  }
});

/* ---------- Sheet ---------- */
function openSheet(html, bind) {
  const sh = $('#sheet');
  const fresh = sh.cloneNode(false); sh.replaceWith(fresh); // 清掉舊的 listener
  fresh.innerHTML = html;
  bind && bind(fresh);
  $('#sheet-bg').classList.add('show');
  requestAnimationFrame(() => fresh.classList.add('show'));
}
function closeSheet() {
  $('#sheet').classList.remove('show');
  $('#sheet-bg').classList.remove('show');
}
$('#sheet-bg').addEventListener('click', closeSheet);

/* ---------- 啟動 ---------- */
function boot() {
  let startTab = 'workout';
  try { startTab = sessionStorage.getItem('fitlog.tab') || 'workout'; } catch (e) {}
  go(startTab);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try { localStorage.removeItem('fitlog.apikey'); } catch (e) {} // 舊版付費模式留下的 key
  // 要求持久化儲存，降低瀏覽器自動清除資料的機率
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
