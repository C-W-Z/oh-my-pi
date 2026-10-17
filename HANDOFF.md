# Context Viewer 工作交接

## 目前狀態

- Branch：`feat/context-viewer`；排版變更的本地 commit 為 `f258e6d4f5`，未授權 push。開工先檢查 Git 狀態；本次僅更新交接文件，未另行授權 commit。
- 已實作：原版容量分攤、總覽 Compaction／Snapcompact 診斷、footer 分隔線、ANSI entry 全區塊左框；共用 theme 彩色括號標題與暗色 token 數、Instruction Files 單一路徑標題、選中限定的內容提示與 thinking block 編號。兩個 package 的 Changelog 已更新。**Request 資料來源 cutover 與真實 skill description 的長文字換行仍未完成。**
- **Native 多行 entry 左框尚未實作；Native 畫面尚未在 Tern 原生窗口驗收。** 不是「功能完成，只差測試」。
- Native 保留 `list/item` 選中樣式與 entry id／select／activate 事件。使用者尚未決定暫緩此項或接受兩端外觀不同，不自行縮減需求。

## 下一步

1. 讓 Context Viewer 與真正送出流程共用 request preparation 的結果；不要在 viewer 補一套 abort／resume／rewind／thinking 篩選規則。具體缺口與邊界見下節。
2. 定位並修正真實 skill description 超長後以 `...` 結尾、沒有換行繼續顯示的問題；使用者已確認仍存在，不重跑檢查來質疑此回報，也不宣稱已修復。
3. 研究 Tern 現有元件組合能否呈現多行 entry 與整塊左框，不預設必須修改 renderer。
4. 現用 [item](https://docs.stencil.so/tern/elements/lists.md#item) 不換行、detail 截斷、children 被忽略；[common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes) 的 `mark: "pick"` 可作研究入口，但不能視為已可達成。
5. 取得 Tern 環境驗收總覽、分類、全文、選取／啟用、Esc、resize 與 footer；節點／事件測試不能取代視覺驗收。
6. 若現有能力確實不足，再向使用者提出 renderer 擴充或差異方案。未授權 push、PR、對外發文或邀測。

## Request context 資料來源（未完成）

- 目前 `packages/coding-agent/src/session/context-view.ts` 的 `buildSessionContextView()` 讀取 `session.systemPrompt`、`session.agent.state.tools` 與 `session.messages`；assistant message 刻意跳過 `convertToLlm`，保留原始 blocks。因此 viewer 並不等同模型實際收到的內容，不能只因為讀的是 active state 就宣稱正確。
- 真正送出流程在 `packages/agent/src/agent-loop.ts` 的 `prepareProviderCall()`：依序執行 `transformContext`、`convertToLlm`、normalization、`transformProviderContext` 與 dialect 處理；之後仍有 provider-specific 編碼／replay 與 payload hooks。只共用 `convertToLlm` 或只看 session state 都不足以保證與最終 payload 一致。
- 修正方向是送出流程與 viewer 共用準備好的 context snapshot，viewer 只負責分類、排版與瀏覽，內容與 token 估算採用同一份資料。保留 prompt 來源追蹤，不得以歷史 transcript 冒充目前送出的 context。
- 開啟 viewer 必須維持唯讀，不能為預覽重跑有副作用的 hooks、執行工具或發送模型 request；也不能把上一筆已送出的 payload 冒充目前準備送出的內容。尚未送出的預覽與已送出證據必須明確區分。
- abort／resume／rewind 等情境用來驗收共用流程，不是讓 viewer 自行推測內容的分支。最終驗收要比對真正送出的 payload，而不是只證明手工 fixture 有幾個 thinking blocks。

## Skill description 截斷（未解決）

- 使用者確認：真實 skill 的 description 超過一定長度後，尾端變成 `...`，而不是換行繼續顯示。名稱標題與暗色路徑的排版可以保留，但不得把 description 完整顯示列為已完成。
- 需分辨截斷發生於 prompt source／上游 description 壓縮，還是 viewer rendering。研究入口是 `packages/coding-agent/src/extensibility/skill-descriptions.ts` 的 `previewSkillDescription()`／`SkillDescriptionCatalog`、`system-prompt.ts` 的 skill source fragment，以及 viewer 的 preview／full-content 路徑；目前不能預先斷定單一根因。
- 驗收應使用正式 CLI 的真實長 description，確認準備送給模型的內容可依寬度完整換行、尾端可達。不能以合成長字串 fixture 通過取代此項驗收，也不能讀取未送出的 SKILL.md 原文來冒充模型輸入；若實際輸入本身已被壓縮，須明確區分來源截斷與 renderer 截斷，再確認是否需要調整上游行為。


## 不可破壞的契約

- Used／Buffer／Free 沿用 `breakdown`；細分類按 raw estimates 比例分配 Used，保留估算標示，不覆寫 raw estimates 或重複計入 children。Window／Fit 百分比均以完整 window 為分母。
- 唯讀 snapshot：重新開啟才更新；瀏覽不影響背景 turn、focus 或 composer 草稿。
- 正文保留原始路徑並做終端安全處理；只有 metadata／label 可縮短路徑。
- 一般 entry preview 只 wrap 有界前綴；省略數計算未完整呈現的原始行並快取，不完整 wrap 尾端。開全文才完整 wrap，大型多行／超長單行尾部必須可達。Skills 以實際模型輸入為準，不讀取未送出的 SKILL.md 原文來替換；真實 description 的完整換行與尾端可達仍待修復及驗收。
- 保留 oversized entry 先捲動再換項、Enter／Esc 返回位置、空分類及單條目直開全文語意；不簡化 prompt 來源追蹤／rollback，不刪共用 `ContextUsageView`。
- 新增 code comments／文件用中文，technical terms 保留 English；中文字寬 fixture 保留。

## 程式入口與驗證

- `packages/tui/src/overlays/context-viewer.ts`：ANSI／Native rendering、選取與導航；Native 型別見 `packages/wire/src/tsp.ts`。
- `packages/coding-agent/src/session/context-view.ts`：snapshot；共用 map／容量計算見 `packages/tui/src/chrome/context-map.ts`、`packages/tui/src/status-line/context-usage.ts`。
- 下列 focused suite 已通過：**59 pass，0 fail**；`packages/tui`、`packages/coding-agent` 各自的 `bun check` 均通過。只改本文件不重跑程式測試。

```sh
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/coding-agent/test/modes/context-view.test.ts packages/coding-agent/test/issue-4806-command-output.test.ts
```

- 正式 CLI／ConPTY 已驗收總覽、Fit、分類左框／捲動、全文／End、resize、Esc 返回 composer；ANSI 已觀察 100×30、48×18、48×6。Native 未包含在此視覺驗收內。
- 獨立 fixture 的實際 TUI／ConPTY 驗證涵蓋 100×40 的標題／tokens cell 顏色差異、選中提示切換、instruction path 僅一列、合成 skill 全文尾端、三個 thinking entry、Enter／End／Esc，以及 48×18 resize。這不代表正式 CLI 的真實 skill description 已完整顯示，也不是最終 provider payload 一致性的證據；Native 亦未包含在此驗收內。
- 指定 session `2026-10-17T01-19-52-866Z_01a14771-a622-7303-87c6-54babb1f0313.jsonl` 的唯讀調查證據：`7c95448a` 為正常結束的一個 encoded thinking；`012b8a63` 為 `aborted`／`Interrupted by user`，包含 475 字元明文 summary 與另一個 encoded thinking。沒有 compaction，三個 blocks 都仍在原檔與 transcript。Resume 建立 active context 時排除該 aborted turn，viewer 因而只剩一項；將 transcript 交給同一 snapshot builder 則可列出三項。
- 同一 session 的 aborted record 直接經 live `convertToLlm` 轉換時，仍保留帶 signature 的明文 summary 與 encoded block；resume 後則排除該輪。這證明兩條路徑的輸入結果不同，但尚未驗證使用者那次 rewind 的最終 provider payload。模型自稱「看得到」不是 payload 證據；不能概括成所有 aborted thinking 下次都不會送出，也不能把減少完全歸為「與 viewer 無關」。原 session 與 replay 規則均未改動。

## 環境陷阱

- 本機找不到 Tern executable；Windows `xd://tui` 缺 `/bin/sh`，bash PTY 也可能被 CLI 判為非 TTY。
- 可用 `PtySession.startArgv()` 啟動正式 `packages/coding-agent/src/cli.ts`，搭配 `packages/tui/test/virtual-terminal.ts` 觀察畫面。
- 用臨時 agent dir／`config.yml` 的 `setupVersion: 999` 避免 onboarding，不改使用者設定；ConPTY 已處理 terminal 回覆，不再回送 VirtualTerminal CPR replies。
- 已知無關問題：`packages/tui/test/usage-native-describe.test.ts:452` 的 `pm`／「下午」locale 差異，勿為本 feature 修正。
