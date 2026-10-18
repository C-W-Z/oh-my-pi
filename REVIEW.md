# Context Viewer 审查与修复顺序

## 结论

暂不建议标记为 ready-to-merge。已确认 Native 内容访问与滚动、payload-only reasoning 估算、custom prompt attribution 和 remapped keybinding 提示存在问题。旧 UI 与本地材料属于清理事项，不应与运行时缺陷混为一谈。

本文整合两份审查及代码、内存 smoke、LSP references 的复核结论。以下顺序同时考虑用户影响、修改依赖和验证边界；不代表所有事项具有相同严重程度。

## 1. 优先修复：Native category 展示、全文入口与滚动

**性质：已确认的功能缺陷，应作为同一个修复阶段。**

位置：
- [activation 的 ANSI 可见性判断](packages/tui/src/overlays/context-viewer.ts#L578)
- [category 内导航](packages/tui/src/overlays/context-viewer.ts#L603)
- [Native category 描述](packages/tui/src/overlays/context-viewer.ts#L729)

### 全文入口不可用

Native category 把多行 preview 放入 `item.detail`，但 [Tern item 契约](https://docs.stencil.so/tern/elements/lists.md#item)明确规定文本不 wrap、detail 会 truncate、children 被忽略。与此同时，activation 用 ANSI preview 的完整性与可见范围决定是否提前返回。ANSI 能完整显示不代表 Native 能完整显示。

实际 `ContextViewer` smoke：包含两个条目的 category，第一项正文三行；activate 后仍保留 `entries` list，没有创建全文 entry。证据覆盖节点和导航状态，不是 Tern 视觉验证。

### 内部滚动没有 Native 更新

当前条目超出 viewport 时，Down／Page Down 先移动 `#previewScroll`，selection 保持不变。但 Native 描述既不使用 ANSI viewport 输出，也没有把 scroll request 附到 category 的滚动节点，因而没有对应更新。

实际 `ContextViewer`／`Reconciler` smoke：48×12 viewport、两个 Skills 条目、第一项 60 行；按 `j` 后 ANSI 内容改变，Native reconciliation 输出 `[]`，selection 仍为第一项。

### 修复要求

- Native activation 不以 ANSI viewport 的可见性作为拒绝打开全文的依据。
- 多行 preview 使用支持 wrap 的 `text`／`col`，不再由 `item.detail` 承担；不能简单把它们放进会忽略 children 的 `item`。
- 将滚动请求发送到实际承载 preview 的 Native 滚动节点，并保持 selection 与导航语义一致。
- 不只补一个 list scroll，也不只放开 activation；两者都不足以修复完整问题。

### 验收

- 短多行条目可以打开全文并访问尾部。
- 长条目逐行／翻页滚动产生对应 Native 更新，条目内滚动完成后再移动 selection。
- 全文页、Back、Esc、selection／返回位置和 resize 行为正确。
- 保留空 category、单条目直接打开全文等行为。
- 保留能触发实际故障路径的 regression tests；不能仅断言 `detail` 包含正文。
- 在 Tern 实际检查内容尾部、返回、滚动和布局。Native multiline entry borders 尚未实现；节点／协议验证不能替代视觉验收。

## 2. 修复 payload-only reasoning 的 token 估算

**性质：已确认的 viewer 计数缺陷。**

位置：[reasoning budget 分配](packages/coding-agent/src/session/context-view.ts#L187)。

整条 assistant 消息的 `reasoningBudget` 只分配给 `thinking`／`redactedThinking` blocks。当 replayable reasoning 仅存在于 `providerPayload`、content 只有 text 时，`reasoningIndexes` 为空，预算没有落点。

真实 `AgentSession`、tokenizer 和 Codex replay converter 的复核 smoke：replay 中有 1 个 reasoning item，tokenizer 计数 1,002 tokens，snapshot 的 `estimatedTokens` 只有 2，Assistant Thinking 为 0 tokens、0 entries。该 fixture 证明漏掉 1,000 reasoning tokens；绝对数值随可见正文不同而变化。

### 修复要求与验收

- 为 payload-only reasoning 保留独立计数和安全展示项，不暴露原始 payload、ciphertext 或 signature。
- 沿用已有 replay-aware tokenizer 语义，不按 ciphertext 长度或整条消息的 output usage 猜测 reasoning。
- 显式 thinking blocks 与 provider payload 同时存在时不能重复计数。
- 验证 payload-only、显式 thinking，以及 reader 改变／reasoning 被过滤时的计数边界。
- 保持共享 conversion 的过滤与归因语义，不新增 viewer 专用 provider 分支。

已证实影响是 thinking category、raw estimate 和 overview 比例。没有证据表明该漏项改变实际请求计费或 compaction 行为。

## 3. 修复 literal custom prompt 的 instruction attribution

**性质：已确认的来源归因缺口；instruction 正文没有丢失。**

位置：
- [project prompt 仍注入 context files](packages/coding-agent/src/system-prompt.ts#L1060)
- [custom prompt 禁用全部 sources](packages/coding-agent/src/system-prompt.ts#L1074)
- [snapshot 来源归因与 fallback](packages/coding-agent/src/session/context-view.ts#L63)

传入 literal custom prompt 和内存 instruction file 的 smoke 确认：最终 prompt 包含文件正文，但 `sources` 不存在，Instruction Files 为 0 entries，正文归入 System Prompt，`notices` 为空。这会让用户误以为没有加载 instruction files。

### 修复要求与验收

- 不因 block 0 使用 custom prompt 就禁用全部 metadata。
- 只归因最终 blocks 中实际出现且可确认的已知 fragments，不解析任意 custom prompt 来猜来源。
- 复用 block 配对、唯一匹配、重叠检查与 ambiguity fallback。
- 验证 custom prompt 与 instruction file 共存时正确归因、正文保留且不重复计数。
- 保留 prompt rebuild、session switch 和 rollback 的来源一致性契约。

## 4. 修复 remapped navigation 的键盘提示

**性质：已确认的操作提示错误，优先级低于内容访问与计数缺陷。**

位置：[固定 footer](packages/tui/src/overlays/context-viewer.ts#L543)、[可配置 navigation](packages/tui/src/overlays/context-viewer.ts#L647)。

实际 smoke 将 up/down 改为 `Ctrl+P`／`Ctrl+N`：Down arrow 不改变 selection，`Ctrl+N` 正常切换，但 footer 仍显示 `↑↓ j/k select/scroll`。

### 修复要求与验收

- 复用 [editorKey／editorKeys](packages/tui/src/chrome/keybinding-hints.ts#L18)，参照 `UsageDashboard`。
- 固定支持的 `j/k` 等别名单独保留；不能为维持旧提示而重新硬编码箭头支持。
- 检查默认、重映射和未绑定状态下的提示与实际输入行为。
- 同步调整 [CLI reference](docs/cli-reference.md#L83) 中把箭头描述为固定支持的措辞。

## 5. 独立清理旧 UI，保留共享计算能力

**性质：已确认的仓库内 dead UI，属于维护性清理。安排在功能修复稳定后。**

LSP references 确认：
- `ContextUsageView` 除定义外只剩 tests 引用。
- `renderContextUsage`／`describeContextUsage` 只由旧 UI 与相关 tests 使用。
- `contextUsageHead` 没有运行时 caller。
- 当前 `/context` 已通过 `command-controller.ts` 直接创建 `ContextViewer`。

### 清理边界

| 移除范围 | 必须保留 |
|---|---|
| 旧 `ContextUsageView`、专用 grid／legend／Native rendering、仅服务旧画面的 helpers | `computeContextBreakdown`、token estimates、compaction boundaries |
| 仅验证旧画面的 tests | 新 viewer 的 `planContextMap`、category styles、theme symbols |
| 已无调用的旧 rendering exports | `contextSnapcompactLines` 及其仍被使用的 diagnostics 格式化 |

这些 symbols 存在可导入的 package 路径。仓库内无 caller 不等于外部无 consumer；移除前需明确 API 影响，更新受影响 callers、tests 和 Changelog。不能把整份 `context-usage.ts` 删除，也不应为了旧画面继续维护第二套 renderer。

## 6. 准备 PR 时再移除本地材料

**性质：提交范围建议，不是运行时缺陷；按用户安排留到最后。**

- `HANDOFF.md` 与 `CONTEXT_VIEWER_PR_NOTES.md` 包含本地授权、会话指令、Windows smoke 操作、验证记录及 PR 流程，不由产品消费。
- PR 需要的验证证据和已知限制放入 `Testing`；产品语义保留在现有 `docs/cli-reference.md`。
- 此阶段不提前删除本地材料。

## 最终集成与发布门槛

### 上游兼容性

没有已证实的上游 API 不兼容，但尚未在与最新远端 main 的组合树上完成验证。只读远端查询得到 main 为 `dc4a66a84c`；本地 tracking baseline 为 `e34a37389c`。远端会继续变化，准备集成时应重新确定目标 commit。

不能把针对旧 tracking ref 的无冲突结果或当前分支绿色检查，视为最新组合树的兼容性证明。集成后需检查共享 conversion、prompt provenance 和上游 narration 等语义，并执行相关行为验证。

共享 conversion visitor 避免第二套 message conversion；prompt sources 随 rebuild／switch rollback 更新有行为测试支持。没有证据要求仅为减少文件数量而重写这些边界处理。

### 测试与证据限制

两份输入审查报告的结果，不代表本次重新运行：
- 功能与邻近 regression：11 个文件，141 pass、0 fail。
- Prompt／template compatibility：8 个文件，94 pass、1 fail。
- `packages/coding-agent` 与 `packages/tui` 的 package-local `bun check` 通过。

报告中的失败为 [system-prompt-template.test.ts:150](packages/coding-agent/test/system-prompt-template.test.ts#L150)：期望发现用户级 `SYSTEM.md`，实际为 `undefined`。该 test 与 discovery 目录未在分支中修改，但尚未证明失败由本 PR 引入，也未证明 baseline 同样失败。不能列为已确认回归，也不能声称所有相关测试通过。

复核执行了 Native activation／reconciliation、payload-only reasoning、custom prompt attribution 和 remapped navigation 的内存 smoke，并通过 LSP 检查旧 UI references；未重跑上述整批 tests，未执行 repository-wide `bun check`，未完成 Tern 或完整生产 CLI 的视觉验收。输入审查未满足“8 个带工具权限的 reviewer agent”的执行要求，不能宣称已完成该项。

提交 PR 前还需满足 `CONTRIBUTING.md`：重大 UI／跨 package 变更的事前讨论、贡献者亲自审阅和运行功能，以及贡献者用自己的话提供改动原因。现有材料不能证明这些人工要求已满足。
