import {
	ItemView,
	WorkspaceLeaf,
	Menu,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	setIcon,
} from "obsidian";
import FocusExplorerPlugin from "./main";
import { FileExplorerEntry } from "./explorer/types";
import { RECENT_FOCUS_LIMIT } from "./settings";
import {
	buildEntries,
	listAllSubfolders,
	normalizePath,
	parentPath,
	basename,
	createFile,
	createFolder,
	renameItem,
	duplicateItem,
	moveItem,
	copyItem,
	trashItem,
	showInFolder,
} from "./explorer/vault-helpers";
import { DragDropManager, DragState } from "./explorer/drag-drop";
import { encodeMultiPaths, decodeMultiPaths } from "./explorer/store";

export const VIEW_TYPE_FOCUS_EXPLORER = "focus-explorer-view";

export class FocusExplorerView extends ItemView {
	plugin: FocusExplorerPlugin;

	private expandedPaths: Set<string> = new Set();
	private focusedPath: string | null = null;
	private selectedPaths: Set<string> = new Set();
	private anchorPath: string | null = null;
	private isActive = false;

	private cutPath: string | null = null;
	private copyPath: string | null = null;

	private newItem: {
		type: "file" | "folder";
		fileExt?: "md" | "base" | "canvas";
		parentPath: string;
		depth: number;
		insertIndex: number;
	} | null = null;

	private editingItem: { path: string; name: string } | null = null;
	private editName = "";

	private isHeaderExpanded = true;
	private entries: FileExplorerEntry[] = [];

private scrollContainer: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private headerEl: HTMLElement | null = null;
	private dragOverlayEl: HTMLElement | null = null;
	private dropOverlayEl: HTMLElement | null = null;
	private dragDrop: DragDropManager | null = null;
	private dragState: DragState | null = null;
	private suppressNextClick = false;

	private focusedFolderPath: string | null = null;
	private focusBarEl: HTMLElement | null = null;
	private focusInputEl: HTMLInputElement | null = null;
	private focusDropdownEl: HTMLElement | null = null;
	private focusDropdownSelected = 0;
	private folderTree: { name: string; path: string; depth: number }[] = [];
	private savedExpandedBeforeFocus: Set<string> | null = null;
	private recentFocusPaths: string[] = [];

	private autoRevealDisposer: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: FocusExplorerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_FOCUS_EXPLORER;
	}

	getDisplayText(): string {
		return "Focus explorer";
	}

	getIcon(): string {
		return "folder-tree";
	}

	isFocused(): boolean {
		return this.focusedFolderPath !== null;
	}

	isFocusedOn(path: string): boolean {
		return this.focusedFolderPath === normalizePath(path);
	}

	async focusOn(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const folder = this.app.vault.getAbstractFileByPath(normalized);
		if (!(folder instanceof TFolder)) {
			new Notice(`Not a folder: ${path}`);
			return;
		}
		if (this.focusedFolderPath === normalized) return;

		if (!this.focusedFolderPath && !this.savedExpandedBeforeFocus) {
			this.savedExpandedBeforeFocus = new Set(this.expandedPaths);
		}
		this.focusedFolderPath = normalized;

		this.addRecentFocus(normalized);

		const newExpanded = new Set<string>();
		for (const p of this.expandedPaths) {
			if (p === normalized || p.startsWith(normalized + "/")) {
				newExpanded.add(p);
			}
		}
		newExpanded.add(normalized);
		this.expandedPaths = newExpanded;
		this.persistFocus();
		this.updateFocusBar();
		this.renderHeader();
		if (this.focusInputEl) {
			this.focusInputEl.value = "";
			const clearBtn = this.focusBarEl?.querySelector(".focus-bar-clear") as HTMLElement | null;
			clearBtn?.addClass("is-hidden");
		}
		this.closeFocusDropdown();
		await this.refresh();

		this.focusedPath = normalized;
		this.selectedPaths = new Set([normalized]);
		this.anchorPath = normalized;
		this.render();
		this.ensureFocusedVisible();
	}

	async clearFocus(): Promise<void> {
		if (!this.focusedFolderPath) return;
		const prevFocused = this.focusedFolderPath;
		const currentExpanded = new Set(this.expandedPaths);
		this.focusedFolderPath = null;
		this.persistFocus();
		this.updateFocusBar();
		this.renderHeader();
		if (this.savedExpandedBeforeFocus) {
			const restored = new Set(this.savedExpandedBeforeFocus);

			for (const p of currentExpanded) {
				if (p === prevFocused || p.startsWith(prevFocused + "/")) {
					restored.add(p);
				}
			}
			this.expandedPaths = restored;
			this.savedExpandedBeforeFocus = null;
		}
		await this.refresh();
		this.render();
	}

	private persistFocus(): void {
		if (this.focusedFolderPath) this.app.saveLocalStorage("focus-explorer-focus-folder", this.focusedFolderPath);
		else this.app.saveLocalStorage("focus-explorer-focus-folder", null);
	}

	private persistRecentFocus(): void {
		this.plugin.setRecentFocus(this.recentFocusPaths);
	}

	private loadRecentFocus(): void {
		this.recentFocusPaths = this.plugin
			.getRecentFocus()
			.map(normalizePath)
			.filter((p) => this.app.vault.getAbstractFileByPath(p) instanceof TFolder)
			.slice(0, RECENT_FOCUS_LIMIT);
	}

	private addRecentFocus(path: string): void {
		const normalized = normalizePath(path);
		this.recentFocusPaths = [
			normalized,
			...this.recentFocusPaths.filter((p) => p !== normalized),
		].slice(0, RECENT_FOCUS_LIMIT);
		this.persistRecentFocus();
	}

	private removeRecentFocus(path: string): void {
		const normalized = normalizePath(path);
		const prev = this.recentFocusPaths.length;
		this.recentFocusPaths = this.recentFocusPaths.filter((p) => p !== normalized);
		if (this.recentFocusPaths.length !== prev) this.persistRecentFocus();
	}

	private renameRecentFocus(oldPath: string, newPath: string): void {
		const oldNorm = normalizePath(oldPath);
		const newNorm = normalizePath(newPath);
		let changed = false;
		this.recentFocusPaths = this.recentFocusPaths.map((p) => {
			if (p === oldNorm) {
				changed = true;
				return newNorm;
			}
			if (p.startsWith(oldNorm + "/")) {
				changed = true;
				return newNorm + p.substring(oldNorm.length);
			}
			return p;
		});
		if (changed) this.persistRecentFocus();
	}

private showRecentFocusMenu(anchorEl: HTMLElement): void {
		const rect = anchorEl.getBoundingClientRect();
		this.showRecentFocusMenuAt(rect.left, rect.bottom);
	}

	private showRecentFocusMenuAt(x: number, y: number): void {
		const menu = new Menu();
		if (this.recentFocusPaths.length === 0) {
			menu.addItem((item) => item.setTitle("No recent focus").setDisabled(true));
		} else {
			for (const path of this.recentFocusPaths) {
				const folder = this.app.vault.getAbstractFileByPath(path);
				if (!(folder instanceof TFolder)) continue;
				const isCurrent = this.focusedFolderPath === path;
				const name = basename(path);
				const parent = parentPath(path);

				const frag = createFragment();
				frag.createSpan({ text: isCurrent ? `${name} (current)` : name });
				if (parent) {
					frag.createSpan({
						cls: "focus-recent-focus-path",
						text: parent,
					});
				}
				menu.addItem((item) => {
					item
						.setTitle(frag)
						.setIcon(isCurrent ? "target" : "folder")
						.onClick(() => void this.focusOn(path));


					const itemWithEls = item as unknown as {
						itemEl?: HTMLElement;
						dom?: HTMLElement;
						titleEl?: HTMLElement;
					};
					const itemEl = itemWithEls.itemEl ?? itemWithEls.dom ?? itemWithEls.titleEl;
					if (itemEl) {
						const removeBtn = itemEl.createSpan({
							cls: "focus-recent-remove",
							attr: { "aria-label": "Remove from recent focus" },
						});
						setIcon(removeBtn, "x");
removeBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						e.preventDefault();
						this.removeRecentFocus(path);

						if (this.focusedFolderPath === path) {
							void this.clearFocus();
						}
						menu.hide();

						this.showRecentFocusMenuAt(x, y);
					});
					}
					return item;
				});
			}
		}
		menu.showAtPosition({ x, y });
	}

	private loadFocus(): void {
		const saved = this.app.loadLocalStorage("focus-explorer-focus-folder") as string | null;
		if (saved) {
			const normalized = normalizePath(saved);
			const folder = this.app.vault.getAbstractFileByPath(normalized);
			if (folder instanceof TFolder) {
				this.focusedFolderPath = normalized;

				this.expandedPaths.add(normalized);
			} else {
				this.app.saveLocalStorage("focus-explorer-focus-folder", null);
				this.focusedFolderPath = null;
			}
		}
	}

	private updateFocusBar(): void {
		if (!this.focusBarEl) return;

		const clearBtn = this.focusBarEl.querySelector(".focus-bar-clear");
		if (clearBtn) {
			if (this.focusInputEl?.value) clearBtn.removeClass("is-hidden");
			else clearBtn.addClass("is-hidden");
		}
		const closeBtn = this.focusBarEl.querySelector(".focus-bar-close");
		if (closeBtn) {
			if (this.focusedFolderPath) closeBtn.removeClass("is-disabled");
			else closeBtn.addClass("is-disabled");
		}
	}

	private buildFocusBar(): void {
		if (!this.focusBarEl) return;
		this.focusBarEl.empty();

		const iconEl = this.focusBarEl.createSpan({ cls: "focus-bar-icon" });
		setIcon(iconEl, "target");

		this.focusBarEl.createSpan({ cls: "focus-bar-label", text: "Focus:" });

		const inputWrap = this.focusBarEl.createDiv({ cls: "focus-bar-input-wrap" });
		const input = inputWrap.createEl("input", {
			cls: "focus-bar-input",
			attr: { placeholder: "Search folder...", spellcheck: "false" },
		});
		this.focusInputEl = input;
		const updateClearBtn = () => {
			if (input.value) clearBtn.removeClass("is-hidden");
			else clearBtn.addClass("is-hidden");
		};
		const clearBtn = inputWrap.createSpan({
			cls: "focus-bar-clear is-hidden",
			attr: { "aria-label": "Clear search" },
		});
		setIcon(clearBtn, "circle-x");
		clearBtn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			input.value = "";
			updateClearBtn();
			this.focusDropdownSelected = 0;
			this.openFocusDropdown();
			input.focus();
		});
		input.addEventListener("focus", () => this.openFocusDropdown());
		input.addEventListener("input", () => {
			updateClearBtn();
			this.focusDropdownSelected = 0;
			this.renderFocusDropdown();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.moveFocusDropdown(1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.moveFocusDropdown(-1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				const item = this.getFilteredFolders()[this.focusDropdownSelected];
				if (item) {
					void this.focusOn(item.path);
					this.closeFocusDropdown();
					input.blur();
				}
			} else if (e.key === "Escape") {
				this.closeFocusDropdown();
				input.blur();
			}
		});
		input.addEventListener("blur", () => {
			window.setTimeout(() => this.closeFocusDropdown(), 150);
		});

		const historyBtn = this.focusBarEl.createSpan({
			cls: "focus-bar-btn focus-bar-history",
			attr: { "aria-label": "Recent focus" },
		});
		setIcon(historyBtn, "clock");
		historyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showRecentFocusMenu(historyBtn);
		});

		const closeBtn = this.focusBarEl.createSpan({
			cls: "focus-bar-btn focus-bar-close",
			attr: { "aria-label": "Exit focus" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.clearFocus();
		});
		this.updateFocusBar();

		const dropdown = this.focusBarEl.createDiv({ cls: "focus-dropdown" });
		this.focusDropdownEl = dropdown;
		dropdown.hide();
	}

	private buildFolderTree(): { name: string; path: string; depth: number }[] {
		const result: { name: string; path: string; depth: number }[] = [];
		const walk = (folder: TFolder, depth: number) => {
			const children = folder.children
				.filter((c): c is TFolder => c instanceof TFolder)
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
			for (const child of children) {
				result.push({ name: child.name, path: child.path, depth });
				walk(child, depth + 1);
			}
		};
		walk(this.app.vault.getRoot(), 0);
		return result;
	}

	private fuzzyMatch(path: string, query: string): boolean {

		const p = path.toLowerCase();
		const q = query.toLowerCase();
		let qi = 0;
		for (let i = 0; i < p.length && qi < q.length; i++) {
			if (p[i] === q[qi]) qi++;
		}
		return qi === q.length;
	}

	private getFilteredFolders(): { name: string; path: string; depth: number }[] {
		const query = (this.focusInputEl?.value ?? "").trim().toLowerCase();
		if (!query) return this.folderTree;
		return this.folderTree.filter(
			(f) => f.name.toLowerCase().includes(query) || this.fuzzyMatch(f.path, query),
		);
	}

	private openFocusDropdown(): void {
		this.focusDropdownSelected = 0;
		if (!this.focusDropdownEl) return;
		this.focusDropdownEl.show();
		this.renderFocusDropdown();
	}

	private closeFocusDropdown(): void {
		this.focusDropdownEl?.hide();
	}

	private moveFocusDropdown(delta: number): void {
		const items = this.getFilteredFolders();
		if (items.length === 0) return;
		this.focusDropdownSelected = (this.focusDropdownSelected + delta + items.length) % items.length;
		this.renderFocusDropdown();
	}

	private renderFocusDropdown(): void {
		const dropdown = this.focusDropdownEl;
		if (!dropdown) return;
		dropdown.empty();
		const items = this.getFilteredFolders().slice(0, 200);
		if (items.length === 0) {
			dropdown.createDiv({ cls: "focus-dropdown-empty", text: "No folders found" });
			return;
		}
		items.forEach((folder, idx) => {
			const row = dropdown.createDiv({ cls: "focus-dropdown-item" });
			if (idx === this.focusDropdownSelected) row.addClass("is-selected");
			if (this.focusedFolderPath === folder.path) row.addClass("is-current");
			row.style.paddingLeft = `${folder.depth * 12 + 8}px`;
			const icon = row.createSpan({ cls: "focus-dropdown-item-icon" });
			setIcon(icon, this.focusedFolderPath === folder.path ? "target" : "folder");
			row.createSpan({ cls: "focus-dropdown-item-name", text: folder.name });
			row.createSpan({ cls: "focus-dropdown-item-path", text: folder.path });
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				void this.focusOn(folder.path);
				this.closeFocusDropdown();
				this.focusInputEl?.blur();
			});
			row.addEventListener("mouseenter", () => {
				if (this.focusDropdownSelected === idx) return;
				this.focusDropdownSelected = idx;

				dropdown.querySelectorAll(".focus-dropdown-item").forEach((el, i) => {
					el.toggleClass("is-selected", i === idx);
				});
			});
		});
	}

	private onVaultRenameForFocus(file: TAbstractFile, oldPath: string): void {
		if (this.focusedFolderPath === normalizePath(oldPath)) {
			this.focusedFolderPath = normalizePath(file.path);
			this.persistFocus();
			this.updateFocusBar();
			void this.refresh();
		} else if (this.focusedFolderPath && file.path.startsWith(this.focusedFolderPath + "/")) {
			this.debouncedRefresh();
		}

		const oldNorm = normalizePath(oldPath);
		const newNorm = normalizePath(file.path);
		if (this.expandedPaths.has(oldNorm)) {
			this.expandedPaths.delete(oldNorm);
			this.expandedPaths.add(newNorm);

			for (const p of Array.from(this.expandedPaths)) {
				if (p.startsWith(oldNorm + "/")) {
					this.expandedPaths.delete(p);
					this.expandedPaths.add(newNorm + p.substring(oldNorm.length));
				}
			}
		}
		if (this.focusedPath === oldNorm) {
			this.focusedPath = newNorm;
		}

		if (this.selectedPaths.has(oldNorm)) {
			this.selectedPaths.delete(oldNorm);
			this.selectedPaths.add(newNorm);
		}

	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("focus-explorer-container");

		const saved = this.app.loadLocalStorage("focus-explorer-expanded") as string | null;
		if (saved) {
			try {
				const arr = JSON.parse(saved) as string[];
				this.expandedPaths = new Set(arr.map(normalizePath));
			} catch (e) {
				console.error("Failed to parse expanded state", e);
			}
		}
		const savedFocused = this.app.loadLocalStorage("focus-explorer-focused") as string | null;
		if (savedFocused) this.focusedPath = normalizePath(savedFocused);
		const savedSelected = this.app.loadLocalStorage("focus-explorer-selected") as string | null;
		if (savedSelected) {
			try {
				const arr = JSON.parse(savedSelected) as string[];
				this.selectedPaths = new Set(arr.map(normalizePath));
			} catch (e) {
				console.error("Failed to parse selected state", e);
			}
		}

		this.loadFocus();
		this.loadRecentFocus();

		this.renderShell();
		this.updateFocusBar();

		this.dragDrop = new DragDropManager({
			getEntries: () => this.entries,
			getExpanded: () => this.expandedPaths,
			getContainer: () => this.scrollContainer,
			onMove: (sources, targetDir) => void this.handleDragMove(sources, targetDir),
		});
		this.dragDrop.onStateChange = (state) => {
			const prevDragging = this.dragState?.isDragging ?? false;
			const curDragging = state?.isDragging ?? false;
			if (!prevDragging && curDragging) {
				this.suppressNextClick = true;
			}
			this.dragState = state;
			this.dragDrop?.updateDraggingState(state);
			this.updateDragOverlay();
			const newDragging = state?.isDragging ?? false;
			if (prevDragging !== newDragging) {
				this.updateDraggingVisuals();
			}
			if (prevDragging && !newDragging) {

				window.setTimeout(() => {
					this.suppressNextClick = false;
				}, 300);
			}
		};

		this.registerEvent(
			this.app.vault.on("create", () => {
				this.folderTree = this.buildFolderTree();
				this.debouncedRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (this.focusedFolderPath && file.path === this.focusedFolderPath) {
					void this.clearFocus();
				}
				this.removeRecentFocus(file.path);
				this.folderTree = this.buildFolderTree();
				this.debouncedRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.onVaultRenameForFocus(file, oldPath);
				this.renameRecentFocus(oldPath, file.path);
				this.folderTree = this.buildFolderTree();
				this.debouncedRefresh();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && this.plugin.settings.autoReveal) {
					void this.revealFile(file.path, true);
				}
			}),
		);

		this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => this.handleKeyDown(e));

		this.registerDomEvent(window, "drag-expand-folder" as keyof WindowEventMap, (e: Event) => {
			const ce = e as CustomEvent<{ path: string }>;
			const path = ce.detail?.path;
			if (path && !this.expandedPaths.has(path)) {
				this.expandedPaths.add(path);
				void this.refresh();
			}
		});

		if (this.scrollContainer) {
			this.registerDomEvent(this.scrollContainer, "focus", () => {
				this.isActive = true;
				this.renderHeader();
			});
			this.registerDomEvent(this.scrollContainer, "blur", () => {
				window.setTimeout(() => {
					if (!this.contentEl.contains(document.activeElement)) {
						this.isActive = false;
						this.renderHeader();
					}
				}, 0);
			});

			this.registerDomEvent(this.scrollContainer, "scroll", () => {
				if (this.dragState?.isDragging) {
					this.dragDrop?.handleContainerScroll();
				}
			});

			this.registerDomEvent(this.contentEl, "mousedown", (e) => {

				if (this.contentEl.contains(e.target as Node)) {
					this.isActive = true;
				}
			});
			this.registerDomEvent(window, "mousedown", (e) => {
				if (!this.contentEl.contains(e.target as Node)) {
					if (this.isActive) {
						this.isActive = false;
						this.renderHeader();
					}
				}
			});
		}

		await this.refresh();

		const active = this.app.workspace.getActiveFile();
		if (active && this.plugin.settings.autoReveal) {
			void this.revealFile(active.path, true);
		}

		this.registerInterval(window.setInterval(() => this.persistState(), 1000));
	}

	async onClose(): Promise<void> {
		this.dragDrop?.dispose();
		this.persistState();
		this.contentEl.empty();
	}

	private persistState() {
		this.app.saveLocalStorage("focus-explorer-expanded", JSON.stringify(Array.from(this.expandedPaths)));
		if (this.focusedPath) this.app.saveLocalStorage("focus-explorer-focused", this.focusedPath);
		else this.app.saveLocalStorage("focus-explorer-focused", null);
		this.app.saveLocalStorage("focus-explorer-selected", JSON.stringify(Array.from(this.selectedPaths)));
	}

	private debounceTimer: number | null = null;
	private debouncedRefresh() {
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.refresh();
		}, 200);
	}

	private async refresh() {
		this.entries = buildEntries(this.app, this.expandedPaths, this.focusedFolderPath);

		const allPaths = new Set(this.entries.map((e) => normalizePath(e.path)));
		allPaths.add("");
		if (this.cutPath) {
			const cps = decodeMultiPaths(this.cutPath);
			if (cps.some((p) => !allPaths.has(normalizePath(p)))) {
				this.cutPath = null;
			}
		}
		if (this.copyPath) {
			const cps = decodeMultiPaths(this.copyPath);
			if (cps.some((p) => !allPaths.has(normalizePath(p)))) {
				this.copyPath = null;
			}
		}

		for (const p of Array.from(this.expandedPaths)) {
			if (!allPaths.has(p)) this.expandedPaths.delete(p);
			else {

				const ef = this.app.vault.getAbstractFileByPath(p);
				if (!(ef instanceof TFolder)) this.expandedPaths.delete(p);
			}
		}
		this.render();
	}

	private renderShell() {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.addClass("focus-explorer");

		this.focusBarEl = contentEl.createDiv({ cls: "focus-bar" });
		this.folderTree = this.buildFolderTree();
		this.buildFocusBar();

		this.headerEl = contentEl.createDiv({ cls: "focus-explorer-header" });

		this.scrollContainer = contentEl.createDiv({ cls: "focus-explorer-scroll" });
		this.scrollContainer.tabIndex = 0;
		this.listEl = this.scrollContainer.createDiv({ cls: "focus-explorer-list" });

		this.scrollContainer.addEventListener("click", (e) => {
			if (e.target === this.scrollContainer || e.target === this.listEl) {
				this.handleEmptyAreaClick();
			}
		});
		this.scrollContainer.addEventListener("contextmenu", (e) => {

			const target = e.target as HTMLElement;
			if (target === this.scrollContainer || target === this.listEl || target.classList.contains("focus-explorer-list")) {
				e.preventDefault();
				this.handleEmptyAreaContextMenu(e);
			}
		});

		this.dropOverlayEl = this.listEl.createDiv({ cls: "focus-explorer-drop-overlay" });
		this.dropOverlayEl.hide();

		this.dragOverlayEl = contentEl.createDiv({ cls: "focus-explorer-drag-overlay" });
		this.dragOverlayEl.hide();

		this.renderHeader();
	}

	private renderHeader() {
		if (!this.headerEl) return;
		this.headerEl.empty();

		const actions = this.headerEl.createDiv({ cls: "focus-explorer-header-actions" });

		const makeBtn = (icon: string, tooltip: string, onClick: (e: MouseEvent) => void, active?: boolean) => {
			const btn = actions.createEl("button", { cls: "focus-explorer-header-btn" });
			if (active) btn.addClass("is-active");
			setIcon(btn, icon);
			btn.setAttribute("aria-label", tooltip);
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick(e);
			});
			return btn;
		};

		makeBtn("file-plus", "New note", () => this.startCreate("file", { followVaultSettings: true }));
		makeBtn("folder-plus", "New folder", () => this.startCreate("folder"));
		makeBtn("list-tree", "Auto reveal", () => {
			this.plugin.settings.autoReveal = !this.plugin.settings.autoReveal;
			void this.plugin.saveSettings();
			this.renderHeader();
			if (this.plugin.settings.autoReveal) {
				const active = this.app.workspace.getActiveFile();
				if (active) void this.revealFile(active.path, true);
			}
		}, this.plugin.settings.autoReveal);
		makeBtn("chevrons-down-up", "Collapse all", () => void this.collapseAll());
	}

	private render() {
		if (!this.listEl || !this.scrollContainer) return;

		const prevScroll = this.scrollContainer.scrollTop;

		this.listEl.empty();

		if (this.dropOverlayEl && !this.dropOverlayEl.isConnected) {
			this.dropOverlayEl = this.listEl.createDiv({ cls: "focus-explorer-drop-overlay" });
			this.dropOverlayEl.hide();
		}

		if (!this.isHeaderExpanded) {
			this.listEl.hide();
			return;
		} else {
			this.listEl.show();
		}

		if (this.entries.length === 0 && !this.newItem) {
			const empty = this.listEl.createDiv({ cls: "focus-explorer-empty" });
			empty.setText("No files");
			return;
		}

		if (this.entries.length === 0 && this.newItem) {
			this.renderNewItemInput(this.listEl, this.newItem);
		}

		this.entries.forEach((entry, index) => {

			if (this.newItem && this.newItem.insertIndex === index) {
				this.renderNewItemInput(this.listEl!, this.newItem);
			}

			const itemEl = this.createItemElement(entry, index);
			this.listEl!.appendChild(itemEl);

			if (this.newItem && this.newItem.insertIndex === index + 1 && index === this.entries.length - 1) {
				this.renderNewItemInput(this.listEl!, this.newItem);
			}
		});

		this.scrollContainer.scrollTop = prevScroll;

		this.updateDragOverlay();
	}

	private createItemElement(entry: FileExplorerEntry, index: number): HTMLElement {
		const isFocused = this.focusedPath === entry.path;
		const isSelected = this.selectedPaths.has(entry.path);
		const isExpanded = this.expandedPaths.has(entry.path);
		const isCut = this.cutPath ? decodeMultiPaths(this.cutPath).map(normalizePath).includes(normalizePath(entry.path)) : false;
		const isDragging = this.dragState?.isDragging && this.dragState.sourceEntries.some((s) => s.path === entry.path);
		const isEditing = this.editingItem?.path === entry.path;

		const item = createDiv();
		item.setAttribute("data-entry-path", entry.path);
		item.addClass("focus-explorer-item");
		if (isFocused) item.addClass("is-focused");
		if (isSelected) item.addClass("is-selected");
		if (isCut) item.addClass("is-cut");
		if (isDragging) item.addClass("is-dragging");
		if (this.focusedFolderPath === entry.path) item.addClass("focus-explorer-item-root");
		item.style.paddingLeft = `${entry.depth * 12 + 6}px`;

		for (let i = 0; i < entry.depth; i++) {
			const line = createDiv();
			line.addClass("focus-explorer-indent");
			line.style.left = `${i * 12 + 12}px`;
			item.appendChild(line);
		}

		const chevronWrap = createSpan();
		chevronWrap.addClass("focus-explorer-chevron");
		if (entry.is_dir) {
			setIcon(chevronWrap, isExpanded ? "chevron-down" : "chevron-right");
		}
		item.appendChild(chevronWrap);

		if (isEditing) {
			const input = createEl("input");
			input.addClass("focus-explorer-input");
			input.value = this.editName;
			input.addEventListener("click", (e) => e.stopPropagation());
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					void this.handleRename();
				} else if (e.key === "Escape") {
					this.editingItem = null;
					this.render();
				}
			});
			input.addEventListener("blur", () => {
				void this.handleRename();
			});
			input.addEventListener("change", (e) => {
				this.editName = (e.target as HTMLInputElement).value;
			});
			input.addEventListener("input", (e) => {
				this.editName = (e.target as HTMLInputElement).value;
			});
			item.appendChild(input);

			window.setTimeout(() => {
				input.focus();
				input.select();
			}, 10);
		} else {
			const nameSpan = createSpan();
			nameSpan.addClass("focus-explorer-name");
			nameSpan.setText(entry.is_dir ? entry.name : entry.name.replace(/\.md$/, ""));
			nameSpan.title = entry.name;
			item.appendChild(nameSpan);
			if (this.focusedFolderPath === entry.path) {
				const parent = parentPath(entry.path);
				if (parent) {
					const pathSpan = createSpan();
					pathSpan.addClass("focus-explorer-item-path");
					pathSpan.setText(parent);
					pathSpan.title = parent;
					item.appendChild(pathSpan);
				}
			}
		}

		item.addEventListener("mousedown", (e) => {

			if (e.button === 1) {
				e.preventDefault();
				if (!entry.is_dir) {
					void this.openFileInNewLeaf(entry.path);
				}
				return;
			}

			if (e.button !== 0) return;

			if (isEditing) return;
			const paths = this.selectedPaths.size > 1 && this.selectedPaths.has(entry.path) ? Array.from(this.selectedPaths) : [entry.path];
			const sources = paths.map((p) => this.entries.find((en) => en.path === p)).filter(Boolean) as FileExplorerEntry[];
			this.dragDrop?.handleMouseDown(e, sources);


		});

		item.addEventListener("click", (e) => {
			if (this.suppressNextClick) {
				this.suppressNextClick = false;
				e.stopPropagation();
				e.preventDefault();
				return;
			}
			e.stopPropagation();
			this.isActive = true;

			this.scrollContainer?.focus();
			if (e.ctrlKey || e.metaKey) {
				const next = new Set(this.selectedPaths);
				if (next.has(entry.path)) next.delete(entry.path);
				else next.add(entry.path);
				this.selectedPaths = next;
				this.focusedPath = entry.path;
				this.anchorPath = entry.path;
			} else if (e.shiftKey && this.anchorPath) {
				const startIdx = this.entries.findIndex((en) => normalizePath(en.path) === normalizePath(this.anchorPath!));
				const endIdx = index;
				if (startIdx !== -1) {
					const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
					const range = new Set<string>();
					for (let i = lo; i <= hi; i++) {
						const e = this.entries[i];
						if (e) range.add(e.path);
					}
					this.selectedPaths = range;
				}
				this.focusedPath = entry.path;
			} else {
				this.selectedPaths = new Set([entry.path]);
				this.focusedPath = entry.path;
				this.anchorPath = entry.path;
				if (entry.is_dir) {
					void this.toggleFolder(index);
				} else {
					void this.openFile(entry.path);
				}
			}
			this.render();
			this.ensureFocusedVisible();
		});

		item.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.focusedPath = entry.path;
			if (!this.selectedPaths.has(entry.path)) {
				this.selectedPaths = new Set([entry.path]);
				this.anchorPath = entry.path;
			}
			this.isActive = true;
			this.render();
			this.showContextMenu(e, entry);
		});

		return item;
	}

	private renderNewItemInput(container: HTMLElement, newItem: { type: "file" | "folder"; fileExt?: "md" | "base" | "canvas"; parentPath: string; depth: number; insertIndex: number }) {
		const wrap = container.createDiv({ cls: "focus-explorer-new-input-wrap" });
		wrap.style.paddingLeft = `${newItem.depth * 12 + 26}px`;
		wrap.addEventListener("click", (e) => e.stopPropagation());
		const input = wrap.createEl("input", { cls: "focus-explorer-input" });
		input.placeholder =
			newItem.type === "folder"
				? "folder name"
				: newItem.fileExt === "base"
					? "base name"
					: newItem.fileExt === "canvas"
						? "canvas name"
						: "note name";

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 10);
		let submitted = false;
		const submit = (val?: string) => {
			if (submitted) return;
			submitted = true;
			const v = val ?? input.value;
			void this.handleCreateNew(v);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			} else if (e.key === "Escape") {
				this.newItem = null;
				this.render();
			}
		});
		input.addEventListener("blur", () => {
			submit();
		});
	}

	private ensureFocusedVisible() {
		if (!this.scrollContainer || !this.focusedPath) return;
		const el = this.scrollContainer.querySelector(`[data-entry-path="${CSS.escape(this.focusedPath)}"]`);
		if (el) {
			el.scrollIntoView({ block: "nearest" });
		}
	}


	private async handleCreateNew(overrideName?: string) {
		if (!this.newItem) return;
		const nameToUse = overrideName?.trim() ?? "";
		const type = this.newItem.type;
		const fileExt = this.newItem.fileExt ?? "md";
		const parentPathStr = this.newItem.parentPath;
		this.newItem = null;
		if (!nameToUse) {
			this.render();
			return;
		}
		try {
			let newPath: string;
			if (type === "file") {
				newPath = await createFile(this.app, parentPathStr, nameToUse, fileExt);
			} else {
				newPath = await createFolder(this.app, parentPathStr, nameToUse);
			}

			const normalizedParent = normalizePath(parentPathStr);
			if (normalizedParent) {
				this.expandedPaths.add(normalizedParent);
			}
			await this.refresh();
			if (type === "file") {
				await this.openFile(newPath);
				this.focusedPath = newPath;
				this.selectedPaths = new Set([newPath]);
				this.anchorPath = newPath;
				this.render();
				this.ensureFocusedVisible();
			} else {
				this.focusedPath = newPath;
				this.selectedPaths = new Set([newPath]);
				this.anchorPath = newPath;
				this.render();
			}
		} catch (e) {
			new Notice(`Failed to create: ${(e as Error).message}`);
			this.render();
		}
	}

	private getDefaultNewNoteLocation(): string {
		const vault = this.app.vault as unknown as {
			getConfig?: (key: string) => string | undefined;
		};
		const location = vault.getConfig?.("newFileLocation");
		if (location === "folder") {
			return normalizePath(vault.getConfig?.("newFileFolderPath") ?? "");
		}
		if (location === "current") {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) return parentPath(activeFile.path);
		}
		return "";
	}

	private startCreate(
		type: "file" | "folder",
		opts: { entry?: FileExplorerEntry; followVaultSettings?: boolean; ext?: "md" | "base" | "canvas" } = {},
	) {
		let parentPathStr = "";
		let depth = 0;

		if (opts.followVaultSettings && type === "file") {
			parentPathStr = this.getDefaultNewNoteLocation();
			depth = parentPathStr ? 1 : 0;
		} else {
			let targetEntry: FileExplorerEntry | undefined = opts.entry;
			if (!targetEntry) {
				const idx = this.entries.findIndex((e) => e.path === this.focusedPath);
				if (idx !== -1) targetEntry = this.entries[idx];
			}

			if (targetEntry) {
				if (targetEntry.is_dir) {
					parentPathStr = normalizePath(targetEntry.path);
					depth = targetEntry.depth + 1;
				} else {
					const p = normalizePath(targetEntry.path);
					const lastSlash = p.lastIndexOf("/");
					if (lastSlash !== -1) parentPathStr = p.substring(0, lastSlash);
					else parentPathStr = "";
					depth = targetEntry.depth;
				}
			} else {
				if (this.focusedFolderPath) {
					parentPathStr = this.focusedFolderPath;
				}
				depth = parentPathStr ? 1 : 0;
			}
		}

		if (parentPathStr && !this.expandedPaths.has(parentPathStr)) {
			this.expandedPaths.add(parentPathStr);
		}

		if (parentPathStr) {
			const parts = parentPathStr.split("/").filter(Boolean);
			let acc = "";
			for (const part of parts) {
				acc = acc ? `${acc}/${part}` : part;
				if (!this.expandedPaths.has(acc)) {
					this.expandedPaths.add(acc);
				}
			}
		}

		this.isHeaderExpanded = true;
		void this.refresh().then(() => {

			let insertIndex = parentPathStr ? this.entries.length : 0;
			if (parentPathStr) {
				const idx = this.entries.findIndex((e) => normalizePath(e.path) === parentPathStr);
				if (idx !== -1) {
					const parentDepth = this.entries[idx]?.depth ?? 0;
					insertIndex = idx + 1;
					if (type === "file") {
						for (let i = idx + 1; i < this.entries.length; i++) {
							const e = this.entries[i];
							if (!e || e.depth <= parentDepth) break;
							if (e.depth === parentDepth + 1 && !e.is_dir) {
								insertIndex = i;
								break;
							}
							insertIndex = i + 1;
						}
					}
				}
			}
			depth = parentPathStr
				? (this.entries.find((e) => normalizePath(e.path) === parentPathStr)?.depth ?? 0) + 1
				: 0;
			this.newItem = { type, fileExt: opts.ext, parentPath: parentPathStr, depth, insertIndex };
			this.render();

			window.setTimeout(() => {
				const newItemEl = this.listEl?.querySelector(".focus-explorer-new-input-wrap");
				newItemEl?.scrollIntoView({ block: "nearest" });
			}, 50);
		});
	}

	private async handleRename() {
		if (!this.editingItem) return;
		const item = this.editingItem;
		const newName = this.editName.trim();
		this.editingItem = null;
		if (!newName) {
			this.render();
			return;
		}
		const isFile = !this.entries.find((e) => e.path === item.path)?.is_dir;
		const finalName = isFile ? newName.replace(/\.md$/, "") + ".md" : newName;
		if (finalName === basename(item.path) || finalName === item.name) {
			this.render();
			return;
		}
		try {
			const newPath = await renameItem(this.app, item.path, finalName);
			this.focusedPath = newPath;
			this.selectedPaths = new Set([newPath]);
			this.anchorPath = newPath;

			if (this.cutPath) {
				const cps = decodeMultiPaths(this.cutPath);
				if (cps.includes(item.path)) {
					this.cutPath = encodeMultiPaths(cps.map((p) => (p === item.path ? newPath : p)));
				}
			}
			if (this.copyPath) {
				const cps = decodeMultiPaths(this.copyPath);
				if (cps.includes(item.path)) {
					this.copyPath = encodeMultiPaths(cps.map((p) => (p === item.path ? newPath : p)));
				}
			}
			await this.refresh();
			this.render();
		} catch (e) {
			new Notice(`Rename failed: ${(e as Error).message}`);
			this.render();
		}
	}

	private async handleDuplicate(entry: FileExplorerEntry) {
		try {
			const newPath = await duplicateItem(this.app, entry.path);
			await this.refresh();
			this.focusedPath = newPath;
			this.selectedPaths = new Set([newPath]);
			this.anchorPath = newPath;
			this.render();
			this.ensureFocusedVisible();
		} catch (e) {
			new Notice(`Duplicate failed: ${(e as Error).message}`);
		}
	}

	private async handleDelete(paths: string[]) {
		if (paths.length === 0) return;

		const confirmed = await this.confirmDelete(paths);
		if (!confirmed) return;
		try {
			for (const p of paths) {
				await trashItem(this.app, p);
				if (this.cutPath && decodeMultiPaths(this.cutPath).includes(p)) {

					const remaining = decodeMultiPaths(this.cutPath).filter((x) => x !== p);
					this.cutPath = remaining.length ? encodeMultiPaths(remaining) : null;
				}
				if (this.copyPath && decodeMultiPaths(this.copyPath).includes(p)) {
					const remaining = decodeMultiPaths(this.copyPath).filter((x) => x !== p);
					this.copyPath = remaining.length ? encodeMultiPaths(remaining) : null;
				}
			}
			this.selectedPaths.clear();
			this.focusedPath = null;
			this.anchorPath = null;
			await this.refresh();
		} catch (e) {
			new Notice(`Delete failed: ${(e as Error).message}`);
		}
	}

	private confirmDelete(paths: string[]): Promise<boolean> {
		return new Promise((resolve) => {
			const count = paths.length;
			const names = paths.slice(0, 3).map(basename).join(", ");
			const msg = count === 1 ? `Move "${names}" to trash?` : `Move ${count} items to trash? (${names}${count > 3 ? "..." : ""})`;


			const modal = createDiv();
			modal.addClass("focus-explorer-modal-overlay");
			const box = modal.createDiv({ cls: "focus-explorer-modal" });
			box.createEl("h3", { text: "Confirm delete" });
			box.createEl("p", { text: msg });
			const btnRow = box.createDiv({ cls: "focus-explorer-modal-btns" });
			const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
			const delBtn = btnRow.createEl("button", { text: "Delete", cls: "mod-warning" });
			cancelBtn.addEventListener("click", () => {
				modal.remove();
				resolve(false);
			});
			delBtn.addEventListener("click", () => {
				modal.remove();
				resolve(true);
			});
			modal.addEventListener("click", (e) => {
				if (e.target === modal) {
					modal.remove();
					resolve(false);
				}
			});
			document.body.appendChild(modal);

		});
	}

	private async handleDragMove(sourcePaths: string[], targetDir: string) {
		let effectiveTargetDir = targetDir;
		if (this.focusedFolderPath && !normalizePath(effectiveTargetDir)) {
			effectiveTargetDir = this.focusedFolderPath;
		}
		const normalizedTarget = normalizePath(effectiveTargetDir);

		const pathsToMove = sourcePaths.filter((sourcePath) => {
			const normalizedSource = normalizePath(sourcePath);
			const sourceParent = parentPath(normalizedSource);
			return sourceParent !== normalizedTarget;
		});
		if (pathsToMove.length === 0) return;
		try {
			const resultPaths: string[] = [];
			for (const sourcePath of pathsToMove) {
				const resultPath = await moveItem(this.app, sourcePath, effectiveTargetDir);
				resultPaths.push(resultPath);
			}
			resultPaths.sort((a, b) => a.localeCompare(b));
			if (resultPaths.length > 0) {
				if (normalizedTarget && !this.expandedPaths.has(normalizedTarget)) {
					this.expandedPaths.add(normalizedTarget);
				}
				await this.refresh();
				const first = resultPaths[0];
				if (first) {
					this.focusedPath = first;
					this.selectedPaths = new Set(resultPaths);
					this.anchorPath = first;
				}
				this.render();
			}
		} catch (e) {
			new Notice(`Move failed: ${(e as Error).message}`);
		}
	}

	private async handlePaste(targetDir: string) {
		let effectiveTargetDir = targetDir;
		if (this.focusedFolderPath && !normalizePath(effectiveTargetDir)) {
			effectiveTargetDir = this.focusedFolderPath;
		}
		const normalizedTargetDir = normalizePath(effectiveTargetDir);
		let needExpand = false;
		if (normalizedTargetDir && !this.expandedPaths.has(normalizedTargetDir)) {
			this.expandedPaths.add(normalizedTargetDir);
			needExpand = true;
		}
		if (this.cutPath) {
			const paths = decodeMultiPaths(this.cutPath);
			const validPaths = paths.filter((p) => {
				const normalized = normalizePath(p);
				const par = parentPath(normalized);
				return normalized !== normalizedTargetDir && par !== normalizedTargetDir;
			});
			if (validPaths.length === 0) {
				this.cutPath = null;
				this.render();
				return;
			}
			try {
				const resultPaths: string[] = [];
				for (const p of validPaths) {
					const result = await moveItem(this.app, p, effectiveTargetDir);
					resultPaths.push(result);
				}
				this.cutPath = null;
				if (needExpand) await this.refresh();
				else await this.refresh();
				this.selectedPaths = new Set(resultPaths);
				const last = resultPaths[resultPaths.length - 1] ?? null;
				this.focusedPath = last;
				this.anchorPath = last;
				this.render();
				this.ensureFocusedVisible();
			} catch (e) {
				new Notice(`Paste failed: ${(e as Error).message}`);
			}
		} else if (this.copyPath) {
			try {
				const paths = decodeMultiPaths(this.copyPath);
				const resultPaths: string[] = [];
				for (const p of paths) {
					const result = await copyItem(this.app, p, effectiveTargetDir);
					resultPaths.push(result);
				}
				if (needExpand) await this.refresh();
				else await this.refresh();
				this.selectedPaths = new Set(resultPaths);
				const last2 = resultPaths[resultPaths.length - 1] ?? null;
				this.focusedPath = last2;
				this.anchorPath = last2;
				this.render();
				this.ensureFocusedVisible();
			} catch (e) {
				new Notice(`Copy failed: ${(e as Error).message}`);
			}
		}
	}

	private async handleCopyPath(path: string, relative: boolean) {
		let textToCopy = path;
		if (!relative) {
			const adapter = this.app.vault.adapter as {
				getBasePath?: () => string;
			};
			const basePath: string | null = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
			if (basePath) textToCopy = `${basePath}/${path}`.replace(/\/\//g, "/");
			else textToCopy = path;
		}

		try {
			await navigator.clipboard.writeText(textToCopy);
			new Notice(`Copied: ${textToCopy}`);
		} catch {
			new Notice("Failed to copy");
		}
	}

	private async toggleFolder(index: number) {
		const entry = this.entries[index];
		if (!entry || !entry.is_dir) return;
		const normalizedPath = normalizePath(entry.path);
		if (this.expandedPaths.has(normalizedPath)) this.expandedPaths.delete(normalizedPath);
		else this.expandedPaths.add(normalizedPath);
		await this.refresh();
		this.focusedPath = normalizedPath;
		this.render();
	}

	private async expandAll() {
		const root = this.focusedFolderPath ?? "";
		const all = listAllSubfolders(this.app, root);
		const newExpanded = new Set(all.map(normalizePath));
		if (this.focusedFolderPath) newExpanded.add(normalizePath(this.focusedFolderPath));
		this.expandedPaths = newExpanded;
		await this.refresh();
	}

	private async collapseAll() {
		this.expandedPaths.clear();

		await this.refresh();
	}

	private async expandFolderAll(folderPath: string) {
		const all = listAllSubfolders(this.app, folderPath);
		this.expandedPaths.add(normalizePath(folderPath));
		for (const dir of all) this.expandedPaths.add(normalizePath(dir));
		await this.refresh();
	}

	private handleEmptyAreaClick() {
		this.focusedPath = null;
		this.selectedPaths.clear();
		this.anchorPath = null;
		this.isActive = true;
		this.scrollContainer?.focus();
		this.render();
	}

	private handleEmptyAreaContextMenu(e: MouseEvent) {
		this.focusedPath = null;
		this.selectedPaths.clear();
		this.anchorPath = null;
		this.isActive = true;
		this.scrollContainer?.focus();
		this.render();
		this.showContextMenu(e, undefined);
	}

	private showContextMenu(e: MouseEvent, entry?: FileExplorerEntry) {
		const menu = new Menu();
		const isFolder = !!entry?.is_dir;
		const isEmpty = !entry;
		const hasPaste = !!((this.cutPath || this.copyPath) && (isFolder || isEmpty));
		const isMulti = !!entry && this.selectedPaths.size > 1 && this.selectedPaths.has(entry.path);

		if (isMulti) {
			const selectedEntries = this.entries.filter((en) => this.selectedPaths.has(en.path));
			menu.addItem((item) =>
				item.setTitle("Copy").setIcon("copy").onClick(() => {
					this.copyPath = encodeMultiPaths(selectedEntries.map((en) => en.path));
					this.cutPath = null;
					this.render();
				}),
			);
			menu.addItem((item) =>
				item.setTitle("Cut").setIcon("scissors").onClick(() => {
					this.cutPath = encodeMultiPaths(selectedEntries.map((en) => en.path));
					this.copyPath = null;
					this.render();
				}),
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Delete").setIcon("trash").onClick(() => void this.handleDelete(selectedEntries.map((en) => en.path))),
			);
			menu.showAtMouseEvent(e);
			return;
		}

		if (isFolder || isEmpty) {
			menu.addItem((item) =>
				item.setTitle("New note").setIcon("file-plus").onClick(() => this.startCreate("file", { entry })),
			);
			menu.addItem((item) =>
				item.setTitle("New folder").setIcon("folder-plus").onClick(() => this.startCreate("folder", { entry })),
			);
			menu.addItem((item) =>
				item.setTitle("New base").setIcon("lucide-layout-list").onClick(() => this.startCreate("file", { entry, ext: "base" })),
			);
			menu.addItem((item) =>
				item.setTitle("New canvas").setIcon("lucide-layout-dashboard").onClick(() => this.startCreate("file", { entry, ext: "canvas" })),
			);
			menu.addSeparator();
		}

		if (entry && entry.is_dir) {
			const isFocused = this.isFocusedOn(entry.path);
			menu.addItem((item) =>
				item
					.setTitle(isFocused ? "Clear focus" : "Focus")
					.setIcon(isFocused ? "x-circle" : "target")
					.onClick(() => {
						if (isFocused) void this.clearFocus();
						else void this.focusOn(entry.path);
					}),
			);
			menu.addSeparator();
		} else if (isEmpty && this.isFocused()) {
			menu.addItem((item) =>
				item.setTitle("Clear focus").setIcon("x-circle").onClick(() => void this.clearFocus()),
			);
			menu.addSeparator();
		}

		if (isFolder || isEmpty) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(isFolder ? "Expand all subfolders" : "Expand all")
					.setIcon("unfold-vertical")
					.onClick(() => {
						if (isFolder && entry) void this.expandFolderAll(entry.path);
						else void this.expandAll();
					}),
			);
		}

		if (entry) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Rename").setIcon("pencil").onClick(() => {
					const nameWithoutExt = entry.is_dir ? entry.name : entry.name.replace(/\.md$/, "");
					this.editingItem = { path: entry.path, name: entry.name };
					this.editName = nameWithoutExt;
					this.render();
				}),
			);
			menu.addItem((item) =>
				item.setTitle("Duplicate").setIcon("copy").onClick(() => void this.handleDuplicate(entry)),
			);
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("Copy relative path").setIcon("file-code").onClick(() => void this.handleCopyPath(entry?.path ?? "", true)),
		);
		menu.addItem((item) =>
			item.setTitle("Copy absolute path").setIcon("folder-tree").onClick(() => void this.handleCopyPath(entry?.path ?? "", false)),
		);
		menu.addItem((item) =>
			item.setTitle("Show in system explorer").setIcon("external-link").onClick(() => void showInFolder(this.app, entry?.path ?? "")),
		);

		if (entry || hasPaste) {
			menu.addSeparator();
			if (entry) {
				menu.addItem((item) =>
					item.setTitle("Copy").setIcon("copy").onClick(() => {
						this.copyPath = entry.path;
						this.cutPath = null;
						this.render();
					}),
				);
				menu.addItem((item) =>
					item.setTitle("Cut").setIcon("scissors").onClick(() => {
						this.cutPath = entry.path;
						this.copyPath = null;
						this.render();
					}),
				);
			}
			if (hasPaste) {
				menu.addItem((item) =>
					item.setTitle("Paste").setIcon("clipboard-paste").onClick(() => void this.handlePaste(entry?.path ?? "")),
				);
			}
		}

		if (entry) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Delete").setIcon("trash").onClick(() => void this.handleDelete([entry.path])),
			);
		}

		menu.showAtMouseEvent(e);
	}

	private async openFile(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Not a file: ${path}`);
			return;
		}

		const explorerLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FOCUS_EXPLORER);
		const explorerSet = new Set(explorerLeaves);
		let leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf || explorerSet.has(leaf)) {
			const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
			const candidate = markdownLeaves.find((l) => !explorerSet.has(l));
			if (candidate) leaf = candidate;
			else leaf = this.app.workspace.getLeaf(true);
			if (leaf && explorerSet.has(leaf)) leaf = this.app.workspace.getLeaf(true);
		}
		if (!leaf) leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);

		this.app.workspace.setActiveLeaf(leaf, { focus: true });

		if (file.extension === "md") {
			const view = leaf.view as { editor?: { focus: () => void } };
			if (view?.editor) {
				view.editor.focus();
			} else {
				window.setTimeout(() => {
					const v = leaf.view as { editor?: { focus: () => void } };
					if (v?.editor) v.editor.focus();
				}, 50);
			}
		}
	}

	private async openFileInNewLeaf(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		if (file.extension === "md") {
			const view = leaf.view as { editor?: { focus: () => void } };
			if (view?.editor) {
				view.editor.focus();
			} else {
				window.setTimeout(() => {
					const v = leaf.view as { editor?: { focus: () => void } };
					if (v?.editor) v.editor.focus();
				}, 50);
			}
		}
	}

	focusTree(): void {
		this.isActive = true;
		this.scrollContainer?.focus();
		this.contentEl.focus();
	}

	async revealFile(path: string, isManual = false) {
		if (!path || !this.plugin.settings.autoReveal || !isManual) return;
		const normalizedTarget = normalizePath(path);

		const file = this.app.vault.getAbstractFileByPath(normalizedTarget);
		if (!file) return;

		if (this.focusedFolderPath) {
			const focusedNorm = normalizePath(this.focusedFolderPath);
			if (normalizedTarget !== focusedNorm && !normalizedTarget.startsWith(focusedNorm + "/")) {
				return;
			}
		}

		const parts = normalizedTarget.split("/").filter(Boolean);
		let current = "";
		let changed = false;
		const newExpanded = new Set(this.expandedPaths);



		const isTargetFolder = file instanceof TFolder;
		const limit = isTargetFolder ? parts.length - 1 : parts.length - 1;
		for (let i = 0; i < limit; i++) {
			const part = parts[i] ?? "";
			current = current ? `${current}/${part}` : part;
			if (this.focusedFolderPath) {
				const focusedNorm = normalizePath(this.focusedFolderPath);
				if (current !== focusedNorm && !current.startsWith(focusedNorm + "/")) {
					continue;
				}
			}
			if (!newExpanded.has(current)) {

				const f = this.app.vault.getAbstractFileByPath(current);
				if (f instanceof TFolder) {
					newExpanded.add(current);
					changed = true;
				}
			}
		}
		if (changed) {
			this.expandedPaths = newExpanded;
			await this.refresh();
		}
		if (!this.selectedPaths.has(normalizedTarget)) {
			this.selectedPaths = new Set();
		}
		this.focusedPath = normalizedTarget;
		this.anchorPath = normalizedTarget;
		this.isHeaderExpanded = true;
		this.render();
		this.ensureFocusedVisible();
	}

	private handleKeyDown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		if (target.instanceOf(HTMLInputElement) || target.instanceOf(HTMLTextAreaElement) || target.isContentEditable) return;
		const hasFocus = this.contentEl.contains(document.activeElement) || this.isActive;
		if (!hasFocus) return;

		if (e.key === "F2") {
			e.preventDefault();
			const idx = this.entries.findIndex((en) => en.path === this.focusedPath);
			if (idx !== -1) {
				const entry = this.entries[idx];
				if (!entry) return;
				const nameWithoutExt = entry.is_dir ? entry.name : entry.name.replace(/\.md$/, "");
				this.editingItem = { path: entry.path, name: entry.name };
				this.editName = nameWithoutExt;
				this.render();
			}
		} else if (e.key === "Delete") {
			e.preventDefault();
			if (this.selectedPaths.size > 1) {
				const items = this.entries.filter((en) => this.selectedPaths.has(en.path));
				if (items.length > 0) void this.handleDelete(items.map((i) => i.path));
			} else if (this.focusedPath) {
				const entry = this.entries.find((en) => en.path === this.focusedPath);
				if (entry) void this.handleDelete([entry.path]);
			}
		} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
			e.preventDefault();
			if (this.selectedPaths.size > 1) {
				const paths = this.entries.filter((en) => this.selectedPaths.has(en.path)).map((en) => en.path);
				this.cutPath = encodeMultiPaths(paths);
				this.copyPath = null;
				this.render();
			} else if (this.focusedPath) {
				this.cutPath = this.focusedPath;
				this.copyPath = null;
				this.render();
			}
		} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
			e.preventDefault();
			if (this.selectedPaths.size > 1) {
				const paths = this.entries.filter((en) => this.selectedPaths.has(en.path)).map((en) => en.path);
				this.copyPath = encodeMultiPaths(paths);
				this.cutPath = null;
				this.render();
			} else if (this.focusedPath) {
				this.copyPath = this.focusedPath;
				this.cutPath = null;
				this.render();
			}
		} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
			e.preventDefault();
			let targetDir = "";
			if (this.focusedPath) {
				const entry = this.entries.find((en) => en.path === this.focusedPath);
				if (entry) {
					if (entry.is_dir) targetDir = entry.path;
					else targetDir = parentPath(entry.path);
				}
			}
			void this.handlePaste(targetDir);
		} else if (e.key === "ArrowDown") {
			if (this.entries.length === 0) return;
			e.preventDefault();
			const currIdx = this.entries.findIndex((en) => en.path === this.focusedPath);
			const next = currIdx < this.entries.length - 1 ? currIdx + 1 : 0;
			const nextEntry = this.entries[next];
			if (!nextEntry) return;
			this.focusedPath = nextEntry.path;
			if (!e.shiftKey) {
				this.selectedPaths = new Set([this.focusedPath]);
				this.anchorPath = this.focusedPath;
			} else if (this.anchorPath) {

				const startIdx = this.entries.findIndex((en) => normalizePath(en.path) === normalizePath(this.anchorPath!));
				const [lo, hi] = startIdx < next ? [startIdx, next] : [next, startIdx];
				const range = new Set<string>();
				for (let i = lo; i <= hi; i++) {
					const e2 = this.entries[i];
					if (e2) range.add(e2.path);
				}
				this.selectedPaths = range;
			}
			this.render();
			this.ensureFocusedVisible();
		} else if (e.key === "ArrowUp") {
			if (this.entries.length === 0) return;
			e.preventDefault();
			const currIdx = this.entries.findIndex((en) => en.path === this.focusedPath);
			const next = currIdx > 0 ? currIdx - 1 : this.entries.length - 1;
			const nextEntry = this.entries[next];
			if (!nextEntry) return;
			this.focusedPath = nextEntry.path;
			if (!e.shiftKey) {
				this.selectedPaths = new Set([this.focusedPath]);
				this.anchorPath = this.focusedPath;
			} else if (this.anchorPath) {
				const startIdx = this.entries.findIndex((en) => normalizePath(en.path) === normalizePath(this.anchorPath!));
				const [lo, hi] = startIdx < next ? [startIdx, next] : [next, startIdx];
				const range = new Set<string>();
				for (let i = lo; i <= hi; i++) {
					const e2 = this.entries[i];
					if (e2) range.add(e2.path);
				}
				this.selectedPaths = range;
			}
			this.render();
			this.ensureFocusedVisible();
		} else if (e.key === "Enter") {
			e.preventDefault();
			const idx = this.entries.findIndex((en) => en.path === this.focusedPath);
			if (idx !== -1) {
				const entry = this.entries[idx];
				if (!entry) return;
				if (entry.is_dir) void this.toggleFolder(idx);
				else void this.openFile(entry.path);
			}
		}
	}

	private updateDragOverlay() {
		if (!this.dragOverlayEl || !this.scrollContainer || !this.listEl || !this.dropOverlayEl) return;
		const state = this.dragState;
		if (!state?.isDragging) {
			this.dragOverlayEl.hide();
			this.dragOverlayEl.empty();
			this.dropOverlayEl.hide();
			this.dropOverlayEl.empty();
			this.scrollContainer.removeClass("focus-explorer-drop-root");
			return;
		}
		this.dragOverlayEl.show();
		this.dragOverlayEl.empty();
		this.dropOverlayEl.show();
		this.dropOverlayEl.empty();
		this.scrollContainer.removeClass("focus-explorer-drop-root");

		const count = state.sourceEntries.length;
		const firstName = state.sourceEntries[0]?.name ?? "";
		const label = count === 1 ? firstName.replace(/\.md$/, "") : `${count} items`;
		const floatEl = this.dragOverlayEl.createDiv({ cls: "focus-explorer-drag-float" });
		floatEl.style.left = `${state.currentX + 12}px`;
		floatEl.style.top = `${state.currentY - 12}px`;
		floatEl.setText(label);


		if (state.dropTarget) {
			const target = state.dropTarget;
			if (target.position === "root") {
				this.scrollContainer.addClass("focus-explorer-drop-root");
				return;
			}
			if (!target.entry) return;
			const rangePaths = this.getFolderRangePaths(target.entry.path);
			const allItems = Array.from(this.listEl.querySelectorAll("[data-entry-path]"));
			let first: HTMLElement | null = null;
			let last: HTMLElement | null = null;
			for (const item of allItems) {
				const el = item as HTMLElement;
				const p = el.getAttribute("data-entry-path");
				if (p && rangePaths.includes(p)) {
					if (!first) first = el;
					last = el;
				}
			}
			if (!first) return;

			const top = first.offsetTop;
			const bottom = (last ?? first).offsetTop + (last ?? first).offsetHeight;
			const height = bottom - top;

			const indicator = this.dropOverlayEl.createDiv({ cls: "focus-explorer-drop-indicator" });
			indicator.setCssProps({
				left: "2px",
				right: "2px",
				top: `${top}px`,
				height: `${height}px`,
			});
		}
	}

	private removeDropIndicators() {
		if (!this.dropOverlayEl) return;
		this.dropOverlayEl.empty();
		this.scrollContainer?.removeClass("focus-explorer-drop-root");
	}

	private updateDraggingVisuals() {
		if (!this.scrollContainer) return;
		const draggingPaths = new Set(
			(this.dragState?.isDragging ? this.dragState.sourceEntries : []).map((e) => e.path),
		);
		const items = this.scrollContainer.querySelectorAll<HTMLElement>("[data-entry-path]");
		for (const el of Array.from(items)) {
			const p = el.getAttribute("data-entry-path");
			if (p && draggingPaths.has(p)) el.addClass("is-dragging");
			else el.removeClass("is-dragging");
		}
		if (!this.dragState?.isDragging) {
			this.scrollContainer.removeClass("focus-explorer-drop-root");
		}
	}

	private getFolderRangePaths(folderPath: string): string[] {
		const paths: string[] = [folderPath];
		const folderEntry = this.entries.find((e) => e.path === folderPath) ?? null;
		if (!folderEntry) return paths;
		const folderDepth = folderEntry.depth;
		const folderIndex = this.entries.indexOf(folderEntry);
		for (let i = folderIndex + 1; i < this.entries.length; i++) {
			const e = this.entries[i];
			if (!e) break;
			if (e.depth > folderDepth) paths.push(e.path);
			else break;
		}
		return paths;
	}
}
