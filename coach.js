'use strict';
/* AI 教練（免費）：產生含 App 資料的指令，使用者貼到任何 AI 聊天（ChatGPT／Gemini／Claude），
   再把回覆貼回來，App 從中讀出 JSON 課表並套用。漸進加重規則在 app.js 本機運算。 */

const EX_LIST = Object.entries(EX_TREE).map(([part, subs]) =>
  `${part}：${Object.entries(subs).map(([sub, l]) => `${sub}（${l.join('、')}）`).join('；')}`).join('\n');

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

function renderCoach() {
  $('#subtitle').textContent = '教練＋營養師';
  $('#v-coach').innerHTML = freeHtml();
  bindFree();
}

$('#v-coach').addEventListener('click', e => {
  const cp = e.target.closest('[data-copy]');
  if (cp) { copyPrompt(cp.dataset.copy); return; }
  if (e.target.id === 'paste-read') { readPaste(); return; }
  if (e.target.id === 'paste-apply' && pastePlan) {
    if (S.plan && !confirm(`用這份取代目前課表「${S.plan.name}」？`)) return;
    applyPlan({ ...toPlan(pastePlan), source: 'paste' });
    pastePlan = null; pasteText = ''; pasteErr = '';
    toast('已套用！到「訓練」分頁開始');
    renderCoach();
  }
});
