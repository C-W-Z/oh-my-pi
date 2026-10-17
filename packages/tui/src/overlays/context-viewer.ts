import { countNewlines, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspScrollBy, TspSpan } from "@oh-my-pi/pi-wire";
import { contextFitScale, planContextMap } from "../chrome/context-map";
import {
	CONTEXT_PRESENTATION,
	type ContextCategoryId,
	type ContextPresentationId,
} from "../chrome/context-presentation";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { ScrollView } from "../components/scroll-view";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import { col, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
import { PREVIEW_LIMITS, replaceTabs, shortenEmbeddedPaths, shortenPath } from "../render/render-utils";
import { type ContextBreakdown, contextSnapcompactLines } from "../status-line/context-usage";
import { ensureThemeSync, theme } from "../theme/theme";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

export interface ContextViewEntry {
	readonly id: string;
	readonly label: string;
	readonly text: string;
	readonly tokens: number;
	readonly path?: string;
	readonly info?: string;
}

export interface ContextViewCategory {
	id: ContextCategoryId;
	key?: string;
	label: string;
	tokens: number;
	entries: ContextViewEntry[];
	children?: ContextViewCategory[];
}

export interface ContextViewData {
	readonly modelLabel: string;
	readonly window: number;
	readonly usage: number;
	readonly estimatedTokens: number;
	readonly buffer: number;
	readonly free: number;
	readonly breakdown: ContextBreakdown;
	readonly categories: readonly ContextViewCategory[];
	readonly notices: readonly string[];
}

interface OverviewRow {
	key: string;
	id: ContextPresentationId;
	label: string;
	tokens: number | undefined;
	child?: boolean;
	category?: ContextViewCategory;
}

interface EntryRange {
	start: number;
	end: number;
	complete: boolean;
	hiddenLines: number;
}

function allocateTokens(weights: readonly number[], total: number): number[] | undefined {
	const sum = weights.reduce((value, weight) => value + weight, 0);
	if (!(sum > 0) || !Number.isFinite(sum)) return;
	const shares = weights.map((weight, index) => {
		const exact = (total * weight) / sum;
		return { index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	const remaining = total - shares.reduce((value, share) => value + share.tokens, 0);
	const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let index = 0; index < remaining; index++) ranked[index]!.tokens++;
	return shares.map(share => share.tokens);
}

/** Read-only snapshot navigation with shared state for keyboard and native interactions. */
export class ContextViewer implements Component {
	readonly nativeOverlay = { role: "omp.overlay.context", size: "lg", anchor: "center", head: "Context" } as const;
	readonly #data: ContextViewData;
	readonly #close: () => void;
	readonly #requestRender: () => void;
	readonly #getRows: () => number;
	readonly #overview: MenuSelection<OverviewRow>;
	readonly #overviewScroll = new ScrollView([], { height: 1 });
	readonly #previewScroll = new ScrollView([], { height: 1 });
	readonly #fullScroll = new ScrollView([], { height: 1 });
	readonly #panel = new OverlayPanel("Context");
	readonly #allocated = new Map<ContextViewCategory, number>();
	readonly #allocationAvailable: boolean;
	readonly #header = new PanelRows();
	readonly #body = new PanelRows();
	readonly #footer = new PanelRows();
	#state: "overview" | "category" | "entry" = "overview";
	#category: ContextViewCategory | undefined;
	#entries = new MenuSelection<ContextViewEntry>([], {
		getKey: entry => entry.id,
		getSearchText: entry => entry.label,
	});
	#entry: ContextViewEntry | undefined;
	#entryParent: "overview" | "category" = "overview";
	#fit = false;
	#mapVisible = false;
	#width = 0;
	#height = 1;
	#previewCache:
		| { category: ContextViewCategory; width: number; height: number; lines: string[]; ranges: EntryRange[] }
		| undefined;
	#fullCache: { entry: ContextViewEntry; width: number; lines: string[] } | undefined;
	#wrapped = new Map<string, { width: number; lines: string[] }>();
	#safeEntries = new Map<string, string>();
	#sourceLineCounts = new Map<string, number>();
	#nativeScroll: NativeScroll = { by: "start", n: 0 };
	#overviewBoundary: "first" | "last" | undefined;
	#disposed = false;

	constructor(
		data: ContextViewData,
		options: { onClose: () => void; requestRender: () => void; getRows: () => number },
	) {
		ensureThemeSync();
		this.#data = data;
		this.#close = options.onClose;
		this.#requestRender = options.requestRender;
		this.#getRows = options.getRows;
		const allocated = allocateTokens(
			data.categories.map(category => category.tokens),
			data.usage,
		);
		this.#allocationAvailable = allocated !== undefined;
		const allocate = (categories: readonly ContextViewCategory[], tokens: readonly number[]): void => {
			for (const [index, category] of categories.entries()) {
				const budget = tokens[index]!;
				this.#allocated.set(category, budget);
				if (category.children) {
					const children = allocateTokens(
						category.children.map(child => child.tokens),
						budget,
					);
					if (children) allocate(category.children, children);
				}
			}
		};
		if (allocated) allocate(data.categories, allocated);
		const rows: OverviewRow[] = [];
		for (const category of data.categories) {
			rows.push({
				key: category.id,
				id: category.id,
				label: category.label,
				tokens: this.#allocated.get(category),
				category,
			});
			for (const child of category.children ?? [])
				rows.push({
					key: child.key!,
					id: category.id,
					label: child.label,
					tokens: this.#allocated.get(child),
					category: child,
					child: true,
				});
		}
		rows.push(
			{ key: "buffer", id: "buffer", label: "Auto-Compact Buffer", tokens: data.buffer },
			{ key: "free", id: "free", label: "Free Space", tokens: data.free },
		);
		this.#overview = new MenuSelection(rows, {
			getKey: item => item.key,
			getSearchText: item => item.label,
			isDisabled: item => !item.category,
		});
		this.#header.setHeight(3);
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	invalidate(): void {
		this.#previewCache = undefined;
		this.#fullCache = undefined;
		this.#wrapped.clear();
		this.#safeEntries.clear();
		this.#sourceLineCounts.clear();
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#wrapped.clear();
		this.#safeEntries.clear();
		this.#sourceLineCounts.clear();
		this.#overviewScroll.dispose();
		this.#previewScroll.dispose();
		this.#fullScroll.dispose();
		this.#panel.dispose();
	}

	#safe(value: string): string {
		return shortenEmbeddedPaths(replaceTabs(sanitizeText(value.replace(/\r\n?/g, "\n"))));
	}

	#safeContent(value: string): string {
		return replaceTabs(sanitizeText(value.replace(/\r\n?/g, "\n")));
	}

	#entryText(entry: ContextViewEntry): string {
		let value = this.#safeEntries.get(entry.id);
		if (value === undefined) {
			value = this.#safeContent(entry.text);
			this.#safeEntries.set(entry.id, value);
		}
		return value;
	}

	#entryLines(entry: ContextViewEntry, width: number): string[] {
		const cached = this.#wrapped.get(entry.id);
		if (cached?.width === width) return cached.lines;
		const lines = this.#entryText(entry)
			.split("\n")
			.flatMap(line => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
		this.#wrapped.set(entry.id, { width, lines });
		return lines;
	}

	/** Preview 只 wrap 有界前綴；省略數計算原始行，不展開尾端內容。 */
	#entryPreview(
		entry: ContextViewEntry,
		width: number,
		budget: number,
	): { lines: string[]; complete: boolean; hiddenLines: number } {
		if (this.#category?.id === "skills")
			return { lines: this.#entryLines(entry, width), complete: true, hiddenLines: 0 };
		const prefix = entry.text.slice(0, Math.max(1, width) * budget * 2);
		const paragraphs = this.#safeContent(prefix).split("\n");
		const lines: string[] = [];
		let shownSourceLines = 0;
		for (const [index, paragraph] of paragraphs.entries()) {
			const wrapped = paragraph ? wrapTextWithAnsi(paragraph, Math.max(1, width)) : [""];
			const remaining = budget - lines.length;
			lines.push(...wrapped.slice(0, remaining));
			if (wrapped.length > remaining) break;
			if (index < paragraphs.length - 1 || prefix.length === entry.text.length) shownSourceLines++;
			if (lines.length === budget) break;
		}
		let total = this.#sourceLineCounts.get(entry.id);
		if (total === undefined) {
			total = countNewlines(entry.text.replace(/\r\n?/g, "\n")) + 1;
			this.#sourceLineCounts.set(entry.id, total);
		}
		const hiddenLines = Math.max(0, total - shownSourceLines);
		return { lines, complete: hiddenLines === 0, hiddenLines };
	}

	#entryLabel(entry: ContextViewEntry): string {
		const label = this.#category?.id === "instruction-files" ? (entry.path ?? entry.label) : entry.label;
		return this.#safe(shortenPath(label)).replace(/\n/g, " ");
	}

	#entryInfo(entry: ContextViewEntry): string {
		return this.#safe(
			[entry.info, this.#category?.id !== "instruction-files" && entry.path ? shortenPath(entry.path) : undefined]
				.filter(Boolean)
				.join(" · "),
		);
	}

	#entryHeader(entry: ContextViewEntry): TspSpan[] {
		const color = CONTEXT_PRESENTATION[this.#category!.id].color;
		return [
			span("[", "dim"),
			span(this.#entryLabel(entry), `${color} strong`),
			span(`] ${entry.tokens.toLocaleString("en-US")} tokens`, "dim"),
		];
	}

	#entryHeaderLine(entry: ContextViewEntry): string {
		const color = CONTEXT_PRESENTATION[this.#category!.id].color;
		return (
			theme.fg("dim", "[") +
			theme.fg(color, theme.bold(this.#entryLabel(entry))) +
			theme.fg("dim", `] ${entry.tokens.toLocaleString("en-US")} tokens`)
		);
	}

	#truncationMarker(hiddenLines: number, selected: boolean): string {
		return (
			theme.fg("dim", `  … +${hiddenLines} lines`) +
			(selected ? theme.fg("dim", " · ") + theme.fg("accent", "Enter - View Content") : "")
		);
	}

	#share(tokens: number): string {
		return this.#data.window > 0 ? `${((tokens / this.#data.window) * 100).toFixed(1)}%` : "—";
	}

	#summary(): string[] {
		const { usage, window, buffer, free, breakdown } = this.#data;
		const threshold = breakdown.thresholdTokens;
		return [
			`${this.#safe(this.#data.modelLabel)} · ${formatNumber(window)} context · Read-only snapshot`,
			`Used ${formatNumber(usage)} · Buffer ${formatNumber(buffer)} · Free ${formatNumber(free)}${usage > window ? ` · ${formatNumber(usage - window)} over window` : ""}`,
			threshold === undefined
				? "Compaction off"
				: `Compaction at ${formatNumber(threshold)} · ${formatNumber(Math.abs(threshold - usage))} ${usage > threshold ? "over threshold" : "until threshold"}`,
			this.#allocationAvailable
				? "Category shares: estimated allocation of Used · Reopen to update"
				: "Category estimates unavailable · Original totals retained · Reopen to update",
		];
	}

	#legendLine(item: OverviewRow, width: number): string {
		const presentation = CONTEXT_PRESENTATION[item.id];
		const glyph = theme.styledSymbol(presentation.symbol, presentation.color);
		const selected = this.#overview.selectedKey === item.key;
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ".repeat(visibleWidth(theme.nav.cursor));
		const prefix = `${cursor} ${item.child ? "  " : ""}${glyph} `;
		const suffix = item.tokens === undefined ? " —" : ` ${formatNumber(item.tokens)} ${this.#share(item.tokens)}`;
		const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		const label = truncateToWidth(this.#safe(item.label).replace(/\n/g, " "), budget);
		const name = selected ? theme.bold(label) : label;
		return truncateToWidth(
			`${prefix}${name}${" ".repeat(Math.max(0, budget - visibleWidth(label)))}${theme.fg("dim", suffix)}`,
			width,
		);
	}

	get #canZoom(): boolean {
		return (
			this.#state === "overview" &&
			this.#mapVisible &&
			this.#data.usage > 0 &&
			contextFitScale(this.#data.usage, this.#data.window) < this.#data.window
		);
	}

	#mapGeometry(
		width: number,
		height: number,
	): { columns: number; rows: number; cellWidth: number; gap: string; width: number } | undefined {
		if (
			width < 52 ||
			height < 2 ||
			!(this.#data.window > 0) ||
			!Number.isFinite(this.#data.window) ||
			!this.#allocationAvailable
		)
			return;
		const gap = width >= 72 ? " " : "";
		const cellWidth = Math.max(
			1,
			...Object.values(CONTEXT_PRESENTATION).map(presentation => visibleWidth(theme.symbol(presentation.symbol))),
		);
		const columns = Math.min(16, Math.floor((width - 32 - 3 + gap.length) / (cellWidth + gap.length)));
		if (columns < 1) return;
		const rows = Math.min(16, height);
		return { columns, rows, cellWidth, gap, width: columns * (cellWidth + gap.length) - gap.length };
	}

	#mapCells(columns: number, rows: number) {
		const scale = this.#fit ? contextFitScale(this.#data.usage, this.#data.window) : this.#data.window;
		return planContextMap(
			[
				...this.#data.categories.map(category => ({ id: category.id, tokens: this.#allocated.get(category) ?? 0 })),
				{ id: "free" as const, tokens: this.#data.free },
				{ id: "buffer" as const, tokens: this.#data.buffer },
			],
			scale,
			columns,
			rows,
		);
	}

	#overviewLines(width: number, height: number): string[] {
		const geometry = this.#mapGeometry(width, height);
		this.#mapVisible = !!geometry;
		const listWidth = geometry ? width - geometry.width - 3 : width;
		const source = this.#overview.items.map(item => this.#legendLine(item, Math.max(0, listWidth - 1)));
		const diagnostics = contextSnapcompactLines(this.#data.breakdown);
		for (const notice of this.#data.notices)
			source.push(...wrapTextWithAnsi(theme.fg("warning", this.#safe(notice)), Math.max(1, listWidth - 1)));
		for (const line of diagnostics)
			source.push(...wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, listWidth - 1)));
		this.#overviewScroll.setHeight(height);
		this.#overviewScroll.setLines(source);
		this.#overviewScroll.revealRange(
			{
				id: this.#overview.selectedKey ?? "",
				start: this.#overview.selectedIndex,
				end: this.#overview.selectedIndex + 1,
				margin: 0,
			},
			listWidth,
		);
		if (this.#overviewBoundary === "last") this.#overviewScroll.scrollToBottom();
		else if (this.#overviewBoundary === "first") this.#overviewScroll.scrollToTop();
		this.#overviewBoundary = undefined;
		const legend = this.#overviewScroll.render(listWidth);
		if (!geometry) return [...legend];
		const cells = this.#mapCells(geometry.columns, geometry.rows);
		const lines: string[] = [];
		for (let row = 0; row < height; row++) {
			let grid = "";
			if (row < geometry.rows) {
				grid = cells
					.slice(row * geometry.columns, (row + 1) * geometry.columns)
					.map(cell => {
						const presentation = CONTEXT_PRESENTATION[cell.id];
						const glyph = theme.symbol(presentation.symbol);
						const value = theme.fg(presentation.color, glyph);
						return `${cell.full ? value : `\x1b[2m${value}\x1b[22m`}${" ".repeat(Math.max(0, geometry.cellWidth - visibleWidth(glyph)))}`;
					})
					.join(geometry.gap);
			}
			lines.push(`${grid}${" ".repeat(Math.max(0, geometry.width - visibleWidth(grid)))}   ${legend[row] ?? ""}`);
		}
		return lines;
	}

	#preparePreview(width: number, height: number): void {
		const category = this.#category!;
		const cached = this.#previewCache;
		this.#previewScroll.setHeight(height);
		if (cached?.category === category && cached.width === width && cached.height === height) return;
		const lines: string[] = [];
		const ranges: EntryRange[] = [];
		for (const entry of category.entries) {
			const start = lines.length;
			lines.push(truncateToWidth(this.#entryHeaderLine(entry), width - 1));
			const info = this.#entryInfo(entry);
			if (info) lines.push(...wrapTextWithAnsi(theme.fg("dim", info), Math.max(1, width - 1)));
			const budget = Math.max(1, Math.min(PREVIEW_LIMITS.OUTPUT_EXPANDED, height - 2));
			const content = this.#entryPreview(entry, Math.max(1, width - 3), budget);
			lines.push(...content.lines.map(line => `  ${line}`));
			if (!content.complete) lines.push(this.#truncationMarker(content.hiddenLines, false));
			ranges.push({ start, end: lines.length, complete: content.complete, hiddenLines: content.hiddenLines });
			lines.push("");
		}
		if (lines.length === 0) lines.push("No content in this category.");
		this.#previewCache = { category, width, height, lines, ranges };
		this.#previewScroll.setLines(lines);
	}

	#previewLines(width: number, height: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		this.#preparePreview(contentWidth, height);
		const range = this.#previewCache!.ranges[this.#entries.selectedIndex];
		if (range)
			this.#previewScroll.revealRange(
				{ id: this.#entries.selectedKey!, start: range.start, end: range.end, margin: 0, oversized: "start" },
				contentWidth,
			);
		const offset = this.#previewScroll.getScrollOffset();
		return this.#previewScroll.render(contentWidth).map((line, index) => {
			const selected = range && offset + index >= range.start && offset + index < range.end;
			if (selected && !range.complete && offset + index === range.end - 1)
				line = truncateToWidth(this.#truncationMarker(range.hiddenLines, true), contentWidth - 1);
			return `${selected ? theme.fg("accent", "┃ ") : "  "}${line}`;
		});
	}

	#fullLines(width: number, height: number): string[] {
		this.#prepareFull(width, height);
		return [...this.#fullScroll.render(width)];
	}

	#prepareFull(width: number, height: number): void {
		const entry = this.#entry!;
		this.#fullScroll.setHeight(height);
		if (this.#fullCache?.entry !== entry || this.#fullCache.width !== width) {
			const info = this.#entryInfo(entry);
			const lines = [
				truncateToWidth(this.#entryHeaderLine(entry), Math.max(1, width - 1)),
				...(info ? wrapTextWithAnsi(theme.fg("dim", this.#safe(info)), Math.max(1, width - 1)) : []),
				...this.#entryLines(entry, Math.max(1, width - 1)),
			];
			this.#fullCache = { entry, width, lines };
			this.#fullScroll.setLines(lines);
		}
	}

	render(width: number): readonly string[] {
		this.#width = Math.max(1, width - 4);
		const terminalRows = Math.max(1, this.#getRows());
		const summary = this.#layout();
		this.#panel.title =
			this.#state === "overview" ? `Context · ${this.#fit ? "Fit" : "Window"}` : this.#safe(this.#category!.label);
		this.#header.setHeight(summary.length);
		this.#header.setLines(summary.map(line => truncateToWidth(theme.fg("dim", line), this.#width)));
		const lines =
			this.#state === "overview"
				? this.#overviewLines(this.#width, this.#height)
				: this.#state === "category"
					? this.#previewLines(this.#width, this.#height)
					: this.#fullLines(this.#width, this.#height);
		this.#body.setLines(lines);
		this.#body.setHeight(this.#height);
		const zoom = this.#canZoom ? " · z Window/Fit" : "";
		this.#footer.setLines([
			truncateToWidth(
				theme.fg(
					"dim",
					`↑↓ j/k select/scroll · Enter open · Esc ${this.#state === "overview" ? "close" : "back"}${zoom}`,
				),
				this.#width,
			),
		]);
		const rendered = this.#panel.render(width);
		if (terminalRows >= 4) return rendered;
		if (terminalRows === 3) return [rendered[0]!, rendered[rendered.length - 2]!, rendered[rendered.length - 1]!];
		return terminalRows === 2 ? [rendered[0]!, rendered[rendered.length - 1]!] : [rendered[rendered.length - 1]!];
	}

	#layout(): string[] {
		const rows = Math.max(1, this.#getRows());
		const summary = this.#summary().slice(0, Math.max(0, rows - 5));
		this.#height = Math.max(0, rows - summary.length - 4);
		return summary;
	}

	#activate(): void {
		if (this.#state === "overview") {
			const activation = this.#overview.requestActivation();
			if (activation.kind !== "confirmed" || !activation.item.category) return;
			this.#category = activation.item.category;
			this.#entries.setItems(this.#category.entries, this.#category.entries[0]?.id);
			this.#previewCache = undefined;
			this.#previewScroll.scrollToTop();
			if (this.#category.entries.length === 1) this.#openEntry(this.#category.entries[0]!, "overview");
			else {
				this.#state = "category";
				if (this.#width > 0) this.#preparePreview(Math.max(1, this.#width - 2), this.#height);
			}
		} else if (this.#state === "category") {
			const entry = this.#entries.selectedItem;
			if (!entry) return;
			const range = this.#previewCache?.ranges[this.#entries.selectedIndex];
			const visible = this.#previewScroll.getVisibleRange();
			if (range?.complete && visible.start <= range.start && visible.end >= range.end) return;
			this.#openEntry(entry, "category");
		}
	}

	#openEntry(entry: ContextViewEntry, parent: "overview" | "category"): void {
		this.#entry = entry;
		this.#entryParent = parent;
		this.#fullCache = undefined;
		this.#fullScroll.scrollToTop();
		this.#state = "entry";
		if (this.#width > 0) this.#prepareFull(this.#width, this.#height);
	}

	#back(): void {
		if (this.#state === "entry") this.#state = this.#entryParent;
		else if (this.#state === "category") this.#state = "overview";
		else this.#close();
	}

	#navigate(delta: number): void {
		if (this.#state === "entry") {
			this.#fullScroll.scroll(delta);
			return;
		}
		if (this.#state === "overview") {
			if (!this.#overview.move(delta)) this.#overviewScroll.scroll(delta);
			return;
		}
		const range = this.#previewCache?.ranges[this.#entries.selectedIndex];
		if (range) {
			const visible = this.#previewScroll.getVisibleRange();
			if (delta > 0 && range.end > visible.end) {
				this.#previewScroll.scroll(Math.min(delta, range.end - visible.end));
				return;
			}
			if (delta < 0 && range.start < visible.start) {
				this.#previewScroll.scroll(Math.max(delta, range.start - visible.start));
				return;
			}
		}
		this.#entries.move(delta > 0 ? 1 : -1);
	}

	/** Capture only handled navigation keys; the focus path consumes other modal input. */
	capturesInput(data: string): boolean {
		return (
			matchesSelectCancel(data) ||
			matchesKey(data, "escape") ||
			matchesSelectUp(data) ||
			matchesSelectDown(data) ||
			matchesSelectPageUp(data) ||
			matchesSelectPageDown(data) ||
			getKeybindings().matches(data, "tui.select.confirm") ||
			(["home", "end", "enter", "j", "k"] as const).some(key => matchesKey(data, key)) ||
			(data === "z" && this.#canZoom)
		);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		let by: TspScrollBy | undefined;
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) this.#back();
		else if (getKeybindings().matches(data, "tui.select.confirm") || matchesKey(data, "enter")) this.#activate();
		else if (matchesSelectUp(data) || data === "k") {
			this.#navigate(-1);
			by = "line-up";
		} else if (matchesSelectDown(data) || data === "j") {
			this.#navigate(1);
			by = "line-down";
		} else if (matchesSelectPageUp(data)) {
			this.#navigate(-Math.max(1, this.#height - 1));
			by = "page-up";
		} else if (matchesSelectPageDown(data)) {
			this.#navigate(Math.max(1, this.#height - 1));
			by = "page-down";
		} else if (matchesKey(data, "home") || matchesKey(data, "end")) {
			const last = matchesKey(data, "end");
			if (this.#state === "entry") {
				const scroll = this.#fullScroll;
				if (last) scroll.scrollToBottom();
				else scroll.scrollToTop();
			} else if (this.#state === "overview") {
				this.#overviewBoundary = last ? "last" : "first";
				this.#overview.moveToBoundary(this.#overviewBoundary);
			} else this.#entries.moveToBoundary(last ? "last" : "first");
			by = last ? "end" : "start";
		} else if (data === "z" && this.#canZoom) this.#fit = !this.#fit;
		if (by) this.#nativeScroll = { by, n: this.#nativeScroll.n + 1 };
		this.#requestRender();
	}

	describe(cx: DescribeContext): NativeNode {
		this.#width = Math.max(1, cx.cols - 4);
		const summary = this.#layout();
		const children: NativeNode[] = summary.map(line => text([span(line, "dim")], { wrap: "none" }));
		if (this.#state === "category") children.push(text([span(this.#safe(this.#category!.label), "strong")]));
		else if (this.#state === "entry") children.push(text(this.#entryHeader(this.#entry!)));
		if (this.#state === "overview") {
			const items = this.#overview.items.map(item => {
				const presentation = CONTEXT_PRESENTATION[item.id];
				const label: TspSpan[] = [
					span(`${item.child ? "  " : ""}${theme.symbol(presentation.symbol)} `, presentation.color),
					span(this.#safe(item.label)),
				];
				return node(
					"item",
					{
						label,
						value: item.tokens === undefined ? "—" : `${formatNumber(item.tokens)} · ${this.#share(item.tokens)}`,
						disabled: !item.category,
					},
					undefined,
					item.key,
				);
			});
			const list = selectList("categories", items, { selected: this.#overview.selectedKey, grow: 1 });
			const geometry = this.#mapGeometry(this.#width, this.#height);
			this.#mapVisible = !!geometry;
			if (geometry) {
				const cells = this.#mapCells(geometry.columns, geometry.rows);
				const grid: NativeNode[] = [];
				for (let index = 0; index < geometry.rows; index++)
					grid.push(
						text(
							cells.slice(index * geometry.columns, (index + 1) * geometry.columns).map(cell => {
								const p = CONTEXT_PRESENTATION[cell.id];
								const glyph = theme.symbol(p.symbol);
								return span(
									`${glyph}${" ".repeat(Math.max(0, geometry.cellWidth - visibleWidth(glyph)))}${geometry.gap}`,
									`${p.color}${cell.full ? "" : " dim"}`,
								);
							}),
							{ wrap: "none" },
						),
					);
				children.push(row([col(grid), list], { gap: "lg" }));
			} else children.push(list);
			for (const line of contextSnapcompactLines(this.#data.breakdown))
				children.push(text([span(line, "dim")], { wrap: "word" }));
			for (const notice of this.#data.notices)
				children.push(text([span(this.#safe(notice), "warning")], { wrap: "word" }));
			const body = children.splice(summary.length);
			children.push({ ...node("col", { grow: 1 }, body, "overview"), scroll: this.#nativeScroll });
		} else if (this.#state === "category") {
			this.#previewLines(this.#width, this.#height);
			const items = this.#entries.items.map(entry => {
				const content = this.#entryPreview(
					entry,
					Math.max(1, this.#width - 5),
					Math.max(1, Math.min(PREVIEW_LIMITS.OUTPUT_EXPANDED, this.#height - 2)),
				);
				const info = this.#entryInfo(entry);
				const detail = [
					...(info ? [span(`${info}\n`, "dim")] : []),
					span(content.lines.join("\n")),
					...(!content.complete
						? [
								span(`\n… +${content.hiddenLines} lines`, "dim"),
								...(entry.id === this.#entries.selectedKey
									? [span(" · ", "dim"), span("Enter - View Content", "accent")]
									: []),
							]
						: []),
				];
				return node("item", { label: this.#entryHeader(entry), detail }, undefined, entry.id);
			});
			children.push(
				selectList("entries", items, {
					selected: this.#entries.selectedKey,
					empty: "No content in this category.",
				}),
			);
		} else {
			this.#prepareFull(this.#width, this.#height);
			const info = this.#entryInfo(this.#entry!);
			const body = node(
				"col",
				{},
				[
					...(info ? [text([span(this.#safe(info), "dim")])] : []),
					text(this.#entryText(this.#entry!), { wrap: "word" }),
				],
				`entry-${this.#entry!.id}`,
			);
			children.push({ ...body, scroll: this.#nativeScroll });
		}
		children.push(
			node("rule"),
			actionBar([
				...(this.#state !== "overview" ? [actionButton("Back", "back")] : []),
				...(this.#canZoom ? [actionButton(this.#fit ? "Window" : "Fit", "zoom")] : []),
				actionButton("Close", "close"),
			]),
		);
		return col(children, { role: "omp.context.viewer" });
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (event.type === "action") {
			if (event.act === "close") this.#close();
			else if (event.act === "back") this.#back();
			else if (event.act === "zoom") this.handleInput("z");
		} else if (event.type === "select" || event.type === "activate") {
			if (this.#state === "overview") {
				const item = this.#overview.items.find(item => item.key === event.item);
				if (!item?.category) return;
				this.#overview.setSelectedKey(event.item);
			} else if (this.#state === "category") {
				if (!this.#entries.items.some(entry => entry.id === event.item)) return;
				this.#entries.setSelectedKey(event.item);
			} else return;
			if (event.type === "activate") this.#activate();
		}
		this.#requestRender();
	}
}
