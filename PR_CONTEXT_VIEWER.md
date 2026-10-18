# feat(coding-agent): make context content inspectable in /context

*(Most of description in What & Why was written by me, with ChatGPT assisting with translation.)*

I added this feature because I often want to inspect the actual context, but current way to do that (like `/dump`) is not very convenient.

## What

<!-- Brief description of the change. Include at least one sentence in your own words explaining what changed and why, as required by CONTRIBUTING.md. -->

Replaces `/context` with an interactive, read-only Context Viewer, inspired by [pi-context-view](https://github.com/dimk90/pi-context-view).

- Inspect system prompt content, instruction-file content already included in the context, skill descriptions, active tool definitions, conversation messages, thinking blocks, tool calls, and tool outputs, rather than just context usage statistics and token estimates.
- Navigate and inspect content interactively, with configurable keybindings.
- View estimated context usage broken down by tool (e.g. `read`, `bash`), with direct access to individual tool outputs.
- Preserve the existing context usage and compaction diagnostics.
- Open the viewer without submitting the current draft or interrupting a background turn.

### Additional Changes

Added a new keybinding, `tui.context.toggleFit` (default: `z`), to switch the context map between Window and Fit modes. This allows users to zoom out and view the entire context map, similar to pi-context-view.

This isn't essential to the viewer, so I'm happy to remove it if it feels unnecessary.

### Demo

[Initial demo (in Discord)](https://discord.com/channels/1465833614603325562/1465867712000692459/1561055277967609956)

A more polished demo video will be added later.

## Why

<!-- Motivation, context, or link to issue (fixes #N) -->

### Motivation

I originally used Pi before switching to OMP, and inspecting the actual system prompt through `/context` was one of my most frequently used features.

I often customize my agent by enabling or disabling skills and tools to avoid filling the context with irrelevant information. I also develop extensions, so being able to inspect the actual context helps me verify whether my changes are taking effect.

Having everything in one place, including the actual content and estimated token usage of individual skills and tool definitions, makes this much easier.

Another useful feature is the per-tool breakdown of context usage. Instead of just knowing that tool outputs take up a lot of space, users can see which tools are responsible and inspect their outputs to understand why.

This also partially addresses [#7860](https://github.com/can1357/oh-my-pi/issues/7860), which requests better visibility into tool-result context usage.

A possible future improvement would be to highlight how extensions modify the system prompt, making those changes easier to trace. Some resulting content may already be visible, but the viewer doesn't attribute modifications to individual extensions yet. This is outside the scope of the current PR.

### Implementation Decisions

The viewer only takes a snapshot of the current session context when `/context` is opened. It doesn't run extension hooks, provider request hooks, or configured request conversion, to avoid triggering unintended side effects.

The conversation messages still go through OMP's shared message conversion (`convertToLlm`), rather than being shown directly from the raw session history. Together with the current system prompt and active tool definitions, this gives users a way to inspect what's already in the session context.

However, the displayed content and token estimates may still differ from the actual context sent to the provider, particularly when hooks, configured request conversion, or provider-specific transformations are involved.

## Maintainer Decision Needed: Legacy Context UI/API

The CLI now uses the new `/context` viewer instead of the old static Context UI. The old UI and its exported APIs are still kept in this branch: `ContextUsageView`, `renderContextUsage`, `describeContextUsage`, and `contextUsageHead`.

Apart from tests, nothing in the repository uses these APIs internally.

However, I can't guarantee that external extensions aren't relying on those APIs, so removing them could introduce a breaking change. Removing them would also need a `Breaking Changes` entry.

Personally, I'd prefer removing the legacy UI and API, since maintaining an unused UI solely for backward compatibility would add unnecessary maintenance overhead.

I'd appreciate your thoughts on whether we should keep the old API for compatibility or remove it as part of this change.

## Testing

<!-- How was this tested? -->

The related feature and compatibility tests were run together on Windows with Bun 1.4.3, omp 18.11.3, with **325 passed and 1 failed across 25 test files**.

These tests cover:

- Whether the snapshot shows prompt sources, active tools, thinking blocks, and tool outputs correctly, without counting the same content twice, and keeps its content unchanged when the session changes.
- Navigating categories and full content, reaching the end of long outputs, switching between Window and Fit modes, resizing, remapping or unbinding keys, handling text safely, and updating the theme. Native event handling and reconciliation are also covered.
- Opening `/context` during a background turn without aborting it or submitting the draft, restoring focus and the draft afterward, reloading context files, switching sessions and restoring the previous state when a switch fails, and changing tools while the prompt is frozen for prefix binding.
- Building prompts without duplicate content, showing tool inventories, choosing between literal and Handlebars prompts, using SDK prompt overrides, and refreshing context files. The failing discovery test below is part of this group.
- Resolving and displaying keybindings, including migration from older configurations.

Package-local `bun run check` also passed for both `packages/coding-agent` and `packages/tui`, including lint, formatting, and type checks.

<details>
<summary>Full test command (run from the repository root)</summary>

```sh
bun test --only-failures \
  packages/coding-agent/test/modes/context-view.test.ts \
  packages/coding-agent/test/modes/context-usage.test.ts \
  packages/coding-agent/test/agent-session-context-file-reload.test.ts \
  packages/coding-agent/test/agent-session-switch-prev-context.test.ts \
  packages/coding-agent/test/issue-4806-command-output.test.ts \
  packages/coding-agent/test/prefix-binding-tool-roster.test.ts \
  packages/coding-agent/test/sdk-context-file-refresh.test.ts \
  packages/coding-agent/test/session-messages.test.ts \
  packages/coding-agent/test/skill-prompt-message.test.ts \
  packages/coding-agent/test/prompt-templates.test.ts \
  packages/coding-agent/test/prompt-format.test.ts \
  packages/coding-agent/test/system-prompt-context-dedup.test.ts \
  packages/coding-agent/test/system-prompt-dedup.test.ts \
  packages/coding-agent/test/system-prompt-inventory.test.ts \
  packages/coding-agent/test/system-prompt-kernel.test.ts \
  packages/coding-agent/test/system-prompt-model.test.ts \
  packages/coding-agent/test/system-prompt-personality.test.ts \
  packages/coding-agent/test/system-prompt-template.test.ts \
  packages/coding-agent/test/sdk-system-prompt-template.test.ts \
  packages/tui/test/context-map.test.ts \
  packages/tui/test/context-viewer.test.ts \
  packages/tui/test/context-usage.test.ts \
  packages/tui/test/keybindings.test.ts \
  packages/tui/test/keybindings-display.test.ts \
  packages/tui/test/keybindings-migration.test.ts
```

</details>

### CLI/TUI Interaction Checks

CLI/TUI interactions were also checked using Windows ConPTY, with a temporary profile and a saved fixture session containing `read` and `bash` results. A smoke script sent keyboard input to the actual CLI and checked the captured terminal screens. No user prompt was sent to a provider.

- Opened `/context` at 120×36 and switched Window → Fit → Window.
- Opened the System Prompt preview and full content, then returned to the overview.
- Opened the `read` entry under Tool Output and used End to reach the final line.
- Resized to 72×20 and checked that the final line was still reachable.
- Returned to the overview, closed the viewer, and checked that an unsent draft could be entered in the composer.
- Closed the CLI normally with exit code 0.

### Pre-existing Test Failure

The failure occurred in `packages/coding-agent/test/system-prompt-template.test.ts:150`, where the test expected a user-level `SYSTEM.md` to take precedence over `SYSTEM_TEMPLATE.md`, but received `undefined`.

The same failure was reproduced on `main` at commit [`ba85aef0b3`](https://github.com/can1357/oh-my-pi/commit/ba85aef0b343a25f3c90b4f86628a9bd92d8414d) (24 passed, 1 failed), while the test passes in isolation.

The cause is test isolation: `system-prompt-personality.test.ts` leaves `PI_CODING_AGENT_DIR` set, which the discovery fixture doesn't reset. This issue is not introduced by this PR. A related fix was proposed in [#14013](https://github.com/can1357/oh-my-pi/pull/14013), but it was closed without merging.

### Known Issues and Things Not Yet Verified

- Native multiline entry borders aren't implemented yet.
- Native UI rendering and interaction haven't been visually checked in an actual Tern environment. The Native event and reconciliation tests don't tell us whether it looks and behaves correctly in Tern.
- Repository-wide `bun check` hasn't been run.

## Before Merge

- [ ] Verify and polish the Native UI once Tern access is available.
- [ ] Add Native multiline entry borders and fix any issues found when testing in Tern.
- [ ] Check all docs modified by this PR.
- [ ] Verify compatibility with the latest upstream `main`.
- [ ] Decide whether to keep the old Context UI/API for compatibility or remove it.

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
