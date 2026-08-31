export interface FocusExplorerSettings {
	autoReveal: boolean;
	excludedFolders: string[];
}

export const DEFAULT_SETTINGS: FocusExplorerSettings = {
	autoReveal: false,
	excludedFolders: [],
};

export const RECENT_FOCUS_LIMIT = 10;