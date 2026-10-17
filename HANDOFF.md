# Context Viewer 工作交接

## 範圍與目前狀態

- Branch：`feat/context-viewer`。未授權 commit、push、PR 或對外操作。
- 本次範圍限定 `/context`；Tern 相關問題暫不處理。模型輸入、skill 壓縮、abort／resume／rewind／replay 規則不變。
- ANSI viewer 支援原版容量分攤、Compaction／Snapcompact 診斷、footer 分隔線、entry 全區塊左框、theme 彩色括號標題、暗色 token 數、Instruction Files 單一路徑標題、選中限定提示及 thinking block 編號。
- `/context` 預設顯示目前唯讀預覽；有本 process 捕捉的 request 時，可按 `r` 切換至附時間的最近 prepared request。開啟時固定兩份 snapshot，切換與瀏覽不更新內容。
- Skills 顯示實際 system prompt 中的 hint；來源 catalog 可能縮短或壓縮 description 的說明只放在 Skills 區塊頂部一次，分類與單項全文共用，不放入各 entry metadata；不以未送出的 SKILL.md 原文替換。
- Native 保留 `list/item` 選中樣式及 entry id／select／activate 事件；Native 多行 entry 左框尚未實作，也未在 Tern 原生窗口驗收。

## Request context 的資料邊界

- `packages/agent/src/agent.ts` 的 `observeModelCalls()` 在真正呼叫 provider stream function 前觀察共用 prepared context，不重新執行 preparation。沒有 observer 的 Agent 不包裝 stream function。
- Interactive `CommandController` 註冊 `observeSessionContextRequests()`；不對 headless／SDK／subagent session 自動啟用記錄。註冊隨 session dispose 移除。
- `packages/coding-agent/src/session/context-view.ts` 在 observer 中立即建立文字 snapshot；system prompt、tools、messages 及細分類 token estimates 使用同一份 prepared context。tool examples 不重複附加或估算。
- Snapshot 只保留供瀏覽的文字摘要、估算與 metadata，不保存 binary、thinking signatures 或原始 message objects；僅保存最近一筆，依 session id 隔離，不從 transcript 重建證據，也不持久化。
- `prepareProviderCall()` 的 transformContext、convertToLlm、normalization、transformProviderContext、dialect 處理與 model-call gates 均在捕捉之前完成。Viewer 不自行補 abort／resume／rewind／thinking 篩選分支。
- **Prepared context 不是最終 wire payload，也不是下一筆 request。** Provider-specific encoding／replay、payload hooks、stateful chaining 與 live steering 仍可能影響實際送出的內容；總覽明示此邊界。
- 目前預覽讀取 active session state 並使用純本地 message conversion，不執行有副作用的 hooks 或 provider preparation；不能將它宣稱為下一筆模型輸入。尚無 request 記錄時明示缺少證據。
- Request 畫面的 Used／Buffer／Free 與 compaction 門檻保存捕捉時的 session breakdown；細分類為 prepared content 的 raw estimates，再按原契約分配 Used。Request 畫面不重算目前 state 的 Snapcompact savings。
- 使用者指定的既有 session 那次 rewind 的最終 payload 沒有可用記錄，不能以模型自述或 transcript 中的 thinking 數量推斷實際送出內容。

## Skill description 的來源與顯示

- `previewSkillDescription()` 會將未有壓縮快取的 description 正規化為單行，縮短至約 100 字元，可能以 `…` 結尾；快取壓縮結果也受字數與長度限制。這是模型輸入來源的行為，不是 viewer 能恢復的原文。
- 使用者選擇保留模型輸入，標明壓縮來源，不改上游壓縮，不另顯示未送出的原始 description。
- Viewer 對實際 skill hint 完整換行並可捲動至尾端。Skills 的全量 wrap 保留，因為它提供模型 hint 的完整瀏覽；不能將此視為還原原始 description。
- 正式 CLI／ConPTY 使用 repo 中真實 `semantic-compression` 與 `tool-prompt-optimization` skills，已觀察 100×30、48×18 的換行、選中左框與 End 尾端；本地 HTTP server 收到的 semantic-compression hint 同樣以 `label…` 結尾，與 viewer 相符。

## 不可破壞的契約

- Used／Buffer／Free 沿用 breakdown；細分類按 raw estimates 比例分配 Used，保留估算標示，不覆寫 raw estimates 或重複計入 children。Window／Fit 百分比均以完整 window 為分母。
- 唯讀 snapshot：重新開啟才更新；瀏覽、切換來源不影響背景 turn、focus 或 composer 草稿。
- 正文保留原始路徑並做終端安全處理；只有 metadata／label 可縮短路徑。
- 一般 entry preview 只 wrap 有界前綴；省略數計算未完整呈現的原始行並快取，不完整 wrap 尾端。開全文才完整 wrap，大型多行／超長單行尾部必須可達。
- 保留 oversized entry 先捲動再換項、Enter／Esc 返回位置、空分類及單條目直開全文語意；不簡化 prompt 來源追蹤／rollback，不刪共用 ContextUsageView。
- 新增 code comments／文件用中文，technical terms 保留 English；中文字寬 fixture 保留。

## 驗證與入口

- `packages/tui/src/overlays/context-viewer.ts`：ANSI／Native rendering、選取與導航；Native 型別見 `packages/wire/src/tsp.ts`。
- `packages/coding-agent/src/session/context-view.ts`：預覽、request snapshot 與 attribution；共用 map／容量計算見 `packages/tui/src/chrome/context-map.ts`、`packages/tui/src/status-line/context-usage.ts`。
- Context focused suite：92 pass、0 fail，涵蓋 viewer／map／usage、context-view、issue-4806、context-file-reload、switch-prev-context、prefix-binding-tool-roster。
- Agent suite：248 pass、0 fail，涵蓋 agent、agent-loop、side-request-context、live-steering、queued-message-preparation、sent-tool-definitions。
- `packages/agent`、`packages/tui`、`packages/coding-agent` 各自的 `bun check` 均通過。
- Regression 經真正 Anthropic provider 與本地 HTTP server 比對 transformed prompt／messages，驗證瀏覽不重跑 hooks、normalized tool schema、snapshot 不隨 state 改寫、session id 隔離；pending turn 測試涵蓋來源切換、背景完成、focus／草稿保留及不增加 request。
- 正式 CLI／ConPTY 已觀察首次 request 前的預覽、最近 request 的時間與邊界提示、`r` 來回切換、真實 Skills、48×18 resize、End、Esc 返回 composer。Native 不包含在此驗收中。

## Tern 暫緩項目與環境

- Native 多行 entry 左框及原生窗口的總覽、分類、全文、選取／啟用、Esc、resize、footer 視覺驗收暫緩；節點／事件測試不能替代視覺驗收。
- 現用 Tern item 不換行、detail 截斷、children 被忽略；可研究 common props 的 `mark: "pick"`，不能預設已足夠達成需求。
- 本機找不到 Tern executable；Windows `xd://tui` 缺 `/bin/sh`。可用 `PtySession.startArgv()` 啟動正式 CLI，搭配 `packages/tui/test/virtual-terminal.ts` 觀察畫面。
- 驗證用臨時 agent dir／config.yml 的 `setupVersion: 999` 避免 onboarding，不改使用者設定；ConPTY 已處理 terminal 回覆，不再回送 VirtualTerminal CPR replies。
- CLI `--skills` 是名稱篩選；載入 repo 的真實 skills 可在臨時 config 設定 `skills.customDirectories`，再以 `--skills` 選名。
- 已知無關問題：`packages/tui/test/usage-native-describe.test.ts:452` 的 `pm`／「下午」locale 差異，勿為本 feature 修正。
