import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { TspText } from "@oh-my-pi/pi-wire";
import {
	getKeybindings,
	KeybindingsManager,
	type KeybindingsConfig,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "../src/keybindings";
import type { NativeNode } from "../src/native/node";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";
import { ContextViewer, type ContextViewData, type ContextViewCategory } from "../src/overlays/context-viewer";
import { createTheme, getBuiltinThemes } from "../src/theme/loader";
import { ensureThemeSync, setThemeInstance, theme, type Theme } from "../src/theme/theme";
import { CONTEXT_PRESENTATION } from "../src/chrome/context-presentation";
import { sliceWithWidth, visibleWidth } from "../src/utils";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { computeContextBreakdown } from "../src/status-line/context-usage";

const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => false, feature: () => true };
const meterCx = { ...cx, supports: () => true };
let previous: Theme;
beforeEach(() => {
	ensureThemeSync();
	previous = theme;
});
afterEach(() => setThemeInstance(previous));

function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(child => ("k" in child ? nodes(child) : []))];
}

function textValue(value: TspText | undefined): string | undefined {
	return typeof value === "string" ? value : value?.map(span => span.t).join("");
}

function contextField(row: NativeNode | undefined, field: string): Extract<NativeNode, { k: "text" }> | undefined {
	return row?.c?.find(
		(child): child is Extract<NativeNode, { k: "text" }> =>
			"k" in child && child.k === "text" && child.p?.role === `omp.context.${field}`,
	);
}

function usageColumns(row: NativeNode | undefined): string[] | undefined {
	if (!row) return;
	return ["tokens", "share"].map(field => textValue(contextField(row, field)?.p?.spans)?.trim() ?? "").filter(Boolean);
}

function fixture(): ContextViewData {
	const output: ContextViewCategory = {
		id: "tool-output",
		label: "Tool Output",
		tokens: 30000,
		entries: [
			{
				id: "result/0",
				label: "read result",
				tokens: 20000,
				timestamp: 0,
				callId: "call-123",
				text:
					Array.from({ length: 100 }, (_, index) => `line ${index}\t${"long ".repeat(30)}`).join("\n") +
					"\ncontext-output-tail",
			},
			{ id: "result/1", label: "bash result", tokens: 10000, text: "short result", timestamp: 60_000 },
		],
	};
	output.children = [
		{ ...output, key: "tool-output/read", label: "read", entries: output.entries.slice(0, 1), tokens: 20000 },
		{ ...output, key: "tool-output/bash", label: "bash", entries: output.entries.slice(1), tokens: 10000 },
	];
	return {
		modelLabel: "Fixture",
		window: 200000,
		usage: 85000,
		buffer: 20000,
		free: 95000,
		breakdown: {
			...computeContextBreakdown(
				{
					model: getBundledModel("anthropic", "claude-sonnet-4-5"),
					systemPrompt: ["system"],
					agent: { tokenizer: new Tokenizer(), state: { tools: [] } },
					messages: [],
				},
				{
					compaction: DEFAULT_COMPACTION_SETTINGS,
					snapcompact: {
						visionCapable: true,
						savedTokens: 6000,
						systemPrompt: {
							applied: true,
							textTokens: 10000,
							imageTokens: 4000,
							frames: 2,
							savedTokens: 6000,
							scope: "all",
						},
					},
				},
			),
			usedTokens: 85000,
			freeTokens: 95000,
			autoCompactBufferTokens: 20000,
		},
		categories: [
			{
				id: "system-prompt",
				label: "System Prompt",
				tokens: 20000,
				entries: [{ id: "system/0", label: "system block", tokens: 20000, text: "entire system source" }],
			},
			{
				id: "skills",
				label: "Skills",
				tokens: 10000,
				entries: [{ id: "skill/0", label: "fixture skill", tokens: 10000, text: "skill hint" }],
			},
			{
				id: "built-in-tools",
				label: "Built-in Tools",
				tokens: 10000,
				entries: [{ id: "tool/0", label: "builtin read", tokens: 10000, text: "schema definition" }],
			},
			{ id: "custom-tools", label: "Custom Tools", tokens: 0, entries: [] },
			{
				id: "user-messages",
				label: "User / Developer Messages",
				tokens: 10000,
				entries: [{ id: "user/0", label: "user", tokens: 10000, text: "question" }],
			},
			output,
		],
	};
}

function harness(data = fixture()) {
	let rows = 24;
	let closed = 0;
	const viewer = new ContextViewer(data, { onClose: () => closed++, requestRender: () => {}, getRows: () => rows });
	const render = (width = 100) => viewer.render(width).map(line => Bun.stripANSI(line));
	return { viewer, render, closed: () => closed, resize: (height: number) => (rows = height) };
}

function select(viewer: ContextViewer, key: string, activate = true): void {
	viewer.handleNativeEvent({
		type: "action",
		key: `categories/${key}`,
		act: activate ? "open-category" : "select-category",
		mods: [],
	});
}

function selected(root: NativeNode): string | null | undefined {
	const list = nodes(root).find(node => node.k === "list");
	return list?.k === "list" ? list.p?.selected : nodes(root).find(node => node.p?.mark === "pick")?.key;
}

function scrollToText(viewer: ContextViewer, render: () => readonly string[], value: string): void {
	for (let step = 0; step < 5000; step++) {
		if (render().some(line => line.includes(value))) return;
		viewer.handleInput("\x1b[B");
	}
	throw new Error(`Could not reach ${value} with down navigation`);
}

describe("ContextViewer navigation", () => {
	const navigationBindings: {
		name: string;
		bindings: KeybindingsConfig;
		up?: string;
		down?: string;
	}[] = [
		{ name: "default arrows", bindings: {}, up: "\x1b[A", down: "\x1b[B" },
		{
			name: "remapped control keys",
			bindings: { "tui.select.up": "ctrl+p", "tui.select.down": "ctrl+n" },
			up: "\x10",
			down: "\x0e",
		},
		{ name: "unbound navigation", bindings: { "tui.select.up": [], "tui.select.down": [] } },
	];
	for (const { name, bindings, up, down } of navigationBindings) {
		it(`captures and navigates only with configured keys: ${name}`, () => {
			const previousBindings = getKeybindings();
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
			const h = harness();
			try {
				h.render();
				for (const key of ["\x1b[A", "\x1b[B", "\x10", "\x0e", "k", "j"]) {
					select(h.viewer, "built-in-tools", false);
					expect(h.viewer.capturesInput(key)).toBe(key === up || key === down);
					h.viewer.handleInput(key);
					expect(selected(h.viewer.describe(cx))).toBe(
						key === up ? "system-prompt" : key === down ? "custom-tools" : "built-in-tools",
					);
				}
			} finally {
				h.viewer.dispose();
				setKeybindings(previousBindings);
			}
		});
	}

	it("keeps Skills token totals visible while native and keyboard navigation cannot focus or open them", () => {
		const h = harness();
		try {
			expect(
				h
					.render()
					.find(line => /\sSkills\s+\d/.test(line))
					?.match(/\d+K|\d+\.\d%/g),
			).toEqual(["11K", "5.3%"]);
			for (const context of [cx, meterCx]) {
				const root = h.viewer.describe(context);
				const skills = nodes(root).find(node => node.key === "skills");
				expect(usageColumns(skills)).toEqual(["11K", "5.3%"]);
				for (const activate of [false, true]) {
					select(h.viewer, "skills", activate);
					const unchanged = h.viewer.describe(context);
					expect(selected(unchanged)).toBe("system-prompt");
					expect(nodes(unchanged).some(node => node.key === "overview")).toBe(true);
					expect(nodes(unchanged).some(node => node.key === "entry-skill/0")).toBe(false);
				}
			}
			h.viewer.handleInput("\x1b[B");
			expect(selected(h.viewer.describe(cx))).toBe("built-in-tools");
			h.viewer.handleInput("\r");
			expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-tool/0")).toBe(true);
			h.viewer.handleInput("\x1b");
			h.viewer.handleInput("\x1b[A");
			expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
			h.viewer.handleInput("\r");
			expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-system/0")).toBe(true);
		} finally {
			h.viewer.dispose();
		}
	});

	it("remaps opening and returning without retaining Enter or Escape aliases", () => {
		const previousBindings = getKeybindings();
		const h = harness();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.confirm": "o",
				"tui.select.cancel": "b",
			}),
		);
		try {
			h.render();
			for (const key of ["\r", "\x1b"]) {
				expect(h.viewer.capturesInput(key)).toBe(false);
				h.viewer.handleInput(key);
			}
			expect(h.closed()).toBe(0);
			expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
			for (const key of ["o", "b"]) expect(h.viewer.capturesInput(key)).toBe(true);
			select(h.viewer, "tool-output", false);
			h.viewer.handleInput("o");
			expect(selected(h.viewer.describe(cx))).toBe("result/0");
			h.viewer.handleInput("o");
			expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
			h.viewer.handleInput("b");
			expect(selected(h.viewer.describe(cx))).toBe("result/0");
			h.viewer.handleInput("b");
			expect(selected(h.viewer.describe(cx))).toBe("tool-output");
			h.viewer.handleInput("b");
			expect(h.closed()).toBe(1);
		} finally {
			h.viewer.dispose();
			setKeybindings(previousBindings);
		}
	});

	it("keeps Native open, Back and Close usable when their keyboard actions are unbound", () => {
		const previousBindings = getKeybindings();
		const h = harness();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.confirm": [],
				"tui.select.cancel": [],
			}),
		);
		try {
			h.render();
			for (const key of ["\r", "\x1b", "\x03"]) {
				expect(h.viewer.capturesInput(key)).toBe(false);
				h.viewer.handleInput(key);
			}
			expect(h.closed()).toBe(0);
			expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
			select(h.viewer, "tool-output");
			h.viewer.handleNativeEvent({ type: "action", key: "entries/result/0", act: "open-entry", mods: [] });
			expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
			h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
			expect(selected(h.viewer.describe(cx))).toBe("result/0");
			h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
			expect(selected(h.viewer.describe(cx))).toBe("tool-output");
			h.viewer.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
			expect(h.closed()).toBe(1);
		} finally {
			h.viewer.dispose();
			setKeybindings(previousBindings);
		}
	});

	it("reaches saved output tail and restores preview selection and offset through Back", () => {
		const h = harness();
		h.render();
		select(h.viewer, "tool-output");
		const preview = h.render();
		h.viewer.handleInput("\r");
		scrollToText(h.viewer, () => h.render(), "context-output-tail");
		expect(h.render().join("\n")).toContain("context-output-tail");
		h.viewer.handleInput("\x1b");
		expect(h.render()).toEqual(preview);
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("\x1b");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
		expect(h.closed()).toBe(0);
		h.viewer.handleInput("\x1b");
		expect(h.closed()).toBe(1);
	});

	it("opens per-tool and single entries directly, keeps empty categories navigable and skips disabled capacity rows", () => {
		const h = harness();
		h.render();
		select(h.viewer, "tool-output/read");
		h.render();
		scrollToText(h.viewer, () => h.render(), "context-output-tail");
		expect(h.render().join("\n")).toContain("context-output-tail");
		h.viewer.handleInput("\x1b");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/read");
		select(h.viewer, "custom-tools");
		h.render();
		h.viewer.handleInput("\x1b");
		h.render();
		for (let step = 0; step < 20; step++) {
			h.viewer.handleInput("\x1b[B");
			h.render();
		}
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/bash");
		h.viewer.handleInput("\x1b[B");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/bash");
		h.resize(12);
		h.render(48);
		h.viewer.handleInput("\x1b[B");
		h.render(48);
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("tool-output/bash");
	});

	it("opens a short multiline entry through Native activation and Enter, then returns to the same selection", () => {
		const data = fixture();
		data.categories.find(category => category.id === "tool-output")!.entries[0] = {
			id: "result/0",
			label: "short multiline",
			tokens: 1,
			text: "first line\nmiddle line\nshort-multiline-tail",
		};
		const h = harness(data);
		h.viewer.describe(cx);
		select(h.viewer, "tool-output");
		const preview = h.render();
		const category = h.viewer.describe(cx);
		const entry = nodes(category).find(node => node.key === "result/0")!;
		expect(entry.k).toBe("col");
		expect(
			nodes(entry)
				.filter(node => node.k === "text")
				.every(node => node.p?.wrap === "word"),
		).toBe(true);
		h.viewer.handleNativeEvent({ type: "action", key: "entries/result/0", act: "open-entry", mods: [] });
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		expect(h.render().join("\n")).toContain("short-multiline-tail");
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(h.render()).toEqual(preview);
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("\r");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
	});

	it("scrolls Native multiline metadata before changing selection and restores the category viewport after Back", () => {
		const data = fixture();
		data.categories.find(category => category.id === "tool-output")!.entries = [
			{
				id: "result/0",
				label: "long output",
				tokens: 1,
				info: "output detail\n".repeat(60),
				text: "native-output-tail",
			},
			{ id: "result/1", label: "next output", tokens: 1, text: "next body" },
		];
		const h = harness(data);
		h.resize(12);
		const nativeCx = { ...cx, cols: 48 };
		const reconciler = new Reconciler("context-test");
		const document = new TspDocument("context-test");
		let frame = 0;
		const reconcile = () => {
			const ops = reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, nativeCx);
			expect(document.applyFrame({ sf: document.surface, s: ++frame, ops })).toEqual([]);
			return ops;
		};
		reconcile();
		select(h.viewer, "tool-output");
		reconcile();
		const preview = nodes(h.viewer.describe(nativeCx));
		const body = preview.find(node => node.key === "entries")!;
		expect(body.k).toBe("col");
		expect(body.scroll).toBeDefined();
		for (const [key, by] of [
			["\x1b[B", "line-down"],
			["\x1b[A", "line-up"],
		] as const) {
			h.viewer.handleInput(key);
			const ops = reconcile();
			expect(ops.filter(op => op[0] === "scroll").map(op => op[2])).toEqual([by]);
			expect(selected(h.viewer.describe(nativeCx))).toBe("result/0");
		}
		h.viewer.handleInput("\x1b[B");
		reconcile();
		const before = h.render(48);
		h.viewer.handleInput("\r");
		reconcile();
		scrollToText(h.viewer, () => h.render(48), "native-output-tail");
		reconcile();
		expect(h.render(48).join("\n")).toContain("native-output-tail");
		h.viewer.handleInput("\x1b");
		const restored = reconcile();
		expect(restored.some(op => op[0] === "reveal" && op[2] === "start")).toBe(true);
		expect(h.render(48)).toEqual(before);
		h.resize(18);
		reconcile();
		let changed = false;
		for (let step = 0; step < 80; step++) {
			h.viewer.handleInput("\x1b[B");
			const ops = reconcile();
			if (selected(h.viewer.describe(nativeCx)) === "result/1") {
				expect(ops.some(op => op[0] === "scroll")).toBe(false);
				expect(ops.some(op => op[0] === "reveal")).toBe(true);
				changed = true;
				break;
			}
			expect(ops.some(op => op[0] === "scroll" && op[2] === "line-down")).toBe(true);
		}
		expect(changed).toBe(true);
		h.viewer.handleNativeEvent({ type: "action", key: "entries/result/0", act: "select-entry", mods: [] });
		reconcile();
		expect(selected(h.viewer.describe(nativeCx))).toBe("result/0");
	});

	it("handles native select/activate/Back/Close and emits repeated terminal scroll requests", () => {
		const h = harness();
		h.viewer.describe(cx);
		select(h.viewer, "tool-output/read", false);
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/read");
		select(h.viewer, "tool-output/read");
		h.viewer.describe(cx);
		h.viewer.handleInput("\x1b[B");
		const scroll = nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll;
		expect(scroll).toMatchObject({ by: "line-down", n: 1 });
		h.viewer.handleInput("\x1b[B");
		expect(nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll).toMatchObject({
			by: "line-down",
			n: 2,
		});
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/read");
		h.viewer.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
		expect(h.closed()).toBe(1);
	});
});

describe("ContextViewer preview boundaries", () => {
	it("opens the tail of a single source line even when only part of that line fits the preview", () => {
		const data = fixture();
		const output = data.categories.find(category => category.id === "tool-output")!;
		output.entries[0] = {
			id: "result/0",
			label: "single line",
			tokens: 100,
			text: `${"寬字 ".repeat(10000)}single-line-tail`,
		};
		const h = harness(data);
		h.resize(12);
		h.render(48);
		select(h.viewer, "tool-output");
		expect(h.render(48).join("\n")).toContain("… more");
		h.viewer.handleInput("\r");
		h.render(48);
		scrollToText(h.viewer, () => h.render(48), "single-line-tail");
		expect(h.render(48).join("\n")).toContain("single-line-tail");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("result/0");
	});
});

describe("ContextViewer presentation", () => {
	it("moves the active category into the native sheet title through open and back transitions only", () => {
		const data = fixture();
		const system = data.categories[0]!;
		system.entries.push({ id: "system/1", label: "second system block", tokens: 100, text: "second source" });
		const h = harness(data);
		const overviewHead = textValue(h.viewer.nativeOverlay.head);
		const checkCategory = (category: ContextViewCategory): NativeNode => {
			const root = h.viewer.describe(cx);
			expect(textValue(h.viewer.nativeOverlay.head)).toContain(category.label);
			expect(textValue(h.viewer.nativeOverlay.head)).not.toBe(overviewHead);
			expect(
				root.c?.some(child => "k" in child && child.k === "text" && textValue(child.p?.spans) === category.label),
			).toBe(false);
			expect(h.render()[0]).toContain(category.label);
			expect(h.render()[0]).not.toContain("Context ·");
			return root;
		};
		const back = () => h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		try {
			select(h.viewer, system.id);
			let root = checkCategory(system);
			expect(nodes(root).some(node => node.key === "system/0")).toBe(true);
			expect(nodes(root).some(node => node.key === "system/1")).toBe(true);
			h.viewer.handleInput("\r");
			root = checkCategory(system);
			expect(nodes(root).some(node => node.key === "entry-system/0")).toBe(true);
			expect(
				nodes(root).some(node => node.k === "text" && textValue(node.p?.spans)?.includes(system.entries[0]!.label)),
			).toBe(true);
			back();
			checkCategory(system);
			back();
			expect(textValue(h.viewer.nativeOverlay.head)).toBe(overviewHead);
			expect(h.render()[0]).toContain(data.modelLabel);

			const output = data.categories.find(category => category.id === "tool-output")!;
			const read = output.children![0]!;
			select(h.viewer, read.key!);
			root = checkCategory(read);
			expect(nodes(root).some(node => node.key === "entry-result/0")).toBe(true);
			back();
			expect(textValue(h.viewer.nativeOverlay.head)).toBe(overviewHead);

			const empty = data.categories.find(category => category.id === "custom-tools")!;
			select(h.viewer, empty.id);
			checkCategory(empty);
			back();
			expect(textValue(h.viewer.nativeOverlay.head)).toBe(overviewHead);
		} finally {
			h.viewer.dispose();
		}
	});

	it("exposes native token and usage columns with selection colors but no token bold", () => {
		const h = harness();
		try {
			for (const context of [cx, meterCx]) {
				for (const key of ["system-prompt", "tool-output"]) {
					select(h.viewer, key, false);
					const root = h.viewer.describe(context);
					for (const category of ["system-prompt", "tool-output"] as const) {
						const row = nodes(root).find(node => node.key === category);
						const tokens = contextField(row, "tokens");
						const share = contextField(row, "share");
						if (!tokens || !share) throw new Error(`Missing separate native columns: ${category}`);
						const color = key === category ? CONTEXT_PRESENTATION[category].color : undefined;
						expect(tokens.p?.spans?.[0]?.s).toBe(color);
						expect(share.p?.spans?.[0]?.s).toBe(color);
						expect(usageColumns(row)).toEqual(category === "system-prompt" ? ["21K", "10.6%"] : ["32K", "15.9%"]);
					}
				}
			}
		} finally {
			h.viewer.dispose();
		}
	});

	it("distinguishes tiny nonzero usage from zero and the rounding boundary", () => {
		for (const [tokens, share] of [
			[0, "0.0%"],
			[1, "<0.1%"],
			[99, "<0.1%"],
			[100, "0.1%"],
		] as const) {
			const data = fixture();
			const h = harness({
				...data,
				usage: tokens,
				categories: [{ ...data.categories[0]!, tokens: 1 }],
			});
			try {
				for (const width of [48, 100]) {
					const line = h.render(width).find(line => line.includes("System Prompt"))!;
					expect(line.match(/<?\d+\.\d%/)?.[0]).toBe(share);
				}
				for (const context of [cx, meterCx]) {
					const item = nodes(h.viewer.describe(context)).find(item => item.key === "system-prompt");
					expect(usageColumns(item)?.[1]).toBe(share);
				}
			} finally {
				h.viewer.dispose();
			}
		}
	});

	it("aligns token and usage columns across categories, children, and capacity rows", () => {
		const data = fixture();
		data.categories[0]!.label = "寬".repeat(80);
		const h = harness(data);
		try {
			for (const width of [48, 100]) {
				const lines = h.render(width).filter(line => /\d+K?\s+\d+\.\d%/.test(line));
				const ends = lines.map(line => {
					const match = /(\d+K?)\s+(\d+\.\d%)/.exec(line)!;
					const start = visibleWidth(line.slice(0, match.index));
					return [start + match[1]!.length, start + match[0].length];
				});
				expect(ends.length).toBeGreaterThan(1);
				expect(ends.every(end => end[0] === ends[0]![0] && end[1] === ends[0]![1])).toBe(true);
				expect(h.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
			}
		} finally {
			h.viewer.dispose();
		}
	});

	it("keeps usage in two overview rows and gives preview and full content the reclaimed rows", () => {
		const data = fixture();
		const usage = { contextWindow: 272000, usedTokens: 71000, freeTokens: 160200, thresholdTokens: 231200 };
		const h = harness({
			...data,
			modelLabel: "GPT-6 Luna",
			window: usage.contextWindow,
			usage: usage.usedTokens,
			free: usage.freeTokens,
			buffer: 40800,
			breakdown: { ...data.breakdown, ...usage },
		});
		data.categories[0]!.entries = [
			{ id: "first", label: "first source", tokens: 1, text: "one\ntwo\nthree\nfour\nfive\nsource-tail" },
			{ id: "second", label: "second source", tokens: 1, text: "other source" },
		];
		try {
			const overview = h.render();
			expect(overview[0]).toContain("Context · GPT-6 Luna");
			expect(overview[1]).toMatch(/71K.*272K.*26%/);
			expect(overview[2]).toMatch(/160K.*85%/);
			expect(overview[3]).toContain("System Prompt");
			h.resize(12);
			h.viewer.handleInput("\r");
			const preview = h.render();
			expect(preview[1]).toContain("[first source]");
			expect(preview.join("\n")).toContain("source-tail");
			h.viewer.handleInput("\r");
			const full = h.render();
			expect(full[1]).toContain("[first source]");
			expect(full.join("\n")).toContain("source-tail");
			h.viewer.handleInput("\x1b");
			h.render();
			h.viewer.handleInput("\x1b");
			expect(h.render()[1]).toMatch(/71K.*272K.*26%/);
		} finally {
			h.viewer.dispose();
		}
	});

	it.each([
		{ name: "without meter support", supportsMeter: false, emptyWeights: false },
		{ name: "without category weights", supportsMeter: true, emptyWeights: true },
	])("shows usage and compaction totals $name", ({ supportsMeter, emptyWeights }) => {
		const data = fixture();
		data.breakdown.thresholdTokens = 160000;
		if (emptyWeights) for (const category of data.categories) category.tokens = 0;
		const h = harness(data);
		try {
			const root = h.viewer.describe({ ...cx, supports: () => supportsMeter });
			const lines = nodes(root).flatMap(node => (node.k === "text" ? [textValue(node.p?.spans)] : []));
			expect(lines.some(line => /85K.*200K/.test(line ?? ""))).toBe(true);
			expect(lines.some(line => /75K.*80%/.test(line ?? ""))).toBe(true);
		} finally {
			h.viewer.dispose();
		}
	});

	it("keeps buffer and free totals at normal contrast without opening them or adding a footer rule", () => {
		const h = harness();
		try {
			const root = h.viewer.describe(meterCx);
			const list = nodes(root).find(node => node.key === "categories");
			if (!list) throw new Error("Missing categories");
			for (const key of ["buffer", "free"]) {
				const summary = nodes(list).find(node => node.key === key);
				expect(summary?.p?.actions).toBeUndefined();
				expect(textValue(contextField(summary, "label")?.p?.spans)).toBe(
					key === "buffer" ? "Auto-Compact Buffer" : "Free Space",
				);
				expect(usageColumns(summary)).toEqual(key === "buffer" ? ["20K", "10.0%"] : ["95K", "47.5%"]);
				select(h.viewer, key);
				expect(selected(h.viewer.describe(meterCx))).toBe("system-prompt");
			}
			expect(nodes(root).filter(node => node.k === "rule")).toHaveLength(0);
		} finally {
			h.viewer.dispose();
		}
	});

	it("keeps category swatches matched to the usage bar", () => {
		const h = harness();
		try {
			const root = h.viewer.describe(meterCx);
			const all = nodes(root);
			const meter = all.find(node => node.k === "meter");
			if (meter?.k !== "meter") throw new Error("Missing context meter");
			const list = all.find(node => node.key === "categories");
			if (!list) throw new Error("Missing categories");
			const item = (key: string) => {
				const row = nodes(list).find(node => node.key === key);
				if (!row) throw new Error(`Missing category: ${key}`);
				return row;
			};
			const expected = [
				{
					row: item("system-prompt"),
					glyph: "■",
					color: CONTEXT_PRESENTATION["system-prompt"].color,
					bar: item("system-prompt"),
				},
				{ row: item("skills"), glyph: "■", color: CONTEXT_PRESENTATION.skills.color },
				{
					row: item("tool-output/read"),
					glyph: "■",
					color: CONTEXT_PRESENTATION["tool-output"].color,
					bar: item("tool-output"),
				},
			];
			for (const item of expected) {
				const swatch = contextField(item.row, "swatch")?.p?.spans?.[0];
				expect(swatch?.t.trim()).toBe(item.glyph);
				expect(swatch?.s).toBe(item.color);
				if (item.bar) {
					const label = textValue(contextField(item.bar, "label")?.p?.spans);
					expect(meter.p?.parts?.find(part => part.label?.startsWith(`${label} ·`))?.token).toBe(item.color);
				}
			}
			expect(selected(root)).toBe("system-prompt");
			const fallback = nodes(h.viewer.describe(cx)).find(node => node.key === "system-prompt");
			expect(textValue(contextField(fallback, "swatch")?.p?.spans)).toBe(theme.symbol("context.content"));
		} finally {
			h.viewer.dispose();
		}
	});

	it("selects and opens category rows through reconciled actions without activating the buffer", () => {
		const h = harness();
		try {
			const reconciler = new Reconciler("context-swatches");
			const pending = reconciler
				.reconcile({ main: [h.viewer], dock: [], layer: [] }, meterCx)
				.flatMap(op => (op[0] === "add" ? [op[4]] : []));
			const paths = new Map<string, string>();
			for (let index = 0; index < pending.length; index++) {
				const wire = pending[index]!;
				const path = reconciler.target(wire.id)?.keypath;
				if (wire.k === "row" && path?.includes("/categories/")) {
					paths.set(path.slice(path.indexOf("/categories/") + "/categories/".length), path);
				}
				pending.push(...(wire.c ?? []));
			}
			const act = (key: string, action: string) => {
				const path = paths.get(key);
				if (!path) throw new Error(`Missing category path: ${key}`);
				h.viewer.handleNativeEvent({ type: "action", key: path, act: action, mods: [] });
			};
			act("tool-output/read", "select-category");
			expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
			act("buffer", "open-category");
			expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
			act("tool-output/read", "open-category");
			expect(JSON.stringify(h.viewer.describe(meterCx))).toContain("context-output-tail");
			h.viewer.handleInput("\x1b");
			expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
			h.viewer.handleInput("\x1b[A");
			expect(selected(h.viewer.describe(meterCx))).toBe("tool-output");
		} finally {
			h.viewer.dispose();
		}
	});

	it("places a stacked meter above selectable categories on meter-capable terminals", () => {
		const data = fixture();
		const h = harness(data);
		try {
			for (const cols of [48, 100]) {
				const root = h.viewer.describe({ ...meterCx, cols });
				const all = nodes(root);
				const meter = all.find(node => node.k === "meter");
				if (meter?.k !== "meter") throw new Error("Missing context meter");
				expect(meter.p?.value).toBe(data.usage / data.window);
				expect(meter.p?.parts?.map(part => part.value)).toEqual([
					21250 / 200000,
					10625 / 200000,
					10625 / 200000,
					10625 / 200000,
					31875 / 200000,
					95000 / 200000,
					20000 / 200000,
				]);
				expect(meter.p?.parts?.at(-1)).toMatchObject({ token: "warning", hatch: true });
				expect(meter.p?.marks?.[0]?.at).toBe(data.breakdown.thresholdTokens! / data.window);
				const body = root.c?.findIndex(child => "k" in child && child.key === "overview");
				const bar = root.c?.findIndex(child => "k" in child && child.k === "meter");
				expect(bar).toBeLessThan(body!);
			}
			select(h.viewer, "tool-output/read");
			const entry = nodes(h.viewer.describe(meterCx)).find(node => node.key === "entry-result/0");
			expect(JSON.stringify(entry)).toContain("context-output-tail");
			h.viewer.handleInput("\x1b");
			expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
			expect(nodes(h.viewer.describe(cx)).some(node => node.k === "meter")).toBe(false);
		} finally {
			h.viewer.dispose();
		}
	});

	it("preserves body paths while sanitizing terminal controls in ANSI and native content", () => {
		const data = fixture();
		const path = `${os.homedir()}/context-viewer/source.txt`;
		data.categories[0]!.entries[0] = {
			id: "source",
			label: "source",
			tokens: 1,
			path,
			text: `Source: ${path}\n\tbody\x1b[31m visible\x1b[0m`,
		};
		const h = harness(data);
		h.render();
		select(h.viewer, "system-prompt");
		const ansi = h.render(160).join("\n");
		expect(ansi).toContain(`Source: ${path}`);
		expect(ansi).not.toContain("\t");
		const body = nodes(h.viewer.describe({ ...cx, cols: 160 }))
			.filter(node => node.k === "text")
			.flatMap(node =>
				node.k === "text" ? [node.p?.text ?? "", ...(node.p?.spans?.map(span => span.t) ?? [])] : [],
			)
			.join("\n");
		expect(body).toContain(`Source: ${path}`);
		expect(body).not.toContain("\x1b");
	});

	it("shows message time and tool call ID in ANSI and native previews and full content", () => {
		const h = harness();
		const expectedTime = (hour12: boolean | undefined) =>
			new Date(0).toLocaleString([], {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12,
			});
		h.render();
		select(h.viewer, "tool-output");
		const preview = h.render().join("\n");
		expect(preview).toContain("Call ID: call-123");
		expect(preview).toContain(expectedTime(undefined));
		expect(preview).toContain("[read result]");
		const narrowPreview = h.render(48).join("\n");
		expect(narrowPreview).toContain("Call ID: call-123");
		expect(narrowPreview).toContain(
			new Date(0).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" }),
		);
		const nativePreview = nodes(h.viewer.describe({ ...cx, hour12: false })).find(
			node => node.k === "col" && node.key === "result/0",
		);
		expect(JSON.stringify(nativePreview)).toContain(expectedTime(false));
		h.viewer.handleInput("\r");
		const full = h.render().join("\n");
		expect(full).toContain("Call ID: call-123");
		expect(full).toContain(expectedTime(false));
		const nativeFull = JSON.stringify(h.viewer.describe({ ...cx, hour12: false }));
		expect(nativeFull).toContain("Call ID: call-123");
		expect(nativeFull).toContain(expectedTime(false));
		h.viewer.handleInput("\x1b");
		expect(h.render(48).join("\n")).toContain("Call ID: call-123");
	});

	it("shows estimated wire savings in the overview without a diagnostics navigation level", () => {
		const data = fixture();
		const h = harness(data);
		const overview = h.render(160);
		expect(overview.join("\n")).toContain("85K");
		expect(overview.join("\n")).toContain("95K");
		expect(h.viewer.capturesInput("d")).toBe(false);
		h.viewer.handleInput("d");
		expect(h.render(160)).toEqual(overview);
		scrollToText(h.viewer, () => h.render(160), "2 frames");
		const savings = h.render(160).join("\n");
		expect(savings).toContain("6K");
		expect(savings).toContain("79K");
		expect(savings).toContain("2 frames");
		expect(nodes(h.viewer.describe(cx)).some(node => node.p?.actions?.click === "diagnostics")).toBe(false);
		h.viewer.handleInput("\x1b");
		expect(h.closed()).toBe(1);
	});

	it("resolves map cells and interactive legend swatches from the same live theme, including overrides after invalidate", () => {
		const base = getBuiltinThemes().dark!;
		const h = harness();
		for (const override of ["A", "寬寬"]) {
			setThemeInstance(
				createTheme({
					...base,
					symbols: {
						preset: "unicode",
						overrides: {
							"context.content": override,
							"context.messages": "msg",
							"context.buffer": "buf",
							"context.free": "free",
						},
					},
				}),
			);
			h.viewer.invalidate();
			const lines = h.viewer.render(100);
			const system = lines.find(line => Bun.stripANSI(line).includes("System Prompt"))!;
			const p = CONTEXT_PRESENTATION["system-prompt"];
			const swatch = theme.styledSymbol(p.symbol, p.color);
			// Overrides change geometry; locate the map and the interactive row before its label.
			const legendStart = Bun.stripANSI(system).indexOf("System Prompt");
			expect(system.indexOf(swatch)).toBeGreaterThanOrEqual(0);
			expect(Bun.stripANSI(system.slice(system.indexOf(swatch) + swatch.length))).toContain("System Prompt");
			const native = nodes(h.viewer.describe(cx));
			const grid = native.filter(node => node.k === "text" && node.p?.wrap === "none");
			expect(
				grid.some(
					node =>
						node.k === "text" &&
						node.p?.spans?.some(span => span.t.startsWith(override) && span.s?.split(" ")[0] === p.color),
				),
			).toBe(true);
			for (const key of ["skills", "built-in-tools", "tool-output", "buffer", "free"] as const) {
				const legend = native.find(node => node.key === key);
				const presentation = CONTEXT_PRESENTATION[key];
				const swatch = contextField(legend, "swatch")?.p?.spans?.[0];
				expect(
					grid.some(
						node =>
							node.k === "text" &&
							node.p?.spans?.some(
								cell => cell.t.trim() === swatch?.t.trim() && cell.s?.split(" ")[0] === swatch?.s,
							),
					),
				).toBe(true);
				expect(swatch?.s).toBe(presentation.color);
			}
			const top = native.find(node => node.key === "tool-output");
			const child = native.find(node => node.key === "tool-output/read");
			const topSwatch = contextField(top, "swatch")?.p?.spans?.[0];
			const childSwatch = contextField(child, "swatch")?.p?.spans?.[0];
			expect(childSwatch?.s).toBe(topSwatch?.s);
			expect(childSwatch?.t).toBe(topSwatch?.t);
			if (override === "A") {
				expect(sliceWithWidth(system, 2, 31, true).text).toContain(swatch);
				expect(sliceWithWidth(system, 36, 60, true).text).toContain(swatch);
			}
			expect(legendStart).toBeGreaterThan(3);
		}
	});

	it("conserves Used across top-level allocations and splits only the parent's budget among children", () => {
		const data = fixture();
		const categories = data.categories.filter(category => category.tokens > 0);
		for (const category of categories) category.tokens = 1;
		const output = categories.at(-1)!;
		for (const child of output.children!) child.tokens = 1;
		const h = harness({ ...data, usage: 7, window: 100, buffer: 10, free: 83, categories });
		const value = (key: string) => {
			const item = nodes(h.viewer.describe(cx)).find(node => node.key === key);
			return usageColumns(item);
		};
		expect(categories.map(category => value(category.id))).toEqual([
			["2", "2.0%"],
			["2", "2.0%"],
			["1", "1.0%"],
			["1", "1.0%"],
			["1", "1.0%"],
		]);
		expect(value("tool-output/read")).toEqual(["1", "1.0%"]);
		expect(value("tool-output/bash")).toEqual(["0", "0.0%"]);
		expect(value("buffer")).toEqual(["10", "10.0%"]);
		expect(value("free")).toEqual(["83", "83.0%"]);
		expect(categories.map(category => category.tokens)).toEqual([1, 1, 1, 1, 1]);
	});

	it("assigns leftover tokens by descending remainder before category order", () => {
		const data = fixture();
		const categories = data.categories.slice(0, 3);
		for (const [index, category] of categories.entries()) category.tokens = [1, 2, 4][index]!;
		const h = harness({ ...data, categories, usage: 5, window: 100 });
		const values = nodes(h.viewer.describe(cx)).filter(
			node => node.k === "row" && categories.some(category => category.id === node.key),
		);
		expect(values.map(node => usageColumns(node))).toEqual([
			["1", "1.0%"],
			["1", "1.0%"],
			["3", "3.0%"],
		]);
	});

	it("reserves gutter and scrollbar columns before wrapping a wide-character preview", () => {
		const data = fixture();
		const output = data.categories.find(category => category.id === "tool-output")!;
		const body = `${"寬".repeat(18)}END`;
		output.entries[0] = { id: "result/0", label: "wide", tokens: 1, text: body };
		output.entries[1] = { id: "result/1", label: "overflow", tokens: 1, text: "overflow\n".repeat(100) };
		const h = harness(data);
		h.resize(18);
		h.render(48);
		select(h.viewer, "tool-output");
		const lines = h.render(48);
		const content = lines.find(line => line.includes("END"));
		expect(content).toContain(`┃   ${body}`);
		expect(content).toMatch(/[│█] │$/);
		expect(lines.every(line => visibleWidth(line) <= 48)).toBe(true);
	});

	it("keeps original totals without inventing shares when estimates or capacity are unavailable", () => {
		const data = fixture();
		for (const category of data.categories) category.tokens = 0;
		const h = harness(data);
		expect(h.render(160).join("\n")).toContain("85K");
		const items = nodes(h.viewer.describe(cx)).filter(node => node.k === "row");
		expect(usageColumns(items.find(node => node.key === "system-prompt"))).toEqual(["—"]);
		const zero = harness({ ...fixture(), window: 0, usage: 0, buffer: 0, free: 0 });
		expect(zero.render(160).join("\n")).not.toMatch(/NaN|Infinity/);
		const over = harness({ ...fixture(), window: 10, usage: 15, buffer: 0, free: 0 });
		expect(over.render(160)[1]).toMatch(/15.*10.*150%/);
		const top = nodes(over.viewer.describe(cx)).find(node => node.key === "system-prompt");
		expect(usageColumns(top)).toEqual(["4", "40.0%"]);
	});

	it("keeps a zero-usage allocation at zero without hiding free capacity", () => {
		const data = fixture();
		const zero = harness({ ...data, usage: 0, buffer: 20000, free: 180000 });
		const values = nodes(zero.viewer.describe(cx)).filter(node => node.k === "row");
		expect(usageColumns(values.find(node => node.key === "tool-output"))).toEqual(["0", "0.0%"]);
		expect(usageColumns(values.find(node => node.key === "free"))).toEqual(["180K", "90.0%"]);
	});

	it("keeps inactive Snapcompact reasons visible in the overview", () => {
		const data = fixture();
		const inactive = harness({
			...data,
			breakdown: {
				...data.breakdown,
				snapcompact: { visionCapable: false, savedTokens: 0 },
			},
		});
		scrollToText(inactive.viewer, () => inactive.render(160), "no image input");
		expect(inactive.render(160).join("\n")).toContain("no image input");
	});

	it("keeps selected block gutters on visible body rows after the title scrolls away without marking separators", () => {
		const data = fixture();
		const output = data.categories.find(category => category.id === "tool-output")!;
		output.entries[0] = {
			id: "result/0",
			label: "first title",
			info: "metadata",
			tokens: 1,
			text: "first body\n\n寬字 body\nlast body\nanother body\nmore body\nfinal body",
		};
		const h = harness(data);
		h.resize(12);
		h.render(48);
		select(h.viewer, "tool-output");
		const before = h.render(48);
		expect(before.find(line => line.includes("first title"))).toContain("┃ ");
		let scrolled = before;
		for (let index = 0; index < before.length && scrolled.some(line => line.includes("first title")); index++) {
			h.viewer.handleInput("\x1b[B");
			scrolled = h.render(48);
		}
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("result/0");
		expect(scrolled.some(line => line.includes("first title"))).toBe(false);
		expect(scrolled.filter(line => line.includes("body")).every(line => line.includes("┃ "))).toBe(true);
		h.viewer.handleNativeEvent({ type: "action", key: "entries/result/1", act: "select-entry", mods: [] });
		const next = h.render(48);
		expect(next.find(line => line.includes("bash result"))).toContain("┃ ");
		expect(next.find(line => line.includes("short result"))).toContain("┃ ");
		expect(next.filter(line => line.includes("┃")).length).toBe(3);
		expect(next.every(line => visibleWidth(line) <= 48)).toBe(true);
	});

	it("preserves the footer divider and bottom border at short heights in overview, preview and full content", () => {
		const h = harness();
		for (const page of ["overview", "category", "entry"]) {
			if (page === "category") select(h.viewer, "tool-output");
			if (page === "entry") h.viewer.handleInput("\r");
			for (const height of [18, 6, 4]) {
				h.resize(height);
				const lines = h.render(48);
				expect(lines).toHaveLength(height);
				expect(lines.at(-3)).toMatch(/^├.*┤$/);
				expect(lines.at(-1)).toMatch(/^╰.*╯$/);
				expect(lines.every(line => visibleWidth(line) <= 48)).toBe(true);
			}
			h.resize(24);
			h.render();
		}
	});

	it("keeps wide symbols and content inside all responsive widths, and remains usable after width-only and height-only resizes", () => {
		const base = getBuiltinThemes().dark!;
		setThemeInstance(
			createTheme({
				...base,
				symbols: { preset: "ascii", overrides: { "context.content": "寬寬", "context.messages": "multi" } },
			}),
		);
		const h = harness();
		for (const width of [48, 64, 100]) {
			const lines = h.viewer.render(width);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		}
		select(h.viewer, "tool-output/read");
		h.render(48);
		scrollToText(h.viewer, () => h.render(48), "context-output-tail");
		expect(h.render(48).join("\n")).toContain("context-output-tail");
		h.resize(18);
		h.render(48);
		scrollToText(h.viewer, () => h.render(48), "context-output-tail");
		expect(h.render(48).join("\n")).toContain("context-output-tail");
		h.render(100);
		scrollToText(h.viewer, () => h.render(100), "context-output-tail");
		expect(h.render(100).join("\n")).toContain("context-output-tail");
	});
});
