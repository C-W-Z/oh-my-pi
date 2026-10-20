import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { renderToolExamples } from "@oh-my-pi/pi-ai/dialect";
import { isSurvivingAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { ContextCategoryId } from "@oh-my-pi/pi-tui/chrome/context-presentation";
import type { ContextViewCategory, ContextViewData, ContextViewEntry } from "@oh-my-pi/pi-tui/overlays/context-viewer";
import { estimateContextToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { AgentSession } from "./agent-session";
import { computeSessionContextBreakdown } from "./context-usage-runtime";
import { convertMessagesForContextView } from "./messages";

const CATEGORIES: readonly [ContextCategoryId, string][] = [
	["system-prompt", "System Prompt"],
	["skills", "Skills"],
	["built-in-tools", "Built-in Tools"],
	["custom-tools", "Custom Tools"],
	["user-messages", "User Messages"],
	["assistant-messages", "Assistant Messages"],
	["assistant-thinking", "Assistant Thinking"],
	["tool-calls", "Tool Calls"],
	["tool-output", "Tool Output"],
];

/** Summarize media without retaining binary data, signatures, or message objects. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) => {
			if (block === null || typeof block !== "object") return "[Unknown content]";
			const item = block as Record<string, unknown>;
			if (item.type === "text") return typeof item.text === "string" ? item.text : "";
			if (item.type === "redactedThinking") return "[Redacted thinking]";
			if (item.type === "thinking")
				return typeof item.thinking === "string" && item.thinking ? item.thinking : "[Encoded thinking]";
			const facts = [String(item.type ?? "media")];
			if (typeof item.mimeType === "string") facts.push(item.mimeType);
			if (typeof item.width === "number" && typeof item.height === "number")
				facts.push(`${item.width}×${item.height}`);
			if (typeof item.data === "string") facts.push(`~${Math.floor((item.data.length * 3) / 4)} bytes`);
			return `[${facts.join(" · ")}]`;
		})
		.join("\n");
}

/** Format retained server-tool metadata, omitting known unreadable replay fields for readability. */
function serverToolText(block: unknown): string {
	try {
		return (
			JSON.stringify(
				block,
				(key, value: unknown) => (key === "encrypted_content" || key === "signature" ? undefined : value),
				2,
			) ?? ""
		);
	} catch {
		return "[Content unavailable]";
	}
}

/** Sample once on open without session hooks, provider transforms, or file I/O. */
export function buildSessionContextView(session: AgentSession): ContextViewData {
	const breakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true });
	const tokenizer = session.agent.tokenizer;
	const categories: ContextViewCategory[] = CATEGORIES.map(([id, label]) => ({ id, label, tokens: 0, entries: [] }));
	const byId = new Map(categories.map(category => [category.id, category]));
	const add = (category: ContextCategoryId, entry: ContextViewEntry): void => {
		const target = byId.get(category)!;
		target.entries.push(entry);
		target.tokens += entry.tokens;
	};
	for (const [index, block] of session.systemPrompt.entries()) {
		add("system-prompt", {
			id: `system-prompt/${index}`,
			label: `System Block ${index + 1}`,
			text: block,
			tokens: tokenizer.countTokens(block),
		});
	}
	const skills = byId.get("skills")!;
	skills.tokens = breakdown.categories.find(category => category.id === "skills")!.tokens;
	const systemPrompt = byId.get("system-prompt")!;
	systemPrompt.tokens = Math.max(0, systemPrompt.tokens - skills.tokens);

	const infos = new Map(session.getAllToolInfos().map(info => [info.name, info.sourceInfo]));
	for (const [index, tool] of session.agent.state.tools.entries()) {
		const category = session.hasBuiltInTool(tool.name) ? "built-in-tools" : "custom-tools";
		const parts = [tool.name, tool.description];
		try {
			parts.push(JSON.stringify(toolWireSchema(tool), null, 2) ?? "[Schema unavailable]");
			const examples = renderToolExamples(tool);
			if (examples) parts.push(examples);
		} catch (error) {
			parts.push(`Schema unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		const source = infos.get(tool.name);
		add(category, {
			id: `${category}/${index}`,
			label: tool.name,
			text: parts.join("\n\n"),
			info: source?.source ?? "unknown",
			path: source?.path,
			tokens: estimateContextToolSchemaTokens([tool], tokenizer, session.model),
		});
	}
	const groups = new Map<string, ContextViewCategory>();
	const chronology = new Map<string, number>();
	const output = byId.get("tool-output")!;
	const addOutput = (name: string, entry: ContextViewEntry, timestamp: number): void => {
		let group = groups.get(name);
		if (!group) {
			group = { id: "tool-output", key: `tool-output/tool-${groups.size}`, label: name, tokens: 0, entries: [] };
			groups.set(name, group);
		}
		group.entries.push(entry);
		group.tokens += entry.tokens;
		chronology.set(entry.id, timestamp);
		add("tool-output", entry);
	};
	const serverToolNames = new Map<string, string>();
	const sourceMessages = session.agent.state.messages;
	const convertedMessages = convertMessagesForContextView(sourceMessages);
	const latestAssistantIndex = convertedMessages.findLastIndex(
		({ message }) => message.role === "assistant" && isSurvivingAssistant(message, session.model ?? undefined),
	);
	for (const { message, sourceIndex: messageIndex, convertedIndex } of convertedMessages) {
		const original = sourceMessages[messageIndex]!;
		const execution =
			original.role === "bashExecution" ? "bash" : original.role === "pythonExecution" ? "python" : undefined;
		const prefix = `${messageIndex}/${convertedIndex}`;
		const info =
			original.role !== message.role || "customType" in original
				? `${original.role}${"customType" in original ? ` · ${original.customType}` : ""}${message.role !== original.role ? ` → ${message.role}` : ""}`
				: undefined;
		if (message.role === "assistant") {
			// Count reasoning replay once; text and calls do not inherit the provider's whole-turn usage.
			const blockTokens = message.content.map(block => {
				if (block.type === "text") return tokenizer.countTokens(block.text);
				if (block.type === "toolCall") {
					try {
						return tokenizer.countTokens([block.name, JSON.stringify(block.arguments) ?? "null"]);
					} catch {
						return tokenizer.countTokens(block.name);
					}
				}
				if (block.type === "thinking" || block.type === "redactedThinking") return 0;
				const isolated: AgentMessage = { ...message, providerPayload: undefined, content: [block] };
				return tokenizer.countMessages([isolated]);
			});
			const reasoningIndexes = message.content.flatMap((block, index) =>
				block.type === "thinking" || block.type === "redactedThinking" ? [index] : [],
			);
			const messageTokens =
				convertedIndex === latestAssistantIndex
					? tokenizer.countLatestTurn(message)
					: tokenizer.countMessage(message);
			let reasoningBudget = Math.max(0, messageTokens - blockTokens.reduce((sum, tokens) => sum + tokens, 0));
			for (const [position, index] of reasoningIndexes.entries()) {
				const block = message.content[index]!;
				const isolated: AgentMessage = { ...message, providerPayload: undefined, content: [block] };
				const tokens =
					position === reasoningIndexes.length - 1
						? reasoningBudget
						: Math.min(reasoningBudget, tokenizer.countMessages([isolated]));
				blockTokens[index] = tokens;
				reasoningBudget -= tokens;
			}
			// Preserve the tokenizer's replay budget when no explicit thinking block carries it; never read or display the raw payload.
			if (reasoningBudget > 0) {
				add("assistant-thinking", {
					id: `assistant-thinking/${prefix}/payload`,
					label: `Thinking 1/1 · message ${messageIndex + 1}`,
					info,
					text: "[Encoded thinking]",
					timestamp: original.timestamp,
					tokens: reasoningBudget,
				});
			}
			let thinkingIndex = 0;
			for (const [blockIndex, block] of message.content.entries()) {
				if (block.type === "anthropicServerTool") {
					const retained = block.block;
					const isCall = retained.type === "server_tool_use";
					const callId = isCall ? retained.id : retained.tool_use_id;
					const name = isCall
						? retained.name
						: (serverToolNames.get(callId) ??
							(retained.type === "web_search_tool_result" ? "web_search" : "tool_search"));
					if (isCall) serverToolNames.set(callId, name);
					const category = isCall ? "tool-calls" : "tool-output";
					const entry: ContextViewEntry = {
						id: `${category}/${prefix}/${blockIndex}`,
						label: name,
						info,
						text: serverToolText(retained),
						timestamp: original.timestamp,
						callId,
						tokens: blockTokens[blockIndex]!,
					};
					if (isCall) add(category, entry);
					else addOutput(name, entry, original.timestamp);
					continue;
				}
				const category =
					block.type === "toolCall"
						? "tool-calls"
						: block.type === "thinking" || block.type === "redactedThinking"
							? "assistant-thinking"
							: "assistant-messages";
				let text: string;
				if (block.type === "toolCall") {
					try {
						text = `${block.name}\nCall ID: ${block.id}\n${JSON.stringify(block.arguments, null, 2)}`;
					} catch {
						text = `${block.name}\nCall ID: ${block.id}\n[Arguments unavailable]`;
					}
				} else text = contentText([block]);
				add(category, {
					id: `${category}/${prefix}/${blockIndex}`,
					label:
						block.type === "toolCall"
							? block.name
							: category === "assistant-thinking"
								? `Thinking ${++thinkingIndex}/${reasoningIndexes.length} · message ${messageIndex + 1}`
								: `${block.type} · message ${messageIndex + 1}`,
					info,
					text,
					timestamp: original.timestamp,
					tokens: blockTokens[blockIndex]!,
				});
			}
		} else if (message.role === "toolResult" || execution) {
			const name = message.role === "toolResult" ? message.toolName : execution!;
			const call = message.role === "toolResult" ? message.toolCallId : undefined;
			addOutput(
				name,
				{
					id: `tool-output/${prefix}`,
					label: name,
					info,
					text: contentText(message.content),
					timestamp: original.timestamp,
					callId: call,
					tokens: tokenizer.countMessages([message]),
				},
				original.timestamp,
			);
		} else {
			add("user-messages", {
				id: `user-messages/${prefix}`,
				label: `${message.role} · message ${messageIndex + 1}`,
				info,
				text: contentText(message.content),
				timestamp: original.timestamp,
				tokens: tokenizer.countMessages([message]),
			});
		}
	}
	const chronological = (a: ContextViewEntry, b: ContextViewEntry): number =>
		(chronology.get(a.id) ?? 0) - (chronology.get(b.id) ?? 0);
	output.entries.sort(chronological);
	output.children = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
	for (const group of output.children) group.entries.sort(chronological);
	const estimatedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
	const window = breakdown.contextWindow;
	return {
		modelLabel: session.model?.name ?? session.model?.id ?? "no model",
		window,
		usage: breakdown.usedTokens,
		estimatedTokens,
		buffer: breakdown.autoCompactBufferTokens,
		free: breakdown.freeTokens,
		breakdown,
		categories,
		notices: [],
	};
}
