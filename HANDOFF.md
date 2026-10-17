# Context Viewer 工作交接

## 目前狀態

- Branch：`feat/context-viewer`；程式碼 commit：`2f0bcb125b`。開工先檢查 Git 狀態。
- 已實作：原版容量分攤、總覽 Compaction／Snapcompact 診斷、footer 分隔線、ANSI entry 全區塊左框；兩個 package 的英文 Changelog 已更新。
- **Native 多行 entry 左框尚未實作；Native 畫面尚未在 Tern 原生窗口驗收。** 不是「功能完成，只差測試」。
- Native 保留 `list/item` 選中樣式與 entry id／select／activate 事件。使用者尚未決定暫緩此項或接受兩端外觀不同，不自行縮減需求。

## 下一步

1. 先研究 Tern 現有元件組合能否呈現多行 entry 與整塊左框，不預設必須修改 renderer。
2. 現用 [item](https://docs.stencil.so/tern/elements/lists.md#item) 不換行、detail 截斷、children 被忽略；[common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes) 的 `mark: "pick"` 可作研究入口，但不能視為已可達成。
3. 取得 Tern 環境驗收總覽、分類、全文、選取／啟用、Esc、resize 與 footer；節點／事件測試不能取代視覺驗收。
4. 若現有能力確實不足，再向使用者提出 renderer 擴充或差異方案。未授權 push、PR、對外發文或邀測。

## 不可破壞的契約

- Used／Buffer／Free 沿用 `breakdown`；細分類按 raw estimates 比例分配 Used，保留估算標示，不覆寫 raw estimates 或重複計入 children。Window／Fit 百分比均以完整 window 為分母。
- 唯讀 snapshot：重新開啟才更新；瀏覽不影響背景 turn、focus 或 composer 草稿。
- 正文保留原始路徑並做終端安全處理；只有 metadata／label 可縮短路徑。
- Preview 只處理有界前綴；開全文才完整 wrap，大型多行／超長單行尾部必須可達。
- 保留 oversized entry 先捲動再換項、Enter／Esc 返回位置、空分類及單條目直開全文語意；不簡化 prompt 來源追蹤／rollback，不刪共用 `ContextUsageView`。
- 本 feature 的 code comments／Changelog 用英文；聊天與交接用中文，中文字寬 fixture 保留。

## 程式入口與驗證

- `packages/tui/src/overlays/context-viewer.ts`：ANSI／Native rendering、選取與導航；Native 型別見 `packages/wire/src/tsp.ts`。
- `packages/coding-agent/src/session/context-view.ts`：snapshot；共用 map／容量計算見 `packages/tui/src/chrome/context-map.ts`、`packages/tui/src/status-line/context-usage.ts`。
- 下列 focused suite 已通過：**57 pass，0 fail**；`packages/tui`、`packages/coding-agent` 各自的 `bun check` 均通過。只改本文件不重跑程式測試。

```sh
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/coding-agent/test/modes/context-view.test.ts packages/coding-agent/test/issue-4806-command-output.test.ts
```

- 正式 CLI／ConPTY 已驗收總覽、Fit、分類左框／捲動、全文／End、resize、Esc 返回 composer；ANSI 已觀察 100×30、48×18、48×6。Native 未包含在此視覺驗收內。

## 環境陷阱

- 本機找不到 Tern executable；Windows `xd://tui` 缺 `/bin/sh`，bash PTY 也可能被 CLI 判為非 TTY。
- 可用 `PtySession.startArgv()` 啟動正式 `packages/coding-agent/src/cli.ts`，搭配 `packages/tui/test/virtual-terminal.ts` 觀察畫面。
- 用臨時 agent dir／`config.yml` 的 `setupVersion: 999` 避免 onboarding，不改使用者設定；ConPTY 已處理 terminal 回覆，不再回送 VirtualTerminal CPR replies。
- 已知無關問題：`packages/tui/test/usage-native-describe.test.ts:452` 的 `pm`／「下午」locale 差異，勿為本 feature 修正。
