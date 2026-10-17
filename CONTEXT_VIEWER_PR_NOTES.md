# Context Viewer: Maintainer Review Notes

Local review facts, not a published PR or a submission-ready PR description.

## Feature and scope

- `/context` opens an interactive, read-only snapshot of loaded prompts, instruction files, skills, active tools, conversation content, and tool output, including before the first message. Reopening refreshes it; browsing neither submits the composer draft nor interrupts background turns.
- Overview preserves Used/Buffer/Free from the shared breakdown, allocates Used proportionally across raw category estimates, and shows compaction thresholds and estimated Snapcompact savings. Window/Fit percentages always use the full context window.
- ANSI entries have full-block left borders, theme-colored bracketed headings, dim token counts, bounded previews with omitted source-line counts, and selection-only content hints. Full content and skill input remain scrollable through their tails; the footer divider stays visible on small terminals.
- Instruction Files have one shortened path heading while body paths remain original. Message entries omit redundant role metadata; converted-message provenance remains available. Thinking blocks are numbered in message order, with encoded and plaintext blocks shown separately.
- Changes span `packages/coding-agent` and `packages/tui`; both have Changelog entries. The CLI reference documents the viewer's semantics and navigation.

## What the snapshot means

`/context` shows active context at opening time through shared base `convertToLlm` rules. It is not a raw transcript, the last request, or an exact preview of the next provider payload; category token counts and allocation shares are estimates.

Sources are live `agent.state.messages`, the current system prompt, and active tools. A single whole-sequence conversion covers every message role, including assistant/toolResult. The optional visitor supplies source-message and whole-sequence output indices during traversal, preserving attribution across omissions and splits without zipping arrays or matching text. Custom types, file mentions, and local-execution attribution survive conversion.

The viewer does not invoke configured request conversion, `AgentSession.convertMessagesToLlm`, extension `context` or `before_provider_request` hooks, SDK request wrappers, or provider encoding. Image processing, Snapcompact rasterization, blob uploads, and date/cwd injection are outside the base message projection. Overview Snapcompact diagnostics do not turn the displayed messages into a final wire payload.

Interrupted-thinking continuity and tool-name canonicalization follow the same base conversion rules as replay. Eligible incomplete trailing thinking is stripped; replayable signed/encoded reasoning is retained. Existing session reconstruction owns removal of unsafe error/aborted turns and paired results, with continuity exceptions. The viewer has no independent blanket abort filter and does not repair sessions or restore turns absent from active context.

## Ownership and intentional state changes

- Opening `/context` can warm per-message and array-level WeakMap caches, allocate conversion/display data, and retain cached results while their keys remain reachable. Shared cache state, memory use, and later conversion work can change; message bodies, session history, and provenance values do not thereby change.
- `copyPerCallContextMessage` copies the existing runtime-only `kPerCallContextMessage` Symbol. If conversion returns the source object itself, this is an idempotent assignment on that object. The marker is not serialized to session JSONL or provider wire data.
- The viewer only reads converted messages. Display entries, strings, IDs, labels, and sorted category arrays are viewer-owned; it does not attach metadata to converter output or modify shared message bodies, nested content, or media. Exact-repeat conversion reuses its cached outer array without appending to it; a visitor still observes every cached fragment. Calls without a visitor retain the existing shortcut paths.
- Message identity, owner invalidation, and the live-array mutation contract remain the cache-coherence rules. Owners that prune or rewrite messages use the existing invalidation mechanisms. This is a maintenance invariant, not an identified viewer defect or a residual random-corruption risk in correct code.
- Conversion and display allocation happen on open only. There is no journal-based approximation of live state, per-request snapshot capture, unconditional deep copy of conversation/media, or second replay/abort state machine. The base converter does not perform file/network I/O, dispatch tools, append session entries, or advance the agent turn.

## Behavior to preserve during review

- Keep raw category estimates unchanged and avoid counting child categories twice; allocate capacity from `breakdown`. Preserve the shared `ContextUsageView` and prompt provenance/rollback behavior.
- Sanitize terminal content; shorten only metadata/labels, never original body paths.
- Ordinary previews wrap only a bounded prefix. Count/cache omitted source lines without wrapping the entire tail; full content wraps the complete entry, including very long single lines. Skills show the complete system-prompt fragment actually supplied as model input, not substituted `SKILL.md` content or changed upstream description compression.
- Scroll within oversized entries before advancing selection; preserve Enter/Esc return positions, empty categories, and direct full-content opening for single-entry categories. An open snapshot stays unchanged when a background turn advances.

## Native limitation: disclose explicitly

**Native multiline entry borders are not implemented, and the Native surface has not been visually verified in Tern.** This is incomplete functionality, not merely missing tests. Native retains `list/item` selection styling and entry id/select/activate events; node/event assertions are not visual proof.

The user has deferred all Tern work because no local Tern environment is available. This deferral does not waive the multiline-border requirement or accept different appearances across renderers. Existing-component support remains to be investigated before proposing a renderer extension or appearance difference. Do not describe ANSI and Native as visually equivalent or fully verified.

## Verification

Recorded implementation verification: **108 tests passed, 0 failed** across the eight files below; package-local `bun check` passed for `packages/coding-agent` and `packages/tui`. These are not a claim that the repository-wide `bun check` passed. Documentation-only reorganization does not rerun program tests.

```sh
bun test packages/tui/test/context-viewer.test.ts packages/tui/test/context-map.test.ts packages/tui/test/context-usage.test.ts packages/coding-agent/test/modes/context-view.test.ts packages/coding-agent/test/issue-4806-command-output.test.ts packages/coding-agent/test/session/messages.test.ts packages/coding-agent/test/session-messages.test.ts packages/coding-agent/test/agent-session-interrupted-thinking.test.ts
bun --cwd packages/coding-agent check
bun --cwd packages/tui check
```

- Production CLI/ConPTY, isolated sample session, 100×30 and 48×18: overview boundary labels, actual Window/Fit transition, two replayable thinking entries, full-content End reaching the signed-thinking tail, canonical `recall` output and its tail, footer, resize, Esc, reopen, and editor kill-buffer draft restoration. The transcript retains the incomplete reasoning and excluded execution omitted by `/context`.
- Standalone actual TUI/ConPTY sample-data checks, 100×40 and 48×18: heading/token-count cell colors, selection-dependent hints, one instruction path heading, skill content tail, three thinking entries, Enter/End/Esc, and resize. This is sample-harness evidence, not production CLI or Native visual verification.
- Role-label checks, actual TUI/ConPTY at 100×30 with Tool Output resized to 48×18: no redundant role rows in User Messages, Assistant Messages, Assistant Thinking, Tool Calls, or Tool Output; preview/full-content navigation and tails work. ANSI output and Native node descriptions preserve converted-message provenance; Native descriptions do not establish visual correctness.
- Snapshot/conversion checks: continuity strips eligible unsigned trailing thinking while retaining signed/encoded blocks; custom/file-mention splits, omitted executions, source/output positions, and canonical tool names remain correct. Neighbor append/removal with owner cache invalidation does not leave stale thinking. Without continuity, a synthetic non-user-interrupt abort retains unfinished thinking; no viewer-specific abort filter is involved.
- Read-only smoke: original message bodies, assistant property descriptors, history, and per-call Symbol provenance remain unchanged through snapshot generation, navigation, End, resize, close, and reopen. Repeated conversion reuses the cached result; configured conversion and `transformContext` counters stay zero.
- Pending-turn integration: `/context` remains focused without aborting or submitting the turn; its snapshot stays unchanged after the turn completes. Esc restores editor focus and the original draft; browsing sends no extra request.
- Active-context/transcript distinction: sample reconstruction retains two encoded and one plaintext thinking blocks in one assistant message. A separate sample with three transcript thinking entries and two error/aborted turns retains only one thinking entry in active context. The user accepts exclusion of the aborted turns; no session repair is required.

## Before opening a PR

- Follow [CONTRIBUTING.md](CONTRIBUTING.md), including the required prior Discord discussion for major multi-package/UI changes. Confirm that requirement is satisfied; these notes are not maintainer approval.
- The contributor must review every changed file, understand the behavior, personally exercise the feature, and supply at least one sentence in their own words explaining what changed and why. Generated notes cannot replace that sentence or the contributor's verification.
- Preserve the `What`, `Why`, `Testing`, and checklist sections in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md). Report exact scenarios and the Native gap; check only verified items. Package-local checks alone do not establish the template's repository-wide `bun check` item.
- For an external contribution, add the assigned PR link and contributor credit to the affected Changelogs after creation; push that attribution before marking the Changelog checklist item complete. Do not invent a PR number or claim attribution is already complete.
- Publishing a PR, pushing, posting comments, or inviting external testing requires separate authorization. These notes authorize none of those actions.
