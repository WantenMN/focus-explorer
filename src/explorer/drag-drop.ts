import { FileExplorerEntry } from "./types";

export interface DropTarget {
	entry: FileExplorerEntry | null;
	position: "inside" | "root";
	isExpanded?: boolean;
}

export interface DragState {
	sourceEntries: FileExplorerEntry[];
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
	isDragging: boolean;
	dropTarget: DropTarget | null;
}

function isSameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
	if (a === b) return true;
	const pathA = a?.entry?.path ?? null;
	const pathB = b?.entry?.path ?? null;
	return (a?.position ?? null) === (b?.position ?? null) && pathA === pathB;
}

const DRAG_THRESHOLD = 5;
const FOLDER_EXPAND_DELAY = 800;
const SCROLL_ZONE = 40;
const SCROLL_SPEED = 8;

export class DragDropManager {
	private dragState: DragState | null = null;
	private expandTimer: number | null = null;
	private expandTarget: string | null = null;
	private animFrame: number | null = null;
	private lastMouseY = 0;
	private pendingMouse: { x: number; y: number } | null = null;
	private onMove: (sourcePaths: string[], targetDir: string) => void;
	private getEntries: () => FileExplorerEntry[];
	private getExpanded: () => Set<string>;
	private getContainer: () => HTMLElement | null;
	private listenersAttached = false;

	private rafTickId: number | null = null;
	private handleMouseMoveBound = this.handleMouseMove.bind(this);
	private handleMouseUpBound = this.handleMouseUp.bind(this);

	constructor(opts: {
		getEntries: () => FileExplorerEntry[];
		getExpanded: () => Set<string>;
		getContainer: () => HTMLElement | null;
		onMove: (sourcePaths: string[], targetDir: string) => void;
	}) {
		this.getEntries = opts.getEntries;
		this.getExpanded = opts.getExpanded;
		this.getContainer = opts.getContainer;
		this.onMove = opts.onMove;
	}

	handleMouseDown(e: MouseEvent, sourceEntries: FileExplorerEntry[]) {
		if (e.button !== 0) return;
		this.dragState = {
			sourceEntries,
			startX: e.clientX,
			startY: e.clientY,
			currentX: e.clientX,
			currentY: e.clientY,
			isDragging: false,
			dropTarget: null,
		};
		this.pendingMouse = { x: e.clientX, y: e.clientY };
		this.lastMouseY = e.clientY;
		this.attachWindowListeners();
	}

	private attachWindowListeners() {
		if (this.listenersAttached) return;
		window.addEventListener("mousemove", this.handleMouseMoveBound);
		window.addEventListener("mouseup", this.handleMouseUpBound);
		this.listenersAttached = true;
	}

	private detachWindowListeners() {
		if (!this.listenersAttached) return;
		window.removeEventListener("mousemove", this.handleMouseMoveBound);
		window.removeEventListener("mouseup", this.handleMouseUpBound);
		this.listenersAttached = false;
	}

	private handleMouseMove(e: MouseEvent) {
		this.pendingMouse = { x: e.clientX, y: e.clientY };
		this.startTick();
	}

	private handleMouseUp() {
		const current = this.dragState;
		if (current?.isDragging && current.dropTarget) {
			if (this.isValidMove(current.sourceEntries, current.dropTarget)) {
				const targetDir = this.getTargetDir(current.dropTarget);
				const sourcePaths = current.sourceEntries.map((s) => s.path);
				this.onMove(sourcePaths, targetDir);
			}
		}
		this.dragState = null;
		this.pendingMouse = null;
		this.clearAutoScroll();
		this.clearExpandTimer();
		this.detachWindowListeners();
		this.stopTick();
		this.onStateChange?.(null);
	}

	private startTick() {
		if (this.rafTickId !== null) return;
		let lastScrollTop: number | null = null;
		const tick = () => {
			const container = this.getContainer();
			const scrollTop = container?.scrollTop ?? 0;
			const scrollChanged = lastScrollTop !== null && scrollTop !== lastScrollTop;
			if (lastScrollTop === null && container) lastScrollTop = scrollTop;
			else if (container) lastScrollTop = scrollTop;

			const pending = this.pendingMouse;
			if (!this.dragState) {
				this.stopTick();
				return;
			}
			if (pending) {
				const dx = pending.x - this.dragState.startX;
				const dy = pending.y - this.dragState.startY;
				const isDragging = this.dragState.isDragging || Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD;

				if (!isDragging) {
					this.dragState = { ...this.dragState, currentX: pending.x, currentY: pending.y };
					this.lastMouseY = pending.y;
					this.onStateChange?.(this.dragState);
				} else {
					const dropTarget = this.calculateDropTarget(pending.y);
					this.lastMouseY = pending.y;
					this.dragState = {
						...this.dragState,
						currentX: pending.x,
						currentY: pending.y,
						isDragging,
						dropTarget,
					};
					this.handleFolderExpand(dropTarget);
					this.onStateChange?.(this.dragState);
				}
				this.pendingMouse = null;
			} else if (this.dragState.isDragging) {


				if (scrollChanged) {
					const dropTarget = this.calculateDropTarget(this.lastMouseY);
					const cur = this.dragState.dropTarget;
					if (!isSameDropTarget(cur, dropTarget)) {
						this.dragState = { ...this.dragState, dropTarget };
						this.handleFolderExpand(dropTarget);
					}
				}
				this.onStateChange?.(this.dragState);
			}
			this.rafTickId = window.requestAnimationFrame(tick);
		};
		this.rafTickId = window.requestAnimationFrame(tick);
	}

	private stopTick() {
		if (this.rafTickId !== null) {
			window.cancelAnimationFrame(this.rafTickId);
			this.rafTickId = null;
		}
	}

	onStateChange: ((state: DragState | null) => void) | null = null;

	getState(): DragState | null {
		return this.dragState;
	}

	private calculateDropTarget(clientY: number): DropTarget | null {
		const container = this.getContainer();
		if (!container) return null;
		const entries = this.getEntries();
		const expandedPaths = this.getExpanded();
		const allItems = Array.from(container.querySelectorAll("[data-entry-path]"));
		if (allItems.length === 0) return { entry: null, position: "root" };

		for (const item of allItems) {
			const rect = item.getBoundingClientRect();

			if (clientY >= rect.top - 2 && clientY <= rect.bottom + 2) {
				const path = item.getAttribute("data-entry-path");
				const entry = entries.find((e) => e.path === path);
				if (!entry) continue;
				if (entry.is_dir) {
					const isExpanded = expandedPaths.has(entry.path);
					return { entry, position: "inside", isExpanded };
				} else {
					const lastSlash = entry.path.lastIndexOf("/");
					const parentPath = lastSlash !== -1 ? entry.path.substring(0, lastSlash) : null;
					if (parentPath) {
						const parentEntry = entries.find((e) => e.path === parentPath);
						if (parentEntry) {
							const isExpanded = expandedPaths.has(parentEntry.path);
							return { entry: parentEntry, position: "inside", isExpanded };
						}

						let deepest: typeof entries[0] | null = null;
						for (const e of entries) {
							if (e.is_dir && parentPath.startsWith(e.path + "/") && expandedPaths.has(e.path)) {
								if (!deepest || e.path.length > deepest.path.length) deepest = e;
							}
						}
						if (deepest) {
							return { entry: deepest, position: "inside", isExpanded: true };
						}
					}
					return { entry: null, position: "root" };
				}
			}
		}

		let closest: { entry: typeof entries[0]; dist: number } | null = null;
		for (const item of allItems) {
			const rect = item.getBoundingClientRect();
			const dist = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
			const path = item.getAttribute("data-entry-path");
			const entry = entries.find((e) => e.path === path);
			if (!entry) continue;
			if (!closest || dist < closest.dist) {
				closest = { entry, dist };
			}
		}
		if (closest) {
			const entry = closest.entry;
			if (entry.is_dir) {
				return { entry, position: "inside", isExpanded: expandedPaths.has(entry.path) };
			} else {
				const lastSlash = entry.path.lastIndexOf("/");
				const parentPath = lastSlash !== -1 ? entry.path.substring(0, lastSlash) : null;
				if (parentPath) {
					const parentEntry = entries.find((e) => e.path === parentPath);
					if (parentEntry) return { entry: parentEntry, position: "inside", isExpanded: expandedPaths.has(parentEntry.path) };
					let deepest: typeof entries[0] | null = null;
					for (const e of entries) {
						if (e.is_dir && parentPath.startsWith(e.path + "/") && expandedPaths.has(e.path)) {
							if (!deepest || e.path.length > deepest.path.length) deepest = e;
						}
					}
					if (deepest) return { entry: deepest, position: "inside", isExpanded: true };
				}
				return { entry: null, position: "root" };
			}
		}

		return { entry: null, position: "root" };
	}

	private isValidMove(sources: FileExplorerEntry[], target: DropTarget): boolean {
		return sources.some((source) => {
			const sourcePath = source.path;
			const sourceParent = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
			if (target.position === "root") {
				if (!sourceParent || sourceParent === "") return false;
				return true;
			}
			const targetEntry = target.entry;
			if (!targetEntry) return true;
			if (sourcePath === targetEntry.path) return false;
			if (source.is_dir && targetEntry.path.startsWith(sourcePath + "/")) return false;
			if (sourceParent === targetEntry.path) return false;
			return true;
		});
	}

	private getTargetDir(target: DropTarget): string {
		if (target.position === "root") return "";
		if (target.entry) return target.entry.path;
		return "";
	}

	private clearExpandTimer() {
		if (this.expandTimer !== null) {
			window.clearTimeout(this.expandTimer);
			this.expandTimer = null;
		}
		this.expandTarget = null;
	}

	private clearAutoScroll() {
		if (this.animFrame !== null) {
			window.cancelAnimationFrame(this.animFrame);
			this.animFrame = null;
		}
	}

	private startAutoScroll(clientY: number) {
		this.clearAutoScroll();
		const scroll = () => {
			const container = this.getContainer();
			if (!container) return;
			const rect = container.getBoundingClientRect();
			const y = this.lastMouseY;
			if (y - rect.top < SCROLL_ZONE) {
				container.scrollTop -= SCROLL_SPEED;
			} else if (rect.bottom - y < SCROLL_ZONE) {
				container.scrollTop += SCROLL_SPEED;
			}
			this.animFrame = window.requestAnimationFrame(scroll);
		};
		this.lastMouseY = clientY;
		this.animFrame = window.requestAnimationFrame(scroll);
	}

	private scrollListenerAttached = false;
	private boundScrollHandler = this.handleContainerScroll.bind(this);

	handleContainerScroll(): void {
		if (!this.dragState?.isDragging) return;
		const dropTarget = this.calculateDropTarget(this.lastMouseY);
		const cur = this.dragState.dropTarget;
		if (!isSameDropTarget(cur, dropTarget)) {
			this.dragState = { ...this.dragState, dropTarget };
			this.handleFolderExpand(dropTarget);
		}

		this.onStateChange?.(this.dragState);
	}

	private handleFolderExpand(target: DropTarget | null) {
		if (!target || !target.entry || !target.entry.is_dir || target.position !== "inside") {
			this.clearExpandTimer();
			return;
		}
		const targetPath = target.entry.path;
		if (this.expandTarget === targetPath) return;
		this.clearExpandTimer();
		this.expandTarget = targetPath;
		this.expandTimer = window.setTimeout(() => {
			const event = new CustomEvent("drag-expand-folder", { detail: { path: targetPath } });
			window.dispatchEvent(event);
			this.expandTarget = null;
		}, FOLDER_EXPAND_DELAY);
	}

	updateDraggingState(state: DragState | null) {
		if (state?.isDragging) {
			document.body.addClass("focus-explorer-dragging");
			this.startAutoScroll(state.currentY);

			const container = this.getContainer();
			if (container && !this.scrollListenerAttached) {
				container.addEventListener("scroll", this.boundScrollHandler, { passive: true });
				this.scrollListenerAttached = true;
			}
		} else {
			document.body.removeClass("focus-explorer-dragging");
			this.clearAutoScroll();
			if (this.scrollListenerAttached) {
				const container = this.getContainer();
				if (container) container.removeEventListener("scroll", this.boundScrollHandler);

				this.scrollListenerAttached = false;
			}
		}
		if (state?.isDragging) {
			this.handleFolderExpand(state.dropTarget);
		}
	}

	dispose() {
		this.clearExpandTimer();
		this.clearAutoScroll();
		this.detachWindowListeners();
		this.stopTick();
		if (this.scrollListenerAttached) {
			const container = this.getContainer();
			if (container) container.removeEventListener("scroll", this.boundScrollHandler);
			this.scrollListenerAttached = false;
		}
		document.body.removeClass("focus-explorer-dragging");
	}
}
