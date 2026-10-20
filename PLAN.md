# Context Viewer PR 整理計畫

## 目標

把 PR #16160 收斂成容易獨立審查的 `/context` viewer；先將與 viewer 非必要、可獨立交付的改動移到另一個 branch/PR，再以新增獨立轉換函式的方案處理 viewer 對訊息來源的對應需求。維持既有 agent `convertToLlm` 呼叫路徑及快取行為，不為 viewer 增加它不需要的共用轉換 API 改動。

## 執行順序

### 1. 盤點並拆出非必要改動

- [x] 以 PR #16160 現有 diff 為基準，逐檔標記為「viewer 必要」、「viewer 支援但可獨立」或「無關功能」。不要只按檔案數量判斷；確認每段改動和 viewer 的實際依賴。
- [x] 將 Legacy Context Usage 的渲染演算法重構獨立拆出：包含把原本 `/context` 用途的 legacy context usage renderer 改為共用 presentation / map / meter helper 的工作，以及相應的測試；確認它可先單獨合併，不是新 viewer 正常運作的前置條件。
- [x] 將 Window/Fit 縮放功能及 `tui.context.toggleFit` keybinding 一併從 viewer PR 拆出，包含其設定、互動行為、文件與測試；以依賴 viewer 的 stacked branch 交付，不為舊 context usage 視圖新增互動功能。
- [x] 優先評估可獨立交付的 TUI Context Meter / context-map 共用化改動：`packages/tui/src/status-line/context-usage.ts` 的重構、`packages/tui/src/chrome/context-map.ts`、`context-presentation.ts` 及相應測試。若 viewer 不依賴這些改動，移至另一個 branch/PR；若 viewer 確實依賴，只保留最小必要介面並記錄依賴理由。
- [x] 將任何與 `/context` 顯示、資料取樣或必要來源標示無關的文件、keybinding、工具或行為變更一併移出；不要把 viewer 必需的 UI、命令、資料模型或測試移走。
- [x] 為拆出的改動建立獨立本地 branch，讓原 Context Viewer branch 不再包含這些改動；保留清楚的 commit 邊界，避免重複帶入或遺失依賴。本步不包含 push 或建立遠端 PR。
- [x] 在拆分完成後重新檢查兩邊的 diff：獨立改動可單獨理解與驗證；Context Viewer branch 自帶最小 helper，不依賴尚未合併的新 API。

#### 第 1 步的本地 branch 與依賴

| Branch | Review base | 範圍 |
| --- | --- | --- |
| `feat/context-viewer` | `upstream/main` | Viewer、資料取樣、來源標示與最小 TUI helper；Legacy renderer 維持原有演算法及 glyph 行為，overview 固定使用完整 context window。 |
| `refactor/context-usage` | `upstream/main` | Legacy renderer 的 occupancy 演算法、共用 presentation、live theme invalidation、meter helper 及獨立測試；不含 viewer 或 Window/Fit。 |
| `feat/context-viewer-fit` | `feat/context-viewer` | Window/Fit、`tui.context.toggleFit`、native action、設定文件及測試；這是依賴 viewer 的 stacked branch，不是舊 usage view 的獨立互動功能。 |
| `backup/context-viewer-before-split` | — | 拆分前的完整內容，供本地回復與內容核對；不作為新 PR 的 base。 |

Viewer 必須保留 `planContextMap`、viewer category presentation 與 theme symbols，因為 ANSI/native fallback map 及 category markers 直接使用它們。`context-usage.ts` 僅保留 `contextSnapcompactLines`、`contextUsageSummary`、`describeContextMeter` 的純展示 extraction，以及支援 viewer category colors 的型別；這避免重複實作既有 compaction/Snapcompact 格式及 native meter。Legacy grid、glyph、category 與 invalidation 不使用新的 map/presentation。兩個 main-based branch 均攜帶自身需要的 helper，不存在先合併另一條 branch 才能執行的隱含前置條件。

#### 逐檔／逐段分類

| 檔案（相對 repo root） | 分類與歸屬 |
| --- | --- |
| `PLAN.md` | Viewer 整理範圍與 branch 依賴。 |
| `docs/cli-reference.md` | Viewer 必要使用說明；Window/Fit 段落只屬於 Fit branch。 |
| `docs/keybindings.md` | Viewer 非必要；`tui.context.*` 與 toggleFit 文件只屬於 Fit branch。 |
| `packages/coding-agent/CHANGELOG.md` | Viewer 必要 release notes。 |
| `packages/coding-agent/src/modes/controllers/command-controller.ts` | Viewer 必要 `/context` 入口及 fullscreen overlay。 |
| `packages/coding-agent/src/prompts/system/context-file.md` | Viewer 必要 instruction source fragment。 |
| `packages/coding-agent/src/prompts/system/context-skill.md` | Viewer 必要 skill source fragment。 |
| `packages/coding-agent/src/prompts/system/custom-context-skill.md` | Viewer 必要 custom prompt skill source fragment。 |
| `packages/coding-agent/src/prompts/system/custom-system-prompt.md` | Viewer 必要 custom prompt source 配對。 |
| `packages/coding-agent/src/prompts/system/project-prompt.md` | Viewer 必要 instruction fragment 共用。 |
| `packages/coding-agent/src/prompts/system/system-prompt.md` | Viewer 必要 skill fragment 共用。 |
| `packages/coding-agent/src/sdk.ts` | Viewer 必要初始 prompt sources。 |
| `packages/coding-agent/src/session/agent-session-types.ts` | Viewer 必要 prompt source/result 型別。 |
| `packages/coding-agent/src/session/agent-session.ts` | Viewer 必要 sources lifecycle 及 rollback。 |
| `packages/coding-agent/src/session/context-view.ts` | Viewer 必要 snapshot、分類、token estimates 與 provenance。 |
| `packages/coding-agent/src/session/messages.ts` | Viewer 必要 conversion provenance；API 設計屬第 2 步，本步不變更。 |
| `packages/coding-agent/src/session/session-tools.ts` | Viewer 必要 prompt/sources 同步更新。 |
| `packages/coding-agent/src/slash-commands/builtin-session.ts` | Viewer 必要命令說明。 |
| `packages/coding-agent/src/system-prompt.ts` | Viewer 必要 prompt source metadata。 |
| `packages/coding-agent/test/agent-session-context-file-reload.test.ts` | Viewer 必要 prompt reload attribution 測試。 |
| `packages/coding-agent/test/agent-session-switch-prev-context.test.ts` | Viewer 必要 session switch rollback 測試。 |
| `packages/coding-agent/test/issue-4806-command-output.test.ts` | Viewer 必要 pending-turn/draft 測試；既有 report 測試使用 `/tools`。 |
| `packages/coding-agent/test/modes/context-view.test.ts` | Viewer 必要資料與來源對應測試。 |
| `packages/coding-agent/test/prefix-binding-tool-roster.test.ts` | Viewer 必要 roster 更新 attribution 測試。 |
| `packages/tui/CHANGELOG.md` | 各 branch 僅描述自身 user-facing 功能。 |
| `packages/tui/src/chrome/context-map.ts` | Viewer 必要 occupancy planner；Legacy branch 的 grid 亦使用同一 planner，Fit branch 不改動此檔案。 |
| `packages/tui/src/chrome/context-presentation.ts` | Viewer 必要 category styles；兩個 main-based branch 使用相同 table，Legacy ID 對應只存在 Legacy renderer。 |
| `packages/tui/src/keybindings.ts` | Viewer 非必要；toggleFit 定義只屬於 Fit branch。 |
| `packages/tui/src/overlays/context-viewer.ts` | Viewer 必要 UI；縮放狀態、鍵盤與 native action 只屬於 Fit branch。 |
| `packages/tui/src/status-line/context-usage.ts` | 最小純展示 helper extraction 為 viewer 必要；Legacy 演算法與 live-theme 重構可獨立，只屬於 Legacy branch。 |
| `packages/tui/src/theme/symbols.ts` | Viewer 必要 map/marker glyph；Legacy branch 亦需要 theme-aware glyph。 |
| `packages/tui/test/context-map.test.ts` | Viewer 與 Legacy 共用的 occupancy 邊界測試；Fit scale 測試在 Fit 專屬測試檔。 |
| `packages/tui/test/context-viewer.test.ts` | Viewer 必要 navigation/rendering 測試；Fit 測試只屬於 Fit branch；static usage live-theme 測試屬於 Legacy branch。 |
| `packages/tui/src/chrome/context-fit.ts`、`packages/tui/test/context-fit.test.ts` | Fit branch 專屬 scale helper 及邊界測試，不改動共用 map 檔案。 |
| `packages/tui/test/context-usage-presentation.test.ts` | Legacy branch 專屬的 static usage live-theme 測試。 |

#### 第 1 步的驗證範圍

| Branch | Focused tests | Typecheck / 靜態檢查 | 實際 smoke |
| --- | --- | --- | --- |
| Viewer | 8 個相關檔案，109 pass | TUI 與 coding-agent `check:types` 通過；修改的 TUI 檔案通過 oxlint/oxfmt | CLI `/context` overview、category preview、full content、End 捲動、返回及關閉；沒有 Window/Fit。 |
| Legacy | context-map、context-usage、context-usage-presentation，23 pass | TUI `check:types` 與修改檔案 oxlint/oxfmt 通過 | 獨立 TUI harness 顯示 usage grid/legend；live theme override 同時更新 grid 與 legend glyph。 |
| Fit | context-viewer、context-map、context-fit，40 pass | TUI `check:types` 與修改檔案 oxlint/oxfmt 通過 | 獨立 TUI harness 切換 Window/Fit，map 縮放而 used/buffer/free 數值與百分比不變。 |

`git merge-tree --write-tree` 對 Viewer + Legacy，以及 Fit + Legacy 均無衝突。Worktree 檢查使用各 branch 自身的 workspace packages，第三方依賴及 native build artifact 則使用既有本地安裝；不需要重新下載或修改使用者設定。Native meter 行為由既有 renderer contract tests 驗證，未以真實 Tern terminal 作視覺驗證。第 2–4 步仍不在本步範圍。

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
