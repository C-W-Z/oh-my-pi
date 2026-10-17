# Context Viewer 工作交接

## 任務與狀態

- Repo：`D:/omp/oh-my-pi`；branch：`feat/context-viewer`。
- 本文件更新前的 HEAD：`a16a069df4`（`docs: update HANDOFF.md`）；本次開工檢查工作區 clean。下個 session 仍須先檢查 Git 狀態。
- 現有互動式全螢幕 `/context` 已實作；**下列改版方向已由使用者確認，交由下個 session 實作，不必重新詢問是否採用。**
- 本 session 只更新交接文件，沒有修改 Viewer 程式碼；沒有建立 commit、push 或 PR。不要將以下需求當成已完成。

## 已確認需求

### 1. 原版容量統計 + 新版分類比例分攤

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
- 分攤總和須等於 U；取整建議 largest remainder，餘數相同時依既有分類順序，避免畫面抖動。
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
- `packages/coding-agent/src/session/context-view.ts`：組裝 snapshot；目前 `usage = breakdown.usedTokens`，但 map 使用的細分類總量是 E，`buffer = min(原版 B, max(0, W - E))`、`free = max(0, W - E - buffer)`，**這兩項是待替換的現況，不是目標算法**。
- `packages/tui/src/overlays/context-viewer.ts`：`#legendLine()`、`#mapCells()`、`#canZoom`、`describe()`；ANSI／Native 必須使用一致的分攤結果。
- `packages/tui/src/chrome/context-map.ts`：`planContextMap()`、`contextFitScale()`；沿用共用繪圖能力，不另建第二套 map。

### 2. 診斷資訊整合總覽，移除舊頁面切換

- 新總覽直接呈現原版 Used／Buffer／Free、Compaction threshold 與距離門檻的 tokens；Compaction 關閉或已越過門檻時須如實呈現。
- 啟用 Snapcompact 時保留 estimated savings／wire tokens、相關 prompt／tool-result 資訊及 inactive 原因；原有 wire tokens 為 `max(0, U - savedTokens)`，仍是估算，不稱為實測。
- 移除 Viewer 內的 `diagnostics` 頁面、`d` 快捷鍵、`Usage diagnostics` Native action 及不再需要的狀態／scroll。**不可刪除共用 `ContextUsageView`，它另有用途。**
- 現有 snapshot 已含 `breakdown`，由 `computeSessionContextBreakdown(session, { snapcompactSavings: true })` 取得；優先重用，不重新讀取使用者資料或另算一份診斷。

### 3. Footer 提示列增加上分隔框線

- 比照 `/usage`：在 Viewer 的 body 與 footer 之間加入既有 `PanelDivider`，不改共用元件預設行為。
- 參考 `packages/tui/src/overlays/usage-dashboard.ts`；元件位於 `packages/tui/src/chrome/overlay-box.ts`。
- 高度按實際 summary 行數計算；若 summary 仍為 3 行，固定 chrome 共 7 行，body 為 `terminalRows - 7`。診斷整合可能增加 summary，不能盲目固定此數。
- 同步 ANSI／Native、map、preview 的尺寸預算；極矮畫面須收縮 header/body，不可靠末尾 `.slice()` 截掉 footer／下框。
- Native `describe()` 自行組裝節點，不會沿用 `#panel` children；在 `actionBar()` 前加入 `node("rule")`。總覽、分類預覽、全文共用分隔結構。

### 4. 分類預覽以整個 entry 的彩色左邊框標示選中

- 參考 `../pi-context-view/src/ui/usage-view.ts` 的 `previewStreamLine()`／`blockGutter()`；兩欄 gutter，選中區塊畫 accent `┃ `，未選中保留等寬空白，取代只在首行放箭頭。
- 使用既有 `EntryRange [start, end)` 與 `scrollOffset + visibleRowIndex`，涵蓋標題、metadata、正文、正文內空行與全文提示；entry 間的分隔空行在 range 外。標題捲出畫面後，可見正文仍有左框。
- 先扣 gutter 寬度再準備／render `#previewScroll`，保留右側 scrollbar 欄位；初始化、cache width、`revealRange()`、resize 的寬度須一致，不能加框後才裁掉正文尾字。
- Cache 保留未加選中樣式的行，只為可見行加框；不要為切換 selection 重 wrap 整類，更不能恢復對大型輸出全文 wrap 的做法。
- 保留先捲動 oversized entry 再切換條目、Enter／Esc、返回位置、空分類及單條目直開全文語意。不改成全 Viewer 外框染色，不引入 category focus 配色。
- Native 現在使用 `selectList("entries", …)` 的 `selected`／`item.detail`，由 Tern 繪製；TSP common／list／item 無專用 `borderLeft`。不得假造欄位，也不能以 `tone: "accent"` 或節點測試代替視覺驗收。保留 entry id 與 select／activate 事件；實際 Tern 若不支援整塊左框，須釐清 renderer 變更，明確報告限制。

## 必須保留的既有行為

- 唯讀 snapshot：開啟時取樣，重新開啟才更新；瀏覽不影響背景 turn、focus、composer 草稿。
- 正文經 `#safeContent()` 處理終端安全、tabs／換行，**完整保留原始路徑**；metadata／label 可縮短路徑，不可把正文 home 路徑改成 `~`。
- `#entryPreview()` 只處理有界前綴；開全文才完整 wrap。大型多行與超長單行的尾部必須可到達。
- System Prompt 來源追蹤與 prompt 原子提交／rollback、失敗 rebuild 已有 coverage，勿順手簡化。涉及 `system-prompt.ts`、`session-tools.ts`、`agent-session.ts`。
- 使用者要求本 feature 的 **code comments／Changelog 用英文**；聊天與本交接文件用中文，字寬測試的中文 fixture 保留。

## 實作驗收

- 分攤守恆、零值／無估算／超額、父子不重複計量、整數餘數與 Window/Fit 口徑；分類標示為估算分配，原版 U／B／F 不被修改。
- 總覽保留 Compaction 與 Snapcompact 必要資訊；舊診斷入口完全移除，共用 `ContextUsageView` 不受影響。
- Footer 上框與下框在 resize 後可見；48×18、極矮畫面、寬字元、長行及 scrollbar 共存時不溢出／裁字。
- 選中 entry 全區塊左框、標題捲出後仍有框、切換不左右跳動、不誤標鄰項；Enter／Esc 返回位置不變。
- 用真正 CLI／PTY 操作新總覽、分類、全文、resize、關閉回 composer；Native 需 Tern 實際視覺驗收，未驗證就明說。元件組合 probe 不能算完整驗收。
- 更新既有 contract coverage；新增測試只保護分攤邊界、導航或可見布局 regression，不測 source text／固定提示文案。
- 更新受影響 package 的英文 `[Unreleased]` Changelog；已有 `packages/coding-agent/CHANGELOG.md`、`packages/tui/CHANGELOG.md`，不要宣稱尚未實作的功能已完成。

相關測試：
- `packages/tui/test/context-viewer.test.ts`：導航、正文路徑／安全、診斷、responsive；診斷測試須改成整合後的行為契約。
- `packages/tui/test/context-map.test.ts`：map／Fit。
- `packages/coding-agent/test/modes/context-view.test.ts`：snapshot、來源、真實 Snapcompact planner。
- `packages/coding-agent/test/issue-4806-command-output.test.ts`：正式入口、focus、草稿、背景 turn 隔離。

## 驗證環境與限制

- 現有版本有相關測試及 package-local `bun check` 通過紀錄；**新方案尚未實作或驗收，不可沿用舊結果宣稱通過。** 本次文件更新未重跑程式測試。
- 已知無關失敗：`packages/tui/test/usage-native-describe.test.ts:452` 預期英文 `pm`，本機 locale 輸出「下午」。勿為本 feature 修 locale 或該測試。
- Windows 下 `xd://tui` 缺 `/bin/sh`；本 session 的 bash `pty: true` 仍被 CLI 判為非 TTY。
- 可行路徑為 `@oh-my-pi/pi-natives` 的 `PtySession.startArgv()` 啟動正式 CLI，配合既有 `VirtualTerminal` 觀察畫面。
- 隔離臨時 agent dir 會進 onboarding；可僅在臨時 config 設 `setupVersion: 999`，不改使用者設定。ConPTY 已處理 terminal 回覆，勿再回送 VirtualTerminal CPR replies，以免字元混入 composer。
- 尚無 Tern 原生窗口的視覺驗收；不能把 Native 節點／事件 coverage 當成已驗收。
- 未授權 push、PR、Discord 發文或其他外部操作；不要擴大重構範圍。`CONTRIBUTING.md:19–26` 有大型 UI／跨 package 功能事前討論要求，程式完成不代表 maintainer 已接受方向。
