# 健身紀錄

手機優先的健身紀錄 PWA，不需要後端。線上版：https://psgo555.github.io/FitnessTracker/

- **訓練**：課表自動帶入動作、組數、次數、重量、休息時間；打勾開始休息計時（震動＋提示音）。新增動作依「部位 → 細項 → 動作」分類，可搜尋
- **自動漸進**（本機規則，離線可用）：區間內先加次數，每組達上限就加重；輕鬆加兩級、吃力先維持、動作跑掉退一級、疼痛減重約 10% 並提示代償原因、連續兩次未達下限減約 10%
- **AI 教練**：Claude（`claude-opus-5-5`），用使用者自己的 Anthropic API key。自動讀取 App 內的身體數據與訓練紀錄，問目標後排課表（含營養目標），使用者確認後套用
- **身體**：體重、體脂、腰／胸／臂／臀／大腿圍，趨勢圖
- **計算**：1RM（Epley / Brzycki / Lombardi）與 % 1RM 表、BMI（國健署標準）、BMR（Mifflin-St Jeor，有體脂時用 Katch-McArdle）、TDEE 與熱量／蛋白質目標
- **個人**：個人資料、API key、JSON 匯出／匯入

## 檔案

| 檔案 | 內容 |
|---|---|
| `index.html` | 版面與樣式 |
| `app.js` | 資料、動作庫、漸進規則、各分頁 |
| `coach.js` | AI 教練（提示詞、課表工具、對話） |
| `sw.js` | 離線快取 |

資料存在瀏覽器 localStorage，只在該裝置上。API key 另外存放，不會進備份檔。

## 本機測試

```bash
node serve.js
```

開 http://localhost:5173 。
