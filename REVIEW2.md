## 结论

**暂不建议标记为 ready-to-merge。** 主要 blocker 是 Native 路径存在内容不可完整访问的问题，不只是尚未验证的外观差异。另有 custom prompt 下的 attribution 缺口，以及可以缩小的提交范围。

已审查 `git diff upstream/main...HEAD` 的全部 **30 个文件，+2942 / −142**，并阅读贡献规范、相关现有组件与测试模式。未修改仓库文件、未创建 commit。

## Must fix

### 1. Native 的完整内容入口被 ANSI 的可见性判断错误地拦截
**客观功能缺陷。**

位置：
- [`context-viewer.ts:729–755`](packages/tui/src/overlays/context-viewer.ts#L729)：把多行 preview 放进 `item.detail`。
- [`context-viewer.ts:578–584`](packages/tui/src/overlays/context-viewer.ts#L578)：如果 ANSI preview 被判断为完整且可见，activate 直接返回。

[Tern 的 `item` 契约](https://docs.stencil.so/tern/elements/lists.md#item)明确规定：文本不 wrap，`detail` 会 truncate。因此，“ANSI 中完整可见”不能作为“Native 不需要打开全文”的依据。

**验证：** 使用实际 `ContextViewer` 做只读 smoke；一个包含两条消息的 category，第一条正文为三行。ANSI 显示全部三行；Native activate 后仍保留 list，没有创建 full-content entry。这里确认的是节点与导航状态；没有声称完成 Tern 视觉验证。

**最小改进：**
1. Native activation 不使用 ANSI viewport 的提前返回条件，至少始终允许打开全文。
2. multiline 内容使用支持 wrap 的 `text`/`col`，而不是 `item.detail`。
3. 补充上述短多行消息的导航 regression test，并实际验证 Tern 的内容尾部与返回行为。现有 tests 对 `detail` 中存在字符串的断言不足以证明内容可见。

## Recommended

### 2. Literal custom prompt 会静默丢失已加载 instruction file 的 attribution
**客观功能缺口；正文没有丢失。**

位置：
- [`system-prompt.ts:1074–1102`](packages/coding-agent/src/system-prompt.ts#L1074)：只要存在 `resolvedCustomPrompt`，整个 `sources` 就设为 `undefined`。
- [`system-prompt.ts:1060–1064`](packages/coding-agent/src/system-prompt.ts#L1060)：project prompt 仍然注入 context files。
- [`context-view.ts:63–125`](packages/coding-agent/src/session/context-view.ts#L63)：没有 metadata 时，文件内容全部归入 System Prompt，且不提示 attribution 不可用。

**验证：** 传入 literal custom prompt 和一个内存 instruction file：
- 实际 system prompt 包含该文件正文；
- `sources === undefined`；
- Instruction Files 有零条 entry；
- notices 为空。

这会让支持 `SYSTEM.md` / custom system prompt 的用户误以为没有加载 instruction files。

**最小改进：** 不要因为 block 0 是 custom prompt 就禁用全部 metadata；继续收集确实出现在最终 blocks 中的已知文件 fragments。现有 `blockIndex` 检查及 viewer 的 ambiguity fallback 已可用于保守归因。增加一个 custom prompt 与 instruction file 共存的行为测试。

### 3. 从提交中移除本地 handoff 和会话管理材料 (這個等到最後要發PR時再移除就好)
**范围与维护性建议，不是运行时缺陷。**

位置：
- [`HANDOFF.md:3–40`](HANDOFF.md#L3)
- [`CONTEXT_VIEWER_PR_NOTES.md:38–70`](CONTEXT_VIEWER_PR_NOTES.md#L38)

这两个 root 文件共 111 行，包含本地授权、后续 agent 指令、Windows smoke 操作、历次验证记录和 PR 准备流程。它们没有被产品消费，却让 maintainer 需要判断哪些属于正式契约、哪些只是本地工作记录，也容易随实现漂移。

**最小改进：** 将审查证据和已知限制放进 PR 的 `Testing`；本地 handoff 不纳入提交。产品语义保留在已有 `docs/cli-reference.md`，无需另建长期维护的说明体系。

## Optional

### 4. 键盘帮助应复用现有 keybinding helper
**客观一致性问题，影响 remapped navigation 的用户。**

位置：
- [`context-viewer.ts:543–547`](packages/tui/src/overlays/context-viewer.ts#L543)：固定显示 `↑↓ j/k`。
- [`context-viewer.ts:647–657`](packages/tui/src/overlays/context-viewer.ts#L647)：实际 navigation 使用可配置的 `tui.select.*` bindings。

当用户重映射 up/down 时，界面仍宣称箭头可用，也不显示新的按键。现有 [`keybinding-hints.ts:18–25`](packages/tui/src/chrome/keybinding-hints.ts#L18) 已提供 `editorKey` / `editorKeys`，`UsageDashboard` 也采用该模式。

**最小改进：** 从 bindings 生成可配置按键的提示，只把确实固定支持的 `j/k` 等别名作为附加提示。

### 5. 清除已被替代的 UI，保留新 viewer 仍需要的計算能力

需要區分：

| 部分 | 是否仍需要 |
|---|---|
| 舊畫面的 `ContextUsageView`、專用 grid／legend／Native rendering | 倉庫內已沒有 production caller，沒有必要只為舊畫面繼續維護 |
| `computeContextBreakdown`、token estimates、compaction boundaries | 仍需要，不能隨舊 UI 一起刪除 |
| 新 viewer 使用的 `planContextMap`、category styles、theme symbols | 仍需要 |
| `contextSnapcompactLines` 背後的 diagnostics 格式化 | 新 viewer 仍使用，需要保留 |
| 只驗證舊 UI 的 tests | 舊 UI 移除後應一併移除；仍有價值的行為契約改由新 viewer tests 覆蓋 |

這樣清理後，**新 `/context` 不會失去功能**，反而可以少維護一套畫面，也不再需要處理「新舊 renderer 是否一致」。

唯一需要確認的是公開 API：`ContextUsageView` 等是 exported symbols。這不代表必須永久保留，但刪除前應檢查其他 exports 的 callers，並依專案的 API compatibility 規則處理。先前 LSP 已確認 `ContextUsageView` 的倉庫內剩餘引用只有 tests；外部 consumers 則沒有證據。

> **新 viewer 已完成 cutover，應評估移除 obsolete static report rendering 與其專用 tests，而不是繼續重構、維護它。共享計數與新 viewer 所需 helpers 保留。**

## 上游兼容性

- 审查基线：本地 `upstream/main` 为 `e34a37389c`；当前 HEAD 为 `f270a8aef7`。
- 远端 main 已到 [`50ec66f75d`](https://github.com/can1357/oh-my-pi/compare/e34a37389c...50ec66f75d)，比本地 tracking ref 多 17 个 commit。
- 对本地 upstream 做只读 `merge-tree` 检查，未发现 conflict markers。
- 额外上游变更涉及本 PR 也触及的 `sdk.ts`、`agent-session.ts`、`messages.ts`；最新上游还增加了 narration 的显示语义。

**未发现已证实的上游 API 不兼容，但没有在合入最新远端 main 的组合树上运行验证。** 当前分支的绿色检查不能替代该验证。

没有把所有 core 修改都视为问题：共享 conversion visitor 避免了第二套 message conversion；prompt sources 随 rebuild commit、switch rollback 更新也有行为测试支持。这些边界处理有合理依据，不建议仅为减少文件数量而重写。

## 本次验证

| 检查 | 结果 |
|---|---|
| 功能与邻近 regression：11 个测试文件 | 141 pass，0 fail |
| Prompt / template compatibility：8 个测试文件 | 94 pass，1 fail |
| `bun --cwd packages/coding-agent check` | 通过 |
| `bun --cwd packages/tui check` | 通过 |
| 内存 smoke | 确认 Native activation 与 custom-prompt attribution 问题 |

失败项为 [`system-prompt-template.test.ts:150`](packages/coding-agent/test/system-prompt-template.test.ts#L150)：期望发现用户级 `SYSTEM.md`，实际返回 `undefined`。失败发生在本 PR 未修改的 discovery 路径；**尚未证明是本 PR 引入，也未证明 baseline 同样失败**，因此不将其列为已证实回归，但 PR 不能报告所有相关测试通过。

未运行 repository-wide `bun check`，也未完成 Tern 或完整生产 CLI 的视觉 smoke。提交前还需确认 `CONTRIBUTING.md` 要求的重大 UI／跨 package 功能事前讨论已完成；现有仓库材料不能证明这一点。
