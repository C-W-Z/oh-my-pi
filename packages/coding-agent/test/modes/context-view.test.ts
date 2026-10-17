import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { buildSessionContextView } from "../../src/session/context-view";
import { buildSystemPrompt, type SystemPromptSources } from "../../src/system-prompt";
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
		rebuild?: () => Promise<{ systemPrompt: string[]; sources?: SystemPromptSources }>;
	} = {},
): AgentSession {
	const tools = options.tools ?? [];
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: options.prompt ?? ["opaque system"],
				tools,
				messages: options.messages ?? [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
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

	it("keeps rewritten or ambiguous prompt fragments in System Prompt, pairing repeated blocks by occurrence", () => {
		const sources: SystemPromptSources = {
			blocks: ["prefix FILE suffix", "prefix FILE suffix"],
			sources: [{ id: "file", blockIndex: 1, kind: "instruction-files", label: "rules", fragment: "FILE" }],
		};
		const session = sessionWith({ prompt: [...sources.blocks], sources });
		let data = buildSessionContextView(session);
		expect(category(data, "instruction-files").entries.map(entry => entry.text)).toEqual(["FILE"]);
		expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual([
			"prefix FILE suffix",
			"prefix  suffix",
		]);
		session.agent.setSystemPrompt(["rewritten FILE"]);
		data = buildSessionContextView(session);
		expect(category(data, "instruction-files").entries).toEqual([]);
		expect(category(data, "system-prompt").entries.map(entry => entry.text)).toEqual(["rewritten FILE"]);
		expect(data.notices).toHaveLength(1);
		const ambiguous = sessionWith({
			prompt: ["FILE FILE"],
			sources: { blocks: ["FILE FILE"], sources: [{ ...sources.sources[0]!, blockIndex: 0 }] },
		});
		expect(category(buildSessionContextView(ambiguous), "instruction-files").entries).toEqual([]);
	});

	it("separates assistant blocks without charging reasoning usage repeatedly and never exposes signatures", () => {
		const message = reply([
			{ type: "text", text: "visible answer" },
			{ type: "thinking", thinking: "readable thought", thinkingSignature: "private-signature" },
			{ type: "redactedThinking", data: "private-ciphertext" },
			{ type: "toolCall", name: "read", id: "duplicate", arguments: { path: "notes.txt" } },
		]);
		const session = sessionWith({ prompt: [], messages: [message] });
		const data = buildSessionContextView(session);
		expect(category(data, "assistant-messages").entries.map(entry => entry.text)).toEqual(["visible answer"]);
		expect(category(data, "assistant-thinking").entries.map(entry => entry.text)).toEqual([
			"readable thought",
			"[Redacted thinking]",
		]);
		expect(category(data, "tool-calls").entries[0]?.text).toContain('"path": "notes.txt"');
		expect(data.estimatedTokens).toBe(session.agent.tokenizer.countMessages([message]));
		expect(JSON.stringify(data)).not.toMatch(/private-signature|private-ciphertext/);
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

	it("uses pure OMP conversion, excludes executions and counts original image content rather than display summaries", () => {
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
