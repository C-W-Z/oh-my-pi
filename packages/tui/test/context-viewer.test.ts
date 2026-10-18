import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { TspText } from "@oh-my-pi/pi-wire";
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
import { computeContextBreakdown, ContextUsageView } from "../src/status-line/context-usage";

const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
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
		estimatedTokens: 80000,
		buffer: 20000,
		free: 95000,
		notices: [],
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
			{ id: "instruction-files", label: "Instruction Files", tokens: 0, entries: [] },
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
			{
				id: "user-messages",
				label: "User Messages",
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
	viewer.handleNativeEvent({ type: activate ? "activate" : "select", key: "categories", item: key });
}

function selected(root: NativeNode): string | null | undefined {
	const list = nodes(root).find(node => node.k === "list");
	return list?.k === "list" ? list.p?.selected : nodes(root).find(node => node.p?.mark === "pick")?.key;
}

describe("ContextViewer navigation", () => {
	it("reaches saved output tail and restores preview selection and offset through Back", () => {
		const h = harness();
		h.render();
		select(h.viewer, "tool-output");
		const preview = h.render();
		h.viewer.handleInput("\r");
		h.viewer.handleInput("\x1b[F");
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
		h.viewer.handleInput("\x1b[F");
		expect(h.render().join("\n")).toContain("context-output-tail");
		h.viewer.handleInput("\x1b");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/read");
		select(h.viewer, "instruction-files");
		h.render();
		expect(nodes(h.viewer.describe(cx)).filter(node => node.k === "item")).toEqual([]);
		h.viewer.handleInput("\x1b");
		h.render();
		h.viewer.handleInput("\x1b[F");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/bash");
		h.viewer.handleInput("j");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/bash");
		h.resize(12);
		h.render(48);
		h.viewer.handleInput("\x1b[F");
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

	it("scrolls Native multiline previews before changing selection and restores the category viewport after Back", () => {
		const data = fixture();
		data.categories.find(category => category.id === "skills")!.entries = [
			{ id: "skill/0", label: "long skill", tokens: 1, text: `${"routing hint\n".repeat(60)}native-skill-tail` },
			{ id: "skill/1", label: "next skill", tokens: 1, text: "next routing hint" },
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
		select(h.viewer, "skills");
		reconcile();
		const preview = nodes(h.viewer.describe(nativeCx));
		const body = preview.find(node => node.key === "entries")!;
		expect(body.k).toBe("col");
		expect(body.scroll).toBeDefined();
		for (const [key, by] of [
			["j", "line-down"],
			["\x1b[6~", "page-down"],
			["k", "line-up"],
			["\x1b[5~", "page-up"],
		] as const) {
			h.viewer.handleInput(key);
			const ops = reconcile();
			expect(ops.filter(op => op[0] === "scroll").map(op => op[2])).toEqual([by]);
			expect(selected(h.viewer.describe(nativeCx))).toBe("skill/0");
		}
		h.viewer.handleInput("j");
		reconcile();
		const before = h.render(48);
		h.viewer.handleInput("\r");
		reconcile();
		h.viewer.handleInput("\x1b[F");
		reconcile();
		expect(h.render(48).join("\n")).toContain("native-skill-tail");
		h.viewer.handleInput("\x1b");
		const restored = reconcile();
		expect(restored.some(op => op[0] === "reveal" && op[2] === "start")).toBe(true);
		expect(h.render(48)).toEqual(before);
		h.resize(18);
		reconcile();
		let changed = false;
		for (let step = 0; step < 80; step++) {
			h.viewer.handleInput("j");
			const ops = reconcile();
			if (selected(h.viewer.describe(nativeCx)) === "skill/1") {
				expect(ops.some(op => op[0] === "scroll")).toBe(false);
				expect(ops.some(op => op[0] === "reveal")).toBe(true);
				changed = true;
				break;
			}
			expect(ops.some(op => op[0] === "scroll" && op[2] === "line-down")).toBe(true);
		}
		expect(changed).toBe(true);
		h.viewer.handleNativeEvent({ type: "action", key: "entries/skill/0", act: "select-entry", mods: [] });
		reconcile();
		expect(selected(h.viewer.describe(nativeCx))).toBe("skill/0");
	});

	it("clamps a Native page step to the selected entry tail before advancing selection", () => {
		const data = fixture();
		data.categories.find(category => category.id === "skills")!.entries = [
			{ id: "skill/0", label: "first", tokens: 1, text: `${"body\n".repeat(6)}partial-page-tail` },
			{ id: "skill/1", label: "next", tokens: 1, text: "next body" },
		];
		const h = harness(data);
		h.resize(12);
		const nativeCx = { ...cx, cols: 48 };
		const reconciler = new Reconciler("context-boundary");
		const regions = { main: [h.viewer], dock: [], layer: [] };
		reconciler.reconcile(regions, nativeCx);
		select(h.viewer, "skills");
		reconciler.reconcile(regions, nativeCx);
		h.viewer.handleInput("\x1b[6~");
		const scrolls = reconciler.reconcile(regions, nativeCx).filter(op => op[0] === "scroll");
		expect(scrolls.map(op => op[2])).toEqual(["line-down", "line-down", "line-down"]);
		expect(selected(h.viewer.describe(nativeCx))).toBe("skill/0");
		expect(h.render(48).join("\n")).toContain("partial-page-tail");
		h.viewer.handleInput("\x1b[6~");
		expect(reconciler.reconcile(regions, nativeCx).some(op => op[0] === "scroll")).toBe(false);
		expect(selected(h.viewer.describe(nativeCx))).toBe("skill/1");
	});

	it("handles native select/activate/Back/Close and emits repeated terminal scroll requests", () => {
		const h = harness();
		h.viewer.describe(cx);
		select(h.viewer, "tool-output/read", false);
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/read");
		select(h.viewer, "tool-output/read");
		h.viewer.describe(cx);
		h.viewer.handleInput("\x1b[6~");
		const scroll = nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll;
		expect(scroll).toMatchObject({ by: "page-down", n: 1 });
		h.viewer.handleInput("\x1b[6~");
		expect(nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll).toMatchObject({
			by: "page-down",
			n: 2,
		});
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/read");
		h.viewer.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
		expect(h.closed()).toBe(1);
	});
});

describe("ContextViewer preview boundaries", () => {
	it("keeps a long skill hint scrollable in its category without requiring a full-content level", () => {
		const data = fixture();
		const skills = data.categories.find(category => category.id === "skills")!;
		skills.entries = [
			{
				id: "skill/0",
				label: "long skill",
				tokens: 100,
				path: "/fixture/skills/long/SKILL.md",
				text: `${"routing hint\n".repeat(60)}skill-description-tail`,
			},
			{ id: "skill/1", label: "next skill", tokens: 1, text: "next routing hint" },
		];
		const h = harness(data);
		h.resize(12);
		h.render(48);
		select(h.viewer, "skills");
		let screen = h.render(48).join("\n");
		for (let index = 0; index < 70 && !screen.includes("skill-description-tail"); index++) {
			h.viewer.handleInput("j");
			screen = h.render(48).join("\n");
		}
		expect(screen).toContain("skill-description-tail");
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("skill/0");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(cx))).toBe("skills");
	});

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
		expect(h.render(48).join("\n")).not.toContain("single-line-tail");
		h.viewer.handleInput("\r");
		h.render(48);
		h.viewer.handleInput("\x1b[F");
		expect(h.render(48).join("\n")).toContain("single-line-tail");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("result/0");
	});
});

describe("ContextViewer presentation", () => {
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

	it("shows compaction and estimated wire savings in the overview without a diagnostics navigation level", () => {
		const data = fixture();
		const h = harness(data);
		const overview = h.render(160);
		expect(overview.join("\n")).toContain("85K");
		expect(overview.join("\n")).toContain("95K");
		expect(overview.join("\n")).toContain("Compaction");
		expect(h.viewer.capturesInput("d")).toBe(false);
		h.viewer.handleInput("d");
		expect(h.render(160)).toEqual(overview);
		h.viewer.handleInput("\x1b[F");
		const savings = h.render(160).join("\n");
		expect(savings).toContain("6K");
		expect(savings).toContain("79K");
		expect(savings).toContain("2 frames");
		expect(nodes(h.viewer.describe(cx)).some(node => node.p?.actions?.click === "diagnostics")).toBe(false);
		h.viewer.handleInput("\x1b");
		expect(h.closed()).toBe(1);
	});

	it("preserves counts and percentage denominators when switching Window/Fit", () => {
		const h = harness();
		h.render();
		const before = nodes(h.viewer.describe(cx))
			.filter(node => node.k === "item")
			.map(node => node.p);
		h.viewer.handleInput("z");
		h.render();
		const after = nodes(h.viewer.describe(cx))
			.filter(node => node.k === "item")
			.map(node => node.p);
		expect(after).toEqual(before);
		expect(h.render()[0]).toContain("Fit");
		h.viewer.handleInput("z");
		expect(h.render()[0]).toContain("Window");
	});

	it("does not capture zoom for an empty, window-sized or hidden map", () => {
		for (const [usage, window, width] of [
			[0, 200000, 100],
			[80000, 10000, 100],
			[80000, 200000, 48],
		]) {
			const data = fixture();
			const h = harness({ ...data, usage: usage!, window: window! });
			h.render(width);
			expect(h.viewer.capturesInput("z")).toBe(false);
			h.viewer.handleInput("z");
			expect(h.render(width)[0]).toContain("Window");
		}
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
				const swatch = legend?.k === "item" && Array.isArray(legend.p?.label) ? legend.p.label[0] : undefined;
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
			if (top?.k === "item" && child?.k === "item" && Array.isArray(top.p?.label) && Array.isArray(child.p?.label)) {
				expect(child.p.label[0]?.s).toBe(top.p.label[0]?.s);
				expect(child.p.label[0]?.t.trim()).toBe(top.p.label[0]?.t.trim());
			} else throw new Error("Missing interactive Tool Output items");
			if (override === "A") {
				expect(sliceWithWidth(system, 2, 31, true).text).toContain(swatch);
				expect(sliceWithWidth(system, 36, 60, true).text).toContain(swatch);
			}
			expect(legendStart).toBeGreaterThan(3);
		}
	});

	it("updates the static ANSI legend and native meter/grid swatches with the live theme after invalidate", () => {
		const breakdown = computeContextBreakdown(
			{
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				systemPrompt: ["system source ".repeat(5000)],
				agent: { tokenizer: new Tokenizer(), state: { tools: [] } },
				messages: [],
			},
			{ compaction: DEFAULT_COMPACTION_SETTINGS },
		);
		const view = new ContextUsageView(breakdown, theme);
		for (const glyph of ["SRC", "next"]) {
			setThemeInstance(
				createTheme({
					...getBuiltinThemes().dark!,
					symbols: { preset: "ascii", overrides: { "context.content": glyph } },
					colors: { ...getBuiltinThemes().dark!.colors, accent: glyph === "SRC" ? "#1144cc" : "#cc4411" },
				}),
			);
			view.invalidate();
			const ansi = view.render(160);
			const swatch = theme.fg("accent", glyph);
			expect(ansi.slice(0, 10).some(line => line.includes(swatch))).toBe(true);
			expect(ansi.some(line => Bun.stripANSI(line).includes("System prompt:") && line.includes(swatch))).toBe(true);
			const native = nodes(view.describe(cx));
			expect(
				native.some(
					node => node.k === "text" && node.p?.spans?.some(span => span.t === glyph && span.s === "accent"),
				),
			).toBe(true);
			const fallback = nodes(view.describe({ ...cx, supports: () => false }));
			expect(
				fallback
					.filter(node => node.key?.startsWith("row-"))
					.some(
						node =>
							node.k === "text" && node.p?.spans?.some(span => span.t.trim() === glyph && span.s === "accent"),
					),
			).toBe(true);
		}
	});

	it("conserves Used across top-level allocations and splits only the parent's budget among children", () => {
		const data = fixture();
		const categories = data.categories.filter(category => category.tokens > 0);
		for (const category of categories) category.tokens = 1;
		const output = categories.at(-1)!;
		for (const child of output.children!) child.tokens = 1;
		const h = harness({ ...data, usage: 7, estimatedTokens: 5, window: 100, buffer: 10, free: 83, categories });
		const value = (key: string) => {
			const item = nodes(h.viewer.describe(cx)).find(node => node.key === key);
			return item?.k === "item" ? textValue(item.p?.value) : undefined;
		};
		expect(categories.map(category => value(category.id))).toEqual([
			"2 · 2.0%",
			"2 · 2.0%",
			"1 · 1.0%",
			"1 · 1.0%",
			"1 · 1.0%",
		]);
		expect(value("tool-output/read")).toBe("1 · 1.0%");
		expect(value("tool-output/bash")).toBe("0 · 0.0%");
		expect(value("buffer")).toBe("10 · 10.0%");
		expect(value("free")).toBe("83 · 83.0%");
		expect(categories.map(category => category.tokens)).toEqual([1, 1, 1, 1, 1]);
	});

	it("assigns leftover tokens by descending remainder before category order", () => {
		const data = fixture();
		const categories = data.categories.slice(0, 3);
		for (const [index, category] of categories.entries()) category.tokens = [1, 2, 4][index]!;
		const h = harness({ ...data, categories, estimatedTokens: 7, usage: 5, window: 100 });
		const values = nodes(h.viewer.describe(cx)).filter(node => node.k === "item" && !node.p?.disabled);
		expect(values.map(node => (node.k === "item" ? textValue(node.p?.value) : undefined))).toEqual([
			"1 · 1.0%",
			"1 · 1.0%",
			"3 · 3.0%",
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
		const h = harness({ ...data, estimatedTokens: 0 });
		expect(h.render(160).join("\n")).toContain("unavailable");
		expect(h.render(160).join("\n")).toContain("85K");
		expect(h.viewer.capturesInput("z")).toBe(false);
		const items = nodes(h.viewer.describe(cx)).filter(node => node.k === "item");
		expect(textValue(items.find(node => node.key === "system-prompt")?.p?.value)).toBe("—");
		const zero = harness({ ...fixture(), window: 0, usage: 0, buffer: 0, free: 0 });
		expect(zero.render(160).join("\n")).not.toMatch(/NaN|Infinity/);
		expect(zero.viewer.capturesInput("z")).toBe(false);
		const over = harness({ ...fixture(), window: 10, usage: 15, buffer: 0, free: 0 });
		expect(over.render(160).join("\n")).toContain("5 over window");
		const top = nodes(over.viewer.describe(cx)).find(node => node.key === "system-prompt");
		expect(top?.k === "item" && textValue(top.p?.value)).toBe("4 · 40.0%");
	});

	it("uses Used rather than raw estimates to enable Fit, including a zero-usage allocation", () => {
		const data = fixture();
		const h = harness({ ...data, usage: 20000, estimatedTokens: 400000 });
		h.render();
		expect(h.viewer.capturesInput("z")).toBe(true);
		h.viewer.handleInput("z");
		expect(h.render()[0]).toContain("Fit");
		const zero = harness({ ...data, usage: 0, buffer: 20000, free: 180000 });
		const values = nodes(zero.viewer.describe(cx)).filter(node => node.k === "item");
		expect(values.find(node => node.key === "tool-output")?.p?.value).toBe("0 · 0.0%");
		expect(values.find(node => node.key === "free")?.p?.value).toBe("180K · 90.0%");
	});

	it("keeps disabled and exceeded compaction states and inactive Snapcompact reasons visible", () => {
		const data = fixture();
		const disabled = harness({ ...data, breakdown: { ...data.breakdown, thresholdTokens: undefined } });
		expect(disabled.render(160).join("\n")).toContain("Compaction off");
		const exceeded = harness({
			...data,
			breakdown: {
				...data.breakdown,
				thresholdTokens: 80000,
				snapcompact: { visionCapable: false, savedTokens: 0 },
			},
		});
		expect(exceeded.render(160).join("\n")).toContain("5K over threshold");
		exceeded.viewer.handleInput("\x1b[F");
		expect(exceeded.render(160).join("\n")).toContain("no image input");
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
			h.viewer.handleInput("j");
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
				expect(lines.at(-2)).toContain("Esc");
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
			expect(h.render(width).join("\n")).toContain("System Prompt");
		}
		select(h.viewer, "tool-output/read");
		h.render(48);
		h.viewer.handleInput("\x1b[F");
		expect(h.render(48).join("\n")).toContain("context-output-tail");
		h.resize(18);
		h.render(48);
		h.viewer.handleInput("\x1b[F");
		expect(h.render(48).join("\n")).toContain("context-output-tail");
		h.render(100);
		h.viewer.handleInput("\x1b[F");
		expect(h.render(100).join("\n")).toContain("context-output-tail");
	});
});
