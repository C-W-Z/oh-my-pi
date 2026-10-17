import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { renderToolExamples } from "@oh-my-pi/pi-ai/dialect";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { ContextCategoryId } from "@oh-my-pi/pi-tui/chrome/context-presentation";
import type { ContextViewCategory, ContextViewData, ContextViewEntry } from "@oh-my-pi/pi-tui/overlays/context-viewer";
import { estimateContextToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { AgentSession } from "./agent-session";
import { computeSessionContextBreakdown } from "./context-usage-runtime";
import { convertToLlm } from "./messages";

const CATEGORIES: readonly [ContextCategoryId, string][] = [
	["system-prompt", "System Prompt"],
	["instruction-files", "Instruction Files"],
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

/** Sample once on open without session hooks, provider transforms, or file I/O. */
export function buildSessionContextView(session: AgentSession): ContextViewData {
	const breakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true });
	const tokenizer = session.agent.tokenizer;
	const categories: ContextViewCategory[] = CATEGORIES.map(([id, label]) => ({ id, label, tokens: 0, entries: [] }));
	const byId = new Map(categories.map(category => [category.id, category]));
	const notices: string[] = [];
	const add = (category: ContextCategoryId, entry: ContextViewEntry): void => {
		const target = byId.get(category)!;
		target.entries.push(entry);
		target.tokens += entry.tokens;
	};
	const effective = session.systemPrompt;
	const metadata = session.systemPromptSources;
	const paired = new Map<number, number>();
	const matched = new Set<number>();
	let incomplete = false;
	if (metadata) {
		for (const [index, block] of metadata.blocks.entries()) {
			const target = effective.findIndex((current, position) => current === block && !matched.has(position));
			if (target >= 0) {
				paired.set(index, target);
				matched.add(target);
			}
		}
	}
	const claimed = new Map<number, { start: number; end: number }[]>();
	const delivered = new Set<string>();
	if (metadata) {
		for (const kind of ["instruction-files", "skills"] as const) {
			for (const source of metadata.sources.filter(source => source.kind === kind)) {
				if (delivered.has(source.id)) continue;
				const index = paired.get(source.blockIndex);
				if (!source.fragment || index === undefined) {
					incomplete = true;
					continue;
				}
				const block = effective[index]!;
				const start = block.indexOf(source.fragment);
				const end = start + source.fragment.length;
				const ranges = claimed.get(index) ?? [];
				if (
					start < 0 ||
					block.indexOf(source.fragment, start + 1) >= 0 ||
					ranges.some(range => start < range.end && end > range.start)
				) {
					incomplete = true;
					continue;
				}
				ranges.push({ start, end });
				claimed.set(index, ranges);
				delivered.add(source.id);
				add(kind, {
					id: `${kind}/${source.id}`,
					label: source.label,
					path: source.path,
					text: source.fragment,
					tokens: tokenizer.countTokens(source.fragment),
				});
			}
		}
	}
	for (const [index, block] of effective.entries()) {
		let cursor = 0;
		const fragments: string[] = [];
		for (const range of (claimed.get(index) ?? []).sort((a, b) => a.start - b.start)) {
			fragments.push(block.slice(cursor, range.start));
			cursor = range.end;
		}
		fragments.push(block.slice(cursor));
		const remaining = fragments.join("");
		if (remaining)
			add("system-prompt", {
				id: `system-prompt/${index}`,
				label: `System Block ${index + 1}`,
				text: remaining,
				tokens: tokenizer.countTokens(remaining),
			});
	}
	if (incomplete) notices.push("Some prompt sources could not be attributed; their content remains in System Prompt.");

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
	const sourceMessages = session.agent.state.messages;
	convertToLlm(sourceMessages, (message, messageIndex, convertedIndex) => {
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
			let reasoningBudget = Math.max(
				0,
				tokenizer.countMessages([message]) - blockTokens.reduce((sum, tokens) => sum + tokens, 0),
			);
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
			let thinkingIndex = 0;
			for (const [blockIndex, block] of message.content.entries()) {
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
					label: `${name}${call ? ` · ${call}` : ""}`,
					info,
					text: contentText(message.content),
					tokens: tokenizer.countMessages([message]),
				},
				message.timestamp,
			);
		} else {
			add("user-messages", {
				id: `user-messages/${prefix}`,
				label: `${message.role} · message ${messageIndex + 1}`,
				info,
				text: contentText(message.content),
				tokens: tokenizer.countMessages([message]),
			});
		}
	});
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
		notices,
	};
}
