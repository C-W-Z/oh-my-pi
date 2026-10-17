# OMP `/context` 互動式 Context Viewer 實作計畫

## 1. 目標與實作基線

將 `/context` 改為全螢幕、取得 focus 的互動式 context 瀏覽器。以現有 session 資料顯示分類用量、分類內容及個別工具輸出；尚未對話也能查看已載入的 prompt、instructions、skills 與 active tools。介面文案維持英文。

目前 checkout 的 `CommandController.handleContextCommand()` 仍透過 `showCommandReport()` 顯示靜態 `ContextUsageView`，沒有互動 viewer、細分類 adapter 或共用 `chrome/context-map.ts`。本計畫不假定其他 branch／commit 的實作已存在，也不把其他環境的測試結果當作驗收證據。實作時若已有符合契約的功能，直接沿用，不再造一份。

**核心準則：先復用現有 code，再補足缺少的能力。** 只新增 context 專屬的資料 adapter 與導覽狀態；不建立通用 viewer framework、第二套 tokenizer、scroller、symbol registry、overlay stack 或 prompt builder。

## 2. 全螢幕與輸入契約

現有 `showCommandReport()` 的短報表會 dock 在 editor 上方，保留 editor focus；長報表才切換全螢幕。`ReportPanel.handleInput()` 自行處理捲動與關閉，不將選取／Enter 轉送 body。互動 `/context` 不得繼續走這個自動 dock 分支，也不能只把報表 body 換成互動元件。

採用 `/usage` 的 focused fullscreen overlay 慣例，但不復用其 quota／activity 業務邏輯：

- ANSI 一律使用既有 `ui.showOverlay()`，設定 `anchor: "bottom-center"`、`width: "100%"`、`maxHeight: "100%"`、`margin: 0`、`fullscreen: true`，並 `ui.setFocus(viewer)`。使用既有 alternate-screen 生命週期，不改寫主畫面 transcript。
- Native 同樣走 fullscreen overlay 與 focus 路徑；實際 sheet 佈局依既有 native overlay 契約，不保留舊報表專用的 90% sizing 分支，不另造 native modal 協定。
- Viewer 開啟期間，選取、Enter、翻頁與 Esc 由 viewer 處理，不得落到 editor 送出訊息，或將 Esc 誤解為中止 agent。
- Esc 在全文返回分類預覽，在分類預覽返回總覽；單筆分類直接進全文時，Esc 直接回總覽。只有總覽的 Esc 關閉 viewer。Native Back 遵循相同返回規則，Close 直接關閉整個 viewer。
- 關閉後恢復原 editor focus 與既有草稿。**互動 UI 暫時接管輸入，不代表暫停對話執行**：已在執行的 turn、工具及背景工作照常進行；不因開啟、返回或關閉 viewer 而 abort、排入新 turn 或修改 messages。
- 資料為開啟當下的唯讀 snapshot，不 live-refresh。畫面提示重新開啟可更新；背景 turn 產生的新內容於下次開啟取得。
- 沿用 `CommandController` 的 `#reportSheet`、`#clearReport()`、`#closeReportSheet()` 與 `clearCommandReport()`。新 report 取代 viewer；session／transcript reset 關閉 viewer。不要另掛一套 reset 訂閱或管理 overlay stack。
- 非 TUI 的 `buildContextReportText()` 保持現有文字報表；沒有有效 model/window 時維持既有 warning。

## 3. 分類與計量契約

| 順序／名稱 | 內容與操作 |
| --- | --- |
| 1. System Prompt | 有效 system prompt 扣除可靠歸屬的 instructions／skills 後的內容；保留 eval guidance、environment、workspace、memory 及其他 system 文字。 |
| 2. Instruction Files | 此次 prompt build 實際載入的個別 instruction file 路徑與內容，不把整個 System context 改名。 |
| 3. Skills | 實際渲染的 skill catalog 項目與資訊；不為預覽重新讀取完整 skill 文件，也不新增載入提示語意。 |
| 4. Built-in Tools | 目前 active 的 builtin tool 定義、schema、examples。 |
| 5. Custom Tools | Active 的非 builtin tools；MCP／SDK／extension／unknown 來源放在項目資訊，不另設頂層分類。 |
| 6. User Messages | 有效對話中的 user／developer 內容與相應 OMP 訊息，保留來源 role／customType。 |
| 7. Assistant Messages | Assistant text blocks。 |
| 8. Assistant Thinking | 可讀 thinking blocks；redacted／encoded 僅標示類型，不輸出 signature bytes。 |
| 9. Tool Calls | 工具名稱、call ID 與參數，不混入工具定義或結果。 |
| 10. Tool Output | 總覽直接展開一層 per-tool 子列，可進入個別 result 的完整已保存內容。 |
| 11. Auto-Compact Buffer | 顯示用量與圖例，不可選取。 |
| 12. Free Space | 顯示容量與圖例，不可選取。 |

十個內容分類的 ID 依序為 `system-prompt`、`instruction-files`、`skills`、`built-in-tools`、`custom-tools`、`user-messages`、`assistant-messages`、`assistant-thinking`、`tool-calls`、`tool-output`；零用量分類仍顯示，進入時顯示空狀態。Buffer／free 為不可選尾列，不當成內容 entries。

- 所有分類及 per-tool 百分比一律以真正 context window 為分母。Map 只計頂層 totals，不重複計入 Tool Output children。
- Header 分開顯示既有 `OMP usage` 與細分類的 `Estimated content`。兩者不保證相等，不以比例縮放分類數字硬湊。
- 使用 `computeSessionContextBreakdown()` 取得既有 usage/window/compaction 資料；viewer 不要求 `snapcompactSavings: true`，不為瀏覽啟動影像 planner。
- 內容估算復用 `session.agent.tokenizer`；schema 復用 `toolWireSchema()`、`renderToolExamples()`、`estimateContextToolSchemaTokens()` 及既有 `model.toolSchemasInContext` policy。不新增 provider/model 字串分支。
- Tools 以 `agent.state.tools` 為準，`getAllToolInfos()` 只補來源。未 active、僅註冊或 server-side deferred 的 schema 不算進來；prompt 中的 `xd://` docs 留在 System Prompt。
- Assistant 的 text／thinking／toolCall 分別建立 entry。Tool results 依原始 tool name 分組，子列按 tokens 遞減、平手依首次出現順序；內容按時間遞增、平手保留對話順序。頂層 Tool Output 合併各組按相同規則瀏覽。
- OMP 特有訊息復用本地純 `convertToLlm()`，不呼叫 session 的 context hooks／provider transforms。`bashExecution`／`pythonExecution` 歸相應 Tool Output；`excludeFromContext` 則排除。Custom、hook、fileMention、branch／compaction summary 按轉換後 role 分類，不靜默丟棄。
- 多媒體只顯示類型、MIME 與可用尺寸／大小摘要，不顯示 base64；訊息估算可復用 tokenizer `countMessages()`，不可將顯示用摘要再當原始內容計量。
- `buffer = min(existingBuffer, max(0, window - estimatedTokens))`；`free = max(0, window - estimatedTokens - buffer)`。Compaction 停用時沿用現有 policy。超出 window 保留實際估算與超額資訊，map clamp，不產生負 free。
- Entry ID 使用 category／message index／block index 等本次 snapshot 位置，不僅依 timestamp 或可能重複的 call ID。只保留必要的 display values，不 clone session，不寫入 logs、session、clipboard 或磁碟，不追讀工具輸出提及的 artifact。

## 4. 必須復用的接點與最小擴充

| 既有接點 | 復用方式／必要擴充 |
| --- | --- |
| `modes/controllers/command-controller.ts` | 改 `/context` 入口及既有 report handle 的掛載，不改其他 report 的 dock 行為。 |
| `modes/controllers/selector-controller.ts` 的 `/usage`、`#showFullscreenMenu()` | 沿用 showOverlay／focus／close 慣例；不為復用數行掛載程式抽出泛用 controller 或搬動其他 dashboards。 |
| `session/context-usage-runtime.ts` | 取得現有 usage 與 compaction 設定，不另寫容量政策。 |
| `status-line/context-usage.ts` | 復用 tokenizer/schema 計量與 category glyph/color → map/legend 資料流；只抽取真正共用部分，不改五大類公開統計契約。 |
| `theme/symbols.ts`、`Theme.symbol()`／`styledSymbol()`、`activeThemeSymbol()` | 集中 context symbols，支援既有 unicode／nerd／ascii presets 與 override；不建立新 resolver/cache。 |
| `components/menu-selection.ts`、`chrome/selector-helpers.ts` | 復用 stable keys、disabled skip、選取與列表 viewport；不搬 Pi 的 ListNavigator。 |
| `components/scroll-view.ts` 與既有 viewport helpers | 復用內容捲動、翻頁、reveal、首尾定位；viewer 只保存 entry row ranges 與返回位置。 |
| `system-prompt.ts`、`SkillDescriptionCatalog`、SessionTools prompt commit | 保留實際 build 來源，沿用凍結描述及 commit/rollback，不重新 discovery/render。 |
| `session/messages.ts` | 復用純訊息轉換，不進模型請求 pipeline。 |
| 既有 key matchers、sanitize／path／width／wrap helpers、native nodes | 復用輸入、顯示安全及原生事件契約，不另造協定或字串寬度計算。 |

本計畫中的 coding-agent 路徑以 `packages/coding-agent/src/` 為根，TUI 路徑以 `packages/tui/src/` 為根。修改 exported 型別／函式前先用 LSP references 遷移所有 callers，不保留相容別名或另一套結構型別。

### 4.1 Prompt 來源：保留 build 結果，不反向猜 prompt

現有 `BuildSystemPromptResult` 只有 blocks 與 xdev catalog bookkeeping，不足以可靠拆出 instructions／skills。這是必要的最小資料擴充，不是重寫 prompt 系統。

- 在 build result 增加 optional 來源 metadata，保存對應的原始 blocks，以及來源 ID、kind、label、path、實際 rendered fragment。用命名型別在 SDK、AgentSessionConfig 與 SessionTools 傳遞，不維護多份 structural shape。
- 復用已 dedupe／展開 imports 的 `contextFiles` 與當次已凍結 `filteredSkills`。若現有 template 無法直接取得單筆 rendered fragment，只將原 loop 中的 instruction／skill 片段抽成最小 static Markdown partial，讓 prompt 與 metadata 使用同一份渲染結果。不得在 TypeScript 拼 prompt，也不得另寫 renderer。
- 保留自訂 templates 現有欄位及變數；stock blocks 的 bytes、順序、技能過濾與語意不得改變。局部 metadata 變數避開現有 rule dedup 的 `contextPromptSources` 名稱。
- Metadata 與 base prompt 原子提交：涵蓋 initial build、active-tool rebuild、prepare/commit、memory append、session switch rollback。失敗、abort、discarded、frozen rebuild 不發布候選來源。Setter 未傳 metadata 時清除舊來源；memory append 明確保留仍對應原 blocks 的來源。
- Viewer 只對與當前有效 prompt 完全相同的整個 block 分配來源；以 exact rendered fragments 唯一、不重疊地歸屬，先 instructions 再 skills，同一來源只計一次。重複 blocks 按 occurrence 配對；不得用 XML／Markdown regex parser 猜區段。
- 被改寫、缺失或歧義片段留在 System Prompt，顯示一條歸屬不完整 notice。固定／callback replacement、`NULL_PROMPT` 或無 canonical fragment 的自訂 template 不攜帶不可信來源；opaque prompt 仍可完整檢視，沒有 metadata 本身不報錯。
- Viewer 不讀 instruction 路徑、不呼叫 `SkillDescriptionCatalog.render()`、不啟動壓縮，不擴充 extension context API。

### 4.2 顯示 adapter：只補細分類與預覽

新增薄的 `session/context-view.ts`，入口 `buildSessionContextView(session)`。開啟時一次讀取 effective prompt、messages、active tools 與已提交來源，產生唯讀顯示資料。

UI 契約與 `overlays/context-viewer.ts` 同置：entry 保存穩定 ID、label、原文、tokens 及必要來源資訊；category 保存 ID、label、tokens、entries／children；view data 保存 model label、window、既有 usage、估算總量、buffer/free 及 notices。不預先加入 viewer 不使用的通用欄位。

不持有可變 message/schema 物件。無法序列化的單一 tool schema 保留名稱、描述與可讀錯誤，不使整個 viewer 無法開啟。

### 4.3 Map 與 legend：同一個視覺來源

現有 `context-usage.ts` 的 category 已同時持有 glyph/color，`planCells()` 與 `buildLegendParts()` 共用它們。現有 glyph 是該檔內的 `CELL_*` 常數，不能宣稱已有 context 專用 symbol keys。

- 從這個資料流抽取最小 context 呈現定義，供靜態報表及新 viewer 共用；必要時置於既有 `chrome/`。集中遷移至現有 symbol registry，補足三種 presets，不在 viewer 新增 `CELL_*`、`MAP_STYLES`、raw glyph table 或臨時預設 palette。
- 保留既有視覺語彙：System Prompt 為 accent、Instruction Files 承接 System Context 的 customMessageLabel、Built-in Tools 承接 warning、Skills 為 success、User Messages 承接 userMessageText；其餘細分類只在同一來源擴充，不強迫新增十個圖案。
- **每個分類列都是 legend**：選取指示之外，必須有與 map 同源的 glyph/color，接著才是名稱、tokens、百分比。不能只染整列，也不能把選取箭頭當分類圖標。選取樣式不得蓋掉 swatch 色彩。
- Per-tool 子列沿用 Tool Output 身份；buffer 為 warning、free 為 dim，仍有圖例且不可選；零用量及窄畫面無 map 時仍有圖標。
- ANSI 與 native 消費同一份呈現資料。Native 圖例放在真正可互動 item 的可見 styled content，不另加重複 legend，不猜測 TSP 欄位；依現有 selectList／text/spans／row 與 meter swatch 契約組裝。
- Theme 在 render/describe 時解析；override、theme 切換／invalidate 同時更新 map 與 legend，不把 glyph 凍結在 session snapshot。保留靜態報表、native meter 及 glyph-grid fallback 的圖例。

### 4.4 Map 計算：擴充現有能力，不複製 renderer

現有 `planCells()` 為固定 grid、整格 rounding；viewer 需要 fractional occupancy 與 Window/Fit。將占用計算抽取／擴充為純 `chrome/context-map.ts` helper，舊 map 與新 viewer 共用，不留下兩份占用算法；它不依賴 Theme、ANSI 或 native nodes。

- 以頂層 totals 形成連續 segments，cell 按最大重疊 category 決定身份；主要分類覆蓋至少 70% 標記 full，否則 partial。Full／partial 使用相同分類圖標，不另造填滿／半滿 glyph。
- Fit scale 為估算總量 × 115%，向上取兩位有效數字，最小 10k、最大 context window。Window/Fit 只改 map 比例，不改數字或百分比分母；沒有 zoom 意義或 map 隱藏時不啟用 z。
- 未知／無效 window 或 geometry 不繪 map；超額占用 clamp，buffer/free 不為負。
- 舊報表保持其 geometry、theme 語彙、public signatures、native meter、snapcompact 及統計分類；不以本次細分類改造 status line、ACP 或 extension API。

### 4.5 Viewer：專屬導覽狀態，復用現有元件

新增 `ContextViewer implements Component`，只管理 overview、category preview、entry full content 三種狀態；render 與 describe／native events 共用同一份選取及返回狀態。

- 總覽寬畫面為左 map／右互動 legend。Map requested geometry 為 16×16，依可用高度／寬度縮小；至少保留列表 32 columns。Inner width < 52 只顯示列表，52–71 無格間距，≥72 可加間距。高度不足先減 map 附註，再讓列表捲動。
- 寬度依現有 visibleWidth／truncate helpers 計量實際 symbol；先扣選取欄、縮排、glyph 與數字欄，再截 label，不假定 override 永遠一格寬。
- 單筆分類直接全文；多筆分類先顯示可選 preview blocks，使用 `PREVIEW_LIMITS.OUTPUT_EXPANDED` 並受剩餘高度限制。已完整顯示的短 entry 不再開重複層級。空分類顯示 `No content in this category.`。
- 使用 MenuSelection 管選取與 disabled skip，ScrollView 管 viewport、翻頁與首尾。超高區塊先在區塊內捲動，抵達邊界再移下一筆。返回保留 selected key／entry 與 offset；改開另一分類從頂端開始。
- 復用 OMP select/cancel/page matchers、matchesKey，支援方向鍵、j/k、Home/End、Enter，z 僅用於總覽 map。依既有 capturesInput 路由攔住確實處理的操作鍵，避免誤入 app interrupt；modal 內其他輸入不送到 editor。
- 原文先 sanitize、replaceTabs，再套 theme；來源路徑用 shortenPath，內文用中央 embedded-path helper，單行用 truncateToWidth，全文復用 wrap/viewport。只改顯示，不改原文或估算，不永久截斷全文。
- Resize 重算 wrap 與 viewport，clamp 選取／offset；invalidate 清除顯示 caches，不讀 session、不 tokenize。必要的安全文字／換行快取依 entry、width、theme 管理，不為每個按鍵重建整段對話。
- Native select／activate／Back／Close／scroll 對應相同操作，使用現有 item keys 與 `{ by, n }` scroll 契約。不能只提供靜態 describe 而沒有原生互動。

## 5. 實作順序

1. **保留來源與建立 adapter**：補最小 prompt metadata，接上 commit／rollback，完成分類、計量與預覽資料。不改 prompt bytes 或觸發模型 pipeline。
2. **集中 map／legend 呈現與占用計算**：先沿用現有分類視覺，再擴充細分類、fractional／Fit；靜態與新介面共用，沒有 renderer-local mapping。
3. **實作 viewer 與正式 `/context` 掛載**：復用選取／捲動／native 契約，切換 focused fullscreen，沿用 report replacement/reset 與 editor focus 復原。
4. **驗收實際 changed path**：執行 focused tests、型別檢查與真實 UI 操作。完成後更新受影響 package 的 `[Unreleased]` changelog，只寫使用者可見行為；不修改已發布區段。

本次合併計畫只修改文件，不實作上述功能、不建立 commit、不 push 或更新 PR。

## 6. 驗證與完成條件

### Contract tests

沿用既有 Bun／isolated Settings／TempDir 慣例；不使用 mock.module、source grep、固定文案／色碼／行號 snapshots、constructor-copy assertions，或僅檢查畫面包含某 glyph。新增測試只保護可觀察契約：

- **資料**：空對話仍可預覽靜態來源；assistant blocks 分類不重複；per-tool 排序與時間順序；OMP 特有訊息與 excluded execution；opaque／改寫 prompt 不繼承錯誤來源；不可序列化 schema 不阻斷 viewer。
- **來源生命週期**：開啟不重讀檔案；accepted rebuild 才更新；deferred／abort／frozen rebuild 不覆蓋舊來源；session switch 失敗還原 prompt 及來源。
- **Map ↔ legend**：對足夠非零用量分類，定位實際 map cell 與列表 item，驗證同源 glyph/color；隔離 Theme override 並 invalidate 後兩側一起改變。涵蓋 partial、buffer/free、零用量與 per-tool 身份；不重複測 helper 已證明的數學。
- **導覽**：分類／per-tool → preview／全文 → 尾端 sentinel → Back 恢復位置；單筆直接全文、空分類、disabled skip、Window/Fit 數字不變；寬 symbol override 與三種寬度分支不溢出，width-only／height-only resize 後仍可操作。
- **入口與執行隔離**：小用量也一律 focused fullscreen；Esc 分層返回而不 abort turn；viewer 內 Enter 不送到 editor；Close 回原草稿與 focus；新 report 替換、reset 關閉。操作期間 viewer 不增加 model request／transformContext／onPayload／before-model-call hooks，不自行改 messages。背景 turn 可持續，snapshot 不跟著變動。
- **既有報表**：其他 report 的 dock／streaming 行為、靜態 ANSI/native legend、native meter swatch 與 glyph-grid fallback 不回歸。

新 adapter／viewer／map 測試分別放在 `packages/coding-agent/test/modes/context-view.test.ts`、`packages/tui/test/context-viewer.test.ts`、`packages/tui/test/context-map.test.ts`；其餘優先延伸既有測試，不跨層重複同一契約。

```text
bun test packages/coding-agent/test/modes/context-view.test.ts packages/coding-agent/test/modes/context-usage.test.ts packages/coding-agent/test/agent-session-context-file-reload.test.ts packages/coding-agent/test/issue-4806-command-output.test.ts
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/tui/test/usage-native-describe.test.ts packages/tui/test/report-panel.test.ts
bun test packages/coding-agent/test/system-prompt-template.test.ts packages/coding-agent/test/system-prompt-context-dedup.test.ts
bun check
```

如抽出 prompt partial，以 throwaway probe 比較相同 inputs 的 blocks bytes：stock、自訂 template、append、imports、空 skills；不加入永久 boilerplate snapshot。以上新檔案是實作產物，不表示目前已存在或已通過。

### 真實 UI smoke

- 正式 CLI 執行 `bun run dev -- --no-session` 開 `/context`，確認全螢幕、focus、左右圖例、空對話的靜態內容及分層 Esc。不能只跑獨立 viewer 而跳過正式入口。
- 隔離 session fixture 提供 assistant text/thinking/call、兩個工具、同工具多筆結果、一筆多頁且末行為 `context-output-tail` 的輸出，以及 tabs／ANSI／長單行。透過正式 adapter 與真實 TUI renderer 操作 per-tool、全文尾端、Back、Close。
- 在 48×18、100×24、100×36 與不同 symbol presets／至少一組 override 觀察 map/legend、Window/Fit、列表可達性、resize 及 offset；窄畫面無 map 仍保留圖例。
- 驗證開啟期間背景執行不被中止，viewer snapshot 不自行變動，關閉後可見新進度；另以靜止 fixture 的 counters/messages 對比證明瀏覽本身沒有模型請求、hooks 或 mutation。
- Native 用同一 fixture 驗證實際帶圖例 item 的 select／activate／Back／Close／scroll。可用 Tern 時操作真實原生畫面；只有 describe/event 證據時明確標記未做 Tern 視覺驗證。
- 使用真實 PTY／既有 TUI debug input path，等待 paint 後觀察 text/screenshot、focus 與 counters。Windows 若啟動工具缺 `/bin/sh`，改用既有 Windows PTY／IPC 路徑，不另造測試輸入系統。
- 完成後移除 throwaway fixture/probe、停止自行啟動的服務。`--smoke-test` 的 worker probe 不代替 viewer 驗收。Locale、native bindings 或 build tools 的限制分開記錄，不冒稱通過、不為本功能修改無關環境設定。

### 完成清單

- [ ] 指定十二列、內容歸屬、per-tool 預覽及完整已保存輸出可達，沒有重複計量或靜默漏項。
- [ ] `/context` 一律 focused fullscreen，分層 Esc／Close、背景 turn、草稿／focus、replacement/reset 契約成立。
- [ ] Map 與互動 legend 共用分類 symbols/color；靜態報表與 ANSI/native 不保留第二套 mapping。
- [ ] 既有 tokenizer、schema、訊息轉換、prompt build、選取、捲動與 overlay 生命週期被復用，新增 code 只補缺口。
- [ ] Fractional／Fit、responsive geometry、寬 symbol、零用量、超額 context 與 opaque prompt 邊界成立。
- [ ] Focused checks、prompt bytes probe 與真實 UI smoke 有當次證據；未驗證的 surface／缺少的 prerequisite 明確列出。
