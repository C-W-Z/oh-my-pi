# Context Viewer Handoff

## Status and permissions

- Branch: `feat/context-viewer`. Check the working tree before editing; local commits authorized. Pushing, PR creation, external posts, and invitations to test require separate authorization.
- ANSI viewer and whole-sequence base `convertToLlm` projection implemented; both packages have Changelog entries. No non-Tern implementation work remains in the current scope.
- Native multiline entry borders remain unimplemented; Native visuals remain unverified. All Tern work is deferred by the user until an environment is available, not waived or accepted as an appearance difference.
- Maintainer-facing scope, conversion/cache semantics, behavioral contracts, verification commands/evidence, and PR prerequisites: [CONTEXT_VIEWER_PR_NOTES.md](CONTEXT_VIEWER_PR_NOTES.md). Read it before preparing a PR; it is not a final PR description.

## Deferred Tern work

1. Investigate existing components before proposing renderer changes. [`item`](https://docs.stencil.so/tern/elements/lists.md#item) does not wrap, truncates detail, and ignores children; [common props](https://docs.stencil.so/tern/elements/index.md#props-every-node-takes) `mark: "pick"` is only an investigation lead, not proof of multiline-border support.
2. In Tern, visually verify overview, categories, full content, selection/activation, Esc, resize, and footer. Node/event checks do not replace visual verification.
3. If existing components cannot meet the requirement, present renderer-extension or appearance-difference options to the user.

## Keep intact

- Snapshot active context only on open through shared batch conversion; preserve source attribution after omissions/splits. No request hooks/provider pipeline, journal approximation, per-request capture, or viewer-specific abort filter.
- Viewer owns display data and sorting; do not mutate converter outputs. Shared cache warming and idempotent runtime Symbol assignments are intentional, not message-content edits.
- Preserve capacity allocation, raw estimates, original body paths, terminal sanitization, bounded previews, full-content/skill tails, oversized-entry scrolling, Enter/Esc positions, empty/single-entry categories, prompt provenance/rollback, and shared `ContextUsageView`; detailed contracts are in the PR notes.
- Comments/docs in English. Non-English fixture input is allowed for character-width, wrapping, and scrolling checks.

## Entry points and verification

- `packages/coding-agent/src/session/context-view.ts`: snapshot; `src/session/messages.ts`: shared conversion.
- `packages/tui/src/overlays/context-viewer.ts`: rendering/navigation; `src/chrome/context-map.ts` and `src/status-line/context-usage.ts`: capacity/map calculations.
- `packages/wire/src/tsp.ts`: Native types.
- Recorded checks: **108 pass, 0 fail**; both package-local `bun check` commands pass. [Verification commands and evidence](CONTEXT_VIEWER_PR_NOTES.md#verification). Documentation-only edits need no program-test rerun.

## Windows smoke setup

- No local Tern; Windows `xd://tui` lacks `/bin/sh`, and a bash PTY may appear non-TTY to the CLI.
- Launch production `packages/coding-agent/src/cli.ts` with `PtySession.startArgv()`; observe via `packages/tui/test/virtual-terminal.ts`. Use a temporary agent directory with `setupVersion: 999` in `config.yml`; do not alter user settings or resend VirtualTerminal CPR replies handled by ConPTY.
- Unrelated known failure: `pm`/Chinese afternoon locale mismatch in `packages/tui/test/usage-native-describe.test.ts:452`; do not fix in this scope.
