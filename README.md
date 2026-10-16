# 健身紀錄

手機優先的健身紀錄 PWA，單一 `index.html`，不需要後端。

- **訓練**：逐組記錄重量 × 次數，自動帶入上次數字，打勾開始休息計時（震動 + 提示音）
- **身體**：體重、體脂、腰／胸／臂／臀／大腿圍，趨勢圖
- **計算**：1RM（Epley / Brzycki / Lombardi）與 % 1RM 表、BMI（國健署標準）、BMR（Mifflin-St Jeor，有體脂時用 Katch-McArdle）、TDEE 與熱量／蛋白質目標
- **個人**：個人資料、休息時間、JSON 匯出／匯入

資料存在瀏覽器 localStorage，只在該裝置上。換手機前先匯出備份。

## 本機測試

```bash
node serve.js
```

開 http://localhost:5173 。同一個 Wi-Fi 的手機可用 `http://<電腦IP>:5173` 開啟（離線功能與「加到主畫面」需要 https）。
