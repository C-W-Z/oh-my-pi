# OMP `/context` 互動式 Context Viewer 實作計畫

## Context：需求與預期結果

將 OMP 既有 `/context` 擴充為類似本地 `../pi-context-view/` Usage 畫面的互動式用量與內容瀏覽器，使用目前 session 已持有的資料，不建立 provider request capture。尚未開始對話時仍可檢視已載入的 system prompt、instruction files、skills 與 tools；對話後可依分類查看訊息、thinking、tool calls 及個別 tool output。

TUI 分類順序固定為 System Prompt、Instruction Files、Skills、Built-in Tools、Custom Tools、User Messages、Assistant Messages、Assistant Thinking、Tool Calls、Tool Output、Auto-Compact Buffer、Free Space。Tool Output 在總覽直接列出各工具的用量子列，能進入瀏覽單筆輸出；介面文案沿用英文。

### 分類與內容契約

| 順序／顯示名稱 | 內容與預覽 |
| --- | --- |
| 1. System Prompt | 目前有效 system prompt 中未另歸屬 instruction files 或 skills 的部分；保留 eval guidance、環境、workspace、memory 等其他 system 文字。 |
| 2. Instruction Files | 個別已載入 instruction file 的路徑與內容，不把整個 System context 直接改名。 |
| 3. Skills | 個別 skills 的資訊與內容預覽；不用另加 skill 載入語意的提示文案。 |
| 4. Built-in Tools | 目前 active 的 builtin tool 定義、schema、examples。 |
| 5. Custom Tools | 目前 active 的非 builtin tool 定義；MCP／SDK／extension 來源放在項目資訊，不增設頂層分類。 |
| 6. User Messages | 目前有效對話中的 user 內容；來源 role 保留在項目資訊。 |
| 7. Assistant Messages | Assistant text blocks，與 thinking／tool calls 分開。 |
| 8. Assistant Thinking | 目前可檢視的 thinking blocks。 |
| 9. Tool Calls | 工具名稱、call ID、參數，與工具定義或輸出分開。 |
| 10. Tool Output | 總覽直接展開 per-tool 子列；進入後依時間查看個別 result，並可打開完整內容。 |
| 11. Auto-Compact Buffer | 顯示用量，無內容可預覽，游標跳過。 |
| 12. Free Space | 顯示容量，無內容可預覽，游標跳過。 |

每個分類和 Tool Output 子列的百分比固定以真正的 context window 為分母。Map 只計頂層分類，不再計一次 Tool Output 子列。Usage 原有回報／估算數字與細分類文字估算不保證完全相等，畫面必須分別標示，不強行用比例修改分類數字。


## 已確認的 OMP 接點

- `packages/coding-agent/src/slash-commands/builtin-session.ts` 的 `context` 指令：TUI 呼叫 `runtime.ctx.handleContextCommand()`；非 TUI 使用 `buildContextReportText()`。
- `packages/coding-agent/src/modes/controllers/command-controller.ts` 的 `handleContextCommand()`：目前計算 breakdown 並透過 `ReportPanel` 顯示 `ContextUsageView`。
- `packages/coding-agent/src/session/context-usage-runtime.ts`：`computeSessionContextBreakdown()` 和 `getSessionCompactionBoundaries()` 統一取得 session/model 的用量及 compaction 設定。
- `packages/tui/src/status-line/context-usage.ts`：目前只有 systemPrompt、systemContext、systemTools、skills、messages 五個大類；已有 tokenizer、工具 wire schema、compaction buffer/free space 與 context map 的相關實作。
- `packages/coding-agent/src/session/session-tools.ts` 的 `getAllToolInfos()`：提供 builtin、mcp、sdk、extension 來源；`getActiveToolNames()` 是目前頂層工具，不應把所有已註冊但未啟用的定義都算入。
- `packages/coding-agent/src/system-prompt.ts` 的 `buildSystemPrompt()`：渲染主 prompt、追加 eval prelude guidance，最後追加 project-context。Instruction Files 不等於整個既有 System context 分類，拆分時須保留其餘 system 內容。

## 如何參考本地 pi-context-view

| 參考位置 | OMP 採用方式 |
| --- | --- |
| `../pi-context-view/src/usage.ts`：`classifyPromptCategories()`、`classifyMessages()`、`collectPreviewEntries()` | 參考 category → children → preview entries 的結構、assistant blocks 分類、per-tool results 聚合，以及依時間合併預覽；改用 OMP 型別與 tokenizer。 |
| `../pi-context-view/src/ui/usage-view.ts`：`UsageView`、`buildCategoryLegendRows()` | 參考左 map／右可選列表、Tool Output inline 子列、分類預覽及全文三級狀態。不要搬 `context.ui.custom()` 的 Pi extension 入口。 |
| `../pi-context-view/src/ui/usage-preview.ts`：`BlockNavigator`、`layoutPreviewBlocks()` | 參考多筆預覽的區塊選取、超長區塊內捲動、翻頁與 resize 後保留位置；優先重用 OMP 已有 navigator／scroll helpers。 |
| `../pi-context-view/src/ui/usage-map.ts`：`buildUsageMap()`、`calculateFitMapScale()` | 參考 fractional occupancy、mixed cells 與 Window/Fit zoom；fit 使用估算總量 × 115%，向上取兩位有效數字，最小 10k、最大 context window，僅改 map 比例。 |
| `../pi-context-view/doc/ui/usage.md`、`doc/ui/previews.md` | 作為操作規格：單筆直接全文、多筆先預覽、Esc 返回位置、窄螢幕優先保留分類列表。 |
| `../pi-context-view/test/usage-preview.test.ts`、`test/usage-view.test.ts` | 只參考邊界、返回位置、超長內容與 resize 的行為情境；不用照抄色碼、固定行號、固定措辭等 incidental assertions。 |
| `../pi-context-view/doc/images/pi-context-view.png` | 寬視窗視覺參考；顏色、元件、key bindings、sanitize 與 native rendering 遵循 OMP。 |

參考的是 Usage 的體驗與純分類邏輯，不移植 `capture/`、`probe/`、`injections`、request diff、Pi provider payload 規則或套件依賴。Reference 額外存在的 MCP Tools、Extensions、Compacted Data 不自動成為本需求的頂層分類；OMP 的現有內容仍須有明確歸屬，不可因沒有同名分類而靜默丟棄。

## Approach：功能實作順序

依序完成資料、呈現、入口；步驟 3 的 map 與步驟 4 的導覽元件可以在步驟 2 的型別確定後分開實作，最後由步驟 5 整合。此處新增的是 viewer 的顯示模型，不改 status line、ACP 文字報表或 extension API 的既有統計契約。

### 1. 在既有 prompt build／commit 保留可供檢視的來源

**修改目標：** `packages/coding-agent/src/system-prompt.ts`、`src/sdk.ts`、`src/session/session-tools.ts`、`src/session/agent-session-types.ts`、`src/session/agent-session.ts`；本節 `src/` 均以 `packages/coding-agent/` 為根。

目前的 prompt builder 已取得 dedupe 後的 context files、展開 imports 後的內容，以及 `SkillDescriptionCatalog.render()` 的已凍結 skills 描述，但 `BuildSystemPromptResult` 只回傳 prompt blocks 與 xdev catalog bookkeeping。新增來源 metadata 是為了保留這些既有資料，不新增 discovery、provider snapshot 或另一套 prompt builder。

在 `system-prompt.ts` 新增以下型別與欄位：

```ts
export interface ContextPromptSource {
  readonly id: string;
  readonly kind: "instruction-file" | "skill";
  readonly label: string;
  readonly path: string;
  readonly text: string;
}

export interface ContextPromptSources {
  readonly blocks: readonly string[];
  readonly entries: readonly ContextPromptSource[];
}
// BuildSystemPromptResult 新增：
// contextPromptSources?: ContextPromptSources;
```

- `text` 必須是該來源在此次 build 實際渲染的片段；`blocks` 保存對應 build 的原始 blocks，讓 viewer 只對尚未改寫的 block 做歸屬。
- 將 stock templates 目前各自的 `<file>` 內容與兩種 skill item 格式抽成三個 static text partial：`src/prompts/system/context-file.md`、`skill-list-entry.md`、`custom-skill-entry.md`。由 builder 用既有 `prompt.render()` 渲染單筆，提供 `renderedText` 給既有 `project-prompt.md`、`system-prompt.md`、`custom-system-prompt.md` 的對應 loop 使用，再把同一段文字保留為 metadata；不在 TypeScript 拼接 prompt 字串。Skill partial 的選擇沿用現有 `resolvedCustomPrompt` 對 stock／custom prompt template 的判斷。
- 保留原本 context file／skill 的欄位，讓使用者自訂 templates 的現有變數繼續可用。抽 partial 前後，stock prompt 的 bytes、block 順序、技能過濾及提示語意必須不變。新增 metadata 的局部變數命名為 `builtContextSources`，避免和既有用於 rule dedup 的 `contextPromptSources` 文字陣列混淆；不更動後者行為。
- 使用目前 build 的 `contextFiles` 和 `filteredSkills`；不要從路徑重讀 instructions，也不要由 viewer 呼叫 `SkillDescriptionCatalog.render()`。已凍結描述只能從 build 結果或現有 `snapshot()` 讀取，不啟動壓縮工作。
- `NULL_PROMPT`、SDK 固定 `options.systemPrompt`、function-valued replacement 直接回傳 opaque blocks，不攜帶已不可信的 section 歸屬；內容仍可在 System Prompt 檢視。自訂 template 沒有輸出 canonical fragment 時同樣不猜測歸屬。
- `SessionToolsOptions.rebuildSystemPrompt` 與 `AgentSessionConfig.rebuildSystemPrompt` 改用已存在的命名型別 `Promise<BuildSystemPromptResult>`，不繼續維護兩份 structural result shape。新增 optional `contextPromptSources` 初始設定，由 SDK 保留 initial build 的完整結果，傳給 AgentSession，再傳進 SessionTools。
- SessionTools 新增 `#contextPromptSources` 與 readonly getter；AgentSession 新增 `get contextPromptSources(): ContextPromptSources | undefined`，只代理這份已提交資料，不把它加進 extension context API。
- metadata 和 base prompt 一起提交：涵蓋 constructor、`#applyActiveToolsByName()` 的 accepted rebuild、`#prepareBaseSystemPrompt().commit()`。丟棄、失敗、abort、frozen 的 rebuild 不發布候選 metadata。Setter 的新簽名為 `setBaseSystemPrompt(prompt: string[], sources?: ContextPromptSources): void`，省略 sources 就清除，不能繼承另一份 prompt 的歸屬。
- memory append 保留原 blocks 的 metadata；新追加的文字自然歸入 System Prompt。AgentSession 的 memoryHost callback（目前約 1967 行）呼叫 setter 時明確傳入當前 `this.#tools.contextPromptSources`，其有效性由步驟 2 的整 block 比對保障。Per-turn override 不改 metadata 本身。
- Session switch rollback 在 `previousBaseSystemPrompt` 附近（目前約 11626 行）一起保存 `previousContextPromptSources`；catch 還原 base prompt（約 11874 行）時把該 metadata 一起傳回 setter。不能在失敗切換後遺失舊歸屬或保留目標 session 的來源。

修改 exported result／setter 前，用 LSP references 重新列出呼叫處並逐一遷移。已查到的主要接點是 `system-prompt.ts:597/630`、`sdk.ts:1322/3864/4235`、`session-tools.ts:121/462/496/1168/1226/1994/2017/2085`、`agent-session.ts:1968/2140/11626/11874`、`agent-session-types.ts:320`；測試側有 `test/system-prompt-template.test.ts` 與 `test/agent-session-tool-rebuild-skip.test.ts`。保留 optional metadata 是為了 SDK 允許 opaque prompt 的既有有效用法，不增加替代／deprecated API。

### 2. 建立只讀的細分類與預覽模型

**新增檔案：** `packages/coding-agent/src/session/context-view.ts`，提供 `buildSessionContextView(session: AgentSession): ContextViewerData`。既有 breakdown 只有五大類和數字，沒有逐項 preview／per-tool results，因此需要這個薄的顯示 adapter；不另寫 tokenizer、schema conversion 或 message transform pipeline。

**新增 UI 資料契約：** 放在 `packages/tui/src/overlays/context-viewer.ts`，由 coding-agent type-import：

```ts
export interface ContextViewerEntry {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly tokens: number;
  readonly timestamp?: number;
  readonly path?: string;
  readonly role?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

export interface ContextViewerCategory {
  readonly id: string;
  readonly label: string;
  readonly tokens: number;
  readonly entries: readonly ContextViewerEntry[];
  readonly children: readonly ContextViewerCategory[];
}

export interface ContextViewerData {
  readonly modelLabel: string;
  readonly contextWindow: number;
  readonly usedTokens: number;
  readonly estimatedTokens: number;
  readonly autoCompactBufferTokens: number;
  readonly freeTokens: number;
  readonly categories: readonly ContextViewerCategory[];
  readonly notices: readonly string[];
}
```

資料規則：

1. 開啟時同步讀取 current effective `session.systemPrompt`、`session.messages`、active tools、工具來源及已提交來源 metadata，一次建置當次 view data。只保留 primitive display values 和必要的唯讀陣列；不 clone 整個 AgentSession、不保留可變的 schema 或 message 物件。開啟期間不 live-refresh；關閉再開啟才重讀。
2. 使用 `computeSessionContextBreakdown(session)` 取得現有 used/window/buffer，不要求 `snapcompactSavings: true`，避免為瀏覽另外執行影像 planner。Header 的 `OMP usage` 顯示既有 used/window/percent；`Estimated content` 顯示細分類總和。Map、分類、free space 使用後者，不能縮放子類數字去硬湊前者。`modelLabel` 用現有 `formatModelString()`。
3. 靜態 prompt 歸屬：對 metadata 中與 current effective prompt **整個字串完全相同**的 blocks，尋找來源的 exact rendered fragments。先分配 instruction files，再分配 skills；只接受唯一且不重疊的完整片段。將已分配片段從 System Prompt 的 preview／估算排除，其餘文字按原順序保留為 System Prompt。多次相同 block 以 occurrence 順序配對，單一 source ID 不重複計入；片段缺失、重複到無法唯一歸屬或 block 被任意重寫時，保留完整文字在 System Prompt，加入一條 `Some prompt sections could not be attributed; they remain in System Prompt.` notice，不做 XML／Markdown regex parser、不猜 extension 作者。沒有 metadata 的 embedding／opaque prompt 原本就不承諾歸屬，不另外報錯。
4. 所有內容估算使用 `session.agent.tokenizer`。Prompt／skill／assistant text／thinking／tool call 的文字片段走 `countTokens()`；tool schemas 用現有 `toolWireSchema()`、`renderToolExamples()` 與 `estimateContextToolSchemaTokens()`，不要重新發明 wire schema serialization。Schema 無法序列化時保留可讀的名稱／描述與錯誤資訊，不能讓一個工具使整個 viewer 開不起來。
5. Tools 以目前 `agent.state.tools` 的定義為準，並用 `getAllToolInfos()` 補來源。只有 `sourceInfo.source === "builtin"` 放 Built-in Tools；其餘放 Custom Tools，來源缺失標為 unknown。未 active 或僅註冊／server-side deferred 的 schema 不假裝占用目前 context；依既有 `model.toolSchemasInContext` 政策估算。`xd://` 只存在 prompt 的 docs 保留在 System Prompt，不把整份已註冊 registry 加進 tool schema 用量。
6. 固定十個內容 category ID／順序：`system-prompt`、`instruction-files`、`skills`、`built-in-tools`、`custom-tools`、`user-messages`、`assistant-messages`、`assistant-thinking`、`tool-calls`、`tool-output`。零用量分類仍顯示，進入時顯示空狀態；buffer/free 由 UI 當不可選取的尾列呈現，不是有 preview 的 categories。
7. 標準 user 訊息進 User Messages；assistant 每個 text／thinking／toolCall block 分開建立 entry，分別進三個分類。Tool Calls 保留工具名稱、call ID 與 JSON 參數；不把工具定義或 toolResult 再算進來。只展示可讀 thinking，redacted／encoded blocks 用類型標記，不輸出 signature bytes，也不新增 provider-specific reasoning 估算政策。
8. Tool results 依原始 `toolName` 分組；每筆保留 call ID、時間與完整已保存內容。Per-tool 子列按總 tokens 遞減，平手保留初次出現順序；每個工具內的 entries 按 timestamp 遞增，平手保留對話順序。進入頂層 Tool Output 時合併所有子列並按時間瀏覽。每個 aggregate 的 tokens 等於其 entries／children 總和，map 不重算 descendants。
9. 其他 OMP 訊息不可漏掉：user 手動 `bashExecution`／`pythonExecution` 用現有純 `convertToLlm()` 產生其可讀內容，分別歸入 Tool Output 的 bash／python 子列；`excludeFromContext` 為真則不列入。`custom`、`hookMessage`、`fileMention`、branch／compaction summary 使用同一個本地純 helper 轉成 preview，user 或 developer 內容歸 User Messages，entry 保留原來源 role／customType；轉換結果若為 assistant/toolResult 就依對應分類處理。不呼叫 `session.convertMessagesToLlm()`、SDK 的 context hooks 或 provider transforms。
10. 多媒體 blocks 以類型、MIME、可用尺寸／大小等摘要呈現，不把 base64 當全文，不另建影像 renderer。ToolResult／user 訊息 token 可用既有 tokenizer 的 `countMessages()` 計算；顯示標記本身不當成原始內容重新計量。
11. `autoCompactBufferTokens = min(existingBuffer, max(0, window - estimatedTokens))`；`freeTokens = max(0, window - estimatedTokens - buffer)`。停用 compaction 時沿用 OMP 現有 policy 結果；不從 Pi 複製 reserve 設定。超出 window 時保留實際估算數字與超額資訊，map 占用 clamp 到可用範圍，不能畫出負 free space。

ID 使用本次資料的 category／message index／block index 組合，tool-result 子列另加工具名稱；不可只依 timestamp 或可能重複的 call ID 生成 ID。內容只駐留記憶體，不寫入 session、logs、clipboard 或磁碟。

### 3. 重用並擴充中央 context map 計算

**新增中央 helper：** `packages/tui/src/chrome/context-map.ts`。目前 `status-line/context-usage.ts` 的 `planCells()` 是固定 grid 的局部實作，沒有可供 viewer 使用的 fractional／zoom model；將 map 占用運算收斂至此 helper，舊靜態 view 與新 viewer 共用，不留兩份相同運算。

- 新增 `buildContextMap(categories: readonly { id: string; tokens: number }[], contextWindow: number, bufferTokens: number, columns: number, rows: number, scaleTokens?: number): ContextMap | undefined`。
- `ContextMap` 欄位為 `columns`、`rows`、`blockTokens`、`cells`；cell 欄位為 optional `categoryId` 和 `fill: "full" | "partial" | "buffer" | "free"`。無有效 window、scale、geometry 時回傳 undefined，不拋錯。
- 按頂層 category totals 形成連續 segments；每格依最大重疊 category 決定顏色。最大 category 覆蓋至少 70% 顯示 full，否則 partial；無占用時判定 buffer/free。沿用 reference 的 fractional overlap 思路，不強迫小分類各占一整格。
- 新增 `fitContextMapScale(estimatedTokens: number, contextWindow: number): number | undefined`，使用上方 reference 表指定的 115%／兩位有效數字／10k floor／window cap。
- 更新舊 `planCells()` 轉接共用 helper，維持 `ContextBreakdown`、`ContextUsageView`、native meter、`contextUsageHead()` 及 `renderContextUsage()` 的 public signatures；舊靜態 view 仍用原本 geometry／theme glyphs，新 viewer 使用自己的 responsive geometry。不要為這次 TUI 改動重分類 ACP 輸出或 status line。

### 4. 實作共用狀態的 ANSI／native 互動 viewer

**新增：** `packages/tui/src/overlays/context-viewer.ts` 的 `ContextViewer implements Component`；constructor 接受 `{ data: ContextViewerData; theme: Theme; getRows: () => number; requestRender: () => void; onClose: () => void }`。既有 `ContextUsageView` 是靜態報表，沒有分類選取／全文狀態，因此新增這個專用元件，不建立泛用 viewer framework。

- 三種狀態：overview、category preview、entry full content；保留 overview 選取 key／offset、category 的 selected entry／offset，以及 full-content scroll。只有 overview 的 Esc 呼叫 onClose，其餘先 Back；重開另一個分類從頂端開始，從全文返回則回原 entry 與 offset。
- Overview 寬視窗為左 map／右分類列表；以 16×16 為 requested geometry，依可用寬高縮小而不裁掉部分 map。至少保留右側 32 columns；inner width < 52 時只顯示列表，52–71 無格間距，≥72 可加格間距。高度不足先移除額外 map 說明，再讓列表捲動；分類不能因 map 而無法選取。
- System Prompt 等頂層分類維持指定順序；僅 Tool Output 在 overview 直接顯示一層 per-tool 子列。每個工具顯示 tokens 與占 context window 的百分比。Buffer/free dim 顯示但不可選取。
- 重用 `components/menu-selection.ts` 的 `MenuSelection`（disabled-row skip／stable keys）、`chrome/selector-helpers.ts` 的 `clampSelection()`／`renderScrollableList()`，不複製 Pi 的 ListNavigator。Overview row renderer 自行處理縮排、顏色與數值欄。
- 單筆分類直接開完整內容；多筆分類顯示依時間的可選取區塊，每個 preview 上限用 `PREVIEW_LIMITS.OUTPUT_EXPANDED`，並依剩餘高度縮小。超出的內容標記可進入全文，不刪減 model 裡的原文。較短項目 Enter 不必再開重複層級。
- 區塊選取使用 MenuSelection，viewport 使用既有 `ScrollView` 的 `setLines()`／`setHeight()`／`revealRange()`／`page()`／`scrollToTop()`／`scrollToBottom()`；以 entry 的 row ranges 保留選取與最小捲動。選到高於 viewport 的區塊時先在區塊內逐行捲動，抵達邊界才移動到下一筆。需要的「區塊邊界 → ScrollView」轉接放在 viewer 內，不再造一套 scroller。
- 鍵盤路由重用 OMP `matchesSelectUp/Down/PageUp/PageDown/Cancel`、`matchesKey()` 並支援 j/k、Home/End、Enter；z 只在 overview 且 fit scale < window、map 可見時有效。實作 `capturesInput(data)`，只對當前 view 確實處理的鍵回傳 true，讓 Esc/Back 先走 focused component，而不是誤入 app interrupt。Zoom 不改分類數字或百分比；視窗縮放後重算 wrap／viewport，clamp 選取與 offset。
- 全文重用 ScrollView 的 line/page/home/end；保留完整已保存的文字，不追蹤工具輸出中提及的 artifact 檔案去另外載入內容。空分類顯示 `No content in this category.`，Esc 可返回；全空 session 仍可選取有載入內容的靜態分類。
- 內容與來源標籤先經 `sanitizeText()`、`replaceTabs()`；標頭路徑用 `shortenPath()`，內容中的 home paths 用同一中央模組的 `shortenEmbeddedPaths()`。列表與單行錯誤用 `truncateToWidth()`／中央截斷常數，完整內容用既有 wrap helper 與 viewport，而非永久截斷。先 sanitize 再套 theme，不能把來源 ANSI 當成 UI styling；上述轉換只影響顯示，不改原始內容或 token 估算。
- 實作 `render(width)` 與 `describe(cx)` 共用相同 selection/state／entry 資料。Native 使用 `selectList()`、`actionButton()`／`hintsRow()`、`col/row/text`；`handleNativeEvent` 的 select／activate/action 對應同一套選取、Enter、Back、Zoom 操作，key 使用 category/entry ID。Full preview native scroll requests 用既有 `{ by, n }` 協定，Back/Close 的事件語意與 Esc 相同。不得讓 native 使用者只能看到靜態文字、卻無法選取或返回。
- `invalidate()` 清除寬度／theme／node caches，不讀取 session 或重新 tokenize。每次操作只更新當前視圖；sanitized／wrapped 內容依 entry、width、theme 快取，不在每個按鍵重建整段對話。

### 5. 接上 `/context` 與既有關閉生命週期

**修改：** `packages/coding-agent/src/modes/controllers/command-controller.ts` 的 `handleContextCommand()`。保留目前沒有可用 model/window 的 warning，其他情況呼叫 `buildSessionContextView()` 並建立 ContextViewer；`builtin-session.ts` 與 InteractiveMode 的既有 forwarding 不需要新增指令或變更簽名。

不能直接把新 body 傳進現有 `showCommandReport()`：`ReportPanel.handleInput()` 不轉送給 body，且短報表會 dock 並把 focus 留給 editor，這會讓 Enter／方向鍵／Back 無效。

- ContextViewer 自己成為 focused overlay root。沿用同一個 `#reportSheet` 欄位與 `#clearReport()`、`#closeReportSheet()`、`clearCommandReport()`，不另建 overlay stack／session reset 訂閱。
- 開啟前清除舊 docked report、關閉舊 report sheet；建立 viewer 的 `onClose` 為現有 `#closeReportSheet()`。
- ANSI 使用既有 `ui.showOverlay()`，options 為 `anchor: "bottom-center"`、`width: "100%"`、`maxHeight: "100%"`、`margin: 0`、`fullscreen: true`，並 `ui.setFocus(viewer)`。互動 viewer 不走短 report dock 分支。
- Native 使用相同 overlay stack，保持目前 report 的 90% width/maxHeight、center anchor；viewer 的 `nativeOverlay` 設 `role: "omp.overlay.report"`、`size: "lg"`，以免破壞現有 native sheet 及 reset/replacement contract。不要再包一層 ReportPanel 攔截輸入。
- 開另一個 report 時既有 `showCommandReport()` 會取代同一個 sheet；session/transcript reset 走 `clearCommandReport()` 關閉 viewer。回到原 editor focus，不修改 transcript 或 abort 正在執行的 turn。
- 非 TUI 的 `buildContextReportText()` 維持現有文字報表；不新增 `/context injections`、`/context config` 或 provider payload 模式。

## Critical files & anchors

以下是跨層、容易漏掉的接點；行號只供定位，實作前重讀：

| 檔案／symbol | 為何重要 |
| --- | --- |
| `packages/coding-agent/src/system-prompt.ts`：`buildSystemPrompt()`，尤其 filteredSkills 與 projectPrompt 組裝 | 來源必須來自已完成的實際 build，不能在 viewer 重跑 discovery／render。 |
| `packages/coding-agent/src/sdk.ts`：`rebuildSystemPrompt`，initial build，固定／callback prompt branches | 初始 metadata 需傳進 session，opaque replacement 不能保留過期歸屬。 |
| `packages/coding-agent/src/session/session-tools.ts`：`#applyActiveToolsByName()`、`#prepareBaseSystemPrompt()`、`setBaseSystemPrompt()` | Prompt 與 metadata 必須同時提交，避免 cancelled/frozen rebuild 顯示未生效內容。 |
| `packages/tui/src/overlays/report-panel.ts`：`handleInput()` | 這是不能只替換報表 body 的原因；新 viewer 必須掌握自己的 focus/input。 |
| `packages/coding-agent/src/session/messages.ts`：`convertToLlm()`／`convertOne()` | 處理 custom／hook／fileMention／summary 等 OMP 訊息時重用純轉換，不誤入 extension context pipeline。 |

## Verification：功能驗證與驗收證據

### Contract tests

依既有 Bun test 與 TempDir／isolated Settings 慣例撰寫；不要用 `mock.module()`、source grep、prompt boilerplate snapshot 或固定色碼／行號斷言。若受影響的既有測試只是固定文案／排版，刪除該 incidental assertion，不重新 pin 新措辭；保留有消費者行為意義的邊界與生命周期測試。下列 `context-view.test.ts`、`context-viewer.test.ts`、`context-map.test.ts` 是計畫中的新檔案，其餘是現有檔案：

- `packages/coding-agent/test/modes/context-view.test.ts`：以真實 AgentSession 資料建立 viewer model。空 messages 配 instruction、skill、builtin tool、custom tool，確認可取得來源預覽；同一 assistant 內含 text/thinking/toolCall，確認進入不同分類且不重複；兩個工具、同工具多個 results，確認分組、最大輸出排序、call ID 與時間順序；custom/developer／summary／excluded execution 有明確歸屬；opaque prompt 不沿用舊 sections；來源含控制字元時資料估算與安全呈現分離。
- 延伸 `packages/coding-agent/test/agent-session-context-file-reload.test.ts`：檔案改動後 viewer 開啟本身不讀新內容；走既有 reset/rebuild commit 後才更新。另以 deferred rebuild 加 commitIf/abort 測舊來源不被未提交結果覆蓋，並驗證 session switch 失敗 rollback 會恢復舊 prompt 與舊來源預覽。
- `packages/tui/test/context-viewer.test.ts`：用 Component 的真實 input／native event 與渲染／describe 路徑，證明 per-tool row → 指定 output → 全文 → Back 回原位置；單筆直接全文、多筆長輸出、翻頁抵達首尾、buffer/free skip、空分類、z 前後數字不變、width-only／height-only resize、ANSI／tabs 不破壞畫面。測原文尾端 sentinel 可捲動到，不能只檢查「非空」或 render() 有跑。
- `packages/tui/test/context-map.test.ts`：小分類共格、window/fit scale、buffer/free 非負與未知 window；同一輸入 zoom 後估算值不變但 cell resolution 變化，總量不含 tool children。
- 延伸 `packages/coding-agent/test/issue-4806-command-output.test.ts`：保留既有其他 report dock／streaming 行為；驗證 `/context` 在 ANSI/native 都取得 focus、Back 不關 overlay、Close 回 editor、新 report 替換、session reset 關閉。透過 config 的 `transformContext`／`onPayload` counters、`agent.addBeforeModelCallHook()` 與操作前後的 session messages 比較，證明瀏覽不執行 context pipeline、不開始模型請求、不修改對話，而不只測呼叫了 adapter。

所有命令在 `D:/omp/oh-my-pi` 執行，前提是現有 Bun workspace dependencies 和平台 native bindings 可用。功能完成後的 focused commands：

```text
bun test packages/coding-agent/test/modes/context-view.test.ts packages/coding-agent/test/modes/context-usage.test.ts packages/coding-agent/test/agent-session-context-file-reload.test.ts packages/coding-agent/test/agent-session-tool-rebuild-skip.test.ts packages/coding-agent/test/issue-4806-command-output.test.ts
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/tui/test/usage-native-describe.test.ts packages/tui/test/report-panel.test.ts
bun test packages/coding-agent/test/system-prompt-template.test.ts packages/coding-agent/test/system-prompt-context-dedup.test.ts
```

抽取 prompt partial 的前後，以 throwaway probe 使用相同 build inputs 比較生成的 blocks bytes，涵蓋 stock、custom prompt、append text、imports 展開與空 skills；這是防止無關 prompt/cache-prefix 變動的比較，不加入永久「預設文案必須長這樣」測試。

### 實際 TUI smoke：必須操作 changed path，不以測試通過代替

一般終端在 repo root 執行 `bun run dev -- --no-session`；或使用 `xd://tui` 的真實 PTY：

```json
{"op":"start","name":"context-view-empty","args":["--no-session"],"cols":100,"rows":36}
{"op":"type","name":"context-view-empty","text":"/context"}
{"op":"keys","name":"context-view-empty","keys":"enter"}
{"op":"text","name":"context-view-empty"}
```

- 尚未送任何訊息就能進入 System Prompt／Instruction Files／Skills／Tools；選取、Enter、Esc 都在 viewer 內生效，未發送模型請求。
- 切換到 48×18、100×24，再回 100×36：分類仍可操作、map 不擠掉列表、選取與全文 offset 合法。
- 帶資料情境建立暫時 entry `packages/coding-agent/.context-view-smoke.ts`：沿用 `test/issue-4806-command-output.test.ts` 的隔離 AgentSession／Settings fixture，先裝入 Message-shaped entries，再呼叫正式 `buildSessionContextView(session)`。依 `packages/tui/examples/debug-demo.ts` 的 `new TUI(new ProcessTerminal())`／`setFocus()`／`start()` 方式，將真正的 ContextViewer 作為 focused overlay 顯示；不以 mock renderer 取代 UI。Fixture 包含同一工具三筆輸出、一筆超過數頁且末行為 `context-output-tail`、另一個工具輸出、assistant text/thinking/call，以及 tabs／ANSI／長單行。使用 `{"op":"start","name":"context-view-results","file":"packages/coding-agent/.context-view-smoke.ts","cols":100,"rows":36}` 啟動，真實按鍵選取某筆、翻到 sentinel、Back，觀察原選取／位置；Esc callback 呼叫 `ui.stop()`、dispose fixture session，然後退出。正式 `/context` 指令入口則由上面的實際 CLI 空對話 smoke 與 InteractiveMode integration tests 證明。
- 在 native rendering 對同一 fixture 檢視 `describe` tree，送 select／activate／Back／scroll events，確認同一筆內容與 lifecycle；可用 Tern 時再實際點選。只有 headless native describe/event 證據時明確報告尚未做 Tern 視覺驗證，不冒稱已看過原生畫面。
- 觀察 screenshot／text、focus 和 session 訊息數／hook counters 後才記錄通過；最後關閉 PTY。`--smoke-test` 只驗 workers/CLI，不當成此 viewer 的驗收證據。

## Assumptions & contingencies

- 採用指定十二列順序；十個內容分類即使為零仍保留，buffer/free 固定尾列且不可選。Custom Tools 包含所有非 builtin 來源，沒有額外 MCP 頂層分類。
- 採用 memory-only、view-open-time 的顯示資料；開啟時不重新讀取 sources、不持續追蹤新訊息。需要更新就關閉再開；session reset 直接關閉。
- 遇到任意 prompt replacement／自訂 template 無法可靠拆分時，完整內容保留在 System Prompt，顯示一條一般 attribution notice；不以猜測補分類，也不阻擋其他資料瀏覽。這是歸屬精度的降級，不改成 provider capture 或重新執行 hooks。
- 模型不可用時沿用現有 `/context` warning；dependencies/native bindings 不可用時記錄缺少的 prerequisite。
