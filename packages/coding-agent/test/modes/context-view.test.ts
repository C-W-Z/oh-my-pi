import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { buildSessionContextView } from "../../src/session/context-view";
import { buildSystemPrompt, type SystemPromptSources } from "../../src/system-prompt";
import {
	convertToLlm,
	invalidateConvertToLlmArrayCache,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "../../src/session/messages";
import type { ContextViewData } from "@oh-my-pi/pi-tui/overlays/context-viewer";

const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: type({ value: "string" }),
		async execute() {
			return { content: [{ type: "text", text: "result" }] };
		},
	};
}

function sessionWith(
	options: {
		prompt?: string[];
		sources?: SystemPromptSources;
		messages?: AgentMessage[];
		tools?: AgentTool[];
		settings?: Settings;
		model?: Model;
		rebuild?: () => Promise<{ systemPrompt: string[]; sources?: SystemPromptSources }>;
	} = {},
): AgentSession {
	const tools = options.tools ?? [];
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: options.model ?? model,
				systemPrompt: options.prompt ?? ["opaque system"],
				tools,
				messages: options.messages ?? [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: options.settings ?? Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		builtInToolNames: ["read"],
		systemPromptSources: options.sources,
		rebuildSystemPrompt: options.rebuild,
	});
	sessions.push(session);
	return session;
}

function category(data: ContextViewData, id: string) {
	return data.categories.find(category => category.id === id)!;
}

const reply = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 24,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 24,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 10,
});

describe("context snapshot", () => {
	it("retains compaction thresholds and computes optional wire savings without changing content capacity", () => {
		const prompt = ["Repeated context policy for the next model request.\n".repeat(1000)];
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"todo.enabled": false,
			"snapcompact.systemPrompt": "all",
		});
		const session = sessionWith({ prompt, settings });
		const data = buildSessionContextView(session);
		expect(data.breakdown.thresholdTokens).toBeGreaterThan(0);
		expect(data.breakdown.snapcompact?.systemPrompt).toMatchObject({ applied: true, scope: "all" });
		expect(data.breakdown.snapcompact?.savedTokens).toBeGreaterThan(0);
		const plain = buildSessionContextView(sessionWith({ prompt }));
		expect(plain.breakdown.snapcompact).toBeUndefined();
		expect(data.estimatedTokens).toBe(plain.estimatedTokens);
		expect(data.free + data.buffer + data.usage).toBe(data.window);
	});

	it("keeps provider-anchored capacity when raw prompt estimates exceed the window", () => {
		const message = reply([{ type: "text", text: "saved answer" }]);
		message.usage.input = 100;
		message.usage.totalTokens = 124;
		const session = sessionWith({
			prompt: ["large prompt ".repeat(120000)],
			messages: [message],
			settings: Settings.isolated({ "compaction.enabled": true, "todo.enabled": false }),
		});
		const data = buildSessionContextView(session);
		expect(data.estimatedTokens).toBeGreaterThan(data.window);
		expect(data.usage).toBe(100);
		expect(data.buffer).toBeGreaterThan(0);
		expect(data.free + data.buffer).toBe(data.window - 100);
	});

	it("previews actual static sources before the first message without reading skill or instruction files", async () => {
		const built = await buildSystemPrompt({
			cwd: import.meta.dir,
			personality: "none",
			activeRepoContext: null,
			contextFiles: [{ path: "/nonexistent/instructions.md", content: "Unique instruction body" }],
			skills: [
				{
					name: "fixture",
					description: "Frozen skill hint",
					filePath: "/nonexistent/SKILL.md",
					baseDir: "/nonexistent",
					source: "user",
				},
			],
		});
		const session = sessionWith({ prompt: built.systemPrompt, sources: built.sources, tools: [tool("read")] });
		const file = vi.spyOn(Bun, "file");
		const data = buildSessionContextView(session);
		expect(category(data, "instruction-files").entries.map(entry => entry.text)).toEqual([
			expect.stringContaining("Unique instruction body"),
		]);
		expect(category(data, "skills").entries.map(entry => entry.text)).toEqual([
			expect.stringContaining("Frozen skill hint"),
		]);
		expect(
			category(data, "system-prompt")
				.entries.map(entry => entry.text)
				.join("\n"),
		).not.toContain("Unique instruction body");
		const systemEntry = category(data, "system-prompt").entries[0]!;
		const skillEntry = category(data, "skills").entries[0]!;
		expect(systemEntry.text).toContain("<skills>\n[Shown in Skills: fixture]\n</skills>");
		expect(built.systemPrompt[0]).toContain(skillEntry.text);
		expect(built.systemPrompt[0]).not.toContain("[Shown in");
		expect(systemEntry.tokens).toBe(
			session.agent.tokenizer.countTokens(built.systemPrompt[0]!.replace(skillEntry.text, "")),
		);
		expect(file).not.toHaveBeenCalled();
		expect(data.categories.map(category => category.id)).toEqual([
			"system-prompt",
			"instruction-files",
			"skills",
			"built-in-tools",
			"custom-tools",
			"user-messages",
			"assistant-messages",
			"assistant-thinking",
			"tool-calls",
			"tool-output",
		]);
	});

	it("attributes instruction files and XML skills delivered with a literal custom prompt without double-counting", async () => {
		const built = await buildSystemPrompt({
			cwd: import.meta.dir,
			customPrompt: "Literal custom prompt.",
			personality: "none",
			activeRepoContext: null,
			contextFiles: [{ path: "/nonexistent/instructions.md", content: "Unique instruction body" }],
			skills: [
				{
					name: "fixture",
					description: "Use <T> & {{literal}} without expansion",
					filePath: "/nonexistent/SKILL.md",
					baseDir: "/nonexistent",
					source: "user",
				},
			],
		});
		const session = sessionWith({ prompt: built.systemPrompt, sources: built.sources, tools: [tool("read")] });
		const data = buildSessionContextView(session);
		const instructionEntries = category(data, "instruction-files").entries;
		const systemPromptText = category(data, "system-prompt")
			.entries.map(entry => entry.text)
			.join("\n");

		expect(instructionEntries).toHaveLength(1);
		expect(instructionEntries[0]?.text).toContain("Unique instruction body");
		expect(systemPromptText).toContain("Literal custom prompt.");
		expect(systemPromptText).not.toContain("Unique instruction body");
		expect(data.notices).toEqual([]);
		const skillEntries = category(data, "skills").entries;
		expect(skillEntries.map(entry => entry.label)).toEqual(["fixture"]);
		const fragment = skillEntries[0]!.text;
		expect(fragment).toContain('<skill name="fixture">');
		expect(fragment).toContain("Use <T> & {{literal}} without expansion");
		expect(built.systemPrompt[0]).toContain(fragment);
		expect(systemPromptText).not.toContain("Use <T>");
		expect(systemPromptText).toContain("<skills>\n[Shown in Skills: fixture]\n</skills>");
		expect(built.systemPrompt[0]).not.toContain("[Shown in");
		expect(category(data, "system-prompt").entries[0]!.tokens).toBe(
			session.agent.tokenizer.countTokens(built.systemPrompt[0]!.replace(fragment, "")),
		);
		expect(category(data, "skills").tokens).toBe(session.agent.tokenizer.countTokens(fragment));
	});

	it("keeps duplicate prompt blocks unattributed instead of pairing them by occurrence", () => {
		const sources: SystemPromptSources = {
			blocks: ["prefix FILE suffix", "prefix FILE suffix"],
			sources: [{ id: "file", blockIndex: 1, kind: "instruction-files", label: "rules", fragment: "FILE" }],
		};
		const session = sessionWith({ prompt: [...sources.blocks], sources });
		const data = buildSessionContextView(session);
		expect(category(data, "instruction-files").entries).toEqual([]);
		expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual([...sources.blocks]);
		expect(data.estimatedTokens).toBe(2 * session.agent.tokenizer.countTokens(sources.blocks[0]!));
		expect(data.notices).toHaveLength(1);
	});

	it("keeps missing, changed, reordered and non-unique blocks or fragments entirely in System Prompt", () => {
		const source = {
			id: "file",
			blockIndex: 0,
			kind: "instruction-files" as const,
			label: "rules",
			fragment: "FILE",
		};
		const cases: { blocks: string[]; prompt: string[]; fragment?: string; blockIndex?: number }[] = [
			{ blocks: ["prefix FILE suffix"], prompt: ["rewritten FILE"] },
			{ blocks: ["prefix FILE suffix"], prompt: [] },
			{ blocks: ["prefix FILE suffix", "other"], prompt: ["other", "prefix FILE suffix"] },
			{ blocks: ["prefix FILE suffix"], prompt: ["prefix FILE suffix", "prefix FILE suffix"] },
			{ blocks: ["FILE FILE"], prompt: ["FILE FILE"] },
			{ blocks: ["AAA"], prompt: ["AAA"], fragment: "AA" },
			{ blocks: ["prefix FILE suffix"], prompt: ["prefix FILE suffix"], fragment: "MISSING" },
			{ blocks: ["prefix FILE suffix"], prompt: ["prefix FILE suffix"], fragment: "" },
			{ blocks: ["prefix FILE suffix"], prompt: ["prefix FILE suffix"], blockIndex: -1 },
		];
		for (const fixture of cases) {
			const sources: SystemPromptSources = {
				blocks: fixture.blocks,
				sources: [
					{
						...source,
						fragment: fixture.fragment ?? source.fragment,
						blockIndex: fixture.blockIndex ?? source.blockIndex,
					},
				],
			};
			const session = sessionWith({ prompt: fixture.prompt, sources });
			const data = buildSessionContextView(session);
			expect(category(data, "instruction-files").entries).toEqual([]);
			expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual(fixture.prompt);
			expect(data.estimatedTokens).toBe(
				fixture.prompt.reduce((sum, block) => sum + session.agent.tokenizer.countTokens(block), 0),
			);
			expect(data.notices).toHaveLength(1);
		}
	});

	it("rejects every overlapping source independent of category and metadata order", () => {
		const cases: SystemPromptSources["sources"][] = [
			[
				{ id: "file", blockIndex: 0, kind: "instruction-files", label: "rules", fragment: "ABCD" },
				{ id: "skill", blockIndex: 0, kind: "skills", label: "skill", fragment: "BCDE" },
			],
			[
				{ id: "first", blockIndex: 0, kind: "instruction-files", label: "first", fragment: "ABCD" },
				{ id: "second", blockIndex: 0, kind: "instruction-files", label: "second", fragment: "BCDE" },
			],
			[
				{ id: "first", blockIndex: 0, kind: "instruction-files", label: "first", fragment: "ABCDE" },
				{ id: "second", blockIndex: 0, kind: "skills", label: "second", fragment: "ABCDE" },
			],
			[
				{ id: "first", blockIndex: 0, kind: "instruction-files", label: "first", fragment: "AB" },
				{ id: "middle", blockIndex: 0, kind: "skills", label: "middle", fragment: "BCD" },
				{ id: "last", blockIndex: 0, kind: "instruction-files", label: "last", fragment: "DE" },
			],
			[
				{ id: "duplicate", blockIndex: 0, kind: "instruction-files", label: "first", fragment: "AB" },
				{ id: "duplicate", blockIndex: 0, kind: "skills", label: "last", fragment: "DE" },
			],
		];
		for (const sources of cases) {
			for (const ordered of [sources, [...sources].reverse()]) {
				const session = sessionWith({ prompt: ["ABCDE"], sources: { blocks: ["ABCDE"], sources: ordered } });
				const data = buildSessionContextView(session);
				expect(category(data, "instruction-files").entries).toEqual([]);
				expect(category(data, "skills").entries).toEqual([]);
				expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual(["ABCDE"]);
				expect(data.estimatedTokens).toBe(session.agent.tokenizer.countTokens("ABCDE"));
				expect(data.notices).toHaveLength(1);
			}
		}
	});

	it("does not attribute a unique fragment that overlaps a repeated ambiguous fragment", () => {
		for (const blockIndex of [0, -1]) {
			const session = sessionWith({
				prompt: ["FILE FILE"],
				sources: {
					blocks: ["FILE FILE"],
					sources: [
						{ id: "file", blockIndex, kind: "instruction-files", label: "rules", fragment: "FILE" },
						{ id: "skill", blockIndex: 0, kind: "skills", label: "skill", fragment: "FILE FILE" },
					],
				},
			});
			const data = buildSessionContextView(session);
			expect(category(data, "instruction-files").entries).toEqual([]);
			expect(category(data, "skills").entries).toEqual([]);
			expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual(["FILE FILE"]);
			expect(data.estimatedTokens).toBe(session.agent.tokenizer.countTokens("FILE FILE"));
			expect(data.notices).toHaveLength(1);
		}
	});

	it("retains disjoint sources while leaving all overlapping content and marker-free tokens in System Prompt", () => {
		const session = sessionWith({
			prompt: ["ABCDE SAFE"],
			sources: {
				blocks: ["ABCDE SAFE"],
				sources: [
					{ id: "first", blockIndex: 0, kind: "instruction-files", label: "first", fragment: "ABCD" },
					{ id: "second", blockIndex: 0, kind: "skills", label: "second", fragment: "BCDE" },
					{ id: "safe", blockIndex: 0, kind: "skills", label: "safe", fragment: "SAFE" },
				],
			},
		});
		const data = buildSessionContextView(session);
		expect(category(data, "instruction-files").entries).toEqual([]);
		expect(category(data, "skills").entries.map(entry => entry.text)).toEqual(["SAFE"]);
		const system = category(data, "system-prompt");
		expect(system.entries[0]!.text).toBe("ABCDE [Shown in Skills: safe]");
		expect(system.tokens).toBe(session.agent.tokenizer.countTokens("ABCDE "));
		expect(data.estimatedTokens).toBe(
			session.agent.tokenizer.countTokens("ABCDE ") + session.agent.tokenizer.countTokens("SAFE"),
		);
		expect(data.notices).toHaveLength(1);
	});

	it("retains missing and non-unique rendered skill metadata so incomplete attribution is visible", async () => {
		for (const template of [
			"Prompt without skill delivery",
			"{{#each skills}}{{contextViewerFragment}}\n{{contextViewerFragment}}{{/each}}",
		]) {
			const built = await buildSystemPrompt({
				cwd: import.meta.dir,
				personality: "none",
				activeRepoContext: null,
				systemPromptTemplate: template,
				contextFiles: [],
				skills: [
					{
						name: "fixture",
						description: "Frozen skill hint",
						filePath: "/nonexistent/SKILL.md",
						baseDir: "/nonexistent",
						source: "user",
					},
				],
			});
			expect(built.sources?.sources).toHaveLength(1);
			expect(built.sources?.sources[0]?.blockIndex).toBe(-1);
			const session = sessionWith({ prompt: built.systemPrompt, sources: built.sources });
			const data = buildSessionContextView(session);
			expect(category(data, "skills").entries).toEqual([]);
			expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual(built.systemPrompt);
			expect(data.estimatedTokens).toBe(
				built.systemPrompt.reduce((sum, block) => sum + session.agent.tokenizer.countTokens(block), 0),
			);
			expect(data.notices).toHaveLength(1);
		}
	});

	it("keeps a source-only block's location visible without charging tokens for the display marker", () => {
		const sources: SystemPromptSources = {
			blocks: ["FILE"],
			sources: [{ id: "file", blockIndex: 0, kind: "instruction-files", label: "rules", fragment: "FILE" }],
		};
		const session = sessionWith({ prompt: [...sources.blocks], sources });
		const data = buildSessionContextView(session);
		const systemEntries = category(data, "system-prompt").entries;
		expect(systemEntries.map(entry => entry.label)).toEqual(["System Block 1"]);
		expect(systemEntries[0]!.text).toContain("Instruction Files: rules");
		expect(category(data, "system-prompt").tokens).toBe(0);
		expect(category(data, "instruction-files").entries.map(entry => entry.text)).toEqual(["FILE"]);
		expect(data.estimatedTokens).toBe(session.agent.tokenizer.countTokens("FILE"));
		expect(session.systemPrompt).toEqual(["FILE"]);
	});

	it("separates assistant blocks without charging reasoning usage repeatedly and never exposes signatures", () => {
		const message = reply([
			{ type: "text", text: "visible answer" },
			{ type: "thinking", thinking: "readable thought", thinkingSignature: "private-signature" },
			{ type: "thinking", thinking: "", thinkingSignature: "private-encoded-thinking" },
			{ type: "redactedThinking", data: "private-ciphertext" },
			{ type: "toolCall", name: "read", id: "duplicate", arguments: { path: "notes.txt" } },
		]);
		const session = sessionWith({ prompt: [], messages: [message] });
		const data = buildSessionContextView(session);
		expect(category(data, "assistant-messages").entries.map(entry => entry.text)).toEqual(["visible answer"]);
		expect(category(data, "assistant-thinking").entries.map(entry => entry.text)).toEqual([
			"readable thought",
			"[Encoded thinking]",
			"[Redacted thinking]",
		]);
		expect(category(data, "tool-calls").entries[0]?.text).toContain('"path": "notes.txt"');
		expect(data.estimatedTokens).toBe(session.agent.tokenizer.countMessages([message]));
		expect(JSON.stringify(data)).not.toMatch(/private-signature|private-encoded-thinking|private-ciphertext/);
	});

	it("prices the latest surviving signed turn until a newer assistant response survives replay", () => {
		const message: AssistantMessage = {
			...reply([
				{ type: "thinking", thinking: "retained excerpt", thinkingSignature: "private-signature" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "notes.md" } },
			]),
			stopReason: "length",
			usage: { ...reply([]).usage, output: 1000 },
		};
		const session = sessionWith({ prompt: [], messages: [message] });
		const initial = buildSessionContextView(session);
		expect(initial.estimatedTokens).toBe(1000);
		expect(category(initial, "assistant-thinking").tokens).toBe(1000 - category(initial, "tool-calls").tokens);

		session.agent.appendMessage({ ...reply([]), stopReason: "length" });
		expect(buildSessionContextView(session).estimatedTokens).toBe(1000);

		const next = reply([{ type: "text", text: "new response" }]);
		session.agent.appendMessage(next);
		const updated = buildSessionContextView(session);
		expect(updated.estimatedTokens).toBe(
			session.agent.tokenizer.countMessage(message) + session.agent.tokenizer.countMessage(next),
		);
		expect(category(updated, "assistant-thinking").tokens).toBe(
			session.agent.tokenizer.countTokens("retained excerpt"),
		);
		expect(initial.estimatedTokens).toBe(1000);
		expect(JSON.stringify(updated)).not.toContain("private-signature");
	});

	it("groups retained server-tool calls and results without exposing encrypted replay fields", () => {
		const message = reply([
			{
				type: "anthropicServerTool",
				block: { type: "server_tool_use", id: "search", name: "web_search", input: { query: "release notes" } },
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "tools",
					name: "tool_search_tool_regex",
					input: { pattern: "read.*" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "tool_search_tool_result",
					tool_use_id: "tools",
					content: [{ type: "tool_reference", tool_name: "read_file" }],
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "web_search_tool_result",
					tool_use_id: "search",
					content: [
						{
							type: "web_search_result",
							title: "Release notes",
							url: "https://example.org/releases",
							encrypted_content: "private-ciphertext",
							signature: "private-signature",
						},
					],
				},
			},
		]);
		const session = sessionWith({ prompt: [], messages: [message] });
		const before = structuredClone(message);
		const data = buildSessionContextView(session);
		const calls = category(data, "tool-calls").entries;
		expect(calls.map(entry => [entry.label, entry.callId])).toEqual([
			["web_search", "search"],
			["tool_search_tool_regex", "tools"],
		]);
		expect(JSON.parse(calls[0]!.text).input).toEqual({ query: "release notes" });
		const results = category(data, "tool-output");
		expect(results.entries.map(entry => [entry.label, entry.callId, entry.timestamp])).toEqual([
			["tool_search_tool_regex", "tools", message.timestamp],
			["web_search", "search", message.timestamp],
		]);
		expect(JSON.parse(results.entries[0]!.text).content).toEqual([
			{ type: "tool_reference", tool_name: "read_file" },
		]);
		expect(JSON.parse(results.entries[1]!.text).content).toEqual([
			{ type: "web_search_result", title: "Release notes", url: "https://example.org/releases" },
		]);
		expect(category(data, "assistant-messages").entries).toEqual([]);
		expect(data.estimatedTokens).toBe(session.agent.tokenizer.countMessages([message]));
		expect(JSON.stringify(data)).not.toMatch(/private-ciphertext|private-signature/);
		expect(message).toEqual(before);
	});

	it("counts payload-only reasoning safely and does not duplicate it beside explicit thinking", () => {
		const reader = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol")!;
		const reasoning = { type: "reasoning", id: "rs_private", summary: [], encrypted_content: "private-ciphertext" };
		const text = "visible answer";
		const message: AssistantMessage = {
			...reply([{ type: "text", text }]),
			api: reader.api,
			provider: reader.provider,
			model: reader.id,
			stopReason: "stop",
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: reader.provider,
				dt: true,
				items: [reasoning, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
			},
			usage: { ...reply([]).usage, output: 6_000, totalTokens: 6_000, reasoningTokens: 1_000 },
		};
		const session = sessionWith({ model: reader, prompt: [], messages: [message] });
		const before = structuredClone(session.messages);
		const payloadOnly = buildSessionContextView(session);
		const visibleTokens = session.agent.tokenizer.countTokens(text);
		const thinking = category(payloadOnly, "assistant-thinking");
		expect(thinking.tokens).toBe(1_000);
		expect(thinking.entries).toEqual([expect.objectContaining({ tokens: 1_000, timestamp: message.timestamp })]);
		expect(category(payloadOnly, "assistant-messages").tokens).toBe(visibleTokens);
		expect(payloadOnly.estimatedTokens).toBe(visibleTokens + 1_000);
		expect(JSON.stringify(payloadOnly)).not.toMatch(/private-ciphertext|rs_private|encrypted_content/);
		expect(session.messages).toEqual(before);

		const explicit: AssistantMessage = {
			...message,
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
				{ type: "text", text },
			],
		};
		const withBlock = buildSessionContextView(sessionWith({ model: reader, prompt: [], messages: [explicit] }));
		expect(category(withBlock, "assistant-thinking").entries).toHaveLength(1);
		expect(category(withBlock, "assistant-thinking").tokens).toBe(1_000);
		expect(withBlock.estimatedTokens).toBe(payloadOnly.estimatedTokens);
		expect(JSON.stringify(withBlock)).not.toMatch(/private-ciphertext|rs_private|encrypted_content/);

		session.agent.setModel(getBundledModel("openai-codex", "gpt-6-sol")!);
		const changedReader = buildSessionContextView(session);
		expect(category(changedReader, "assistant-thinking").entries).toEqual([]);
		expect(changedReader.estimatedTokens).toBe(session.agent.tokenizer.countTokens(text));

		session.agent.setModel({ ...reader, compat: { ...reader.compat, filterReasoningHistory: true } });
		const filtered = buildSessionContextView(session);
		expect(category(filtered, "assistant-thinking").entries).toEqual([]);
		expect(filtered.estimatedTokens).toBe(session.agent.tokenizer.countTokens(text));
	});

	it("projects neighboring continuity and canonical tool names without rewriting saved assistant content", () => {
		const assistant = {
			...reply([
				{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "signature" },
				{ type: "thinking", thinking: "", thinkingSignature: "encoded" },
				{ type: "toolCall", name: "xd://recall", id: "call", arguments: { query: "history" } },
				{ type: "text", text: "assistant answer" },
				{ type: "thinking", thinking: "incomplete trailing reasoning" },
			]),
			stopReason: "aborted",
		} satisfies AssistantMessage;
		const messages: AgentMessage[] = [
			assistant,
			{
				role: "custom",
				customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
				content: "preserved continuity",
				display: false,
				attribution: "agent",
				timestamp: 11,
			},
			{
				role: "toolResult",
				toolName: "xd://recall",
				toolCallId: "call",
				content: [{ type: "text", text: "remembered result" }],
				isError: false,
				timestamp: 12,
			},
		];
		const session = sessionWith({ messages });
		const before = structuredClone(session.messages);
		const projected = convertToLlm(session.messages);
		const data = buildSessionContextView(session);
		expect(category(data, "assistant-thinking").entries.map(entry => entry.text)).toEqual([
			"signed reasoning",
			"[Encoded thinking]",
		]);
		expect(category(data, "assistant-thinking").entries.map(entry => entry.timestamp)).toEqual([10, 10]);
		expect(category(data, "assistant-messages").entries.map(entry => entry.timestamp)).toEqual([10]);
		expect(category(data, "tool-calls").entries[0]?.timestamp).toBe(10);
		expect(category(data, "tool-output").entries[0]).toMatchObject({
			label: "recall",
			timestamp: 12,
			callId: "call",
		});
		expect(category(data, "tool-calls").entries.map(entry => entry.label)).toEqual(["recall"]);
		expect(category(data, "tool-output").children?.map(group => group.label)).toEqual(["recall"]);
		expect(category(data, "user-messages").entries.map(entry => [entry.info, entry.text])).toEqual([
			["custom · interrupted-thinking → developer", "preserved continuity"],
		]);
		expect(category(data, "user-messages").entries[0]?.timestamp).toBe(11);
		expect(session.messages).toEqual(before);
		expect(buildSessionContextView(session)).toEqual(data);
		expect(convertToLlm(session.messages)).toBe(projected);
	});

	it("updates thinking on continuity-neighbor changes while preserving earlier snapshots and cached repeats", () => {
		const assistant = {
			...reply([
				{ type: "thinking", thinking: "complete reasoning", thinkingSignature: "signed" },
				{ type: "thinking", thinking: "unfinished reasoning" },
			]),
			stopReason: "aborted",
		} satisfies AssistantMessage;
		const session = sessionWith({ messages: [assistant] });
		const before = structuredClone(assistant);
		const initial = buildSessionContextView(session);
		expect(category(initial, "assistant-thinking").entries.map(entry => entry.text)).toEqual([
			"complete reasoning",
			"unfinished reasoning",
		]);
		session.agent.appendMessage({
			role: "custom",
			customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
			content: "continuity",
			display: false,
			timestamp: 11,
		});
		const projected = convertToLlm(session.messages);
		const updated = buildSessionContextView(session);
		expect(category(updated, "assistant-thinking").entries.map(entry => entry.text)).toEqual(["complete reasoning"]);
		expect(buildSessionContextView(session)).toEqual(updated);
		expect(convertToLlm(session.messages)).toBe(projected);
		session.agent.state.messages.pop();
		invalidateConvertToLlmArrayCache(session.messages);
		expect(buildSessionContextView(session)).toEqual(initial);
		expect(category(initial, "assistant-thinking").entries.map(entry => entry.text)).toEqual([
			"complete reasoning",
			"unfinished reasoning",
		]);
		expect(assistant).toEqual(before);
	});

	it("retains source and output positions across omitted executions, empty interruptions and image splits", () => {
		const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" } as const;
		const session = sessionWith({
			messages: [
				{
					role: "bashExecution",
					command: "excluded",
					output: "hidden",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: 1,
				},
				{
					role: "custom",
					customType: "image-note",
					content: [{ type: "text", text: "same body" }, image],
					display: false,
					timestamp: 2,
				},
				{
					role: "fileMention",
					files: [
						{ path: "notes.md", content: "same body" },
						{ path: "picture.png", content: "", image },
					],
					timestamp: 3,
				},
				{
					role: "pythonExecution",
					code: "print('kept')",
					output: "kept output",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 4,
				},
				{ ...reply([]), stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL },
				{ role: "user", content: "same body", timestamp: 6 },
			],
		});
		const before = structuredClone(session.messages);
		const data = buildSessionContextView(session);
		const users = category(data, "user-messages").entries;
		expect(users.map(entry => entry.id)).toEqual([
			"user-messages/1/0",
			"user-messages/1/1",
			"user-messages/2/2",
			"user-messages/2/3",
			"user-messages/5/5",
		]);
		expect(users.slice(0, 2).every(entry => entry.info?.includes("image-note"))).toBe(true);
		expect(users.slice(2, 4).every(entry => entry.info?.includes("fileMention"))).toBe(true);
		expect(users[2]?.text).toContain('<file path="notes.md">');
		expect(users[3]?.text).toContain('<file path="picture.png">');
		expect(users[4]?.info).toBeUndefined();
		const output = category(data, "tool-output");
		expect(output.children?.map(group => group.label)).toEqual(["python"]);
		expect(output.entries[0]?.id).toBe("tool-output/3/4");
		expect(output.entries[0]?.info).toContain("pythonExecution");
		expect(output.entries[0]?.text).toContain("kept output");
		expect(session.messages).toEqual(before);
		expect(buildSessionContextView(session)).toEqual(data);
	});

	it("sorts per-tool totals by tokens then first appearance and saved results by timestamp then conversation order", () => {
		const result = (name: string, text: string, timestamp: number): AgentMessage => ({
			role: "toolResult",
			toolName: name,
			toolCallId: "duplicate",
			content: [{ type: "text", text }],
			isError: false,
			timestamp,
		});
		const session = sessionWith({
			messages: [
				result("small", "b", 20),
				result("large", "large ".repeat(100), 30),
				result("small", "a", 10),
				result("small", "c", 20),
			],
		});
		const output = category(buildSessionContextView(session), "tool-output");
		expect(output.children?.map(group => group.label)).toEqual(["large", "small"]);
		expect(output.children?.[1]?.entries.map(entry => entry.text)).toEqual(["a", "b", "c"]);
		expect(output.entries.map(entry => entry.text)).toEqual(["a", "b", "c", "large ".repeat(100)]);
		expect(new Set(output.entries.map(entry => entry.id)).size).toBe(4);
		expect(output.tokens).toBe(output.children!.reduce((sum, group) => sum + group.tokens, 0));
	});

	it("uses base OMP conversion, excludes executions and counts original image content rather than display summaries", () => {
		const messages: AgentMessage[] = [
			{
				role: "bashExecution",
				command: "echo kept",
				output: "saved stdout",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{
				role: "pythonExecution",
				code: "print('excluded')",
				output: "hidden",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			},
			{ role: "custom", customType: "fixture", content: "custom body", display: false, timestamp: 3 },
			{ role: "fileMention", files: [{ path: "notes.md", content: "file contents" }], timestamp: 4 },
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 5 },
		];
		const session = sessionWith({ messages });
		const data = buildSessionContextView(session);
		expect(category(data, "tool-output").children?.map(group => group.label)).toEqual(["bash"]);
		const users = category(data, "user-messages").entries;
		expect(users.some(entry => entry.info?.includes("fixture") && entry.text === "custom body")).toBe(true);
		expect(users.some(entry => entry.info?.includes("developer") && entry.text.includes("file contents"))).toBe(true);
		const image = users.find(entry => entry.text.includes("image/png"))!;
		expect(image.tokens).toBe(session.agent.tokenizer.countMessages([messages[4]!]));
		expect(JSON.stringify(data)).not.toContain("aGVsbG8=");
		expect(JSON.stringify(data)).not.toContain("excluded");
	});

	it("counts only active schemas, tolerates cyclic schemas and keeps snapshots detached from later updates", () => {
		const read = tool("read");
		const broken = tool("cyclic");
		const schema: Record<string, unknown> = {};
		schema.self = schema;
		broken.parameters = schema as never;
		const session = sessionWith({ tools: [read, broken] });
		const data = buildSessionContextView(session);
		expect(category(data, "custom-tools").entries[0]?.text).toContain("Schema unavailable");
		expect(category(data, "built-in-tools").entries.map(entry => entry.label)).toEqual(["read"]);
		session.agent.setTools([]);
		session.agent.setSystemPrompt(["different system"]);
		expect(category(data, "built-in-tools").entries.map(entry => entry.label)).toEqual(["read"]);
		expect(category(buildSessionContextView(session), "built-in-tools").entries).toEqual([]);
	});

	it("updates active-tool prompt sources only on successful rebuild and clears absent replacement metadata", async () => {
		const initial: { systemPrompt: string[]; sources?: SystemPromptSources } = {
			systemPrompt: ["original"],
			sources: {
				blocks: ["original"],
				sources: [{ id: "rules", blockIndex: 0, kind: "instruction-files", label: "rules", fragment: "original" }],
			},
		};
		const accepted: typeof initial = {
			systemPrompt: ["accepted"],
			sources: {
				blocks: ["accepted"],
				sources: [{ id: "rules", blockIndex: 0, kind: "instruction-files", label: "rules", fragment: "accepted" }],
			},
		};
		let next = accepted;
		let fail = false;
		const session = sessionWith({
			prompt: initial.systemPrompt,
			sources: initial.sources,
			tools: [tool("read")],
			rebuild: async () => {
				if (fail) throw new Error("tool rebuild rejected");
				return next;
			},
		});
		await session.setActiveToolsByName([]);
		expect(session.systemPrompt).toEqual(accepted.systemPrompt);
		expect(session.systemPromptSources).toBe(accepted.sources);
		expect(category(buildSessionContextView(session), "instruction-files").entries.map(entry => entry.text)).toEqual([
			"accepted",
		]);
		fail = true;
		await expect(session.setActiveToolsByName(["read"])).rejects.toThrow("tool rebuild rejected");
		expect(session.systemPrompt).toEqual(accepted.systemPrompt);
		expect(session.systemPromptSources).toBe(accepted.sources);
		fail = false;
		next = { systemPrompt: ["replacement without source metadata"] };
		await session.setActiveToolsByName(["read"]);
		expect(session.systemPrompt).toEqual(next.systemPrompt);
		expect(session.systemPromptSources).toBeUndefined();
		const data = buildSessionContextView(session);
		expect(category(data, "instruction-files").entries).toEqual([]);
		expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual(next.systemPrompt);
		expect(data.notices).toEqual([]);
	});

	it("publishes sources only with an accepted rebuild and leaves stale or throwing preparations untouched", async () => {
		const make = (word: string) => ({
			systemPrompt: [`prefix ${word} suffix`],
			sources: {
				blocks: [`prefix ${word} suffix`],
				sources: [
					{ id: "rules", blockIndex: 0, kind: "instruction-files" as const, label: "rules", fragment: word },
				],
			},
		});
		const initial = make("original");
		let next = make("accepted");
		let fail = false;
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let hold = false;
		const session = sessionWith({
			prompt: initial.systemPrompt,
			sources: initial.sources,
			rebuild: async () => {
				if (hold) {
					entered.resolve();
					await gate.promise;
				}
				if (fail) throw new Error("build rejected");
				return next;
			},
		});
		await session.refreshBaseSystemPrompt();
		expect(category(buildSessionContextView(session), "instruction-files").entries[0]?.text).toBe("accepted");
		next = make("stale");
		hold = true;
		let current = true;
		const refresh = session.refreshBaseSystemPrompt(() => current);
		await entered.promise;
		expect(session.systemPrompt).toEqual(["prefix accepted suffix"]);
		expect(session.systemPromptSources?.blocks).toEqual(session.systemPrompt);
		current = false;
		gate.resolve();
		await refresh;
		expect(category(buildSessionContextView(session), "instruction-files").entries[0]?.text).toBe("accepted");
		hold = false;
		fail = true;
		await expect(session.refreshBaseSystemPrompt()).rejects.toThrow("build rejected");
		expect(category(buildSessionContextView(session), "instruction-files").entries[0]?.text).toBe("accepted");
	});
});
