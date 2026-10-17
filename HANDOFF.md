# Context Viewer 工作交接

## 任務與狀態

- Repo：`D:/omp/oh-my-pi`；branch：`feat/context-viewer`。
- 程式碼 commit：`2f0bcb125b`（`fix(tui): align context viewer accounting and layout`）。下個 session 仍須先檢查 Git 狀態。
- 互動式全螢幕 `/context`、原版容量分攤、總覽診斷與 footer 分隔結構已實作；ANSI entry 全區塊左框已實作並以正式 CLI／ConPTY 驗收。
- **Native 多行 entry 全區塊左框尚未實作；所有 Native 視覺效果均尚未在 Tern 原生窗口驗收。** 不可將此狀態寫成「Native 左框已完成，只差測試」。
- Native 目前保留 `list/item` 選中樣式、entry id 及 select／activate 事件；是否接受 ANSI／Native 外觀不同、暫緩或放棄 Native 左框，尚無使用者明確決定，不自行縮減需求。
- 既有 commit message 不宣稱 Native 多行左框完成，無須 amend；目前狀態及待辦以本文件為準。未授權 push、PR 或其他對外操作。

## 目前實作契約

### 1. 原版容量統計 + 新版分類比例分攤（已實作）

**決策：** Used／Buffer／Free Space 全部沿用原版統計；新版仍保留所有細分類及內容瀏覽，按本地估算比例分配原版 Used，供 map 與分類 legend 使用。不是退回原版五分類，也不是只保留文字列表。

計算契約：

```text
U = breakdown.usedTokens
B = breakdown.autoCompactBufferTokens
F = breakdown.freeTokens
W = breakdown.contextWindow
e[i] = 新版第 i 個頂層分類的原始估算 tokens
E = sum(e[i])，不重複計入 children 或 entries

分類分攤量 a[i] = U * e[i] / E
分類佔整個 context window 的比例 = a[i] / W
分類佔 Used 的比例 = e[i] / E
```

- Map 使用 `a[i]`、原版 B、原版 F；不要再用 E 重算 Free Space，或用 E 限縮 Buffer。
- 分攤總和等於 U；使用 largest remainder 取整，餘數相同時依既有分類順序，避免畫面抖動。
- 子分類只分配所屬父分類的預算；不要把 Tool Output 的 per-tool children 又加進總量。Map／legend／子分類顯示口徑須一致。
- 保留 raw estimates 與正文，不要覆寫成分攤值而失去估算依據或重複套用縮放。
- UI 清楚標示「分類佔比為估算分配」，不是各類實測值；只保留一套 Free Space／Buffer，不再並列 `Estimated Free Space`／`Estimated Auto-Compact Buffer`。
- 這是假設誤差按各類大小同比例分攤，不代表能精確歸因 thinking、圖片或 provider overhead。
- 處理 E=0、U=0、W=0：不得除零、NaN 或憑空造出分類比例；無法分攤時明示估算不可用並保留原版總量。原版 Used 超過 window 時保留超額資訊，不可為湊成 100% 而改寫 U。
- Window/Fit、zoom 是否可用及 map 分母一併改用相同容量口徑，不能仍拿 E 判斷。Fit 僅縮放視圖，百分比仍以 W 為分母；不要把 Fit 視圖內的剩餘部分當成完整 window 的 F。

**準確度與名詞，避免再次誤解：**
- 原版總 Used 有可用的 provider usage anchor 時，以它為基準加上本地估算的變動／新增內容；無 anchor 時仍是本地估算，不是下一次 request 的精確值。
- **Messages 不是獨立量到的實際值，不能以它作校準基準。** 原版 Messages 是總 Used 扣除其餘四類估算後的餘額。
- Buffer 是策略預留容量，不是另一項 tokenizer 實測；原版 Free Space 已扣除 Buffer。

| 原版分類 | 含義／新版對應 |
|---|---|
| System prompt | 第一個 system prompt block 扣除 Skills 估算；主要對應新版 System Prompt，但切法不完全相同 |
| System tools | 模型可用工具的定義／schema 等；對應 Built-in Tools + Custom Tools，不是呼叫或執行結果 |
| System context | 其餘 system prompt blocks；包含附加 guidance、專案 context 等，新版拆入 Instruction Files 及剩餘 System Prompt |
| Skills | skill 目錄／描述估算，非所有 skill 文件全文；主要對應新版 Skills |
| Messages | 新版 User Messages、Assistant Messages、Assistant Thinking、Tool Calls、Tool Output |

實作入口：
- `packages/coding-agent/src/session/session-stats.ts`：`getContextBreakdown()`、`#anchoredUsedTokens()`；原版 Used 的 provider anchor／增量計算。
- `packages/tui/src/status-line/context-usage.ts`：`computeNonMessageBreakdown()`、`computeContextBreakdown()`；原版分類、Buffer、Free、threshold。
- `packages/coding-agent/src/session/context-view.ts`：組裝唯讀 snapshot；`usage = breakdown.usedTokens`、`buffer = breakdown.autoCompactBufferTokens`、`free = breakdown.freeTokens`，保留 `estimatedTokens`、分類 raw estimates 及正文。
- `packages/tui/src/overlays/context-viewer.ts`：`allocateTokens()` 與 `#allocated` 保存獨立的父／子分類分攤量；`#legendLine()`、`#mapCells()`、`#canZoom`、`describe()` 使用一致的容量口徑。E=0 時顯示估算不可用，不畫分類 map；W=0 時不計百分比、不畫 map。
- `packages/tui/src/chrome/context-map.ts`：`planContextMap()`、`contextFitScale()`；沿用共用繪圖能力，不另建第二套 map。

### 2. 診斷資訊整合總覽（已實作）

- 總覽 summary 呈現原版 Used／Buffer／Free、Compaction threshold 與距離門檻的 tokens；Compaction 關閉或已越過門檻時如實呈現。
- Snapcompact 資訊位於總覽內容區，可捲動查看；重用 `contextSnapcompactLines()` 及既有 formatter，保留 estimated savings、prompt／tool-result 資訊及 inactive 原因。wire tokens 估算為 `max(0, U - savedTokens)`，有節省量時顯示，不稱為實測。
- Viewer 無 `diagnostics` 頁面、`d` 快捷鍵、`Usage diagnostics` Native action 或專用 diagnostic scroll；共用 `ContextUsageView` 保留。
- snapshot 的 `breakdown` 由 `computeSessionContextBreakdown(session, { snapcompactSavings: true })` 取得；總覽直接重用，不重新讀取使用者資料或另算一份診斷。Native 總覽內容包含 keyboard scroll request。

### 3. Footer 上分隔框線（已實作；Native 視覺未驗收）

- Viewer body 與 footer 之間使用既有 `PanelDivider`，不改共用元件預設行為；參考 `packages/tui/src/overlays/usage-dashboard.ts`，元件位於 `packages/tui/src/chrome/overlay-box.ts`。
- `#layout()` 按可用 terminal rows 與實際 summary 行數計算 body 高度；正常 summary 為 4 行，固定 chrome 為上下框、footer 上分隔線與提示列，共 4 行。極矮畫面收縮 summary／body；不足 4 行時保留可容納的框線／提示。
- ANSI map、preview、full view 與 Native 使用相同高度計算入口；48×18、48×6 的 ANSI footer 上下框已由正式 CLI／ConPTY 觀察確認。
- Native `describe()` 在 `actionBar()` 前有 `node("rule")`；總覽、分類預覽、全文共用分隔結構，但 Tern 實際布局與 resize 效果仍需原生窗口驗收。

### 4. Entry 全區塊選中左框（ANSI 已實作；Native 未完成）

- ANSI 兩欄 gutter：選中區塊畫 accent `┃ `，未選中保留等寬空白；參考 `../pi-context-view/src/ui/usage-view.ts` 的 `previewStreamLine()`／`blockGutter()`。
- 使用 `EntryRange [start, end)` 與 `scrollOffset + visibleRowIndex`，涵蓋標題、metadata、正文、正文內空行與全文提示；entry 間分隔空行在 range 外。標題捲出畫面後，可見正文仍有左框。
- 先扣 gutter 寬度再準備／render `#previewScroll`，保留右側 scrollbar 欄位；初始化、cache width、`revealRange()`、resize 使用一致寬度，不靠事後裁字補框。
- Cache 保留未加選中樣式的行，只為可見行加框；切換 selection 不重 wrap 整類，預覽只讀有界前綴。
- 保留先捲動 oversized entry 再切換條目、Enter／Esc、返回位置、空分類及單條目直開全文語意。不使用全 Viewer 外框染色或 category focus 配色。
- Native 使用 `selectList("entries", …)` 的 `selected`／`item.detail`，由 Tern 繪製；保留 entry id 與 select／activate 事件。沒有加入虛構 `borderLeft` 欄位，也沒有以 `tone: "accent"` 充當整塊左框。
- [Tern list／item 文件](https://docs.stencil.so/tern/elements/lists.md#item)明定 `item` 不換行、detail 截斷、children 被忽略；此元件不能直接表示所需的多行 entry 區塊。這不代表所有 Native 元件組合都不可行，也不能直接推論一定要修改 Tern renderer。
- [Tern common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes)與 `packages/wire/src/tsp.ts` 包含 `mark: "pick"`；它是可研究的左側標記能力，不是目前多行 preview 已完成的證據。其他組合仍須保留 entry identity、選取／啟用語意、有界預覽及可達的完整正文，並經 Tern 視覺驗收。

## 必須保留的既有行為

- 唯讀 snapshot：開啟時取樣，重新開啟才更新；瀏覽不影響背景 turn、focus、composer 草稿。
- 正文經 `#safeContent()` 處理終端安全、tabs／換行，**完整保留原始路徑**；metadata／label 可縮短路徑，不可把正文 home 路徑改成 `~`。
- `#entryPreview()` 只處理有界前綴；開全文才完整 wrap。大型多行與超長單行的尾部必須可到達。
- System Prompt 來源追蹤與 prompt 原子提交／rollback、失敗 rebuild 已有 coverage，勿順手簡化。涉及 `system-prompt.ts`、`session-tools.ts`、`agent-session.ts`。
- 使用者要求本 feature 的 **code comments／Changelog 用英文**；聊天與本交接文件用中文，字寬測試的中文 fixture 保留。

## 驗收契約

- 分攤守恆、零值／無估算／超額、父子不重複計量、整數餘數與 Window/Fit 口徑；分類標示為估算分配，原版 U／B／F 不被修改。
- 總覽保留 Compaction 與 Snapcompact 必要資訊；舊診斷入口完全移除，共用 `ContextUsageView` 不受影響。
- Footer 上框與下框在 resize 後可見；48×18、極矮畫面、寬字元、長行及 scrollbar 共存時不溢出／裁字。
- 選中 entry 全區塊左框、標題捲出後仍有框、切換不左右跳動、不誤標鄰項；Enter／Esc 返回位置不變。
- 用真正 CLI／PTY 操作新總覽、分類、全文、resize、關閉回 composer；Native 需 Tern 實際視覺驗收，未驗證就明說。元件組合 probe 不能算完整驗收。
- 更新既有 contract coverage；新增測試只保護分攤邊界、導航或可見布局 regression，不測 source text／固定提示文案。
- 更新受影響 package 的英文 `[Unreleased]` Changelog；已有 `packages/coding-agent/CHANGELOG.md`、`packages/tui/CHANGELOG.md`，不要宣稱尚未實作的功能已完成。

相關測試：
- `packages/tui/test/context-viewer.test.ts`：導航、正文路徑／安全、總覽診斷、分攤守恆／餘數／零值／超額、Window/Fit、左框、寬字元／scrollbar 及 responsive 布局。
- `packages/tui/test/context-map.test.ts`：map／Fit。
- `packages/tui/test/context-usage.test.ts`：共用原版容量計算與 `ContextUsageView` 相關契約。
- `packages/coding-agent/test/modes/context-view.test.ts`：snapshot、來源、真實 Snapcompact planner。
- `packages/coding-agent/test/issue-4806-command-output.test.ts`：正式入口、focus、草稿、背景 turn 隔離。

## 已執行驗證與環境限制

- 對應目前程式碼的 focused suite：**57 pass，0 fail**，涵蓋上述 5 個測試檔。本文件更新不修改程式碼，未重跑程式測試。
- `packages/tui` 與 `packages/coding-agent` 各自的 `bun check` 均通過（lint、format、type checks）。
- 正式 `packages/coding-agent/src/cli.ts` 已透過 `PtySession.startArgv()`／ConPTY 啟動，使用既有 `VirtualTerminal` 觀察總覽、Fit、Built-in Tools 分類、標題捲出後的左框、全文、End、resize、Esc 關閉與返回 composer 輸入。不是只有元件組合 probe。
- ANSI 已觀察 100×30、48×18、48×6；寬字元／長行／scrollbar 與返回位置另有 contract coverage。隔離驗收程序正常退出，臨時 agent dir 已移除。
- 已知無關失敗：`packages/tui/test/usage-native-describe.test.ts:452` 預期英文 `pm`，本機 locale 輸出「下午」。未為本 feature 重跑或修正該測試。
- Windows 的 `xd://tui` 缺 `/bin/sh`，bash `pty: true` 路徑仍可能被 CLI 判為非 TTY；可用路徑為 `@oh-my-pi/pi-natives` 的 `PtySession.startArgv()`。
- 隔離臨時 agent dir 可在臨時 `config.yml` 設 `setupVersion: 999` 避免 onboarding，不改使用者設定。ConPTY 已處理 terminal 回覆，勿再回送 VirtualTerminal CPR replies，以免字元混入 composer。
- 本機 `where.exe tern` 找不到 executable；尚無 Tern 原生窗口視覺驗收。Native 資料／事件／節點 coverage 能驗契約，不能證明畫面、左框或 footer 正確。
- 兩個受影響 package 的英文 `[Unreleased]` Changelog 已描述目前功能；ANSI 左框有明確限定，不宣稱 Native 多行左框完成。

## 下一步：Native 驗收與左框方案

1. 取得可操作的 Tern 環境，或由有 Tern 的協作者驗收目前 Native 總覽數字、Compaction／Snapcompact、選取／啟用、全文、Esc、resize 與 footer。請人測現有 Native 有價值，但不能代替實作多行左框。
2. 先確認 Tern 現有 Native 元件組合能否呈現多行 entry 與整塊左框；不要直接假定必須擴充 renderer。若能實作，保留目前導航／identity／事件與有界預覽契約，並實際驗收。
3. 若現有能力確實不足，再提出具體 renderer 變更或 ANSI／Native 差異方案，由使用者決定是否暫緩此項；目前不把建議當成已確認的 scope 調整。
4. 不 amend `2f0bcb125b` 來掩蓋未完成項；新的程式或文件提交依使用者授權處理，不自行 push、建立 PR、發文或請第三方操作。`CONTRIBUTING.md:19–26` 的大型 UI／跨 package 功能事前討論要求仍適用，程式完成不代表 maintainer 已接受方向。
