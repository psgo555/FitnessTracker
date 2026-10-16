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

function renderCoach() {
  const el = $('#v-coach');
  $('#subtitle').textContent = '教練＋營養師';
  if (!getApiKey()) { el.innerHTML = keySetupHtml(); return; }

  let h = '';
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
    <b>設定 AI 教練</b>
    <div class="small" style="margin:8px 0">AI 教練使用 Anthropic 的 Claude，需要你自己的 API key（按用量付費，排一份課表約 US$0.05–0.15）。</div>
    <ol class="small muted" style="padding-left:20px;margin:0 0 12px">
      <li>到 console.anthropic.com 註冊並儲值</li>
      <li>在 Settings → API Keys 建立一把 key</li>
      <li>複製後貼在下面</li>
    </ol>
    <input id="key-in" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
    <button class="primary block" id="key-save" style="margin-top:10px">儲存</button>
    <div class="small muted" style="margin-top:10px">key 只存在這支手機的瀏覽器，不會上傳到其他地方，也不會放進備份檔。沒有 key 也能用「訓練」分頁的範本課表，加減重規則一樣會運作。</div>
  </div>`;
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
    days: inp.days.map(d => ({
      name: d.name, focus: d.focus || '',
      exercises: (d.exercises || []).map(e => ({
        name: String(e.name).trim(),
        sets: Math.max(1, Math.min(10, Math.round(e.sets) || 3)),
        repMin: Math.max(1, Math.round(e.rep_min) || 8),
        repMax: Math.max(Math.round(e.rep_min) || 8, Math.round(e.rep_max) || 12),
        rest: Math.max(15, Math.round(e.rest_sec) || 90),
        startWeight: e.start_weight_kg > 0 ? e.start_weight_kg : 0,
        inc: e.increment_kg > 0 ? e.increment_kg : incFor(e.name),
        note: e.note || '',
      })),
    })).filter(d => d.exercises.length),
    nutrition: inp.nutrition || null,
    client: inp.client_profile || null,
  };
}

function findToolUse(id) {
  for (const m of S.chat) if (m.role === 'assistant')
    for (const b of m.content) if (b.type === 'tool_use' && b.id === id) return b;
  return null;
}

$('#v-coach').addEventListener('click', e => {
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
