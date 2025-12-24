> 本文件描述的是「已驗證可穩定運作的設計決策」。
> 除非能明確說出「現在的問題是什麼」，否則請勿因個人偏好進行重構。
# 🗳️ Real-Time Voting System

一個輕量級、無資料庫、基於 Socket.IO 的即時投票系統。專為臨時會議、講座互動、社區表決設計。

## 🚀 技術架構
- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: Vanilla JS (No Framework), HTML5, CSS3
- **Storage**: In-Memory Map (不使用資料庫)
- **Deployment**: Render / Railway

---

## 🔒 決策紀錄 (Architecture Decision Record - ADR)
*開發者或維護人員請務必閱讀此節，以免破壞系統核心穩定性。*

### 1. 為什麼不使用資料庫 (Why No DB?)
**決策**：使用 In-Memory `Map` 儲存會議資料。
**理由**：本系統定位為「短生命週期」的即時互動。引入 Redis 或 MongoDB 會增加部署複雜度與維護成本。目前的架構可支援 Render 免費方案，且足以應付單場 500+ 人同時在線。

### 2. 雙軌制身分識別 (Dual-Track Device ID)
**決策**：
- 真實使用者：ID 存於 `localStorage` (持久化)。
- 主持人預覽：ID 存於 `sessionStorage` (隨機生成，不與本機衝突)。
**理由**：為解決「主持人使用同一台電腦預覽」導致的身分衝突與鬼影人數問題。這也確保了真實用戶在重新整理頁面時，考勤時間不會重置。

### 3. 事件命名與狀態管理 (Event Naming & State)
**決策**：維持目前的混合命名風格 (e.g., `create-meeting`, `admin-login`)，暫不進行全面標準化重構。
**理由**：系統目前處於穩定狀態，全面重構 Socket 事件名稱風險大於效益。建議在系統規模擴大至 1000 行以上程式碼時再行考慮。

### 4. 主持人防呆與權限 (Host Safety)
**決策**：
- 主持人建立會議時，Server 會自動將其註冊為合法投票者。
- 後端 `start-vote` 與 `stop-vote` 增加狀態檢查，防止因網路延遲或手誤造成的重複觸發。

---

## 🛠️ 未來維護建議
1. **不要隨意升級架構**：除非有跨伺服器擴展需求，否則請勿引入 Redis Adapter。
2. **保持前端輕量**：不要為了 UI 美觀而引入 React/Vue，這會破壞「單檔即用」的便攜性。
3. **Debug 模式**：Server 端設有 `DEBUG` 變數 (預設 false)，設為 `true` 可在 Console 查看詳細 Log。

---
&copy; 2024 Project Handoff Document.
