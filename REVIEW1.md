## Findings

### 1. [P2] Native category 页未转发条目内部滚动

**位置：** [packages/tui/src/overlays/context-viewer.ts:751–755](packages/tui/src/overlays/context-viewer.ts#L751-L755)

当 category 有多个 entry，且当前 entry 高于 viewport 时，Down/Page Down 只移动 `#previewScroll`，不会改变 selection。Native 描述既没有使用该 viewport 的输出，也没有给 `entries` list 设置 `scroll` request；selection 不变时，`Reconciler` 也不会发送 reveal。

**已复现：** 在 48×12 viewport 打开包含两项的 Skills category，第一项有 60 行。按 `j` 后 ANSI 内容向下移动，但 Native reconciliation 输出为 `[]`，Native 端不会更新滚动位置。

应将 category 内部滚动同步到 Native 的滚动节点，而非只更新 ANSI viewport。

### 2. [P2] 丢失仅存在于 `providerPayload` 的 reasoning token 估算

**位置：** [packages/coding-agent/src/session/context-view.ts:194–202](packages/coding-agent/src/session/context-view.ts#L194-L202)

代码计算了整条 assistant 消息的 `reasoningBudget`，但仅分配给 `thinking` / `redactedThinking` content block。如果 Responses 消息只在 `providerPayload` 保存 replayable reasoning，而 `content` 只有 text，`reasoningIndexes` 为空，该预算就被丢弃。

**已复现：** 使用真实 `AgentSession`、tokenizer 和 Codex replay converter：
- replay 包含 1 个 reasoning item；
- tokenizer 计数为 **1,003 tokens**；
- snapshot 的 `estimatedTokens` 只有 **3**，Assistant Thinking 为空。

这会低估 thinking category，并使 overview 的比例分配失真。应为这类 payload-only reasoning 保留独立计数及不暴露原始 payload 的展示项。

## Verdict

**建议修复上述 2 个 P2 后合并。**

验证：11 个相关测试文件，**141 pass、0 fail**；另用两段内存 smoke 复现了上述问题。Native 验证覆盖描述与 reconciliation 协议输出，未做 Tern 视觉验证。

未修改文件。环境缺少 `task` tool，本次使用 8 路独立模型审查及主进程复核，未满足“8 个带工具权限的 reviewer agent”这一执行要求。
