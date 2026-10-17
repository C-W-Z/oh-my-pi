以下內容可直接貼到新 session：

---

# Context Viewer 工作交接

## 目前狀態

- Repo：`D:/omp/oh-my-pi`
- Branch：`feat/context-viewer`
- 最新本地 commit：`982e01e521`
- Commit message：`fix(context): preserve diagnostics and improve content previews`
- **已 commit，未 push，未建立或更新 PR。**
- Commit 後未重新查詢工作區狀態；新 session 開始時先確認，不要直接假定 clean。

這個分支已實作互動式全螢幕 `/context` Viewer。本次是在既有實作上核實 GPT 的 review 並修復問題，不是重新開發。

## 使用者目前關注的設計問題

目前總覽按 **`d`** 會在 Viewer 內打開原本的 `ContextUsageView`，Esc 返回新總覽。

這是為了保留舊 `/context` 的診斷功能而採取的實作：
- 原有 OMP usage 統計。
- Compaction threshold／Native meter marker。
- 設定啟用時的 Snapcompact estimated savings。

**使用者對這個額外頁面的必要性有疑問。** 上一個 session 已說明：

> 要保留的是舊診斷資訊，不一定要保留舊介面。兩張報表會迫使用者理解不同的計量口徑，交互不夠直觀。

建議的方向是：
1. 在新總覽直接補上 Compaction threshold、距離門檻的 token 數。
2. 啟用 Snapcompact 時，顯示預估 savings／wire tokens。
3. 保留 `OMP usage` 與 `Estimated content` 的區分。
4. 移除獨立診斷頁、`d` 快捷鍵與對應 Native action。

**這只是討論與建議，尚未獲得實作指示。** 使用者最後要求先 commit 當前結果；不要直接把建議當成已授權需求。

## 待實作的 Viewer 視覺需求與方案

**範圍：** 使用者要求記錄下列兩項需求並研究實作方式；本節是實作方案，不代表 UI 已修改。獨立診斷頁是否整合總覽仍屬另一項待確認決策，不與這兩項視覺修改綁定。

### 1. 操作提示列上方增加分隔框線

**需求：** Viewer 底部操作提示列要像 `/usage` 一樣有上邊框，與可捲動內容明確分開；總覽、分類預覽、全文與現存診斷頁都採用同一個 footer 結構。

**現有依據：**
- `packages/tui/src/overlays/usage-dashboard.ts` 的 `UsageDashboardComponent` 使用 `OverlayPanel`，在 body 與 footer 之間放入 `new PanelDivider()`。
- `packages/tui/src/chrome/overlay-box.ts` 的 `PanelDivider` 由 `OverlayPanel` 畫成接合左右外框的水平線，不必自行拼接字元。
- `packages/tui/src/overlays/context-viewer.ts` 目前只有 header、body、footer，尚未加入 divider。

**建議實作：**
1. 在 `ContextViewer` 匯入並插入既有 `PanelDivider`，放在 `#body` 與 `#footer` 之間；不要改共用元件的預設行為，以免影響其他 overlays。
2. 固定 chrome 在正常尺寸下共 7 行：上框 1、summary 3、divider 1、提示 1、下框 1；body 高度由 `terminalRows - 6` 調整為 `terminalRows - 7`。
3. 同步核對 `render()`、`describe()`、map geometry 與 category preview 的高度預算，避免 ANSI／Native 共用導航狀態卻用不同的 preview 行數。極矮視窗須明確分配 header/body 空間，不能只靠末尾 `.slice()` 把 footer 或下框截掉。
4. Native 的 `describe()` 是自行組裝節點，不會自動沿用 `#panel` 的 children；在 `actionBar()` 前加入 `node("rule")`，明確描述相同分區。

### 2. 分類預覽的選中條目改為整個區塊的彩色左邊框

**需求：** Enter 進入多條目的分類預覽後，以連續彩色左邊框標示目前選中的整個 entry，不再只在標題前放箭頭。這是每個 entry 的內側 gutter，不是將整個 Viewer 外框染色。

**參考依據：**
- `../pi-context-view/src/ui/usage-view.ts` 的 `previewStreamLine()`／`blockGutter()` 使用兩欄 gutter；選中區塊每行畫 `theme.fg("accent", "┃ ")`，未選中區塊保留等寬縮排。
- 參考實作以所屬 block 判斷每個可見行的選中狀態，因此標題捲出畫面後，正文仍有彩色左邊框。
- 本 repo 的 `#preparePreview()` 已產生 `EntryRange { start, end, complete }`，`#previewLines()` 已能取得 scroll offset；不必引入參考專案的整套 navigator。

**建議實作：**
1. 重用 `EntryRange` 的半開區間 `[start, end)`；用 `scrollOffset + visibleRowIndex` 判斷可見行是否屬於選中 entry，取代目前只比對 `range.start` 的箭頭分支。
2. 選中區塊的標題、metadata、正文、正文內空行與全文提示行均畫 accent 左框；未選中 entry 使用兩個空白，內容不因切換選中項而左右跳動。區塊之間的分隔空行在 range 外，不連接左框。
3. 固定預留 gutter 的兩欄，先以剩餘寬度準備與 render `#previewScroll`，最後才為可見行加上 gutter。保留 `ScrollView` 的右側 scrollbar 欄位，wrap／truncate 也需預留該欄，不能在已佔滿寬度的行前直接加框再截斷。
4. `#preparePreview()` 的初始化呼叫、cache 的 width、`revealRange()` 與後續 render 要使用一致的縮減後寬度，避免 Enter 初次開啟或 resize 時重算出不同的 ranges。
5. cache 保留未加選中樣式的 preview 行與 ranges；只對可見行加框。選擇改變不應重新 wrap 全分類，更不能恢復對大型 Tool Output 全文 wrap 的舊做法。
6. 保留既有 selection、先捲動 oversized entry 再切換條目、Enter／Esc 與返回位置規則；單條目分類直接進全文的行為不變。使用 theme `accent` 表示 focus，不額外引入 category 配色規則。

**Native 邊界：**
- 現在使用 `selectList("entries", …)` 的 `selected` 與 `item.detail`，視覺由 Tern 繪製；ANSI gutter 的修改不會自動反映到 Native。
- `packages/wire/src/tsp.ts` 的 common／list／item props 沒有專用的左邊框屬性，不能假造 `borderLeft` 欄位，也不能把 `tone: "accent"` 當成整塊左框已完成的證據。
- 實作時保留既有 select／activate 事件與 entry id，先在實際 Tern 視窗確認 multiline item 的選中外觀；若未提供整塊左框，須另行釐清 Tern renderer 所需變更，不能只靠節點測試宣稱兩端視覺一致。本方案尚未驗證 Tern 視覺。

### 驗收與目前方案驗證

後續 UI 實作的驗收：
- 四種 Viewer 狀態都有 footer 上分隔線；48×18 resize 後，提示列、下框與內容可操作且不超出寬高。
- 選中 entry 的 metadata、多行正文、內部空行與截斷提示均有連續左框；切換 entry 不左右跳動，分隔空行及鄰近 entry 不被誤標。
- 選中 entry 標題捲出 viewport 時，其餘可見正文仍有左框；第一筆、最後一筆、空分類、單條目直開全文及 Esc 返回位置維持原有語意。
- 窄視窗、寬字元、長行與右側 scrollbar 共存時不裁掉正文尾字；大型輸出仍只做有界預覽，全文尾部仍可到達。
- ANSI 用實際 CLI／PTY 驗收；Native 需實際 Tern 視覺驗收。更新既有 behavior coverage，針對 footer 邊界與區塊選中範圍補必要 regression coverage，不測 source text 或固定提示文案。
- 實作落地時更新 `packages/tui/CHANGELOG.md` 的英文 user-facing entry；不因單純記錄方案就聲稱功能已完成。

目前只做過無落盤的 Bun 組合 probe：使用既有 `OverlayPanel`、`PanelDivider`、`PanelRows`、`ScrollView`，以兩欄 gutter 與 7 行固定 chrome 產生 48×18 畫面，觀察到 6 行連續左框及 footer 分隔線；輸出為 `rows: 18`、`maxWidth: 48`、`gutterRows: 6`。這只證明元件組合與基本尺寸預算可行，沒有修改 `ContextViewer`，不代表真實導航、resize、scrollbar 或 Tern 已驗收；未新增測試或臨時檔案。

## 已完成的修復

### 1. 保留舊診斷資訊

`packages/coding-agent/src/session/context-view.ts`

- `buildSessionContextView()` 現在呼叫：
  ```ts
  computeSessionContextBreakdown(session, { snapcompactSavings: true })
  ```
- 將 `breakdown` 放進 snapshot。

`packages/tui/src/overlays/context-viewer.ts`

- `ContextViewData` 增加 `breakdown: ContextBreakdown`。
- 新增 `diagnostics` 狀態。
- 使用既有 `ContextUsageView` 與 `ScrollView` 呈現診斷頁。
- ANSI 用 `d` 開啟；Native 有 `Usage diagnostics` action。
- Esc 返回總覽。

如果後續改成整合總覽，注意：
- 不要再丟失 Snapcompact 或 Compaction 資訊。
- **不要刪掉共用的 `ContextUsageView`**；它仍有其他用途。
- Snapshot 是開啟時取樣，瀏覽期間不會重新讀取 session。

### 2. 正文保留完整路徑

原先 `#safe()` 會呼叫 `shortenEmbeddedPaths()`，導致正文中的 home 路徑被改寫成 `~`。

目前：
- `#safeContent()` 用於正文，只處理終端安全、tabs 與換行。
- 正文不再縮短路徑。
- Metadata／label 的路徑仍可縮短。
- ANSI 和 Native 均有 regression coverage。

不要為了遵循一般 TUI 路徑縮短慣例，又把正文路徑改寫回去。

### 3. 容量估算標示

Viewer 的細分類總量與既有 OMP usage 不保證相同，沒有強行縮放數字。

目前仍是：
```ts
buffer = min(existingBuffer, max(0, window - estimatedTokens))
free = max(0, window - estimatedTokens - buffer)
```

容量列已改成：
- `Estimated Auto-Compact Buffer`
- `Estimated Free Space`

原 OMP 統計仍在診斷頁。後續整合 UI 時，必須保留兩種口徑的清楚區分。

### 4. 大型 Tool Output 預覽效能

原本分類預覽會全文 wrap 每筆 entry，再只取前幾行。

目前：
- `#entryPreview()` 只處理有界前綴。
- 開啟全文才完整 wrap。
- ANSI 與 Native preview 都使用有界預覽。
- 全文未被永久截斷，尾部仍可到達。

單次本機 probe：約 6 MB 多行輸出，分類預覽從約 **558 ms** 降到約 **6 ms**。這不是通用 benchmark 保證。
另驗證了約 6 MB 的超長單行輸出，全文尾部可到達。

### 5. 提交範圍與文字

- 已移除過時的根目錄 `PLAN.md`。
- 已補：
  - `packages/coding-agent/CHANGELOG.md`
  - `packages/tui/CHANGELOG.md`
- 本 feature 新增的 comments/docstrings 已改成英文，包括來源追蹤與測試註解。
- 測試中的 `"寬寬"` 等中文 fixture 是字寬測試資料，刻意保留。

**語言注意：** 雖然本地 context 預設要求中文 comments/docs，但使用者已在這次任務明確要求 **Changelog 和 code comments 使用英文**。後續相關修改沿用這個要求；聊天仍用中文。

## 主要檔案

| 路徑 | 用途 |
|---|---|
| `packages/coding-agent/src/session/context-view.ts` | 組裝唯讀 snapshot、來源歸屬、內容分類與估算 |
| `packages/tui/src/overlays/context-viewer.ts` | ANSI／Native Viewer、導航、預覽、全文與診斷頁 |
| `packages/tui/src/status-line/context-usage.ts` | 原有 context 統計與診斷呈現 |
| `packages/coding-agent/src/session/context-usage-runtime.ts` | Session policy、Compaction 與可選 Snapcompact 估算 |
| `packages/tui/src/chrome/context-map.ts` | Token map 與 Fit scale |
| `packages/tui/src/chrome/context-presentation.ts` | Map／legend 共用分類視覺 |
| `packages/coding-agent/test/modes/context-view.test.ts` | Snapshot 與真實 Snapcompact planner coverage |
| `packages/tui/test/context-viewer.test.ts` | 導航、路徑、安全處理、診斷與 responsive coverage |
| `packages/coding-agent/test/issue-4806-command-output.test.ts` | 正式入口、focus、草稿及背景 turn 隔離 |

既有 feature 還包含 System Prompt 來源追蹤，涉及 `system-prompt.ts`、`session-tools.ts`、`agent-session.ts` 等。來源與 prompt 的原子提交、rollback、失敗 rebuild 行為已有測試；不要順手簡化掉。

## 已執行的驗證

### 自動檢查

- 12 個相關測試檔案：**121 pass，0 fail**。
- 最後只翻譯 comments 後，重跑：
  ```text
  bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/coding-agent/test/modes/context-view.test.ts
  ```
  結果：**23 pass，0 fail**。
- 分別在 `packages/tui`、`packages/coding-agent` 執行 `bun check`，均通過。
- 未宣稱整個 monorepo 全部測試或 CI 通過。

### 已知無關測試失敗

`packages/tui/test/usage-native-describe.test.ts:452`

時間格式測試預期英文 `pm`，本機 locale 輸出「下午」，導致失敗。沒有修改該測試或 locale，也不要為了本 feature 順手修它。

### 實際 CLI／UI smoke

使用 Windows 原生 `PtySession.startArgv()` 啟動正式 CLI，搭配既有 `VirtualTerminal` 觀察畫面，確認：
- 全新空 Session 可開 `/context`。
- System Prompt、Instruction Files、Skills、active `read` tool 內容可查看。
- `d` 開診斷頁，Esc 返回。
- Resize 到 48×18 後仍可操作。
- 分層 Esc 最後關閉 Viewer，恢復 composer。
- 大型多行及超長單行輸出的全文尾部可到達。

**未做 Tern 原生窗口的視覺驗證。** Native 有節點／事件測試，不能說已在 Tern 親自驗收。

臨時 smoke scripts 與臨時資料已清除，沒有提交。

### Windows 驗證注意事項

- `xd://tui` 啟動失敗，因環境沒有 `/bin/sh`。
- 本 session 的 `bash` 工具即使設定 `pty: true`，CLI 仍判斷 stdin 非 TTY。
- 可行路徑是 repo 的 `@oh-my-pi/pi-natives` → `PtySession.startArgv()`。
- 新建隔離 agent dir 會進 onboarding；當時只在臨時 config 設 `setupVersion: 999` 跳過，未修改使用者設定。
- ConPTY 已處理 terminal 回覆，當時不要再把 `VirtualTerminal` 的 CPR replies 回送 PTY，否則會有字元混入 composer。

## 後續操作約束

- 使用者尚未授權 push、PR 或 Discord 發文。
- `CONTRIBUTING.md:19–26` 確實要求大型 UI／跨 package 功能事前在 Discord 討論；程式完成不代表 maintainer 已接受方向。
- 不要自動重構整個 feature。
- 若使用者確認要整合診斷資訊，再針對總覽布局與資料欄位做最小修改，同時更新 ANSI、Native、測試及英文 Changelog。
