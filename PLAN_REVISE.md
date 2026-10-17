# `/context` Viewer 修正計畫：沿用 main 的 Map／Legend 契約

## 1. 目標與目前狀態

本輪工作是修正已存在的互動 viewer，不是重新實作 `/context`。優先恢復 main 的核心視覺契約：**左側 map 的分類圖標與顏色，必須在右側各分類列有同源、可辨識的圖例。** 保留目前的互動、細分類資料、fractional occupancy、Window／Fit scale 與 responsive geometry。

本計畫重寫只修改 `PLAN.md`；以下實作項目尚未完成。不要把前一輪「測試通過」當成 map／legend 已符合需求，也不要再把只替換 map 字元記成修正完成。

### 已有、應保留的實作

- Commit `39e6b0d525` 已包含 session 分類 adapter、prompt source metadata 提交／rollback 生命週期、ANSI／native viewer 及 `/context` 入口。
- `packages/tui/src/chrome/context-map.ts` 已提供 `buildContextMap()` 與 `fitContextMapScale()`；本輪不改其占用算法。
- Viewer 已有 overview → category preview → full content 的導覽、返回位置、完整內容捲動與 overlay focus 生命週期。
- 前一輪未提交的 glyph 修正仍在 working tree，但不是本輪的設計基準；需替換其中重複的視覺定義，而不是再疊一份 mapping。

### 使用者已指出、必須處理的缺口

1. 沒有先回查 main，便在 viewer 內自行新增 `CELL_*`、`MAP_STYLES` 與圖標字面值。
2. 右側 System Prompt、Skills、Tools 等列只有文字／數值，缺少對應 map 的圖標；只有整列染色不算 legend。
3. ANSI 與 native 分別拼裝 map／分類列，沒有維持 main 的同源圖例契約。
4. 前一輪測試只證明挑選的字元出現在畫面，沒有證明右側圖例能解釋左側 map；這個驗收缺口必須補上。

## 2. 已查證的 main 基準

查證時本地 `main` 與 `origin/main` 都指向：

```text
2b722296cdbd42e818806d3fceab6b3fdd8724cf
```

已讀取 `git show main:packages/tui/src/status-line/context-usage.ts`。`theme/symbols.ts` 與 `theme/theme.ts` 相對 main 的 diff 為空。

### 不可混淆的事實

- 這個 main 版本的 context map 確實在 `context-usage.ts` 內定義 `CELL_FILLED`、`CELL_FILLED_MESSAGES`、`CELL_FREE`、`CELL_BUFFER`，不是經 map 專用的 theme symbol keys 取圖標。
- main 的正確做法是 **category 同時持有 `glyph`／`color`，map 與 legend 共用它們**，而不是每個 renderer 自己決定圖標。
- OMP 已有中央 symbol registry 與 theme override 機制，但現有 context map 尚未接上。不能宣稱 main 已有不存在的 `context.map.*` keys。
- 因此本輪要保留 main 的視覺與同源資料流；若要消除 renderer 的字面值，應接入既有 symbol 機制並集中遷移，不是在 viewer 複製 main 常數，更不是另造圖標系統。

### 應直接沿用的接點

| 接點 | main 已有的行為 | 本輪應沿用的契約 |
| --- | --- | --- |
| `computeContextBreakdown()` 的 category 定義 | 每個分類有 `glyph`、`color`、label、tokens | 顯示身份只定義一次；不在 map／legend 各自重建 |
| `planCells()` | 使用 category 的 glyph／color；free 是 dim，buffer 是 warning | 保留 cell → 分類樣式的做法，不恢復舊 rounding 算法 |
| `buildLegendParts()` | 每個分類列前先放 `{ t: category.glyph, s: category.color }` | 互動列表也必須有同源圖例，不能只染整列 |
| `buildLegendLines()`／`describeContextUsage()` | ANSI 與 native glyph-grid legend 共用 styled parts | 共用語意與樣式，再分別輸出 ANSI／native |
| `contextShareRow()`／`describeContextFrame()` | Native meter 的分類、free、buffer 也有對應 swatch | 不可因 native 使用不同呈現就省略圖例；保留既有 meter 路徑 |
| `theme/symbols.ts` | `SymbolKey`、unicode／nerd／ascii presets | 所需圖標集中於既有 registry；不在 viewer 寫 literal glyph |
| `Theme.symbol()`／`Theme.styledSymbol()` | 取用當前 theme 的符號及色彩 | 使用實際 API 名稱，不另建 symbol resolver framework |
| `activeThemeSymbol()` | 無 Theme 參數時讀取 active theme，未載入時用 ascii preset | 沿用既有無 Theme 參數的 lookup 入口，不為取圖標改 session API |

Main 的原有分類色彩：System Prompt → `accent`、System Context → `customMessageLabel`、System Tools → `warning`、Skills → `success`、Messages → `userMessageText`。保留其既有視覺語彙。不要把前一輪自行挑選的 `⛀`／`⛂` 或新的色彩分配視為已核准設計。

## 3. 範圍與不變條件

### 本輪只處理呈現

主要檔案：

- `packages/tui/src/status-line/context-usage.ts`
- `packages/tui/src/overlays/context-viewer.ts`
- `packages/tui/src/theme/symbols.ts`
- 對應的 TUI contract tests

若需讓兩個 renderer 共用 main 的既有視覺定義，可抽出一個小型 context presentation 模組，放在既有 `chrome/` 領域中。只抽取／擴充分類樣式與圖例資料，不建立通用 viewer framework；不讓純計算的 `context-map.ts` 依賴 Theme、ANSI 或 native nodes。

### 不重做已完成的功能

- 不更動 session 分類 adapter、prompt source metadata、prompt templates、tokenizer、tools wire schema 或 provider policy。
- 不重新分類 status line、ACP 文字報表或 extension API 的統計資料。
- 保留既有 public function signatures；若調整 exported 型別或接點，實作前先用 LSP references 列出並遷移所有 callers，不留相容別名或第二套路徑。
- 不改 `buildContextMap()` 的 major-overlap／full／partial 判斷；full／partial 不新增不同的繪製字元。
- 不改 Fit 的估算總量 × 115%、兩位有效數字向上取整、10k floor、window cap。Zoom 只改 map 比例，不改任何分類數字或百分比。
- 不以 main 舊版的每類至少一格／rounding 計算取代現有 fractional occupancy。
- 不新增模型請求、context transforms、payload hooks、檔案重讀或 session 寫入。

### 保留十二列與既有內容契約

順序固定為 System Prompt、Instruction Files、Skills、Built-in Tools、Custom Tools、User Messages、Assistant Messages、Assistant Thinking、Tool Calls、Tool Output、Auto-Compact Buffer、Free Space。

十個內容分類的既有 category IDs 不變；零用量列仍顯示。只有 Tool Output 展開一層 per-tool 子列，map 只計頂層 totals，不重複計入 children。Buffer／free 不可選取。所有分類與 per-tool 百分比仍以真正 context window 為分母；OMP usage 與 Estimated content 保持分開顯示，不縮放數字硬湊。

## 4. 實作順序

### A. 集中既有視覺來源，不再複製常數

1. 從 main 的 category glyph／color、buffer／free 定義及 `buildLegendParts()` 抽取可共用的最小呈現資料；保留目前靜態 report 的語意與色彩。
2. 圖標取用接入現有 `SymbolKey`／presets／Theme override 機制。缺少的 context keys 在 `theme/symbols.ts` 集中加入，三種 presets 都要有合理定義；保留 main 對應 preset 下的熟悉視覺，不自行換一組圖案。
3. 共用分類樣式只引用 symbol key 與 ThemeColor。Viewer、map renderer、legend renderer 不存放 raw glyph literals，也不各自保存同一張 category-style table。
4. 保留五大類與細分類之間的顯示對應：System Prompt、Instruction Files、Skills、Built-in Tools、User Messages 沿用其原本語彙；其餘細分類只擴充這個中央呈現來源。不要為區分十個分類強迫引進十個全新符號；識別方式是同源的圖標與色彩配對。
5. 清除前一輪 viewer-local 的 `CELL_*`、`MAP_STYLES`、臨時預設樣式與任意圖標定義；不要同時保留舊 mapping 和新 registry。
6. 圖標在 render／describe 時依有效 theme 解析；invalidate／theme 切換後更新兩側，不把已解析字串凍結在 session snapshot 中。無 Theme 參數的既有路徑使用 `activeThemeSymbol()`，不另造全域 theme cache。

### B. 把右側分類列表恢復成可互動的 legend

1. 每個頂層分類列都包含：選取指示、對應 map 的圖標、分類名稱、tokens、百分比。選取指示不是分類圖標，兩者不能互相取代。
2. 圖標的 glyph 與 theme color 必須和該分類的 map cell 完全一致，兩側讀取同一份已解析的樣式；不以左右兩份 mapping「剛好相同」替代共用。
3. 沿用 main 的 styled-parts 作法：圖標依分類色彩著色，label／tokens／percent 保留各自可讀層級。選取或 disabled 樣式不可把分類圖例的色彩覆蓋掉。
4. Tool Output 的 per-tool 子列保留縮排，使用 Tool Output 的圖例身份；不能為每個工具建立新的 map 分類，也不能因 tool name 不在頂層 style table 而落到 System Prompt 的預設樣式。
5. Buffer 與 free 兩列同樣有對應 map 的圖標；buffer 圖例維持 warning，free 圖例維持 dim。不可選狀態由選取邏輯與文字樣式表達，不抹掉其圖例身份。
6. 零用量分類仍有圖例，即使目前沒有任何 map cell 被分配給它。窄螢幕隱藏 map 時，列表仍保留圖標。
7. Layout 以 `visibleWidth()`、`truncateToWidth()` 等既有 helpers 計量當前 symbol 的真實寬度，不假設每個 preset／override 都是一個 cell。扣除選取欄、縮排、圖標與數字欄後才截斷 label。
8. 保留既有 map／list responsive 規則：寬畫面左右排列，至少保留列表空間；不足寬度只顯示列表；高度不足時列表可捲動。新增圖標不能造成溢出或讓 category 無法操作。

### C. ANSI／native 使用同一個 legend 模型

1. ANSI 的 `#overviewLines()` 與 native 的 `describe()` 都消費同源的分類／buffer／free 呈現資料，不各自選 icon 或 color。
2. Native 保留 `selectList()` 與原有 item keys、disabled、select／activate 事件；在 item 的實際可見內容中放入帶樣式的圖例，不只把 glyph 塞進無色的 label，也不加一張與互動列表分離的重複 legend。
3. Native node 的具體組裝沿用現有 `text`／spans／row 以及 `contextShareRow()` 的 swatch 作法，依既有 TSP item 契約實作；不猜測或新增協定欄位。
4. Map 的 native spans 與 ANSI 著色都使用同一個分類 style resolution；保留 buffer／free 與 spacing 的意義。
5. 靜態 `ContextUsageView`、native meter 與 glyph-grid fallback 不失去原有 legend／swatch。不要為了修新 viewer，改壞既有 report、snapcompact 顯示或其公開入口。
6. 導覽、全文、Back／Close、返回 offset、overlay replacement／reset 與 editor focus 不變。

### D. 以使用者可見契約驗收

前一輪新增的「硬寫十組字元／顏色，再檢查整個畫面包含它們」測試不應當成新契約延續。替換為以下行為驗證，不再 pin 任意新圖標、固定色碼或固定行號。

- **Map ↔ legend 對應：** 各分類有非零且足夠的用量時，同時定位該分類的 map cells 與右側列，驗證其 glyph／color 一致；ANSI、native 都要檢查實際圖例，不只掃全畫面找字元。
- **Theme override：** 用隔離的真實 Theme／symbol overrides，讓代表性的圖標有可辨認的不同內容；確認 map 與右側列一起改變，能抓出 renderer 偷用硬編碼常數的回歸。切換／invalidate 後也要一起更新；避免污染其他測試的全域 theme。
- **主要分類與 partial：** Mixed／partial cell 仍顯示主要分類的同源圖標，不變成另一種 full／partial 繪製樣式；不重測 helper 已覆蓋的占用數學。
- **非內容列：** Buffer／free 的 map 與右側圖例一致且仍不能選取；disabled 不抹掉 buffer 的 warning swatch。
- **零用量／per-tool：** 無 map cell 的零用量列仍有圖標；per-tool 子列承接 Tool Output 圖例、不落入其他分類、不重複計量。
- **Layout 邊界：** 有間距／無間距／map 隱藏三種分支，以及較寬的實際 symbol override；圖標不被截掉、行寬不溢出、數字仍可讀、選取有效。
- **既有互動：** 保留分類 → 單筆全文／多筆預覽 → 尾端 sentinel → Back 的行為驗證；Zoom 不改數字、buffer/free skip、resize 後選取／offset 合法。
- **既有報表：** 靜態 ANSI legend、native glyph-grid legend、native meter swatch 保持與相應可視化一致，不靠 source grep 或 constructor-copy assertions 驗證。

## 5. 驗證命令與實際 UI

### Focused tests／checks

```text
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/tui/test/report-panel.test.ts
bun run check:ts
bun check
```

若 symbol registry 的型別或 preset 契約受到影響，加入既有 theme／symbol focused tests。若需要更動 `/context` 入口或 lifecycle，才擴大到 coding-agent 對應 tests；不要無故重跑 prompt builder／session metadata 改造。

`usage-native-describe.test.ts` 已知有本機 `pm`／「下午」locale assertion failure。保持其與 viewer 回歸分開記錄；不要為 map 修正修改 locale 或重 pin 文案，也不要把該已知失敗隱藏在總數裡。

### 真實 UI smoke 的必要畫面

1. 正式 CLI 以 `--no-session` 開 `/context`，觀察左 map 與右分類圖例同時出現；System Prompt、Instruction Files、Skills、Tools 兩側對應可辨認。
2. 有內容的隔離 session fixture 覆蓋 assistant text／thinking／call、多個工具結果與長輸出，不能只用空對話驗十個分類的視覺。
3. 操作 Window／Fit，確認兩側身份不變、tokens／百分比不變；小分類沒分到 cell 時右側圖例仍存在。
4. 在 48×18、100×24、100×36 操作分類、返回、resize；另外檢查無 map 的窄畫面仍有分類圖標。
5. 在不同既有 symbol presets／至少一個 override 下檢視實際畫面，確認沒有只更新 map 或只更新 legend。
6. 進入工具輸出全文並捲到尾端 sentinel，Back 恢復選取／位置，Close 回 editor focus；確認模型 request、context transform、payload hooks 為 0，messages 未改動。
7. Native describe／select／activate／Back 需驗證帶圖例的實際 item，並保留完整內容。可用 Tern 時檢查真實原生畫面；只有 headless 證據就明寫未做 Tern 視覺驗證。
8. 保存 screenshot／text、symbol preset、尺寸、focus 與 counters 的觀察結果。`--smoke-test` 的 worker probe 不替代本項驗收。

Windows 若 `xd://tui` 因 `/bin/sh` 不存在而無法啟動，使用真實 PTY 加 `OMP_TUI_DEBUG`／Windows IPC，走既有 debug input path。等待 paint 後才讀畫面；不要把 service stdin 自動附帶的 Enter 誤認為送出了單一按鍵。移除所有 smoke 暫存檔並停止本輪啟動的服務。

## 6. 歷史證據與本輪完成條件

### 歷史證據：不是本輪通過證明

- 初始 checkpoint：coding-agent focused tests 112 pass；TUI viewer／map／usage／report 50 pass；先前完成多尺寸 PTY、全文尾端、Back／Close、focus 及無 request／hooks／session mutation 驗證。Prompt partial 五種輸入 bytes 相同。這些工作保留，不重做資料層。
- 前一輪 glyph 修正：四個 TUI test files 合計 52 pass，`bun run check:ts` 全 workspace 通過；完整 `bun check` 的 Rust 部分被 `opusic-sys` CMake 找不到 Ninja 擋住。
- 前一輪真實 CLI／PTY 120×40 已觀察 Window／Fit、分類預覽、Back／Close 與 editor focus；沒有證明右側圖例完整，也未做 Tern 視覺驗證。**因此不得標記 map／legend 修正完成。**
- 本次重寫計畫已完成 main 原始碼與現況比對；沒有修改實作、沒有執行新的 runtime 驗證。

### 所有條件成立後才可標記完成

- [ ] Map 與右側十二列都有對應圖例；per-tool 子列身份正確。
- [ ] 靜態 report、新 viewer、ANSI／native 使用單一 context 呈現來源；viewer 沒有另一份 literal glyph／palette table。
- [ ] 使用既有 symbol/theme 機制，preset／override／invalidate 不會使兩側失配。
- [ ] Fractional occupancy、Fit、responsive geometry、分類資料與 session metadata 沒有被重做。
- [ ] 行為測試、type check 與真實 UI smoke 有本輪的新證據；locale、Ninja、Tern 限制各自明確記錄。

PR 前補受影響 package 的 `[Unreleased]` changelog；外部貢獻待取得 PR 編號後補 PR link 與 contributor credit。不要修改已發布版本的 changelog。未經明確指示，不 commit、不 push、不建立或更新 PR。
