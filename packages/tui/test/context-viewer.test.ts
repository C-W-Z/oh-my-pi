import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { NativeNode } from "../src/native/node";
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
				text:
					Array.from({ length: 100 }, (_, index) => `line ${index}\t${"long ".repeat(30)}`).join("\n") +
					"\ncontext-output-tail",
			},
			{ id: "result/1", label: "bash result", tokens: 10000, text: "short result" },
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
		free: 100000,
		notices: [],
		breakdown: computeContextBreakdown(
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
	return list?.k === "list" ? list.p?.selected : undefined;
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

	it("does not add a redundant full-content level for a preview already showing the complete entry", () => {
		const h = harness();
		h.render();
		select(h.viewer, "tool-output");
		h.render();
		h.viewer.handleNativeEvent({ type: "select", key: "entries", item: "result/1" });
		h.render();
		h.viewer.handleInput("\r");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("result/1");
		h.viewer.handleInput("\x1b");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
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

	it("opens the original usage report with compaction markers and savings, then returns without closing", () => {
		const data = fixture();
		const h = harness(data);
		h.render();
		h.viewer.handleInput("d");
		h.render();
		const diagnostic = nodes(h.viewer.describe(cx));
		const meter = diagnostic.find(node => node.k === "meter");
		expect(meter).toMatchObject({
			p: { marks: [expect.objectContaining({ at: data.breakdown.thresholdTokens! / data.window })] },
		});
		expect(diagnostic.some(node => node.key === "snapcompact")).toBe(true);
		h.viewer.handleInput("\x1b[F");
		expect(h.render(160).join("\n")).toContain("6K");
		h.viewer.handleInput("\x1b");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		expect(h.closed()).toBe(0);
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
		for (const [estimatedTokens, window, width] of [
			[0, 200000, 100],
			[80000, 10000, 100],
			[80000, 200000, 48],
		]) {
			const data = fixture();
			const h = harness({ ...data, estimatedTokens: estimatedTokens!, window: window! });
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
			const item = native.find(node => node.key === "system-prompt");
			expect(item?.k === "item" && item.p?.label).toEqual([
				{ t: `${override} `, s: p.color },
				{ t: "System Prompt" },
			]);
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
