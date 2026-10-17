# Context Viewer 工作交接

## 目前狀態

- Branch：`feat/context-viewer`；本任務已授權本地 commit，未授權 push。開工先檢查 Git 狀態。
- 已實作：原版容量分攤、總覽 Compaction／Snapcompact 診斷、footer 分隔線、ANSI entry 全區塊左框；共用 theme 彩色括號標題與暗色 token 數、Instruction Files 單一路徑標題、選中限定的內容提示、可完整捲動的 skill 輸入與 thinking block 編號。兩個 package 的 Changelog 已更新。
- **Native 多行 entry 左框尚未實作；Native 畫面尚未在 Tern 原生窗口驗收。** 不是「功能完成，只差測試」。
- Native 保留 `list/item` 選中樣式與 entry id／select／activate 事件。使用者尚未決定暫緩此項或接受兩端外觀不同，不自行縮減需求。

## 下一步

1. 取得使用者回報的舊 session 去敏結構，定位 thinking 從三個變成一個的原因；需要相關 assistant message 的 `stopReason`、各 content block 的 `type`、thinking 字數與 signature 是否存在，不需要正文或 signature 值。尚未宣稱修復該 session。
2. 研究 Tern 現有元件組合能否呈現多行 entry 與整塊左框，不預設必須修改 renderer。
3. 現用 [item](https://docs.stencil.so/tern/elements/lists.md#item) 不換行、detail 截斷、children 被忽略；[common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes) 的 `mark: "pick"` 可作研究入口，但不能視為已可達成。
4. 取得 Tern 環境驗收總覽、分類、全文、選取／啟用、Esc、resize 與 footer；節點／事件測試不能取代視覺驗收。
5. 若現有能力確實不足，再向使用者提出 renderer 擴充或差異方案。未授權 push、PR、對外發文或邀測。

## 不可破壞的契約

- Used／Buffer／Free 沿用 `breakdown`；細分類按 raw estimates 比例分配 Used，保留估算標示，不覆寫 raw estimates 或重複計入 children。Window／Fit 百分比均以完整 window 為分母。
- 唯讀 snapshot：重新開啟才更新；瀏覽不影響背景 turn、focus 或 composer 草稿。
- 正文保留原始路徑並做終端安全處理；只有 metadata／label 可縮短路徑。
- 一般 entry preview 只 wrap 有界前綴；省略數計算未完整呈現的原始行並快取，不完整 wrap 尾端。開全文才完整 wrap，大型多行／超長單行尾部必須可達。Skills 顯示實際 system prompt fragment 的完整內容，可直接捲動；不讀取 SKILL.md 來替換模型未收到的內容，也不更改上游 description 壓縮。
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
- 新排版透過獨立 fixture 啟動實際 TUI／ConPTY，在 100×40 驗證標題與 tokens 的 cell 顏色不同、選中提示切換、instruction path 僅一列、skill 全文尾端、三個 thinking entry、Enter／End／Esc，並觀察 48×18 resize；不是正式 CLI 的新排版驗收，Native 亦未驗收。
- Thinking 的已知證據：同一 assistant message 的兩個 encoded 與一個明文 block，經 SessionManager context 重建、snapshot 與實際 TUI 均保留三項。另以 fixture 觀察到：歷史含三個 thinking、其中兩個 turn 為 `error`／`aborted` 時，transcript 保留三個，active context 僅一個。這是 `session-context.ts` 的 replay filtering 契約，不能據此斷言使用者的 session 也是此原因；未改動 replay、compaction 或原 session。

## 環境陷阱

- 本機找不到 Tern executable；Windows `xd://tui` 缺 `/bin/sh`，bash PTY 也可能被 CLI 判為非 TTY。
- 可用 `PtySession.startArgv()` 啟動正式 `packages/coding-agent/src/cli.ts`，搭配 `packages/tui/test/virtual-terminal.ts` 觀察畫面。
- 用臨時 agent dir／`config.yml` 的 `setupVersion: 999` 避免 onboarding，不改使用者設定；ConPTY 已處理 terminal 回覆，不再回送 VirtualTerminal CPR replies。
- 已知無關問題：`packages/tui/test/usage-native-describe.test.ts:452` 的 `pm`／「下午」locale 差異，勿為本 feature 修正。
