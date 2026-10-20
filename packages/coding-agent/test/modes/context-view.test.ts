import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { buildSessionContextView } from "../../src/session/context-view";
import { buildSystemPrompt } from "../../src/system-prompt";
import type { Skill } from "../../src/extensibility/skills";
import { computeSessionContextBreakdown } from "../../src/session/context-usage-runtime";
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
		skills?: Skill[];
		messages?: AgentMessage[];
		tools?: AgentTool[];
		settings?: Settings;
		model?: Model;
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
		skills: options.skills,
	});
	sessions.push(session);
	return session;
}

function category(data: ContextViewData, id: string) {
	return data.categories.find(category => category.id === id)!;
}

function totalTokens(data: ContextViewData): number {
	return data.categories.reduce((sum, category) => sum + category.tokens, 0);
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
		expect(totalTokens(data)).toBe(totalTokens(plain));
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
		expect(totalTokens(data)).toBeGreaterThan(data.window);
		expect(data.usage).toBe(100);
		expect(data.buffer).toBeGreaterThan(0);
		expect(data.free + data.buffer).toBe(data.window - 100);
	});

	it("retains full instruction and skill content in effective system blocks without reading their files", async () => {
		const skills: Skill[] = [
			{
				name: "fixture",
				description: "Use <T> & {{literal}} without expansion",
				filePath: "/nonexistent/SKILL.md",
				baseDir: "/nonexistent",
				source: "user",
			},
		];
		for (const customPrompt of [undefined, "Literal custom prompt."]) {
			const built = await buildSystemPrompt({
				cwd: import.meta.dir,
				customPrompt,
				personality: "none",
				activeRepoContext: null,
				contextFiles: [{ path: "/nonexistent/instructions.md", content: "Unique instruction body" }],
				skills,
			});
			const prompt = [...built.systemPrompt, "Additional effective policy"];
			const session = sessionWith({ prompt, skills, tools: [tool("read")] });
			const file = vi.spyOn(Bun, "file");
			const data = buildSessionContextView(session);
			const system = category(data, "system-prompt");
			expect(system.entries.map(entry => entry.text)).toEqual(prompt);
			expect(system.entries.map(entry => entry.tokens)).toEqual(
				prompt.map(block => session.agent.tokenizer.countTokens(block)),
			);
			const text = system.entries.map(entry => entry.text).join("\n");
			expect(text).toContain("Unique instruction body");
			expect(text).toContain("Use <T> & {{literal}} without expansion");
			if (customPrompt) expect(text).toContain(customPrompt);
			const shared = computeSessionContextBreakdown(session).categories.find(category => category.id === "skills")!;
			expect(shared.tokens).toBeGreaterThan(0);
			expect(category(data, "skills")).toMatchObject({ entries: [], tokens: shared.tokens });
			const fullPromptTokens = system.entries.reduce((sum, entry) => sum + entry.tokens, 0);
			expect(system.tokens).toBe(fullPromptTokens - shared.tokens);
			expect(system.tokens + category(data, "skills").tokens).toBe(fullPromptTokens);
			expect(totalTokens(data)).toBe(fullPromptTokens + category(data, "built-in-tools").tokens);
			expect(file).not.toHaveBeenCalled();
			file.mockRestore();
		}
	});

	it("uses the shared skill estimate with read-tool, hidden-skill and skillful gating", () => {
		const visible: Skill = {
			name: "visible",
			description: "Visible skill description",
			filePath: "/nonexistent/visible/SKILL.md",
			baseDir: "/nonexistent/visible",
			source: "user",
		};
		const hidden: Skill = {
			...visible,
			name: "hidden",
			description: "Hidden skill description",
			hide: true,
		};
		for (const fixture of [
			{ skills: [visible, hidden], tools: [tool("read")], skillful: true, visible: true },
			{ skills: [visible, hidden], tools: [], skillful: true, visible: false },
			{ skills: [hidden], tools: [tool("read")], skillful: true, visible: false },
			{ skills: [visible, hidden], tools: [tool("read")], skillful: false, visible: false },
		]) {
			const session = sessionWith({
				prompt: ["Effective policy including visible and hidden skill descriptions.\n".repeat(20)],
				skills: fixture.skills,
				tools: fixture.tools,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"todo.enabled": false,
					skillful: fixture.skillful,
				}),
			});
			const data = buildSessionContextView(session);
			const shared = computeSessionContextBreakdown(session).categories.find(category => category.id === "skills")!;
			const expected = fixture.visible
				? session.agent.tokenizer.countTokens([visible.name, visible.description])
				: 0;
			expect(shared.tokens).toBe(expected);
			expect(category(data, "skills")).toMatchObject({ tokens: expected, entries: [] });
			const system = category(data, "system-prompt");
			const promptTokens = session.agent.tokenizer.countTokens(session.systemPrompt[0]!);
			expect(system.entries[0]!.text).toBe(session.systemPrompt[0]!);
			expect(system.entries[0]!.tokens).toBe(promptTokens);
			expect(system.tokens + expected).toBe(promptTokens);
		}
	});

	it("clamps the System Prompt total when the shared Skills estimate exceeds the effective blocks", () => {
		const session = sessionWith({
			prompt: [""],
			tools: [tool("read")],
			skills: [
				{
					name: "fixture",
					description: "A nonempty skill description",
					filePath: "/nonexistent/SKILL.md",
					baseDir: "/nonexistent",
					source: "user",
				},
			],
		});
		const data = buildSessionContextView(session);
		expect(category(data, "skills").tokens).toBeGreaterThan(0);
		expect(category(data, "skills").entries).toEqual([]);
		expect(category(data, "system-prompt")).toMatchObject({
			tokens: 0,
			entries: [{ id: "system-prompt/0", text: "", tokens: 0 }],
		});
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
		expect(totalTokens(data)).toBe(session.agent.tokenizer.countMessages([message]));
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
		expect(totalTokens(initial)).toBe(1000);
		expect(category(initial, "assistant-thinking").tokens).toBe(1000 - category(initial, "tool-calls").tokens);

		session.agent.appendMessage({ ...reply([]), stopReason: "length" });
		expect(totalTokens(buildSessionContextView(session))).toBe(1000);

		const next = reply([{ type: "text", text: "new response" }]);
		session.agent.appendMessage(next);
		const updated = buildSessionContextView(session);
		expect(totalTokens(updated)).toBe(
			session.agent.tokenizer.countMessage(message) + session.agent.tokenizer.countMessage(next),
		);
		expect(category(updated, "assistant-thinking").tokens).toBe(
			session.agent.tokenizer.countTokens("retained excerpt"),
		);
		expect(totalTokens(initial)).toBe(1000);
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
		expect(totalTokens(data)).toBe(session.agent.tokenizer.countMessages([message]));
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
		expect(totalTokens(payloadOnly)).toBe(visibleTokens + 1_000);
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
		expect(totalTokens(withBlock)).toBe(totalTokens(payloadOnly));
		expect(JSON.stringify(withBlock)).not.toMatch(/private-ciphertext|rs_private|encrypted_content/);

		session.agent.setModel(getBundledModel("openai-codex", "gpt-6-sol")!);
		const changedReader = buildSessionContextView(session);
		expect(category(changedReader, "assistant-thinking").entries).toEqual([]);
		expect(totalTokens(changedReader)).toBe(session.agent.tokenizer.countTokens(text));

		session.agent.setModel({ ...reader, compat: { ...reader.compat, filterReasoningHistory: true } });
		const filtered = buildSessionContextView(session);
		expect(category(filtered, "assistant-thinking").entries).toEqual([]);
		expect(totalTokens(filtered)).toBe(session.agent.tokenizer.countTokens(text));
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
});
