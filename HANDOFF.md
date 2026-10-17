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
