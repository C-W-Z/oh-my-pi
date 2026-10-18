# Context Viewer pull request draft

## What

Adds a read-only `/context` viewer for the active prompts, instruction files, skills, tools, conversation messages, thinking blocks, and tool output. It opens on demand, snapshots the current context when opened, and supports category navigation, bounded previews, and scrollable full-content inspection. The viewer includes context-usage and compaction estimates, source attribution, localized message timestamps, and tool-call IDs. Navigation follows configured keybindings.

**Contributor statement required before submission:** The contributor must add at least one sentence in their own words explaining what changed and why, as required by `CONTRIBUTING.md`. This draft does not supply that personal statement.

## Why

The viewer makes the active context inspectable without submitting the composer draft or interrupting a background turn. It intentionally does not invoke extension `context` / `before_provider_request` hooks or configured request conversion: running that user-defined logic just to inspect context could cause side effects. Instead, the snapshot uses the shared base message conversion. This keeps inspection out of the request pipeline, but means the viewer cannot guarantee an exact match with the payload actually sent to the provider after hooks, request conversion, and provider encoding. It is not a raw transcript; category token counts and allocation shares are estimates.

## Testing

Tern is not available in the current environment, so the Native interface has not been visually verified. Native multiline entry borders are not implemented. This is an outstanding UI limitation, not an accepted appearance difference; node and reconciliation checks do not establish visual correctness. Do not claim ANSI and Native are visually equivalent or fully verified.

Previously recorded verification from the implementation/review notes (not rerun during this documentation and changelog consolidation):

- Functional and adjacent regression checks: 141 passed, 0 failed across 11 test files; package-local `bun check` passed for `packages/coding-agent` and `packages/tui`.
- Prompt/template compatibility checks: 94 passed, 1 failed across 8 test files. `packages/coding-agent/test/system-prompt-template.test.ts:150` expected a user-level `SYSTEM.md` but received `undefined`. Do not report all related tests as passing.
  - The discovery fixture changes home without isolating `PI_CODING_AGENT_DIR`. A separate temporary-directory smoke reproduced `undefined` with an override pointing elsewhere and correctly selected `SYSTEM.md` when the search directory matched the fixture.
  - Related upstream work: [#14013](https://github.com/can1357/oh-my-pi/pull/14013) includes override isolation in the same `withDiscoveryHome()` helper, but is closed without merging; it is not a shipped fix.
  - The relevant discovery, resolver, and test code is unchanged from branch base `d060e142cc`. The original failing run's execution order is not recorded, and the full compatibility suite has not been run on that baseline; the evidence does not establish which preceding test or environment supplied the override in that run.
- A later targeted follow-up recorded 34 passing, 0 failing tests across `context-viewer.test.ts` and `context-view.test.ts`, with both package-local `bun check` commands passing.
- Recorded Native checks exercised activation and reconciliation state, not Tern visuals. Recorded CLI/TUI checks used ConPTY; they are not substitutes for the missing Tern check.

No repository-wide `bun check` result is recorded. Before submission, the contributor must review the complete branch diff, exercise the feature personally, and report the exact checks and scenarios actually run. The repository's PR template also requires checking only verified checklist items.

## Maintainer notes

- `CONTRIBUTING.md` requires prior Discord discussion before implementing a major feature or broad UI / multi-package change. The available branch notes do not establish whether that discussion occurred; confirm it before opening the PR.
- Native multiline entry borders remain unimplemented, and the Native surface still needs investigation in Tern: inspect existing components first, then determine whether a renderer extension is needed. Verify overview, categories, full content and its tail, selection/activation, scrolling, Esc/return behavior, resize, and footer.
- The viewer snapshots on open using shared `convertToLlm` behavior. It does not invoke configured request conversion, provider encoding, extension request hooks, or a viewer-specific abort filter. Opening may warm shared conversion caches and copy the runtime-only per-call context marker; message content and session history are not edited.

### Maintainer decision: legacy context UI and API

The CLI now uses `ContextViewer`, but this branch retains the legacy static context UI and its exported APIs: `ContextUsageView`, `renderContextUsage`, `describeContextUsage`, and `contextUsageHead`. Repository references were reported to be limited to definitions and tests; external consumers of these package exports are unknown.

Please decide whether to retain the legacy UI/API for compatibility or remove them as part of this change:

- **Retain:** preserve compatibility for external consumers, at the cost of keeping a second context UI implementation and its dedicated tests.
- **Remove:** delete the obsolete UI, exports, and dedicated tests while retaining the new viewer and shared context calculations, token estimates, compaction boundaries, and diagnostics. This would break external consumers using the removed exports and requires a `Breaking Changes` entry.

Neither option is assumed to be approved; the current branch leaves the legacy UI/API intact pending maintainer direction.

## Checklist

- [ ] Contributor added their own sentence to **What** explaining what changed and why.
- [ ] Required prior Discord discussion is confirmed.
- [ ] Contributor reviewed every changed file and exercised the feature personally.
- [ ] Testing claims and repository-wide `bun check` status reflect checks actually run.
- [ ] `CHANGELOG.md` attribution is completed after a PR number is assigned, if this is an external contribution.
