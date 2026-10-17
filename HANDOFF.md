# Context Viewer Handoff

## Current State

- Branch: `feat/context-viewer`. Local commits are authorized, including the user's existing handoff edit; pushing is not authorized. Check the working tree before starting work.
- Implemented: original capacity allocation, overview Compaction/Snapcompact diagnostics, footer divider, and full-block left borders for ANSI entries; shared theme-colored bracketed headings with dim token counts, a single path heading for Instruction Files, selection-only content hints, fully scrollable skill input, and thinking block numbering. Both packages have Changelog entries.
- Message entries omit redundant `user`, `assistant`, and `toolResult` metadata rows in previews and full content. Converted-message provenance, including custom types, file mentions, and local executions, remains available.
- **Native multiline entry borders are not implemented; the Native surface has not been visually verified in a Tern window.** This is incomplete functionality, not just missing tests.
- Native retains `list/item` selection styling and entry id/select/activate events. The user has not agreed to defer this requirement or accept different appearances across renderers; do not silently reduce scope.

## Outstanding Work

1. Obtain a sanitized structural description of the user's old session to investigate why three thinking entries become one. Relevant fields: assistant message `stopReason`, each content block's `type`, thinking text length, and whether a signature exists. Neither message bodies nor signature values are needed. Do not claim that session is fixed.
2. Investigate whether existing Tern components can render multiline entries with full-block left borders; do not assume renderer changes are required.
3. The current [item](https://docs.stencil.so/tern/elements/lists.md#item) does not wrap, truncates detail, and ignores children. The [common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes) `mark: "pick"` is an investigation starting point, not proof that the requirement is supported.
4. Obtain a Tern environment and visually verify the overview, categories, full content, selection/activation, Esc, resize, and footer. Node/event tests do not replace visual verification.
5. If existing capabilities are insufficient, present renderer-extension or appearance-difference options to the user. Pushing, PRs, external posts, and invitations to test are not authorized.

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
- Thinking evidence: two encoded blocks and one plaintext block in the same assistant message remain three entries through SessionManager context reconstruction, snapshot generation, and the actual TUI. A separate sample session with three thinking entries and two `error`/`aborted` turns retains three entries in the transcript but only one in active context. This follows the replay-filtering contract in `session-context.ts`; it does not establish the cause in the user's session. Replay, compaction, and the original session are unchanged.

## Environment Constraints

- No local Tern executable is available. Windows `xd://tui` lacks `/bin/sh`, and the CLI may identify a bash PTY as non-TTY.
- `PtySession.startArgv()` can launch the production `packages/coding-agent/src/cli.ts`; use `packages/tui/test/virtual-terminal.ts` to observe the screen.
- Use a temporary agent directory with `setupVersion: 999` in its `config.yml` to avoid onboarding without changing user settings. ConPTY handles terminal replies; do not resend VirtualTerminal CPR replies.
- Known unrelated issue: the `pm`/Chinese afternoon locale difference in `packages/tui/test/usage-native-describe.test.ts:452`. Do not fix it as part of this feature.
