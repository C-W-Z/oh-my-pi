# Context Viewer PR 整理計畫

## 目標

把 PR #16160 收斂成容易獨立審查的 `/context` viewer：新 UI 必需的 map、category presentation、summary 與 native meter helper 直接保留在 viewer PR。非必要部分已拆出到其他brach。接下來，Viewer 對訊息來源的對應需求採新增獨立轉換函式的方案，維持既有 agent `convertToLlm` 呼叫路徑及快取行為，不為 viewer 增加它不需要的共用轉換 API 改動。

## 執行順序

### 1. 將 `convertToLlm` visitor 改成獨立轉換函式（方案 A）

- [x] 移除在 `packages/coding-agent/src/session/messages.ts` 對既有 `convertToLlm(messages, visit?)` 增加 visitor 參數的設計；不讓 viewer 的觀察需求改動 production conversion API 或其 memoization 快取路徑。
- [x] 新增獨立、具明確用途的 viewer-side 轉換函式，透過既有單訊息轉換邏輯產生 LLM-facing message，並回傳每個輸出的來源 message index / converted index 關聯，涵蓋轉換後省略訊息與一對多輸出。
- [x] 保持轉換語義一致：使用 `convertToLlm` 現有的角色、訊息分割、thinking continuity、工具名稱正規化及拒絕訊息處理規則；避免複製一份會逐漸偏離的完整轉換實作。若既有單訊息 helper 無法表達連續訊息上下文，先擴充或抽出共用的純轉換核心，再由現有 API 與 viewer 函式分別呼叫。
- [x] 讓 `packages/coding-agent/src/session/context-view.ts` 只依賴 viewer 專用的結果與來源索引，用它建立分類、原訊息時間、工具輸出關聯與來源資訊；不要在共用 message 上附加 provenance，也不要改動 session 訊息或 provider request。
- [x] 加入有行為意義的測試，驗證一般一對一轉換、被省略的輸入、一對多輸出，以及相鄰訊息影響轉換結果時 source index 對應正確；確認一般 `convertToLlm` 呼叫與快取輸出沒有因 viewer 觀察而改變。

### 2. 保留必要的 system prompt 來源資訊

- [x] 保留 viewer 將 instruction files / skills 從有效 System Prompt 中辨識並分類所需的來源資訊；此功能是 viewer 的資料需求，不屬於可任意刪除的獨立展示裝飾。
- [x] 確保來源 metadata 只在生成 prompt 時建立，與有效 prompt blocks 配對驗證；來源片段無法唯一配對或 prompt 已改變時，內容留在 System Prompt 分類並顯示不完整提示，不錯誤歸因或漏算 tokens。
- [x] 檢視 metadata 的 session lifecycle：prompt 更新、session 切換及 rollback 都須同步更新/還原來源資訊，避免舊來源對應到新 prompt。
- [x] 對來源片段重複、缺失、重疊、prompt block 重排或變更等情況驗證保守 fallback；來源標記本身不額外計入 token estimate。

### 3. 收斂並驗證 Context Viewer PR

- [ ] conversion 設計完成後，更新 PR 描述和變更摘要，說明 viewer 的必要依賴；不要留下過時範圍描述。
- [x] 檢查 `/context` 所有入口、無訊息 session、instruction files / skills、工具 schema、轉換後訊息、thinking、tool output、時間戳與 token estimates 的顯示和分類。
- [x] 執行受影響 package 的 focused tests 與型別檢查；再實際啟動 CLI/TUI，開啟 `/context`，確認分類、展開/收合、導航及關閉操作正常。

## 完成條件

- Viewer 必要 helper 直接包含在 Context Viewer PR。
- Viewer 使用獨立的轉換入口取得訊息來源對應；既有 `convertToLlm` 的對外行為、呼叫點和快取不因 provenance visitor 改變。
- Prompt source metadata 在有效 prompt 不一致時採保守 fallback，不會造成錯誤分類或 token 遺漏。
- focused checks 通過，且實際 CLI/TUI smoke run 證明 `/context` 工作正常。
