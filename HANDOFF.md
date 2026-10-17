# Context Viewer Handoff

## Current State

- Branch: `feat/context-viewer`. Local commits are authorized, including the user's existing handoff edit; pushing is not authorized. Check the working tree before starting work.
- Implemented: original capacity allocation, overview Compaction/Snapcompact diagnostics, footer divider, and full-block left borders for ANSI entries; shared theme-colored bracketed headings with dim token counts, a single path heading for Instruction Files, selection-only content hints, fully scrollable skill input, and thinking block numbering. Both packages have Changelog entries.
- Message entries omit redundant `user`, `assistant`, and `toolResult` metadata rows in previews and full content. Converted-message provenance, including custom types, file mentions, and local executions, remains available.
- The message projection is still hybrid: `context-view.ts` reads live `agent.state.messages`, bypasses `convertToLlm` for assistant/toolResult messages, and converts other internal messages individually. The approved batch-conversion design below is not implemented.
- **Native multiline entry borders are not implemented; the Native surface has not been visually verified in a Tern window.** This is incomplete functionality, not just missing tests.
- Native retains `list/item` selection styling and entry id/select/activate events. The user has not agreed to defer this requirement or accept different appearances across renderers; do not silently reduce scope.

## Outstanding Work

1. Implement the approved batch-conversion design below, preserving converted-message provenance and read-only browsing. The user identified aborted messages as the source of the missing thinking and accepts their exclusion from active context; do not continue treating this as an unexplained viewer bug or claim a session repair.
2. Investigate whether existing Tern components can render multiline entries with full-block left borders; do not assume renderer changes are required.
3. The current [item](https://docs.stencil.so/tern/elements/lists.md#item) does not wrap, truncates detail, and ignores children. The [common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes) `mark: "pick"` is an investigation starting point, not proof that the requirement is supported.
4. Obtain a Tern environment and visually verify the overview, categories, full content, selection/activation, Esc, resize, and footer. Node/event tests do not replace visual verification.
5. If existing capabilities are insufficient, present renderer-extension or appearance-difference options to the user. Pushing, PRs, external posts, and invitations to test are not authorized.

## Approved Context Projection Design (Not Implemented)

- **Meaning:** `/context` shows the active context at opening time, projected through the shared base `convertToLlm` rules. It is not a raw transcript, a last-request viewer, or an exact preview of the next wire payload. Keep this boundary visible to users.
- **Source and lifetime:** retain live `agent.state.messages`, the current system prompt, and active tools as sources. Build the display snapshot only when opened. Do not rebuild from the journal to approximate live state, maintain a second replay/abort state machine, or capture a full snapshot on every request.
- **Conversion:** remove the assistant/toolResult bypass and replace isolated `convertToLlm([original])` calls with a shared whole-sequence projection. Neighbor relationships matter: an assistant followed by an `interrupted-thinking` continuity message must use the same conversion rules as replay. Do not recreate those rules inside the viewer.
- **Provenance:** retain source-message indices, converted-message indices, custom types, file mentions, and local-execution attribution through the shared conversion traversal. Conversion can omit messages or split one source into multiple outputs; do not infer provenance by zipping input/output arrays or matching text. Reuse the existing converter and caches rather than adding a parallel implementation.
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
- The focused suite passes: **59 pass, 0 fail**. The `packages/tui` and `packages/coding-agent` package-local `bun check` commands pass. Documentation-only edits do not require rerunning program tests.

```sh
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/coding-agent/test/modes/context-view.test.ts packages/coding-agent/test/issue-4806-command-output.test.ts
```

- The production CLI/ConPTY verification covers the overview, Fit, category borders/scrolling, full content/End, resize, and Esc back to the composer. Observed ANSI sizes: 100×30, 48×18, and 48×6. Native is not covered by this visual verification.
- A standalone sample-data harness runs the actual TUI/ConPTY at 100×40 and verifies different cell colors for headings and token counts, selection-dependent hints, a single instruction path row, the skill content tail, three thinking entries, Enter/End/Esc, and resize to 48×18. This does not constitute production CLI verification of the new layout or Native verification.
- The role-label smoke runs the actual TUI/ConPTY at 100×30 for User Messages, Assistant Messages, Assistant Thinking, Tool Calls, and Tool Output. Previews and full content have no redundant role rows; Enter/End/Esc navigation and each full-content tail work, including Tool Output after resize to 48×18. ANSI render output and Native node descriptions cover both preview and full-content paths; converted-message provenance is preserved. Native visual verification still requires Tern.
- Thinking evidence: two encoded blocks and one plaintext block in the same assistant message remain three entries through SessionManager context reconstruction, snapshot generation, and the actual TUI. A separate sample session with three thinking entries and two `error`/`aborted` turns retains three entries in the transcript but only one in active context. The user reports that the missing thinking belongs to aborted messages and accepts the active-context exclusion. No session repair is required.
- Architecture smoke: an aborted assistant injected directly into live state retains its thinking in the current viewer, with zero `transformContext` calls and unchanged original message identity. The viewer has no independent abort filter.
- Base-converter smoke: synthetic signed thinking followed by unsigned trailing thinking and a hidden continuity message projects to the signed block plus the continuity message as developer content. Original input content and assistant property descriptors remain unchanged, per-call provenance is preserved, and repeated conversion reuses the cached result. Removing the continuity neighbor retains both original blocks for the synthetic non-user-interrupt abort. This verifies conversion behavior, not the unimplemented viewer cutover or Native rendering.

## Environment Constraints

- No local Tern executable is available. Windows `xd://tui` lacks `/bin/sh`, and the CLI may identify a bash PTY as non-TTY.
- `PtySession.startArgv()` can launch the production `packages/coding-agent/src/cli.ts`; use `packages/tui/test/virtual-terminal.ts` to observe the screen.
- Use a temporary agent directory with `setupVersion: 999` in its `config.yml` to avoid onboarding without changing user settings. ConPTY handles terminal replies; do not resend VirtualTerminal CPR replies.
- Known unrelated issue: the `pm`/Chinese afternoon locale difference in `packages/tui/test/usage-native-describe.test.ts:452`. Do not fix it as part of this feature.
