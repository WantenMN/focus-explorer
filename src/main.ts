import { App, Plugin, PluginSettingTab, TFolder, AbstractInputSuggest, WorkspaceLeaf } from "obsidian";
import { FocusExplorerSettings, DEFAULT_SETTINGS, RECENT_FOCUS_LIMIT } from "./settings";
import { FocusExplorerView, VIEW_TYPE_FOCUS_EXPLORER } from "./view";
import { normalizePath } from "./explorer/vault-helpers";

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
							await leaf.view.revealFile(file.path, { force: true });
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

		this.addSettingTab(new FocusExplorerSettingTab(this.app, this));

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
		this.settings = {
			autoReveal: typeof data.autoReveal === "boolean" ? data.autoReveal : DEFAULT_SETTINGS.autoReveal,
			excludedFolders: Array.isArray(data.excludedFolders)
				? data.excludedFolders.filter((p): p is string => typeof p === "string").map((p) => normalizePath(p)).filter((p) => p.length > 0)
				: [...DEFAULT_SETTINGS.excludedFolders],
		};
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
			...this.settings,
			recentFocus: this.recentFocus,
		} satisfies PluginData);
	}

	onunload() {}
}

class FolderSuggest extends AbstractInputSuggest<string> {
	private folders: string[];
	private input: HTMLInputElement;
	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.input = inputEl;
		this.folders = FolderSuggest.getAllFolders(app);
	}
	static getAllFolders(app: App): string[] {
		const result: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					result.push(normalizePath(child.path));
					walk(child);
				}
			}
		};
		walk(app.vault.getRoot());
		result.sort((a, b) => a.localeCompare(b));
		return result;
	}
	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		if (!q) return this.folders.slice(0, 100);
		return this.folders.filter((p) => p.toLowerCase().includes(q)).slice(0, 100);
	}
	renderSuggestion(value: string, el: HTMLElement): void {
		el.createDiv({ text: value || "/" });
	}
	selectSuggestion(value: string): void {
		this.input.value = value;
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

class FocusExplorerSettingTab extends PluginSettingTab {
	plugin: FocusExplorerPlugin;
	constructor(app: App, plugin: FocusExplorerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	getSettingDefinitions(): import("obsidian").SettingDefinitionItem[] {
		return [
			{
				type: "page",
				name: "Excluded folders",
				desc: "Folders hidden from the focus search dropdown unless the folder itself is currently focused (via context menu or recent list), in which case the focused folder and all its subfolders will be shown.",
				items: [
					{
						name: "Add excluded folder",
						render: (setting) => {
							const input = setting.controlEl.createEl("input", {
								attr: { placeholder: "Folder path", type: "text" },
								cls: "focus-explorer-excluded-input",
							});
							const suggest = new FolderSuggest(this.app, input);
							const origSelect = suggest.selectSuggestion.bind(suggest);
							suggest.selectSuggestion = (value: string) => {
								origSelect(value);
								const v = normalizePath(value);
								if (v && !this.plugin.settings.excludedFolders.includes(v) && this.app.vault.getAbstractFileByPath(v) instanceof TFolder) {
									this.plugin.settings.excludedFolders.unshift(v);
									void this.plugin.saveSettings();
									this.update();
									input.value = "";
								}
							};
							input.addEventListener("focus", () => input.dispatchEvent(new Event("input")));
							input.addEventListener("keydown", (e) => {
								if (e.key === "Enter") {
									const v = normalizePath(input.value.trim());
									if (v && !this.plugin.settings.excludedFolders.includes(v) && this.app.vault.getAbstractFileByPath(v) instanceof TFolder) {
										this.plugin.settings.excludedFolders.unshift(v);
										void this.plugin.saveSettings();
										this.update();
										input.value = "";
									}
								}
							});
						},
					},
					{
						type: "list",
						heading: "Excluded folders",
						emptyState: "No excluded folders",
						onDelete: (index: number) => {
							this.plugin.settings.excludedFolders.splice(index, 1);
							void this.plugin.saveSettings();
							this.update();
						},
						items: this.plugin.settings.excludedFolders.map((path) => ({
							name: path,
						})),
					},
				],
			},
		];
	}
}