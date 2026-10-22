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
import { nativeSlotProps } from "../components/layout/geometry";
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
import { col, item, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeRevealAt, NativeScroll, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
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
	readonly interrupted?: boolean;
}

export interface ContextViewEntry {
	readonly id: string;
	readonly label: string;
	readonly text: string;
	/** Aggregation weight for the unscaled replay estimate; shared blocks contribute through their group. */
	readonly tokens: number;
	readonly interrupted?: boolean;
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

const NATIVE_ENTRY_GUTTER_COLS = 2;
// Wrapper keys around native entry nodes; entry actions arrive at `<list>/<row>/<column>/<entry id>`.
const NATIVE_ENTRY_KEYS = { list: "entries", row: "content", column: "list" } as const;
const NATIVE_ENTRY_KEYPATH = `${NATIVE_ENTRY_KEYS.list}/${NATIVE_ENTRY_KEYS.row}/${NATIVE_ENTRY_KEYS.column}/`;

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
	readonly #ansiPreviewScroll = new ScrollView([], { height: 1 });
	readonly #ansiEntryScroll = new ScrollView([], { height: 1 });
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
	// Only ANSI input needs local full-content scroll geometry.
	#lastRenderMode: "ansi" | "native" = "ansi";
	#ansiPreviewCache:
		| { category: ContextViewCategory; width: number; height: number; lines: string[]; ranges: EntryRange[] }
		| undefined;
	// Like the ANSI cache, holds only the open category's previews, not every category.
	#nativePreviewCache:
		| {
				category: ContextViewCategory;
				width: number;
				height: number;
				previews: Map<ContextViewEntry, { spans: TspSpan[] | undefined; complete: boolean }>;
		  }
		| undefined;
	#entryBodyCache: { entry: ContextViewEntry; text: string } | undefined;
	#ansiEntryLayoutWidth: number | undefined;
	#nativePreviewRevealAt: NativeRevealAt = "nearest";
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
				// Skills is an estimate without entries; empty categories have nothing to open.
				category: category.id === "skills" || category.entries.length === 0 ? undefined : category,
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
		this.#ansiPreviewCache = undefined;
		this.#nativePreviewCache = undefined;
		this.#entryBodyCache = undefined;
		this.#ansiEntryLayoutWidth = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#entryBodyCache = undefined;
		this.#nativePreviewCache = undefined;
		this.#ansiEntryLayoutWidth = undefined;
		this.#overviewScroll.dispose();
		this.#ansiPreviewScroll.dispose();
		this.#ansiEntryScroll.dispose();
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
		return shortenEmbeddedPaths(this.#safeContent(value));
	}

	#safeContent(value: string): string {
		return replaceTabs(sanitizeText(value.replace(/\r\n?/g, "\n")));
	}

	#previewBudget(entry: ContextViewEntry): number {
		const reserved = entry.thinkingGroup ? 3 : 2; // Heading, open hint, and optional group heading.
		return Math.max(1, Math.min(PREVIEW_LIMITS.OUTPUT_EXPANDED, this.#height - reserved));
	}

	/** Bound the source before sanitizing and wrapping large outputs. */
	#previewContent(entry: ContextViewEntry, budget: number): { metadata: string; body: string; complete: boolean } {
		const maxChars = Math.max(1, this.#width) * budget * 2;
		const metadata = this.#entryMetadata(entry, true).join("\n");
		const metadataLength = Math.min(metadata.length, maxChars);
		// Providers often end thinking and tool output with newlines; they render as empty rows.
		const body = entry.text.trimEnd();
		const bodyLength = Math.min(body.length, Math.max(0, maxChars - metadataLength - (metadataLength ? 1 : 0)));
		return {
			metadata: this.#safeContent(metadata.slice(0, metadataLength)),
			body: this.#safeContent(body.slice(0, bodyLength)),
			complete: metadataLength === metadata.length && bodyLength === body.length,
		};
	}

	#entryPreview(entry: ContextViewEntry, width: number, budget: number): { lines: string[]; complete: boolean } {
		const content = this.#previewContent(entry, budget);
		const lines: string[] = [];
		let complete = content.complete;
		parts: for (const [value, body] of [
			[content.metadata, false],
			[content.body, true],
		] as const) {
			if (!value) continue;
			for (const paragraph of value.split("\n")) {
				const remaining = budget - lines.length;
				if (remaining === 0) {
					complete = false;
					break parts;
				}
				const prefix = body ? "  " : "";
				const styled = body ? paragraph : theme.fg("dim", paragraph);
				const wrapped = paragraph ? wrapTextWithAnsi(styled, Math.max(1, width - prefix.length)) : [""];
				lines.push(...wrapped.slice(0, remaining).map(line => `${prefix}${line}`));
				if (wrapped.length > remaining) {
					complete = false;
					break parts;
				}
			}
		}
		return { lines, complete };
	}

	#nativePreview(entry: ContextViewEntry): { spans: TspSpan[] | undefined; complete: boolean } {
		const category = this.#category!;
		let cache = this.#nativePreviewCache;
		if (cache?.category !== category || cache.width !== this.#width || cache.height !== this.#height) {
			cache = { category, width: this.#width, height: this.#height, previews: new Map() };
			this.#nativePreviewCache = cache;
		}
		let preview = cache.previews.get(entry);
		if (!preview) {
			const indent = entry.thinkingGroup ? 2 : 0;
			const width = Math.max(1, this.#width - 1 - NATIVE_ENTRY_GUTTER_COLS - indent);
			const content = this.#entryPreview(entry, width, this.#previewBudget(entry));
			// Tern owns final wrapping; only omitted source creates a more row.
			const spans = content.lines.length ? styledSpans(content.lines.join("\n")) : undefined;
			preview = { spans, complete: content.complete };
			cache.previews.set(entry, preview);
		}
		return preview;
	}

	#entryLabel(entry: ContextViewEntry): string {
		return this.#safe(shortenPath(entry.label)).replace(/\n/g, " ");
	}

	#tokenEstimate(item: ContextViewEntry | ContextThinkingGroup): string {
		if ("thinkingGroup" in item && item.thinkingGroup) return "—";
		if (item.interrupted) return "N/A · Interrupted";
		return `${item.tokens.toLocaleString("en-US")} tokens`;
	}

	#groupHeaderLine(group: ContextThinkingGroup): string {
		const color = CONTEXT_PRESENTATION[this.#category!.id].color;
		return (
			theme.fg(color, theme.bold(this.#safe(group.label).replace(/\n/g, " "))) +
			theme.fg("dim", ` · ${this.#tokenEstimate(group)}`)
		);
	}

	#entryMetadata(entry: ContextViewEntry, preview = false): string[] {
		const group = entry.thinkingGroup;
		const info = this.#safe(
			[entry.info, entry.path ? shortenPath(entry.path) : undefined].filter(Boolean).join(" · "),
		);
		return [
			group && !preview
				? `${this.#safe(group.label).replace(/\n/g, " ")} · ${this.#tokenEstimate(group)}`
				: undefined,
			info || undefined,
			entry.callId !== undefined ? this.#safe(entry.callId) : undefined,
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
			span(`] ${this.#tokenEstimate(entry)}`, "dim"),
		];
	}

	#entryHeaderLine(entry: ContextViewEntry): string {
		const color = CONTEXT_PRESENTATION[this.#category!.id].color;
		return (
			theme.fg("dim", "[") +
			theme.fg(color, theme.bold(this.#entryLabel(entry))) +
			theme.fg("dim", `] ${this.#tokenEstimate(entry)}`)
		);
	}

	#previewHint(selected: boolean): string {
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

	#prepareAnsiPreview(width: number, height: number): void {
		const category = this.#category!;
		const cached = this.#ansiPreviewCache;
		this.#ansiPreviewScroll.setHeight(height);
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
			const content = this.#entryPreview(entry, entryWidth, this.#previewBudget(entry));
			lines.push(...content.lines.map(line => `${indent}${line}`));
			if (!content.complete) lines.push(this.#previewHint(false));
			ranges.push({ start, end: lines.length, complete: content.complete });
			lines.push("");
		}
		this.#ansiPreviewCache = { category, width, height, lines, ranges };
		this.#ansiPreviewScroll.setLines(lines);
	}

	#revealAnsiPreview(width: number, height: number): EntryRange | undefined {
		this.#prepareAnsiPreview(width, height);
		const range = this.#ansiPreviewCache!.ranges[this.#entries.selectedIndex];
		if (range)
			this.#ansiPreviewScroll.revealRange(
				{ id: this.#entries.selectedKey!, start: range.start, end: range.end, margin: 0, oversized: "start" },
				width,
			);
		return range;
	}

	#renderAnsiPreview(width: number, height: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const range = this.#revealAnsiPreview(contentWidth, height);
		const offset = this.#ansiPreviewScroll.getScrollOffset();
		return this.#ansiPreviewScroll.render(contentWidth).map((line, index) => {
			const selected = range && offset + index >= range.start && offset + index < range.end;
			if (selected && !range.complete && offset + index === range.end - 1)
				line = truncateToWidth(this.#previewHint(true), contentWidth - 1);
			return `${selected ? theme.fg("accent", "┃ ") : "  "}${line}`;
		});
	}

	#renderAnsiEntry(width: number, height: number): string[] {
		this.#ensureAnsiEntryLayout(width, height);
		return [...this.#ansiEntryScroll.render(width)];
	}

	#entryBodyText(): string {
		const entry = this.#entry!;
		if (this.#entryBodyCache?.entry !== entry) {
			this.#entryBodyCache = { entry, text: this.#safeContent(entry.text.trimEnd()) };
			this.#ansiEntryLayoutWidth = undefined;
		}
		return this.#entryBodyCache.text;
	}

	#ensureAnsiEntryLayout(width: number, height: number): void {
		const content = this.#entryBodyText();
		this.#ansiEntryScroll.setHeight(height);
		if (this.#ansiEntryLayoutWidth !== width) {
			const entry = this.#entry!;
			const contentWidth = Math.max(1, width - 1);
			const lines = [
				truncateToWidth(this.#entryHeaderLine(entry), contentWidth),
				...this.#entryMetadata(entry).flatMap(line => wrapTextWithAnsi(theme.fg("dim", line), contentWidth)),
				...content.split("\n").flatMap(line => (line ? wrapTextWithAnsi(line, contentWidth) : [""])),
			];
			this.#ansiEntryLayoutWidth = width;
			this.#ansiEntryScroll.setLines(lines);
		}
	}

	render(width: number): readonly string[] {
		this.#lastRenderMode = "ansi";
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
					? this.#renderAnsiPreview(this.#width, this.#height)
					: this.#renderAnsiEntry(this.#width, this.#height);
		this.#body.setLines(lines);
		this.#body.setHeight(this.#height);
		const navigation = [editorKey("tui.select.up"), editorKey("tui.select.down")].filter(Boolean).join("/");
		const canOpen =
			this.#state === "overview"
				? !!this.#overview.selectedItem?.category
				: this.#state === "category" && !!this.#entries.selectedItem;
		const confirm = canOpen ? editorKey("tui.select.confirm") : "";
		const cancel = editorKey("tui.select.cancel");
		const movement = this.#state === "overview" ? "select/scroll" : this.#state === "category" ? "select" : "scroll";
		const paging =
			this.#state === "entry"
				? [editorKey("tui.select.pageUp"), editorKey("tui.select.pageDown")].filter(Boolean).join("/")
				: "";
		const hints = [
			navigation && `${navigation} ${movement}`,
			paging && `${paging} page`,
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
			this.#nativePreviewRevealAt = "nearest";
			this.#ansiPreviewCache = undefined;
			this.#ansiPreviewScroll.scrollToTop();
			if (this.#category.entries.length === 1) this.#openEntry(this.#category.entries[0]!, "overview");
			else this.#state = "category";
		} else if (this.#state === "category") {
			const entry = this.#entries.selectedItem;
			if (!entry) return;
			this.#openEntry(entry, "category");
		}
	}

	#openEntry(entry: ContextViewEntry, parent: "overview" | "category"): void {
		this.#entry = entry;
		this.#entryParent = parent;
		this.#entryBodyCache = undefined;
		this.#ansiEntryLayoutWidth = undefined;
		this.#ansiEntryScroll.scrollToTop();
		this.#state = "entry";
		if (this.#lastRenderMode === "ansi" && this.#width > 0) this.#ensureAnsiEntryLayout(this.#width, this.#height);
	}

	#back(): void {
		if (this.#state === "entry") {
			this.#state = this.#entryParent;
			if (this.#entryParent === "category") this.#nativePreviewRevealAt = "start";
			this.#entry = undefined;
			this.#entryBodyCache = undefined;
			this.#ansiEntryLayoutWidth = undefined;
			this.#ansiEntryScroll.setLines([]);
		} else if (this.#state === "category") this.#state = "overview";
		else this.#close();
	}

	#navigate(delta: -1 | 1): void {
		if (this.#state === "entry") {
			if (this.#lastRenderMode === "ansi") {
				if (this.#width > 0) this.#ensureAnsiEntryLayout(this.#width, this.#height);
				this.#ansiEntryScroll.scroll(delta);
			}
		} else if (this.#state === "overview") {
			if (!this.#overview.move(delta)) this.#overviewScroll.scroll(delta);
		} else {
			this.#entries.move(delta);
			return;
		}
		this.#nativeScroll = {
			by: delta > 0 ? "line-down" : "line-up",
			n: this.#nativeScroll.n + 1,
		};
	}

	/** Page the full-content view; lists keep single-step selection. */
	#page(direction: -1 | 1): void {
		if (this.#state !== "entry") return;
		if (this.#lastRenderMode === "ansi") {
			if (this.#width > 0) this.#ensureAnsiEntryLayout(this.#width, this.#height);
			// Keep one line of overlap so the reading position stays visible.
			this.#ansiEntryScroll.scroll(direction * Math.max(1, this.#height - 1));
		}
		this.#nativeScroll = {
			by: direction > 0 ? "page-down" : "page-up",
			n: this.#nativeScroll.n + 1,
		};
	}

	/** Capture only handled navigation keys; the focus path consumes other modal input. */
	capturesInput(data: string): boolean {
		return (
			matchesSelectCancel(data) ||
			matchesSelectUp(data) ||
			matchesSelectDown(data) ||
			(this.#state === "entry" && (matchesSelectPageUp(data) || matchesSelectPageDown(data))) ||
			getKeybindings().matches(data, "tui.select.confirm")
		);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (matchesSelectCancel(data)) this.#back();
		else if (getKeybindings().matches(data, "tui.select.confirm")) this.#activate();
		else if (matchesSelectUp(data)) this.#navigate(-1);
		else if (matchesSelectDown(data)) this.#navigate(1);
		else if (matchesSelectPageUp(data)) this.#page(-1);
		else if (matchesSelectPageDown(data)) this.#page(1);
		this.#requestRender();
	}
	describe(cx: DescribeContext): NativeNode {
		this.#lastRenderMode = "native";
		this.#width = Math.max(1, cx.cols - 4);
		if (this.#hour12 !== cx.hour12) {
			this.#hour12 = cx.hour12;
			this.invalidate();
		}
		this.#layout();
		const meter = this.#state === "overview" && cx.supports("meter") ? this.#meter : undefined;
		const children: NativeNode[] = [];
		if (this.#state === "entry") children.push(text(this.#entryHeader(this.#entry!)));
		if (this.#state === "overview") {
			const items = this.#overview.items.map(overviewRow => {
				const presentation = CONTEXT_PRESENTATION[overviewRow.id];
				const selected = this.#overview.selectedKey === overviewRow.key;
				const glyph = meter
					? overviewRow.id === "buffer"
						? "▨"
						: overviewRow.id === "free"
							? "□"
							: "■"
					: theme.symbol(presentation.symbol);
				const value =
					overviewRow.tokens === undefined
						? "—"
						: `${formatNumber(overviewRow.tokens)} · ${this.#share(overviewRow.tokens)}`;
				const label: TspSpan[] = [
					span(`${overviewRow.child ? "  " : ""}${glyph} `, presentation.color),
					span(this.#safe(overviewRow.label), selected ? `${presentation.color} strong` : undefined),
				];
				return item(overviewRow.key, {
					label,
					value: selected ? [span(value, presentation.color)] : value,
				});
			});
			const list = selectList("categories", items, { selected: this.#overview.selectedKey, grow: 1 });
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
			const groups = new Set<string>();
			const items = this.#entries.items.flatMap((entry, index) => {
				const selected = entry.id === this.#entries.selectedKey;
				const group = entry.thinkingGroup;
				const children: NativeNode[] = [];
				if (group && !groups.has(group.id)) {
					groups.add(group.id);
					children.push({
						...text(styledSpans(this.#groupHeaderLine(group)), { wrap: "word", lines: 1 }),
						key: "group",
					});
				}
				const header = this.#entryHeader(entry);
				children.push({
					...text(group ? [span("  "), ...header] : header, { wrap: "word", lines: 1 }),
					key: "head",
					...(selected ? { reveal: this.#nativePreviewRevealAt } : {}),
				});
				const content = this.#nativePreview(entry);
				if (content.spans) children.push({ ...text(content.spans, { wrap: "word" }), key: "preview" });
				if (!content.complete)
					children.push({
						...text(styledSpans(this.#previewHint(selected)), { wrap: "word", lines: 1 }),
						key: "hint",
					});
				return [
					{
						...node(
							"col",
							{
								gap: "none",
								mark: selected ? "pick" : undefined,
								actions: { click: "select-entry", dblclick: "open-entry" },
							},
							children,
							entry.id,
						),
						...(selected ? { reveal: { at: "nearest" as const, n: 0 } } : {}),
					},
					{ ...text(" ", { wrap: "none" }), key: `separator-${index}` },
				];
			});
			// list.max owns a wheel scroller; common max.h would only clip.
			children.push(
				node(
					"list",
					{
						grow: 1,
						min: { h: 0 },
						max: { lines: Math.max(1, this.#height) },
						hidden: this.#height === 0 ? true : undefined,
					},
					[
						node(
							"row",
							{ gap: "none", align: "start" },
							[
								// Native pick bars paint outside entry boxes, but must stay inside the viewport.
								node("spacer", nativeSlotProps("w", { fixed: NATIVE_ENTRY_GUTTER_COLS }), undefined, "gutter"),
								node("col", { grow: 1, min: { w: 0 }, gap: "none" }, items, NATIVE_ENTRY_KEYS.column),
							],
							NATIVE_ENTRY_KEYS.row,
						),
					],
					NATIVE_ENTRY_KEYS.list,
				),
			);
		} else {
			const content = this.#entryBodyText();
			const body = node(
				"col",
				{},
				[
					...this.#entryMetadata(this.#entry!).map(line => text([span(line, "dim")])),
					text(styledSpans(content), { wrap: "word" }),
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
		return col(children, {
			role: "omp.context",
			...(this.#state === "category" ? { grow: 1, min: { h: 0 } } : {}),
		});
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (event.type === "action") {
			if (event.act === "close") this.#close();
			else if (event.act === "back") this.#back();
			else if (this.#state === "category" && (event.act === "select-entry" || event.act === "open-entry")) {
				const id = event.key.startsWith(NATIVE_ENTRY_KEYPATH) ? event.key.slice(NATIVE_ENTRY_KEYPATH.length) : "";
				const entry = this.#entries.items.find(entry => entry.id === id);
				if (!entry) return;
				this.#entries.setSelectedKey(entry.id);
				if (event.act === "open-entry") this.#activate();
			}
		} else if (this.#state === "overview" && (event.type === "select" || event.type === "activate")) {
			const item = this.#overview.items.find(item => item.key === event.item);
			if (!item?.category) return;
			this.#overview.setSelectedKey(event.item);
			if (event.type === "activate") this.#activate();
		}
		this.#requestRender();
	}
}
