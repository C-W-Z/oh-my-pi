# Context Viewer Handoff

## Current State

- Branch: `feat/context-viewer`. Local commits are authorized; pushing is not authorized. Check the working tree before starting work.
- Implemented: original capacity allocation, overview Compaction/Snapcompact diagnostics, footer divider, and full-block left borders for ANSI entries; shared theme-colored bracketed headings with dim token counts, a single path heading for Instruction Files, selection-only content hints, fully scrollable skill input, and thinking block numbering. Both packages have Changelog entries.
- Message entries omit redundant `user`, `assistant`, and `toolResult` metadata rows in previews and full content. Converted-message provenance, including custom types, file mentions, and local executions, remains available.
- Message projection uses one whole-sequence base `convertToLlm` call over live `agent.state.messages` when opened. Its optional read-only visitor supplies source-message and whole-sequence output indices through the shared cached traversal; viewer-owned entries retain provenance after omissions and splits. Assistant/toolResult messages use the same conversion as all other roles.
- **Native multiline entry borders are not implemented; the Native surface has not been visually verified in a Tern window.** This is incomplete functionality, not just missing tests.
- Native retains `list/item` selection styling and entry id/select/activate events. All Tern-related investigation and visual verification are explicitly deferred by the user because no Tern environment is available. This does not accept appearance differences or waive the Native multiline-border requirement.

## Outstanding Work

1. Tern work is deferred until a Tern environment is available. Investigate whether existing components can render multiline entries with full-block left borders; do not assume renderer changes are required.
2. The current [item](https://docs.stencil.so/tern/elements/lists.md#item) does not wrap, truncates detail, and ignores children. The [common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes) `mark: "pick"` is an investigation starting point, not proof that the requirement is supported.
3. In Tern, visually verify the overview, categories, full content, selection/activation, Esc, resize, and footer. Node/event tests do not replace visual verification.
4. If existing capabilities are insufficient, present renderer-extension or appearance-difference options to the user. Pushing, PRs, external posts, and invitations to test are not authorized.

## Context Projection Contract

- **Meaning:** `/context` shows the active context at opening time, projected through the shared base `convertToLlm` rules. It is not a raw transcript, a last-request viewer, or an exact preview of the next wire payload. Keep this boundary visible to users.
- **Source and lifetime:** retain live `agent.state.messages`, the current system prompt, and active tools as sources. Build the display snapshot only when opened. Do not rebuild from the journal to approximate live state, maintain a second replay/abort state machine, or capture a full snapshot on every request.
- **Conversion:** one whole-sequence `convertToLlm` traversal handles every role, including assistant/toolResult messages. Neighbor relationships matter: an assistant followed by an `interrupted-thinking` continuity message uses the same conversion rules as replay. The viewer does not recreate those rules.
- **Provenance:** the converter's optional visitor receives each converted message, its source-message index, and its whole-sequence output index. Viewer-owned IDs and labels retain custom types, file mentions, and local-execution attribution. Omissions and splits are attributed during conversion, never by zipping arrays or matching text. Exact repeats reuse the cached outer array while visiting every cached fragment; request calls without a visitor retain the existing shortcut paths.
- **Excluded stages:** do not call extension `context` hooks, `before_provider_request` hooks, or the complete configured request pipeline. Provider transforms such as image processing, snapcompact rasterization, blob uploads, and date/cwd injection are outside this base projection. Do not promise exact final payload contents or token counts.
- **Abort ownership:** existing `buildSessionContext` rules remove unsafe error/aborted turns and paired results from reconstructed active context, with interrupted-thinking continuity exceptions. Base conversion strips eligible incomplete thinking without changing the original transcript. Do not add a blanket aborted-message filter to the viewer or equate base conversion with full provider encoding.

### Base `convertToLlm`: Side Effects and Safety Boundary

- **Scope:** this assessment applies to the base export in `packages/coding-agent/src/session/messages.ts`, not an arbitrary configured `convertToLlm` callback, `AgentSession.convertMessagesToLlm`, SDK request wrappers, or provider encoding. Do not assume those broader paths are side-effect-free.
- **Memory/cache writes:** `convertOneCached` populates the per-message WeakMap; `convertToLlm` populates the array-level WeakMap. Opening the viewer can warm caches used by subsequent conversions, allocate converted messages/arrays, and retain cached results while their keys remain reachable. It therefore changes runtime memory and later conversion work even when the projected content is unchanged; it is not a mathematically pure function.
- **Metadata writes:** `copyPerCallContextMessage` assigns the internal `kPerCallContextMessage` Symbol to converted outputs when it is present on the source. Core assistant conversion may return the source object itself, so this can be an idempotent assignment on the original object, not exclusively a write to a new object. The marker is runtime-only and is not serialized to session JSONL or provider wire data. Do not promise zero property writes or compatibility with frozen/accessor-backed message objects.
- **Aliasing and cached outputs:** some messages, nested content arrays/blocks, and media objects are shared with the input; an unchanged repeated conversion can also return the same cached outer array. Sorting/splicing that array, changing a block, or attaching viewer metadata can corrupt live history or later replay through shared references. Keep labels, provenance mappings, sorting, and display entries in viewer-owned structures; never mutate converter outputs.
- **Cache validity:** existing caches depend on message identity, owner invalidation, and the live-array mutation contract. Owners that prune, rewrite, or otherwise change messages must use the existing invalidation mechanisms. The whole-sequence traversal handles adjacent interrupted-thinking markers; isolated per-message calls do not preserve that context. Do not bypass invalidation, modify cached results, or duplicate cache/replay logic for the viewer.
- **No request-side effects:** the base call does not execute extension hooks, perform file/network I/O, dispatch tools, append session entries, or advance the agent turn. Its existing transformations do not rewrite original message bodies. This is a bounded read-only-consumer assessment, not a claim that the function has no side effects or cannot throw.
- **Implementation boundary:** conversion and viewer-owned display allocation happen on open only. No per-request snapshot capture, unconditional deep copy of the conversation/media, or second state machine is required. Preserve the existing converter's caching and provenance semantics rather than introducing viewer-specific mutations to make it appear pure.

### Acceptance Criteria

- Compare viewer entries with the shared batch projection for interrupted-thinking continuity, replayable signed/encoded reasoning, custom/file-mention splits, excluded local executions, and tool-name canonicalization. Preserve source attribution after omissions and splits.
- Opening, navigating, closing, and reopening the viewer must not change original message content or provenance values, session history, composer drafts, or background turns; hooks and request-side effects must not run. Existing cache writes and idempotent internal Symbol assignments are the explicitly documented exceptions to strict purity.
- Exercise neighbor changes and cached repeated conversion without stale thinking or lost attribution. Add permanent tests only for observable conversion/provenance regressions, not prompt wording or implementation wiring.
- Run the focused suite and package-local checks after implementation, plus a runtime smoke through actual snapshot generation and the changed viewer path. Retain the ANSI/Native requirements below; converter smoke alone is not visual verification.

## Required Contracts

- Used/Buffer/Free follow `breakdown`. Allocate Used to subcategories in proportion to raw estimates, retain estimate labels, and neither overwrite raw estimates nor count children twice. Window/Fit percentages use the full window as the denominator.
- The snapshot is read-only and refreshes only when reopened. Browsing must not affect background turns, focus, or composer drafts.
- Preserve original paths in body content and apply terminal sanitization. Only metadata/labels may shorten paths.
- Ordinary entry previews wrap only a bounded prefix. Count and cache omitted source lines without wrapping the entire tail. Full content wraps the complete entry; the ends of large multiline entries and very long single lines must remain reachable. Skills show the full system prompt fragment actually sent to the model and support direct scrolling; do not substitute SKILL.md content or change upstream description compression.
- Preserve scrolling within oversized entries before changing selection, Enter/Esc return positions, empty categories, and direct full-content opening for single-entry categories. Do not simplify prompt provenance/rollback or remove the shared `ContextUsageView`.
- Write code comments and documentation in English, following repository conventions. A fixture is sample input used by a test or smoke scenario. Chinese text may remain in such input when it exercises character width, wrapping, or scrolling; this does not make Chinese the language for comments or documentation.

## Entry Points and Verification

- `packages/tui/src/overlays/context-viewer.ts`: ANSI/Native rendering, selection, and navigation. Native types are in `packages/wire/src/tsp.ts`.
- `packages/coding-agent/src/session/context-view.ts`: snapshot generation. Shared map/capacity calculations are in `packages/tui/src/chrome/context-map.ts` and `packages/tui/src/status-line/context-usage.ts`.
- The expanded focused suite passes: **108 pass, 0 fail** across eight files. The `packages/tui` and `packages/coding-agent` package-local `bun check` commands pass. Documentation-only edits do not require rerunning program tests.

```sh
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/coding-agent/test/modes/context-view.test.ts packages/coding-agent/test/issue-4806-command-output.test.ts packages/coding-agent/test/session/messages.test.ts packages/coding-agent/test/session-messages.test.ts packages/coding-agent/test/agent-session-interrupted-thinking.test.ts
```

- Production CLI/ConPTY projection verification uses an isolated sample session at 100×30 and 48×18: overview boundary labels, actual Window/Fit transition, two replayable thinking entries, full-content End reaching the signed-thinking tail, canonical `recall` output and its tail, footer, resize, Esc, reopen, and editor kill-buffer draft restoration. The transcript retains the omitted incomplete reasoning and excluded execution; `/context` does not display them. Native is not covered by this visual verification.
- A standalone sample-data harness runs the actual TUI/ConPTY at 100×40 and verifies different cell colors for headings and token counts, selection-dependent hints, a single instruction path row, the skill content tail, three thinking entries, Enter/End/Esc, and resize to 48×18. This does not constitute production CLI verification of the new layout or Native verification.
- The role-label smoke runs the actual TUI/ConPTY at 100×30 for User Messages, Assistant Messages, Assistant Thinking, Tool Calls, and Tool Output. Previews and full content have no redundant role rows; Enter/End/Esc navigation and each full-content tail work, including Tool Output after resize to 48×18. ANSI render output and Native node descriptions cover both preview and full-content paths; converted-message provenance is preserved. Native visual verification still requires Tern.
- Thinking evidence: two encoded blocks and one plaintext block in the same assistant message remain three entries through SessionManager context reconstruction, snapshot generation, and the actual TUI. A separate sample session with three thinking entries and two `error`/`aborted` turns retains three entries in the transcript but only one in active context. The user reports that the missing thinking belongs to aborted messages and accepts the active-context exclusion. No session repair is required.
- Snapshot/viewer smoke exercises actual `AgentSession` snapshot generation and `ContextViewer` navigation, full-content End, resize, close, and reopen. Signed and encoded thinking survive while the adjacent continuity message removes unsigned trailing thinking. Source/output positions survive custom and file-mention splits and excluded local executions; tool names are canonical. Original message bodies, assistant property descriptors, session history, and per-call Symbol provenance remain unchanged; repeated conversion reuses the cached result. Configured request conversion and `transformContext` counters remain zero.
- The focused integration suite exercises a real pending fixture turn while `/context` stays focused: navigation does not abort or submit it, the open snapshot remains unchanged when the turn completes, Esc restores editor focus and its draft, and browsing sends no additional request. Neighbor-change regression coverage appends and removes continuity with owner cache invalidation; a synthetic non-user-interrupt abort without continuity retains its unfinished thinking. No viewer-specific abort filter or session repair is present.

## Environment Constraints

- No local Tern executable is available. Windows `xd://tui` lacks `/bin/sh`, and the CLI may identify a bash PTY as non-TTY.
- `PtySession.startArgv()` can launch the production `packages/coding-agent/src/cli.ts`; use `packages/tui/test/virtual-terminal.ts` to observe the screen.
- Use a temporary agent directory with `setupVersion: 999` in its `config.yml` to avoid onboarding without changing user settings. ConPTY handles terminal replies; do not resend VirtualTerminal CPR replies.
- Known unrelated issue: the `pm`/Chinese afternoon locale difference in `packages/tui/test/usage-native-describe.test.ts:452`. Do not fix it as part of this feature.
