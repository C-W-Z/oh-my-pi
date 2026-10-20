# Context Viewer PR 整理計畫

## 目標

把 PR #16160 收斂成容易獨立審查的 `/context` viewer；先將與 viewer 非必要、可獨立交付的改動移到另一個 branch/PR，再以新增獨立轉換函式的方案處理 viewer 對訊息來源的對應需求。維持既有 agent `convertToLlm` 呼叫路徑及快取行為，不為 viewer 增加它不需要的共用轉換 API 改動。

## 執行順序

### 1. 盤點並拆出非必要改動

- [ ] 以 PR #16160 現有 diff 為基準，逐檔標記為「viewer 必要」、「viewer 支援但可獨立」或「無關功能」。不要只按檔案數量判斷；確認每段改動和 viewer 的實際依賴。
- [ ] 將 Legacy Context Usage 的渲染演算法重構獨立拆出：包含把原本 `/context` 用途的 legacy context usage renderer 改為共用 presentation / map / meter helper 的工作，以及相應的測試；確認它可先單獨合併，不是新 viewer 正常運作的前置條件。
- [ ] 將 Window/Fit 縮放功能及 `tui.context.toggleFit` keybinding 一併從 viewer PR 拆出，包含其設定、互動行為、文件與測試；作為獨立 TUI 改動交付，不讓新 viewer 的審查被舊 context usage 視圖的 fit 行為擴大。
- [ ] 優先評估可獨立交付的 TUI Context Meter / context-map 共用化改動：`packages/tui/src/status-line/context-usage.ts` 的重構、`packages/tui/src/chrome/context-map.ts`、`context-presentation.ts` 及相應測試。若 viewer 不依賴這些改動，移至另一個 branch/PR；若 viewer 確實依賴，只保留最小必要介面並記錄依賴理由。
- [ ] 將任何與 `/context` 顯示、資料取樣或必要來源標示無關的文件、keybinding、工具或行為變更一併移出；不要把 viewer 必需的 UI、命令、資料模型或測試移走。
- [ ] 為拆出的改動建立以目前 PR 為基礎的獨立 branch/PR，讓原 Context Viewer PR 不再包含這些改動；保留清楚的 commit 邊界，避免重複帶入或遺失依賴。
- [ ] 在拆分完成後重新檢查兩邊的 diff：獨立 PR 可單獨理解與驗證；Context Viewer PR 不依賴尚未合併的新 API，或明確採用已存在的介面。

### 2. 將 `convertToLlm` visitor 改成獨立轉換函式（方案 A）

- [ ] 移除在 `packages/coding-agent/src/session/messages.ts` 對既有 `convertToLlm(messages, visit?)` 增加 visitor 參數的設計；不讓 viewer 的觀察需求改動 production conversion API 或其 memoization 快取路徑。
- [ ] 新增獨立、具明確用途的 viewer-side 轉換函式，透過既有單訊息轉換邏輯產生 LLM-facing message，並回傳每個輸出的來源 message index / converted index 關聯，涵蓋轉換後省略訊息與一對多輸出。
- [ ] 保持轉換語義一致：使用 `convertToLlm` 現有的角色、訊息分割、thinking continuity、工具名稱正規化及拒絕訊息處理規則；避免複製一份會逐漸偏離的完整轉換實作。若既有單訊息 helper 無法表達連續訊息上下文，先擴充或抽出共用的純轉換核心，再由現有 API 與 viewer 函式分別呼叫。
- [ ] 讓 `packages/coding-agent/src/session/context-view.ts` 只依賴 viewer 專用的結果與來源索引，用它建立分類、原訊息時間、工具輸出關聯與來源資訊；不要在共用 message 上附加 provenance，也不要改動 session 訊息或 provider request。
- [ ] 加入有行為意義的測試，驗證一般一對一轉換、被省略的輸入、一對多輸出，以及相鄰訊息影響轉換結果時 source index 對應正確；確認一般 `convertToLlm` 呼叫與快取輸出沒有因 viewer 觀察而改變。

### 3. 保留必要的 system prompt 來源資訊

- [ ] 保留 viewer 將 instruction files / skills 從有效 System Prompt 中辨識並分類所需的來源資訊；此功能是 viewer 的資料需求，不屬於可任意刪除的獨立展示裝飾。
- [ ] 確保來源 metadata 只在生成 prompt 時建立，與有效 prompt blocks 配對驗證；來源片段無法唯一配對或 prompt 已改變時，內容留在 System Prompt 分類並顯示不完整提示，不錯誤歸因或漏算 tokens。
- [ ] 檢視 metadata 的 session lifecycle：prompt 更新、session 切換及 rollback 都須同步更新/還原來源資訊，避免舊來源對應到新 prompt。
- [ ] 對來源片段重複、缺失、重疊、prompt block 重排或變更等情況驗證保守 fallback；來源標記本身不額外計入 token estimate。

### 4. 收斂並驗證 Context Viewer PR

- [ ] 完成拆分與 conversion 設計後，更新 PR 描述和變更摘要，明確說明 viewer 的必要依賴及已移出的獨立工作；不要留下過時範圍描述。
- [ ] 檢查 `/context` 所有入口、無訊息 session、instruction files / skills、工具 schema、轉換後訊息、thinking、tool output、時間戳與 token estimates 的顯示和分類。
- [ ] 執行受影響 package 的 focused tests 與型別檢查；再實際啟動 CLI/TUI，開啟 `/context`，確認分類、展開/收合、導航及關閉操作正常。
- [ ] 確認獨立拆出的 PR 與 Context Viewer PR 都有各自對應的測試、必要文件/Changelog 更新，且不存在重複實作或未解決的 branch 依賴。

## 完成條件

- 非必要改動已從 Context Viewer PR 移出，且以獨立 diff 可審查、測試。
- Viewer 使用獨立的轉換入口取得訊息來源對應；既有 `convertToLlm` 的對外行為、呼叫點和快取不因 provenance visitor 改變。
- Prompt source metadata 在有效 prompt 不一致時採保守 fallback，不會造成錯誤分類或 token 遺漏。
- focused checks 通過，且實際 CLI/TUI smoke run 證明 `/context` 工作正常。
