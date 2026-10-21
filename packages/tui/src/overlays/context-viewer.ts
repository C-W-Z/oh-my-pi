import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { planContextMap } from "../chrome/context-map";
import {
	CONTEXT_PRESENTATION,
	type ContextCategoryId,
	type ContextPresentationId,
} from "../chrome/context-presentation";
import { editorKey } from "../chrome/keybinding-hints";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { ScrollView } from "../components/scroll-view";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { col, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { styledSpans } from "../native/spans";
import { PREVIEW_LIMITS, replaceTabs, shortenEmbeddedPaths, shortenPath } from "../render/render-utils";
import {
	type ContextBreakdown,
	contextSnapcompactLines,
	contextUsageHead,
	contextUsageSummary,
	describeContextMeter,
} from "../status-line/context-usage";
import { ensureThemeSync, theme } from "../theme/theme";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

export interface ContextThinkingGroup {
	readonly id: string;
	readonly label: string;
	readonly tokens: number;
	readonly tokenStatus?: "interrupted";
}

export interface ContextViewEntry {
	readonly id: string;
	readonly label: string;
	readonly text: string;
	/** Aggregation weight for the unscaled replay estimate; shared blocks contribute through their group. */
	readonly tokens: number;
	readonly tokenStatus?: "shared" | "interrupted";
	readonly thinkingGroup?: ContextThinkingGroup;
	readonly path?: string;
	readonly info?: string;
	readonly timestamp?: number;
	readonly callId?: string;
}

export interface ContextViewCategory {
	id: ContextCategoryId;
	key?: string;
	label: string;
	/** Overview attribution weight, not reported usage; may differ from the entry sum (e.g. Skills subtraction). */
	tokens: number;
	entries: ContextViewEntry[];
	children?: ContextViewCategory[];
}

export interface ContextViewData {
	readonly modelLabel: string;
	readonly window: number;
	/** Current context usage, which may be provider-anchored or locally estimated. */
	readonly usage: number;
	readonly buffer: number;
	readonly free: number;
	readonly breakdown: ContextBreakdown;
	readonly categories: readonly ContextViewCategory[];
}

interface OverviewRow {
	key: string;
	id: ContextPresentationId;
	label: string;
	tokens: number | undefined;
	value?: string;
	share?: string;
	child?: boolean;
	category?: ContextViewCategory;
}

interface EntryRange {
	start: number;
	end: number;
	complete: boolean;
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
	#nativeOverlay:
		| { category: ContextViewCategory | undefined; props: NonNullable<Component["nativeOverlay"]> }
		| undefined;
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
	readonly #meter: readonly NativeNode[] | undefined;
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
	#width = 0;
	#height = 1;
	#previewCache:
		| { category: ContextViewCategory; width: number; height: number; lines: string[]; ranges: EntryRange[] }
		| undefined;
	#fullCache: { entry: ContextViewEntry; width: number } | undefined;
	#wrapped = new Map<string, { width: number; lines: string[] }>();
	#safeEntries = new Map<string, string>();
	// Native scroll requests, not a viewport offset. The reconciler repeats each
	// line step by the increment in `n`.
	#nativeScroll: NativeScroll = { by: "start", n: 0 };
	#hour12: boolean | undefined;
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
		// Overview attributes current usage proportionally; entries keep their unscaled content/replay estimates.
		// This also applies to child categories, so Overview values need not equal entry sums.
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
		// Only Overview excludes the Skills attribution; content views retain complete system blocks.
		const overviewLabel = (category: ContextViewCategory): string =>
			category.id === "system-prompt" ? `${category.label} (excluding Skills)` : category.label;
		if (this.#allocationAvailable && data.window > 0 && Number.isFinite(data.window)) {
			this.#meter = describeContextMeter({
				contextWindow: data.window,
				usedTokens: data.usage,
				freeTokens: data.free,
				autoCompactBufferTokens: data.buffer,
				thresholdTokens: data.breakdown.thresholdTokens,
				categories: data.categories.map(category => ({
					label: this.#safe(overviewLabel(category)),
					tokens: this.#allocated.get(category)!,
					color: CONTEXT_PRESENTATION[category.id].color,
				})),
			});
		}
		const rows: OverviewRow[] = [];
		for (const category of data.categories) {
			rows.push({
				key: category.id,
				id: category.id,
				label: overviewLabel(category),
				tokens: this.#allocated.get(category),
				category: category.id === "skills" ? undefined : category,
			});
			for (const child of category.children ?? [])
				rows.push({
					key: child.key!,
					id: category.id,
					label: child.label,
					tokens: this.#allocated.get(child),
					category: category.id === "skills" || child.id === "skills" ? undefined : child,
					child: true,
				});
		}
		rows.push(
			{ key: "buffer", id: "buffer", label: "Auto-Compact Buffer", tokens: data.buffer },
			{ key: "free", id: "free", label: "Free Space", tokens: data.free },
		);
		const tokenWidth = Math.max(
			...rows.map(item => (item.tokens === undefined ? 1 : formatNumber(item.tokens).length)),
		);
		const shareWidth = Math.max(
			...rows.map(item => (item.tokens === undefined ? 1 : this.#share(item.tokens).length)),
		);
		for (const item of rows) {
			item.value = item.tokens === undefined ? "—" : formatNumber(item.tokens).padStart(tokenWidth);
			item.share = item.tokens === undefined ? "" : `  ${this.#share(item.tokens).padStart(shareWidth)}`;
		}
		this.#overview = new MenuSelection(rows, {
			getKey: item => item.key,
			getSearchText: item => item.label,
			isDisabled: item => !item.category,
		});
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
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#wrapped.clear();
		this.#safeEntries.clear();
		this.#overviewScroll.dispose();
		this.#previewScroll.dispose();
		this.#fullScroll.dispose();
		this.#panel.dispose();
	}

	get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
		const category = this.#state === "overview" ? undefined : this.#category;
		if (!this.#nativeOverlay || this.#nativeOverlay.category !== category) {
			this.#nativeOverlay = {
				category,
				props: {
					role: "omp.overlay.report",
					size: "lg",
					anchor: "center",
					head: category
						? [span("Context", "strong"), span(` · ${this.#safe(category.label)}`, "muted")]
						: contextUsageHead(this.#data.breakdown),
				},
			};
		}
		return this.#nativeOverlay.props;
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

	/** Wrap only a bounded preview prefix. */
	#entryPreview(entry: ContextViewEntry, width: number, budget: number): { lines: string[]; complete: boolean } {
		const prefixLength = Math.min(entry.text.length, Math.max(1, width) * budget * 2);
		const paragraphs = this.#safeContent(entry.text.slice(0, prefixLength)).split("\n");
		const lines: string[] = [];
		let complete = prefixLength === entry.text.length;
		for (const [index, paragraph] of paragraphs.entries()) {
			const wrapped = paragraph ? wrapTextWithAnsi(paragraph, Math.max(1, width)) : [""];
			const remaining = budget - lines.length;
			lines.push(...wrapped.slice(0, remaining));
			if (wrapped.length > remaining) {
				complete = false;
				break;
			}
			if (lines.length === budget) {
				if (index < paragraphs.length - 1) complete = false;
				break;
			}
		}
		return { lines, complete };
	}

	#entryLabel(entry: ContextViewEntry): string {
		return this.#safe(shortenPath(entry.label)).replace(/\n/g, " ");
	}

	#entryInfo(entry: ContextViewEntry): string {
		return this.#safe([entry.info, entry.path ? shortenPath(entry.path) : undefined].filter(Boolean).join(" · "));
	}
	#tokenEstimate(tokens: number, status?: "shared" | "interrupted"): string {
		if (status === "shared") return "—";
		if (status === "interrupted") return "N/A · Interrupted";
		return `${tokens.toLocaleString("en-US")} tokens`;
	}

	#groupHeaderLine(group: ContextThinkingGroup): string {
		const color = CONTEXT_PRESENTATION[this.#category!.id].color;
		return (
			theme.fg(color, theme.bold(this.#safe(group.label).replace(/\n/g, " "))) +
			theme.fg("dim", ` · ${this.#tokenEstimate(group.tokens, group.tokenStatus)}`)
		);
	}

	#entryMetadata(entry: ContextViewEntry, preview = false): string[] {
		const group = entry.thinkingGroup;
		return [
			group && !preview
				? `${this.#safe(group.label).replace(/\n/g, " ")} · ${this.#tokenEstimate(group.tokens, group.tokenStatus)}`
				: undefined,
			this.#entryInfo(entry) || undefined,
			entry.callId !== undefined ? `Call ID: ${this.#safe(entry.callId)}` : undefined,
			entry.timestamp !== undefined
				? `${new Date(entry.timestamp).toLocaleString([], {
						year: "numeric",
						month: "2-digit",
						day: "2-digit",
						hour: "2-digit",
						minute: "2-digit",
						hour12: this.#hour12,
					})}`
				: undefined,
		].filter((line): line is string => !!line);
	}

	#entryHeader(entry: ContextViewEntry): TspSpan[] {
		const color = CONTEXT_PRESENTATION[this.#category!.id].color;
		return [
			span("[", "dim"),
			span(this.#entryLabel(entry), `${color} strong`),
			span(`] ${this.#tokenEstimate(entry.tokens, entry.tokenStatus)}`, "dim"),
		];
	}

	#entryHeaderLine(entry: ContextViewEntry): string {
		const color = CONTEXT_PRESENTATION[this.#category!.id].color;
		return (
			theme.fg("dim", "[") +
			theme.fg(color, theme.bold(this.#entryLabel(entry))) +
			theme.fg("dim", `] ${this.#tokenEstimate(entry.tokens, entry.tokenStatus)}`)
		);
	}

	#truncationMarker(selected: boolean): string {
		const confirm = selected ? editorKey("tui.select.confirm") : "";
		return (
			theme.fg("dim", "  … more") +
			(confirm ? theme.fg("dim", " · ") + theme.fg("accent", `${confirm} View Content`) : "")
		);
	}

	#share(tokens: number): string {
		if (this.#data.window <= 0) return "—";
		const percent = (tokens / this.#data.window) * 100;
		return percent > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
	}

	#summary(): string[] {
		if (this.#state !== "overview") return [];
		const { usage, window, free, breakdown } = this.#data;
		const labels = contextUsageSummary({
			contextWindow: window,
			usedTokens: usage,
			freeTokens: free,
			thresholdTokens: breakdown.thresholdTokens,
		});
		return [`Used ${labels.used}${labels.detail}`, labels.room];
	}

	#legendLine(item: OverviewRow, width: number): string {
		const presentation = CONTEXT_PRESENTATION[item.id];
		const glyph = theme.styledSymbol(presentation.symbol, presentation.color);
		const selected = this.#overview.selectedKey === item.key;
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ".repeat(visibleWidth(theme.nav.cursor));
		const prefix = `${cursor} ${item.child ? "  " : ""}${glyph} `;
		const suffix = ` ${theme.fg(selected ? presentation.color : "text", item.value!)}${theme.fg(selected ? presentation.color : "dim", item.share!)}`;
		const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		const label = truncateToWidth(this.#safe(item.label).replace(/\n/g, " "), budget);
		const name = selected ? theme.fg(presentation.color, theme.bold(label)) : label;
		return truncateToWidth(
			`${prefix}${name}${" ".repeat(Math.max(0, budget - visibleWidth(label)))}${suffix}`,
			width,
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
		return planContextMap(
			[
				...this.#data.categories.map(category => ({ id: category.id, tokens: this.#allocated.get(category) ?? 0 })),
				{ id: "free" as const, tokens: this.#data.free },
				{ id: "buffer" as const, tokens: this.#data.buffer },
			],
			this.#data.window,
			columns,
			rows,
		);
	}

	#overviewLines(width: number, height: number): string[] {
		const geometry = this.#mapGeometry(width, height);
		const listWidth = geometry ? width - geometry.width - 3 : width;
		const source = this.#overview.items.map(item => this.#legendLine(item, Math.max(0, listWidth - 1)));
		const diagnostics = contextSnapcompactLines(this.#data.breakdown);
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
		const groups = new Set<string>();
		for (const entry of category.entries) {
			const start = lines.length;
			const group = entry.thinkingGroup;
			const indent = group ? "  " : "";
			if (group && !groups.has(group.id)) {
				groups.add(group.id);
				lines.push(truncateToWidth(this.#groupHeaderLine(group), Math.max(1, width - 1)));
			}
			const entryWidth = Math.max(1, width - 1 - indent.length);
			lines.push(`${indent}${truncateToWidth(this.#entryHeaderLine(entry), entryWidth)}`);
			lines.push(
				...this.#entryMetadata(entry, true).flatMap(line =>
					wrapTextWithAnsi(theme.fg("dim", line), entryWidth).map(line => `${indent}${line}`),
				),
			);
			const budget = Math.max(1, Math.min(PREVIEW_LIMITS.OUTPUT_EXPANDED, height - 2));
			const content = this.#entryPreview(entry, Math.max(1, width - 3 - indent.length), budget);
			lines.push(...content.lines.map(line => `${indent}  ${line}`));
			if (!content.complete) lines.push(this.#truncationMarker(false));
			ranges.push({ start, end: lines.length, complete: content.complete });
			lines.push("");
		}
		if (lines.length === 0) lines.push("No content in this category.");
		this.#previewCache = { category, width, height, lines, ranges };
		this.#previewScroll.setLines(lines);
	}

	#revealPreview(width: number, height: number): EntryRange | undefined {
		this.#preparePreview(width, height);
		const range = this.#previewCache!.ranges[this.#entries.selectedIndex];
		if (range)
			this.#previewScroll.revealRange(
				{ id: this.#entries.selectedKey!, start: range.start, end: range.end, margin: 0, oversized: "start" },
				width,
			);
		return range;
	}

	#previewLines(width: number, height: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const range = this.#revealPreview(contentWidth, height);
		const offset = this.#previewScroll.getScrollOffset();
		return this.#previewScroll.render(contentWidth).map((line, index) => {
			const selected = range && offset + index >= range.start && offset + index < range.end;
			if (selected && !range.complete && offset + index === range.end - 1)
				line = truncateToWidth(this.#truncationMarker(true), contentWidth - 1);
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
			const lines = [
				truncateToWidth(this.#entryHeaderLine(entry), Math.max(1, width - 1)),
				...this.#entryMetadata(entry).flatMap(line =>
					wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, width - 1)),
				),
				...this.#entryLines(entry, Math.max(1, width - 1)),
			];
			this.#fullCache = { entry, width };
			this.#fullScroll.setLines(lines);
		}
	}

	render(width: number): readonly string[] {
		this.#width = Math.max(1, width - 4);
		const terminalRows = Math.max(1, this.#getRows());
		const summary = this.#layout();
		this.#panel.title =
			this.#state === "overview"
				? `Context · ${this.#safe(this.#data.modelLabel)}`
				: this.#safe(this.#category!.label);
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
		const navigation = [editorKey("tui.select.up"), editorKey("tui.select.down")].filter(Boolean).join("/");
		const canOpen =
			this.#state === "overview"
				? !!this.#overview.selectedItem?.category
				: this.#state === "category" && !!this.#entries.selectedItem;
		const confirm = canOpen ? editorKey("tui.select.confirm") : "";
		const cancel = editorKey("tui.select.cancel");
		const hints = [
			navigation && `${navigation} select/scroll`,
			confirm && `${confirm} open`,
			cancel && `${cancel} ${this.#state === "overview" ? "close" : "back"}`,
		]
			.filter(Boolean)
			.join(" · ");
		this.#footer.setLines([truncateToWidth(theme.fg("dim", hints), this.#width)]);
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

	#navigate(delta: -1 | 1): void {
		if (this.#state === "entry") this.#fullScroll.scroll(delta);
		else if (this.#state === "overview") {
			if (!this.#overview.move(delta)) this.#overviewScroll.scroll(delta);
		} else {
			// Use the ANSI preview range to scroll the selected entry's remaining content
			// in the requested direction before changing selection in either renderer.
			const range = this.#previewCache?.ranges[this.#entries.selectedIndex];
			const visible = this.#previewScroll.getVisibleRange();
			if (range && (delta > 0 ? range.end > visible.end : range.start < visible.start))
				this.#previewScroll.scroll(delta);
			else {
				this.#entries.move(delta);
				return;
			}
		}
		this.#nativeScroll = {
			by: delta > 0 ? "line-down" : "line-up",
			n: this.#nativeScroll.n + 1,
		};
	}

	/** Capture only handled navigation keys; the focus path consumes other modal input. */
	capturesInput(data: string): boolean {
		return (
			matchesSelectCancel(data) ||
			matchesSelectUp(data) ||
			matchesSelectDown(data) ||
			getKeybindings().matches(data, "tui.select.confirm")
		);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (matchesSelectCancel(data)) this.#back();
		else if (getKeybindings().matches(data, "tui.select.confirm")) this.#activate();
		else if (matchesSelectUp(data)) this.#navigate(-1);
		else if (matchesSelectDown(data)) this.#navigate(1);
		this.#requestRender();
	}
	describe(cx: DescribeContext): NativeNode {
		this.#width = Math.max(1, cx.cols - 4);
		this.#hour12 = cx.hour12;
		this.#layout();
		const meter = this.#state === "overview" && cx.supports("meter") ? this.#meter : undefined;
		const children: NativeNode[] = [];
		if (this.#state === "entry") children.push(text(this.#entryHeader(this.#entry!)));
		if (this.#state === "overview") {
			const items = this.#overview.items.map(item => {
				const presentation = CONTEXT_PRESENTATION[item.id];
				const selected = this.#overview.selectedKey === item.key;
				const glyph = meter
					? item.id === "buffer"
						? "▨"
						: item.id === "free"
							? "□"
							: "■"
					: theme.symbol(presentation.symbol);
				return node(
					"row",
					{
						role: "omp.context.cat",
						align: "center",
						mark: selected ? "pick" : undefined,
						actions: item.category ? { click: "select-category", dblclick: "open-category" } : undefined,
					},
					[
						text([span(glyph, presentation.color)], { role: "omp.context.swatch", wrap: "none" }),
						text(
							[
								span(
									`${item.child ? "  " : ""}${this.#safe(item.label)}`,
									selected ? `${presentation.color} strong` : undefined,
								),
							],
							{ role: "omp.context.label", grow: 1, wrap: "none", truncate: "end" },
						),
						text([span(item.value!.trim(), selected ? presentation.color : undefined)], {
							role: "omp.context.tokens",
							wrap: "none",
						}),
						text([span(item.share!.trim(), selected ? presentation.color : undefined)], {
							role: "omp.context.share",
							wrap: "none",
						}),
					],
					item.key,
				);
			});
			const list = node("col", { grow: 1 }, items, "categories");
			const geometry = meter ? undefined : this.#mapGeometry(this.#width, this.#height);
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
			const diagnostics = contextSnapcompactLines(this.#data.breakdown);
			for (const line of diagnostics) children.push(text([span(line, "dim")], { wrap: "word" }));
			const body = children.splice(0);
			if (meter) children.push(...meter);
			else for (const line of this.#summary()) children.push(text([span(line, "dim")], { wrap: "word" }));
			children.push({ ...node("col", { grow: 1 }, body, "overview"), scroll: this.#nativeScroll });
		} else if (this.#state === "category") {
			this.#revealPreview(Math.max(1, this.#width - 2), this.#height);
			const cache = this.#previewCache!;
			const offset = this.#previewScroll.getScrollOffset();
			const items = this.#entries.items.flatMap((entry, index) => {
				const range = cache.ranges[index]!;
				const selected = entry.id === this.#entries.selectedKey;
				const lines: NativeNode[] = [];
				for (let line = range.start; line < range.end; line++) {
					const content =
						selected && !range.complete && line === range.end - 1
							? this.#truncationMarker(true)
							: cache.lines[line]!;
					lines.push({
						...text(styledSpans(content || " "), { wrap: "word" }),
						key: `line-${line}`,
						// Share ANSI preview wrapping and offsets: reveal restores the viewport
						// when returning from full content; scroll requests move mounted rows.
						...(line === offset ? { reveal: "start" as const } : {}),
					});
				}
				return [
					{
						...node(
							"col",
							{
								mark: selected ? "pick" : undefined,
								actions: { click: "select-entry", dblclick: "open-entry" },
							},
							lines,
							entry.id,
						),
						...(selected ? { reveal: { at: "start" as const, n: 0 } } : {}),
					},
					{
						...text(" ", { wrap: "word" }),
						key: `separator-${index}`,
						...(range.end === offset ? { reveal: "start" as const } : {}),
					},
				];
			});
			children.push({
				...node(
					"col",
					{ grow: 1, gap: "none" },
					items.length ? items : [text("No content in this category.", { wrap: "word" })],
					"entries",
				),
				scroll: this.#nativeScroll,
			});
		} else {
			this.#prepareFull(this.#width, this.#height);
			const body = node(
				"col",
				{},
				[
					...this.#entryMetadata(this.#entry!).map(line => text([span(this.#safe(line), "dim")])),
					text(styledSpans(this.#entryText(this.#entry!)), { wrap: "word" }),
				],
				`entry-${this.#entry!.id}`,
			);
			children.push({ ...body, scroll: this.#nativeScroll });
		}
		children.push(
			actionBar([
				null,
				...(this.#state !== "overview" ? [actionButton("Back", "back")] : []),
				actionButton("Close", "close"),
			]),
		);
		return col(children, { role: "omp.context" });
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (event.type === "action") {
			if (event.act === "close") this.#close();
			else if (event.act === "back") this.#back();
			else if (this.#state === "overview" && (event.act === "select-category" || event.act === "open-category")) {
				const item = this.#overview.items.find(
					item => event.key === `categories/${item.key}` || event.key.endsWith(`/categories/${item.key}`),
				);
				if (!item?.category) return;
				this.#overview.setSelectedKey(item.key);
				if (event.act === "open-category") this.#activate();
			} else if (this.#state === "category" && (event.act === "select-entry" || event.act === "open-entry")) {
				const entry = this.#entries.items.find(entry => event.key === `entries/${entry.id}`);
				if (!entry) return;
				this.#entries.setSelectedKey(entry.id);
				if (event.act === "open-entry") this.#activate();
			}
		}
		this.#requestRender();
	}
}
