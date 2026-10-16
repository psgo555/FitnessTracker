'use strict';
/* AI 教練：用使用者自己的 Anthropic API key，在瀏覽器直接呼叫 Claude。
   漸進加重規則在 app.js 本機運算（離線可用）；AI 負責了解使用者、排課表、解讀紀錄、營養建議。 */

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.130.0/+esm';
const MODEL = 'claude-opus-5-5';
const PRICE = { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 }; // US$ / 百萬 tokens
const KEY_API = 'fitlog.apikey';

function getApiKey() { try { return localStorage.getItem(KEY_API) || ''; } catch (e) { return ''; } }
function setApiKey(k) { try { k ? localStorage.setItem(KEY_API, k) : localStorage.removeItem(KEY_API); } catch (e) {} }

let AnthropicSDK = null;
async function getClient() {
  if (!AnthropicSDK) AnthropicSDK = (await import(SDK_URL)).default;
  return new AnthropicSDK({ apiKey: getApiKey(), dangerouslyAllowBrowser: true });
}

/* ---------- 提示詞與工具（固定內容放前面，方便 prompt cache） ---------- */
const EX_LIST = Object.entries(EX_TREE).map(([part, subs]) =>
  `${part}：${Object.entries(subs).map(([sub, l]) => `${sub}（${l.join('、')}）`).join('；')}`).join('\n');

const SYSTEM = `你是這個健身紀錄 App 內建的 AI 教練，同時具備專業肌力與體能教練、以及運動營養師的知識與經驗。使用者用繁體中文（台灣用語）跟你對話，你也用繁體中文回答。

你的工作：
1. 了解使用者：目標（增肌、減脂、肌力、體態、健康）、訓練經驗、每週可訓練天數與每次時間、可用器材（健身房／居家啞鈴／徒手）、傷病或不適部位、飲食習慣。App 會在使用者訊息開頭附上 <app_data>（身體數據、計算值、課表、近期訓練與回饋），已經知道的不要再問。缺資訊時一次只問最關鍵的 2–3 個問題，不要丟一長串問卷。
2. 資訊足夠時，呼叫 save_workout_plan 產生課表，課表會顯示給使用者確認後套用，套用後 App 會把動作、組數、次數、重量、休息時間自動帶進每次訓練。動作名稱請優先使用下方「動作清單」裡的名稱（App 才能對應歷史紀錄與加重規則）。新手選動作簡單、穩定的器械與基本複合動作，起始重量保守（寧輕勿重），不確定就填 0 讓 App 請使用者自選。每個動作用 note 寫一句最重要的動作要點。課表長度要符合使用者每次可用的時間。
3. 漸進式超負荷由 App 依規則自動處理：在次數區間內先加次數，每組都達上限就加重（輕鬆加兩級）；吃力時先維持；動作跑掉退一級；回報疼痛減重約 10% 並提示代償原因；連續兩次未達下限減約 10%。你負責看 <app_data> 裡的趨勢與回饋：停滯、反覆疼痛或代償（例如練胸卻肩膀痛）時，說明可能原因，必要時換動作或調整課表（再呼叫一次 save_workout_plan）。
4. 營養：依目標與 TDEE 給每日熱量與三大營養素，用台灣常見食物舉例（便利商店、自助餐、早餐店），並寫進 save_workout_plan 的 nutrition。
5. 安全：疼痛、麻、刺痛、胸悶、頭暈等症狀要建議停止並就醫，你不做醫療診斷。未成年、懷孕、高血壓、心臟病、糖尿病等情況，先建議諮詢醫師。

回答方式：使用者在手機上看，回答要簡短、具體、可以直接照做；避免長篇大論和大表格。

動作清單：
${EX_LIST}`;

const PLAN_TOOL = {
  name: 'save_workout_plan',
  description: '建立或更新使用者的訓練課表與每日營養目標。課表會顯示給使用者，使用者按「套用」後才會生效。',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['plan_name', 'summary', 'client_profile', 'days', 'nutrition'],
    properties: {
      plan_name: { type: 'string', description: '課表名稱，例如「新手全身 3 天」' },
      summary: { type: 'string', description: '給使用者看的 2–4 句說明：為什麼這樣排、一週怎麼安排、執行重點' },
      client_profile: {
        type: 'object', additionalProperties: false,
        required: ['goal', 'experience', 'days_per_week', 'session_minutes', 'equipment', 'limitations'],
        properties: {
          goal: { type: 'string' },
          experience: { type: 'string' },
          days_per_week: { type: 'integer' },
          session_minutes: { type: 'integer' },
          equipment: { type: 'string' },
          limitations: { type: 'string', description: '傷病或不適部位，沒有就填「無」' },
        },
      },
      days: {
        type: 'array', description: '每個訓練日，依執行順序排列',
        items: {
          type: 'object', additionalProperties: false,
          required: ['name', 'focus', 'exercises'],
          properties: {
            name: { type: 'string', description: '短名稱，例如「A 上肢推」' },
            focus: { type: 'string', description: '這天的重點' },
            exercises: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                required: ['name', 'sets', 'rep_min', 'rep_max', 'rest_sec', 'start_weight_kg', 'increment_kg', 'note'],
                properties: {
                  name: { type: 'string' },
                  sets: { type: 'integer' },
                  rep_min: { type: 'integer', description: '次數區間下限；棒式等靜態動作填秒數' },
                  rep_max: { type: 'integer' },
                  rest_sec: { type: 'integer' },
                  start_weight_kg: { type: 'number', description: '建議起始重量；徒手填 0；不確定填 0，App 會請使用者自選' },
                  increment_kg: { type: 'number', description: '每次加重幅度：下肢複合 5、上肢槓鈴與器械 2.5、啞鈴與孤立動作 2' },
                  note: { type: 'string', description: '一句動作要點' },
                },
              },
            },
          },
        },
      },
      nutrition: {
        type: 'object', additionalProperties: false,
        required: ['calories', 'protein_g', 'carbs_g', 'fat_g', 'tips'],
        properties: {
          calories: { type: 'integer' },
          protein_g: { type: 'integer' },
          carbs_g: { type: 'integer' },
          fat_g: { type: 'integer' },
          tips: { type: 'string', description: '1–3 句飲食建議，用台灣常見食物舉例' },
        },
      },
    },
  },
};

/* ---------- App 資料摘要（AI 自動讀取） ---------- */
function appContext() {
  const p = S.profile;
  const L = [`今天：${today()}`];
  L.push(`個人：${p.sex === 'f' ? '女' : '男'}、${p.age} 歲、身高 ${p.height} cm、活動量「${ACTIVITY.find(a => a[0] === p.activity)?.[2] ?? p.activity}」`);
  const bodyLatest = METRICS.map(([k, l, u]) => {
    const e = S.body.filter(b => b[k] != null).sort((a, b) => b.date.localeCompare(a.date))[0];
    return e ? `${l} ${fmt(e[k])}${u}（${e.date}）` : null;
  }).filter(Boolean);
  L.push('最新身體數據：' + (bodyLatest.join('、') || '尚未記錄'));
  const ws = S.body.filter(b => b.weight != null && b.date >= daysAgo(30)).sort((a, b) => a.date.localeCompare(b.date));
  if (ws.length >= 2) L.push(`近 30 天體重變化：${fmt(ws[ws.length - 1].weight - ws[0].weight)} kg`);
  const en = energy();
  if (en) L.push(`估算：BMI ${fmt(en.bmi)}、BMR ${fmt(en.bmr, 0)} kcal、TDEE ${fmt(en.tdee, 0)} kcal`);
  if (S.plan) {
    const pl = S.plan;
    L.push(`目前課表「${pl.name}」，下次輪到 ${pl.days[pl.nextDay % pl.days.length].name}：`);
    pl.days.forEach(d => L.push(`  ${d.name}：${d.exercises.map(e => `${e.name} ${e.sets}×${e.repMin}-${e.repMax}`).join('、')}`));
    if (pl.client) L.push(`課表建立時的使用者資訊：${Object.entries(pl.client).map(([k, v]) => `${k}=${v}`).join('、')}`);
  } else L.push('目前課表：無');
  const recent = S.workouts.filter(w => w.date >= daysAgo(28)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  L.push(`近 4 週訓練：${recent.length} 次`);
  for (const w of recent) {
    const exs = w.exercises.map(e => {
      const sets = e.sets.filter(s => s.done && s.w != null && s.r).map(s => `${fmt(s.w)}×${s.r}`).join(',');
      const fb = e.feel && e.feel !== 'ok' ? `［${FEEL_LABEL[e.feel]}${e.pain ? '：' + e.pain : ''}］` : '';
      return sets || fb ? `${e.name} ${sets || '未完成'}${fb}` : null;
    }).filter(Boolean);
    if (exs.length) L.push(`  ${w.date}${w.planDay ? ' ' + w.planDay.name : ''}：${exs.join('；')}`);
  }
  return `<app_data>\n${L.join('\n')}\n</app_data>`;
}

/* ---------- 對話 ---------- */
let coachBusy = false;
let liveText = '';
let coachErr = '';

const QUICK = [
  ['幫我排課表', '我想請你幫我排一份健身課表。'],
  ['檢討最近訓練', '幫我看看最近的訓練紀錄，有沒有停滯、代償或需要調整的地方？'],
  ['飲食怎麼吃', '依照我的目標，每天應該怎麼吃？給我具體份量和台灣常見的食物例子。'],
  ['今天練什麼', '今天應該練什麼？有什麼要注意的？'],
];

let coachMode = null; // 'free' 複製貼上 | 'api' App 內對話

function renderCoach() {
  const el = $('#v-coach');
  $('#subtitle').textContent = '教練＋營養師';
  if (!coachMode) coachMode = getApiKey() ? 'api' : 'free';
  const modes = `<div class="chips" style="margin-bottom:8px">
    <button class="chip ${coachMode === 'free' ? 'on' : ''}" data-mode="free">免費：複製貼上</button>
    <button class="chip ${coachMode === 'api' ? 'on' : ''}" data-mode="api">App 內對話（付費）</button>
  </div>`;
  if (coachMode === 'free') { el.innerHTML = modes + freeHtml(); bindFree(); return; }
  if (!getApiKey()) { el.innerHTML = modes + keySetupHtml(); return; }

  let h = modes;
  if (!S.chat.length) {
    h += `<div class="card">
      <b>嗨，我是你的 AI 教練</b>
      <div class="small muted" style="margin-top:6px">我會讀取 App 裡的身體數據和訓練紀錄，問你幾個問題（目標、經驗、時間、器材、傷病），然後排一份課表。套用後每次訓練的動作、組數、次數、重量都會自動帶好，並依你的表現自動加減重。</div>
    </div>`;
  }
  h += `<div id="chat">${chatHtml()}</div>`;
  if (coachErr && !coachBusy) h += `<div class="msg err">${esc(coachErr)}</div>`;
  if (coachBusy) h += `<div class="msg ai" id="live">${liveText ? mdHtml(liveText) : '<span class="typing">教練思考中…</span>'}</div>`;
  h += `<div class="chips" style="margin-top:8px">${QUICK.map(([l, t]) => `<button class="chip" data-q="${esc(t)}" ${coachBusy ? 'disabled' : ''}>${l}</button>`).join('')}
    ${S.chat.length ? `<button class="chip" data-act="new-chat" ${coachBusy ? 'disabled' : ''}>開新對話</button>` : ''}</div>
  <div class="composer">
    <textarea id="coach-in" rows="1" placeholder="跟教練說說你的狀況…" ${coachBusy ? 'disabled' : ''}></textarea>
    <button class="primary" id="coach-send" ${coachBusy ? 'disabled' : ''} aria-label="送出">送出</button>
  </div>`;
  el.innerHTML = h;
  const ta = $('#coach-in');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
}

function keySetupHtml() {
  return `<div class="card">
    <b>App 內直接對話（付費）</b>
    <div class="small" style="margin:8px 0">AI 教練使用 Anthropic 的 Claude，需要你自己的 API key（按用量付費，排一份課表約 US$0.05–0.15）。</div>
    <ol class="small muted" style="padding-left:20px;margin:0 0 12px">
      <li>到 console.anthropic.com 註冊並儲值</li>
      <li>在 Settings → API Keys 建立一把 key</li>
      <li>複製後貼在下面</li>
    </ol>
    <input id="key-in" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
    <button class="primary block" id="key-save" style="margin-top:10px">儲存</button>
    <div class="small muted" style="margin-top:10px">key 只存在這支手機的瀏覽器，不會上傳到其他地方，也不會放進備份檔。不想付費就用上面的「免費：複製貼上」，加減重規則一樣會運作。</div>
  </div>`;
}

/* ---------- 免費模式：複製指令到任何 AI 聊天，再把課表貼回來 ---------- */
const FORM_FIELDS = [
  ['goal', '目標', ['增肌', '減脂', '增肌同時減脂', '提升肌力', '健康與體態']],
  ['exp', '訓練經驗', ['完全新手', '不到 1 年', '1–3 年', '3 年以上']],
  ['days', '每週可練幾天', ['2', '3', '4', '5', '6']],
  ['mins', '每次多久（分鐘）', ['30', '45', '60', '90']],
  ['equip', '器材', ['健身房（器材齊全）', '居家（啞鈴＋椅子）', '只有徒手']],
];
const AI_SITES = [['ChatGPT', 'https://chatgpt.com/'], ['Gemini', 'https://gemini.google.com/'], ['Claude', 'https://claude.ai/new']];
let pasteText = '', pastePlan = null, pasteErr = '', copyFallback = '';

const JSON_EXAMPLE = `{
  "plan_name": "課表名稱",
  "summary": "2–4 句說明：為什麼這樣排、一週怎麼安排",
  "client_profile": {"goal": "增肌", "experience": "新手", "days_per_week": 3, "session_minutes": 60, "equipment": "健身房", "limitations": "無"},
  "days": [
    {"name": "A 上肢推", "focus": "胸、肩、三頭", "exercises": [
      {"name": "槓鈴臥推", "sets": 3, "rep_min": 8, "rep_max": 12, "rest_sec": 90, "start_weight_kg": 0, "increment_kg": 2.5, "note": "一句動作要點"}
    ]}
  ],
  "nutrition": {"calories": 2400, "protein_g": 140, "carbs_g": 280, "fat_g": 70, "tips": "用台灣常見食物舉例"}
}`;

function buildPrompt(kind) {
  const f = S.coachForm;
  const v = x => x && String(x).trim() ? x : '未填（請合理假設）';
  const task = {
    new: '幫我排一份新的健身課表和每日營養目標。資訊不足的地方請做合理假設並在說明中提到，不要反問我。',
    adjust: '根據我最近的訓練紀錄與回饋（吃力、動作跑掉、疼痛），檢討目前的課表，給我調整後的完整課表。說明改了哪裡、為什麼；如果有疼痛或代償，說明可能原因和動作修正。',
    data: '以下是我的健身資料。請當我的健身教練和營養師，回答我接下來的問題。回答要簡短、具體、可以直接照做。',
  }[kind];
  const ctx = appContext().replace(/^<app_data>\n|\n<\/app_data>$/g, '');
  let p = `你是專業的肌力與體能教練，同時是運動營養師。請用繁體中文（台灣用語）回答。

【任務】
${task}

【我的狀況】
目標：${v(f.goal)}
訓練經驗：${v(f.exp)}
每週可訓練：${v(f.days)} 天，每次約 ${v(f.mins)} 分鐘
器材：${v(f.equip)}
傷病或不適部位：${f.limits.trim() || '無'}
其他需求：${f.extra.trim() || '無'}

【健身 App 自動整理的資料】
${ctx}`;
  if (kind === 'data') return p;
  p += `

【排課原則】
- 動作名稱請優先使用下方「動作清單」裡的名稱，App 才能對應紀錄。
- 新手選動作簡單、穩定的器械與基本複合動作，起始重量保守（寧輕勿重）；不確定就填 0，App 會讓我自己選。
- 每次訓練的長度要符合我可用的時間。
- App 會自動漸進：在次數區間內先加次數，每組都到上限就加重 increment_kg（下肢複合 5、上肢槓鈴與器械 2.5、啞鈴與孤立動作 2），所以請給次數區間。
- 棒式等靜態動作，rep_min／rep_max 填秒數。
- 營養依我的目標與 TDEE 計算，用台灣常見食物舉例（便利商店、自助餐、早餐店）。
- 若有疼痛、麻、胸悶、頭暈等症狀，提醒我就醫。

【回覆格式】
先用 3–5 句話說明你的安排，然後輸出一個 \`\`\`json 程式碼區塊，格式完全照下面（鍵名不要改，數字不要加單位，不要加註解）：
\`\`\`json
${JSON_EXAMPLE}
\`\`\`

【動作清單】
${EX_LIST}`;
  return p;
}

function parsePlanText(text) {
  text = text.replace(/[“”＂]/g, '"').replace(/[‘’]/g, "'");
  const cands = [];
  for (const m of text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) cands.push(m[1]);
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) cands.push(text.slice(a, b + 1));
  for (const c of cands) {
    for (const t of [c, c.replace(/,\s*([}\]])/g, '$1')]) { // 容錯：多餘的逗號
      try {
        let o = JSON.parse(t);
        if (o && o.plan && !o.days) o = o.plan;
        if (o && Array.isArray(o.days) && o.days.length) return o;
      } catch (e) { /* 試下一個 */ }
    }
  }
  return null;
}

function freeHtml() {
  const f = S.coachForm;
  const sel = ([k, label, opts]) => `<label class="field"><span>${label}</span><select data-cf="${k}">
    <option value="">（未選）</option>${opts.map(o => `<option ${f[k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  let h = `<div class="card">
    <b>1. 告訴教練你的狀況</b>
    <div class="small muted" style="margin:4px 0 10px">身高、體重、體脂、訓練紀錄 App 會自動附上，不用再打。</div>
    <div class="grid2">${FORM_FIELDS.map(sel).join('')}</div>
    <label class="field" style="margin-top:10px"><span>傷病或不適部位（沒有就空白）</span><input data-cf="limits" value="${esc(f.limits)}" placeholder="例如：右肩前側推東西會痛"></label>
    <label class="field" style="margin-top:10px"><span>其他需求</span><input data-cf="extra" value="${esc(f.extra)}" placeholder="例如：想練翹臀、不想做深蹲"></label>
  </div>

  <div class="card">
    <b>2. 複製指令，貼到 AI 聊天</b>
    <div class="small muted" style="margin:4px 0 10px">任何免費 AI 都可以，貼上後直接送出。</div>
    <button class="primary block" data-copy="new">複製：排一份新課表</button>
    <div class="grid2" style="margin-top:8px">
      <button data-copy="adjust" ${S.plan || S.workouts.length ? '' : 'disabled'}>複製：依紀錄調整</button>
      <button data-copy="data">複製：只附我的資料</button>
    </div>
    <div class="small muted" style="margin-top:6px">「只附我的資料」適合問飲食或其他問題，不會產生課表。</div>
    ${copyFallback ? `<div class="small" style="margin-top:10px">這支手機不允許自動複製，請長按下面的文字 → 全選 → 複製：</div>
      <textarea id="copy-fallback" rows="5" readonly style="margin-top:6px">${esc(copyFallback)}</textarea>` : ''}
    <div class="row wrap" style="margin-top:12px">${AI_SITES.map(([n, u]) => `<a class="chip" href="${u}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:inline-flex;align-items:center">開啟 ${n} ↗</a>`).join('')}</div>
  </div>

  <div class="card">
    <b>3. 把 AI 的回覆整段貼回來</b>
    <div class="small muted" style="margin:4px 0 10px">在 AI 回覆下方按「複製」，貼在這裡。App 會自動找出課表。</div>
    <textarea id="paste-in" rows="4" placeholder="貼上 AI 的回覆…">${esc(pasteText)}</textarea>
    <button class="primary block" id="paste-read" style="margin-top:8px">讀取課表</button>
    ${pasteErr ? `<div class="msg err" style="margin-top:10px">${esc(pasteErr)}</div>` : ''}
  </div>`;
  if (pastePlan) {
    const p = toPlan(pastePlan), n = pastePlan.nutrition;
    const unknown = unknownEx(p);
    h += `<div class="card plan-card" id="paste-preview">
      <div class="small muted">讀到的課表</div>
      <div style="font-weight:700;font-size:17px">${esc(p.name)}</div>
      ${p.summary ? `<div class="small" style="margin-top:4px">${esc(p.summary)}</div>` : ''}
      ${planHtml(p)}
      ${n ? `<div class="ex-reason" style="margin-top:12px">每日 ${n.calories} kcal · 蛋白質 ${n.protein_g} g · 碳水 ${n.carbs_g} g · 脂肪 ${n.fat_g} g</div>` : ''}
      ${unknown.length ? `<div class="small muted" style="margin-top:8px">不在動作庫的動作（會當成自訂動作）：${esc(unknown.join('、'))}</div>` : ''}
      <button class="primary block" id="paste-apply" style="margin-top:10px">套用這份課表</button>
    </div>`;
  }
  return h;
}

function unknownEx(p) {
  return [...new Set(p.days.flatMap(d => d.exercises.map(e => e.name)).filter(n => !EX_INFO[n]))];
}

function bindFree() {
  const ta = $('#paste-in');
  ta.addEventListener('input', () => { pasteText = ta.value; });
  const fb = $('#copy-fallback');
  if (fb) { fb.focus(); fb.select(); }
}

$('#v-coach').addEventListener('change', e => {
  const k = e.target.dataset.cf;
  if (!k) return;
  S.coachForm[k] = e.target.value; save();
});

async function copyPrompt(kind) {
  const text = buildPrompt(kind);
  copyFallback = '';
  try {
    await navigator.clipboard.writeText(text);
    toast('已複製！到 AI 聊天貼上並送出');
  } catch (err) {
    copyFallback = text;
  }
  renderCoach();
}

function readPaste() {
  pasteText = $('#paste-in').value;
  pastePlan = null; pasteErr = '';
  if (!pasteText.trim()) pasteErr = '還沒貼上內容。';
  else {
    const o = parsePlanText(pasteText);
    const p = o && toPlan(o);
    if (!p || !p.days.length) pasteErr = '找不到課表。請在 AI 對話裡回覆：「請只輸出 json 程式碼區塊」，再把新回覆貼過來。';
    else pastePlan = o;
  }
  renderCoach();
  ($('#paste-preview') || $('#paste-read'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function mdHtml(s) { // 簡易 markdown：粗體、標題、清單、段落
  return esc(s).split(/\n{2,}/).map(par => {
    const html = par
      .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^\s*[-*•]\s+/gm, '• ')
      .replace(/\n/g, '<br>');
    return `<p>${html}</p>`;
  }).join('');
}

function userText(m) {
  if (typeof m.content === 'string') return m.content;
  if (m.content.some(b => b.type === 'tool_result')) return null;
  const t = m.content.filter(b => b.type === 'text' && !b.text.startsWith('<app_data>'));
  return t.length ? t[t.length - 1].text : null;
}

function chatHtml() {
  let h = '';
  for (const m of S.chat) {
    if (m.role === 'user') {
      const t = userText(m);
      if (t) h += `<div class="msg me">${esc(t)}</div>`;
    } else if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) h += `<div class="msg ai">${mdHtml(b.text)}</div>`;
        if (b.type === 'tool_use' && b.name === PLAN_TOOL.name) h += planCardHtml(b);
      }
      if (m._note) h += `<div class="msg sys">${esc(m._note)}</div>`;
    }
  }
  return h;
}

function planCardHtml(b) {
  const inp = b.input || {};
  if (!Array.isArray(inp.days) || !inp.days.length) return '';
  const p = toPlan(inp);
  const applied = S.plan && S.plan.sourceId === b.id;
  const n = inp.nutrition;
  return `<div class="card plan-card">
    <div class="small muted">課表草案</div>
    <div style="font-weight:700;font-size:17px">${esc(p.name)}</div>
    ${p.summary ? `<div class="small" style="margin-top:4px">${esc(p.summary)}</div>` : ''}
    ${planHtml(p)}
    ${n ? `<div class="ex-reason" style="margin-top:12px">每日 ${n.calories} kcal · 蛋白質 ${n.protein_g} g · 碳水 ${n.carbs_g} g · 脂肪 ${n.fat_g} g</div>` : ''}
    ${applied ? '<button class="block" disabled style="margin-top:10px">✓ 已套用</button>'
      : `<button class="primary block" data-apply="${esc(b.id)}" style="margin-top:10px">套用這份課表</button>`}
  </div>`;
}

function toPlan(inp) {
  return {
    name: inp.plan_name || 'AI 課表',
    summary: inp.summary || '',
    days: inp.days.map((d, i) => ({
      name: d.name || 'Day ' + (i + 1), focus: d.focus || '',
      exercises: (d.exercises || []).filter(e => e && e.name).map(e => ({
        name: String(e.name).trim(),
        sets: Math.max(1, Math.min(10, Math.round(e.sets) || 3)),
        repMin: Math.max(1, Math.round(e.rep_min) || repsFrom(e)[0]),
        repMax: Math.max(Math.round(e.rep_min) || repsFrom(e)[0], Math.round(e.rep_max) || repsFrom(e)[1]),
        rest: Math.max(15, Math.round(e.rest_sec) || 90),
        startWeight: e.start_weight_kg > 0 ? e.start_weight_kg : 0,
        inc: e.increment_kg > 0 ? e.increment_kg : (e.increment_kg === 0 && !(e.start_weight_kg > 0) && !EX_INFO[String(e.name).trim()]) ? 0 : incFor(e.name), // 0 = 徒手動作
        note: e.note || '',
      })),
    })).filter(d => d.exercises.length),
    nutrition: inp.nutrition || null,
    client: inp.client_profile || null,
  };
}

function repsFrom(e) { // 容錯：AI 把次數寫成 "8-12"
  const m = String(e.reps ?? '').match(/(d+)D+(d+)/);
  return m ? [+m[1], +m[2]] : [8, 12];
}

function findToolUse(id) {
  for (const m of S.chat) if (m.role === 'assistant')
    for (const b of m.content) if (b.type === 'tool_use' && b.id === id) return b;
  return null;
}

$('#v-coach').addEventListener('click', e => {
  const md = e.target.closest('[data-mode]');
  if (md) { coachMode = md.dataset.mode; renderCoach(); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { copyPrompt(cp.dataset.copy); return; }
  if (e.target.id === 'paste-read') { readPaste(); return; }
  if (e.target.id === 'paste-apply' && pastePlan) {
    if (S.plan && !confirm(`用這份取代目前課表「${S.plan.name}」？`)) return;
    applyPlan({ ...toPlan(pastePlan), source: 'paste' });
    pastePlan = null; pasteText = ''; pasteErr = '';
    toast('已套用！到「訓練」分頁開始');
    renderCoach();
    return;
  }
  if (e.target.id === 'key-save') {
    const k = $('#key-in').value.trim();
    if (!/^sk-ant-/.test(k)) { toast('看起來不是 Anthropic API key（應以 sk-ant- 開頭）'); return; }
    setApiKey(k); toast('已儲存'); renderCoach();
    return;
  }
  if (e.target.id === 'coach-send') { const t = $('#coach-in').value.trim(); if (t) coachSend(t); return; }
  const q = e.target.closest('[data-q]');
  if (q) { coachSend(q.dataset.q); return; }
  if (e.target.closest('[data-act="new-chat"]')) {
    if (!confirm('開新對話？目前的對話會清除（課表與紀錄不受影響）。')) return;
    S.chat = []; S.chatCtx = ''; save(); renderCoach();
    return;
  }
  const a = e.target.closest('[data-apply]');
  if (a) {
    const b = findToolUse(a.dataset.apply);
    if (!b) return;
    if (S.plan && S.plan.sourceId !== b.id && !confirm(`用這份取代目前課表「${S.plan.name}」？`)) return;
    applyPlan({ ...toPlan(b.input), source: 'ai', sourceId: b.id });
    toast('已套用！到「訓練」分頁開始');
    renderCoach();
  }
});

function scrollChatEnd() {
  const live = $('#live');
  (live || $('.composer'))?.scrollIntoView({ block: 'end' });
}

function costOf(u) {
  if (!u) return 0;
  return ((u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out
    + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (u.cache_read_input_tokens || 0) * PRICE.cacheRead) / 1e6;
}

async function coachSend(text) {
  if (coachBusy) return;
  if (!navigator.onLine) { toast('沒有網路，AI 教練需要連線'); return; }
  const snapshot = S.chat.length; // 失敗時回到這裡，不留下半套對話
  const ctx = appContext();
  const content = [];
  if (ctx !== S.chatCtx) content.push({ type: 'text', text: ctx });
  content.push({ type: 'text', text });
  S.chat.push({ role: 'user', content });
  coachBusy = true; liveText = ''; coachErr = '';
  renderCoach(); scrollChatEnd();

  try {
    const client = await getClient();
    for (let turn = 0; turn < 4; turn++) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: SYSTEM,
        tools: [PLAN_TOOL],
        messages: S.chat.map(({ role, content }) => ({ role, content })),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          liveText += ev.delta.text;
          const live = $('#live');
          if (live) live.innerHTML = mdHtml(liveText);
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          const live = $('#live');
          if (live) live.innerHTML = (liveText ? mdHtml(liveText) : '') + '<p class="typing">正在排課表…</p>';
        }
      }
      const msg = await stream.finalMessage();
      S.aiUsage.calls++; S.aiUsage.usd += costOf(msg.usage);
      const am = { role: 'assistant', content: msg.content };
      if (msg.stop_reason === 'refusal') am._note = '這個問題教練無法回答，換個方式問問看。';
      if (msg.stop_reason === 'max_tokens') am._note = '回答太長被截斷了，可以請教練簡短一點。';
      S.chat.push(am);
      liveText = '';
      if (msg.stop_reason !== 'tool_use') break;

      const results = msg.content.filter(b => b.type === 'tool_use').map(b => {
        const ok = b.name === PLAN_TOOL.name && Array.isArray(b.input?.days) && b.input.days.length;
        return {
          type: 'tool_result', tool_use_id: b.id,
          content: ok ? '課表已顯示給使用者，等使用者按「套用」才會生效。請用一兩句話請使用者確認，或詢問是否要調整。'
            : '課表格式不完整，沒有顯示給使用者。',
          ...(ok ? {} : { is_error: true }),
        };
      });
      S.chat.push({ role: 'user', content: results });
      renderCoach(); scrollChatEnd();
    }
    S.chatCtx = ctx;
  } catch (err) {
    S.chat.length = snapshot;
    coachErr = coachErrorText(err);
    console.error(err);
    coachBusy = false; liveText = '';
    save(); renderCoach();
    const ta = $('#coach-in'); if (ta) ta.value = text;
    scrollChatEnd();
    return;
  }
  coachBusy = false; liveText = '';
  save(); renderCoach(); scrollChatEnd();
}

function coachErrorText(err) {
  const A = AnthropicSDK;
  let msg;
  if (A && err instanceof A.AuthenticationError) msg = 'API key 無效或已被停用，請到「個人」移除後重新設定。';
  else if (A && err instanceof A.PermissionDeniedError) msg = '這把 API key 沒有權限使用這個模型。';
  else if (A && err instanceof A.RateLimitError) msg = '請求太頻繁或額度不足，稍等一下再試，或到 console.anthropic.com 檢查餘額。';
  else if (A && err instanceof A.APIConnectionError) msg = '連不上 Anthropic，請檢查網路。';
  else if (A && err instanceof A.APIError) msg = `AI 服務錯誤（${err.status ?? ''}）：${err.message}`;
  else msg = '無法載入 AI 教練：' + (err?.message || err);
  return msg + '（訊息已放回輸入框，可以再送一次）';
}
