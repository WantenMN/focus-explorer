export interface FileExplorerEntry {
	name: string;
	path: string;
	is_dir: boolean;
	depth: number;
}

export interface VaultOpsResult {
	success: boolean;
	error?: string;
}
