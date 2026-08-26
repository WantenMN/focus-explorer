import { Plugin, WorkspaceLeaf } from "obsidian";
import { FocusExplorerSettings, DEFAULT_SETTINGS, RECENT_FOCUS_LIMIT } from "./settings";
import { FocusExplorerView, VIEW_TYPE_FOCUS_EXPLORER } from "./view";

type PluginData = FocusExplorerSettings & { recentFocus?: unknown };

export default class FocusExplorerPlugin extends Plugin {
	settings!: FocusExplorerSettings;
	recentFocus: string[] = [];

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_FOCUS_EXPLORER,
			(leaf) => new FocusExplorerView(leaf, this),
		);

		this.addCommand({
			id: "open",
			name: "Open",
			icon: "folder-tree",
			callback: async () => {
				await this.activateView();
			},
		});

		this.addCommand({
			id: "reveal-active-file",
			name: "Reveal active file",
			icon: "locate",
			callback: async () => {
				await this.activateView();
				const file = this.app.workspace.getActiveFile();
				if (file) {
					const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FOCUS_EXPLORER);
					for (const leaf of leaves) {
						if (leaf.view instanceof FocusExplorerView) {
							await leaf.view.revealFile(file.path, true);
						}
					}
				}
			},
		});

		this.addCommand({
			id: "focus",
			name: "Focus",
			callback: async () => {
				await this.activateView();
				const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_FOCUS_EXPLORER)[0];
				if (leaf) {
					void this.app.workspace.revealLeaf(leaf);
					if (leaf.view instanceof FocusExplorerView) {
						leaf.view.focusTree();
					}
				}
			},
		});

		this.app.workspace.onLayoutReady(() => {
			if (this.app.workspace.getLeavesOfType(VIEW_TYPE_FOCUS_EXPLORER).length === 0) {
				void this.activateView();
			}
		});
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_FOCUS_EXPLORER);
		if (leaves.length > 0) {
			leaf = leaves[0] ?? null;
			if (leaf) void void workspace.revealLeaf(leaf);
			return;
		}

		leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_FOCUS_EXPLORER, active: true });
		void workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData> & Record<string, unknown>;
		this.recentFocus = Array.isArray(data.recentFocus)
			? data.recentFocus.filter((p): p is string => typeof p === "string")
			: [];
		delete data.recentFocus;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	getRecentFocus(): string[] {
		return [...this.recentFocus];
	}

	setRecentFocus(paths: string[]): void {
		this.recentFocus = paths.slice(0, RECENT_FOCUS_LIMIT);
		void this.saveSettings();
	}

	async saveSettings() {
		await this.saveData({
			autoReveal: this.settings.autoReveal,
			recentFocus: this.recentFocus,
		} satisfies PluginData);
	}

	onunload() {}
}