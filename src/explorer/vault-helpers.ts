import { App, TFile, TFolder, TAbstractFile, Notice } from "obsidian";

export function isFolder(file: TAbstractFile): file is TFolder {
	return file instanceof TFolder;
}

export function isFile(file: TAbstractFile): file is TFile {
	return file instanceof TFile;
}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/");
}

export function parentPath(p: string): string {
	const norm = normalizePath(p);
	const idx = norm.lastIndexOf("/");
	if (idx === -1) return "";
	return norm.substring(0, idx);
}

export function basename(p: string): string {
	const norm = normalizePath(p);
	const idx = norm.lastIndexOf("/");
	if (idx === -1) return norm;
	return norm.substring(idx + 1);
}

const SUPPORTED_EXTENSIONS = new Set([".md", ".canvas", ".base"]);

export function isSupportedFile(name: string): boolean {
	const dot = name.lastIndexOf(".");
	if (dot === -1) return false;
	const ext = name.substring(dot).toLowerCase();
	return SUPPORTED_EXTENSIONS.has(ext);
}

export function buildEntries(
	app: App,
	expandedPaths: Set<string>,
	focusedPath: string | null = null,
): import("./types").FileExplorerEntry[] {
	const entries: import("./types").FileExplorerEntry[] = [];
	const root = app.vault.getRoot();

	function traverse(folder: TFolder, depth: number) {
		const children = [...folder.children].sort((a, b) => {
			const aDir = a instanceof TFolder ? 1 : 0;
			const bDir = b instanceof TFolder ? 1 : 0;
			if (aDir !== bDir) return bDir - aDir;
			return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
		});
		for (const child of children) {

			if (child instanceof TFile && !isSupportedFile(child.name)) continue;
			const entry: import("./types").FileExplorerEntry = {
				name: child.name,
				path: normalizePath(child.path),
				is_dir: child instanceof TFolder,
				depth,
			};
			entries.push(entry);
			if (child instanceof TFolder && expandedPaths.has(normalizePath(child.path))) {
				traverse(child, depth + 1);
			}
		}
	}

	if (focusedPath) {
		const folder = app.vault.getAbstractFileByPath(focusedPath);
		if (folder instanceof TFolder) {

			entries.push({
				name: folder.name,
				path: normalizePath(folder.path),
				is_dir: true,
				depth: 0,
			});

			const isExpanded = expandedPaths.has(normalizePath(folder.path));
			if (isExpanded) {
				traverse(folder, 1);
			}
			return entries;
		}

	}

	traverse(root, 0);
	return entries;
}

export function listAllSubfolders(app: App, folderPath: string): string[] {
	const folder = folderPath === "" || folderPath === "/" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return [];
	const result: string[] = [];
	function walk(f: TFolder) {
		for (const child of f.children) {
			if (child instanceof TFolder) {
				result.push(normalizePath(child.path));
				walk(child);
			}
		}
	}
	walk(folder);
	return result;
}

export async function createFile(app: App, dirPath: string, name: string): Promise<string> {
	let fullName = name.trim();
	if (!fullName) throw new Error("Name cannot be empty");

	if (!fullName.endsWith(".md")) fullName = `${fullName}.md`;
	const normalizedDir = normalizePath(dirPath);
	const newPath = normalizedDir ? `${normalizedDir}/${fullName}` : fullName;
	if (app.vault.getAbstractFileByPath(newPath)) throw new Error(`File already exists: ${newPath}`);
	await app.vault.create(newPath, "");
	return normalizePath(newPath);
}

export async function createFolder(app: App, dirPath: string, name: string): Promise<string> {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Name cannot be empty");
	if (trimmed.includes("/") || trimmed.includes("\\")) throw new Error("Invalid folder name");
	const normalizedDir = normalizePath(dirPath);
	const newPath = normalizedDir ? `${normalizedDir}/${trimmed}` : trimmed;
	if (app.vault.getAbstractFileByPath(newPath)) throw new Error(`Folder already exists: ${newPath}`);
	await app.vault.createFolder(newPath);
	return normalizePath(newPath);
}

export async function renameItem(app: App, oldPath: string, newName: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(oldPath);
	if (!file) throw new Error(`File not found: ${oldPath}`);
	const isDir = file instanceof TFolder;
	let finalName = newName.trim();
	if (!finalName) throw new Error("Name cannot be empty");
	if (!isDir) {


		const withoutExt = finalName.replace(/\.md$/, "");
		finalName = `${withoutExt}.md`;
	}
	const par = parentPath(oldPath);
	const newPath = par ? `${par}/${finalName}` : finalName;
	if (oldPath === newPath) return normalizePath(newPath);
	if (app.vault.getAbstractFileByPath(newPath)) throw new Error(`Target already exists: ${newPath}`);
	await app.vault.rename(file, newPath);
	return normalizePath(newPath);
}

export async function duplicateItem(app: App, path: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) throw new Error(`File not found: ${path}`);
	const par = parentPath(path);
	const base = basename(path);
	const isDir = file instanceof TFolder;

	function generateDuplicateName(baseName: string, isDir: boolean): string {
		const dotIdx = baseName.lastIndexOf(".");
		const nameWithoutExt = isDir ? baseName : dotIdx !== -1 ? baseName.substring(0, dotIdx) : baseName;
		const ext = isDir ? "" : dotIdx !== -1 ? baseName.substring(dotIdx) : ".md";

		let candidate = `${nameWithoutExt} copy${ext}`;
		let counter = 2;
		let candidatePath = par ? `${par}/${candidate}` : candidate;
		while (app.vault.getAbstractFileByPath(candidatePath)) {
			candidate = `${nameWithoutExt} copy ${counter}${ext}`;
			candidatePath = par ? `${par}/${candidate}` : candidate;
			counter++;
		}
		return candidatePath;
	}

	const newPath = generateDuplicateName(base, isDir);
	if (file instanceof TFile) {
		const content = await app.vault.read(file);
		await app.vault.create(newPath, content);
		return normalizePath(newPath);
	} else if (file instanceof TFolder) {

		await app.vault.createFolder(newPath);
		async function copyRecursively(srcFolder: TFolder, destPath: string) {
			for (const child of srcFolder.children) {
				const childDest = `${destPath}/${child.name}`;
				if (child instanceof TFile) {
					const content = await app.vault.read(child);
					await app.vault.create(childDest, content);
				} else if (child instanceof TFolder) {
					await app.vault.createFolder(childDest);
					await copyRecursively(child, childDest);
				}
			}
		}
		await copyRecursively(file, newPath);
		return normalizePath(newPath);
	}
	throw new Error("Unknown file type");
}

export async function moveItem(app: App, oldPath: string, targetDir: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(oldPath);
	if (!file) throw new Error(`File not found: ${oldPath}`);
	const base = basename(oldPath);
	const normalizedTarget = normalizePath(targetDir);
	const newPath = normalizedTarget ? `${normalizedTarget}/${base}` : base;
	if (normalizePath(oldPath) === normalizePath(newPath)) throw new Error("Already in target");
	if (app.vault.getAbstractFileByPath(newPath)) throw new Error(`Target already exists: ${newPath}`);

	if (file instanceof TFolder && normalizePath(newPath).startsWith(normalizePath(oldPath) + "/")) {
		throw new Error("Cannot move folder into itself");
	}
	await app.vault.rename(file, newPath);
	return normalizePath(newPath);
}

export async function copyItem(app: App, oldPath: string, targetDir: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(oldPath);
	if (!file) throw new Error(`File not found: ${oldPath}`);
	const base = basename(oldPath);
	const normalizedTarget = normalizePath(targetDir);
	let newPath = normalizedTarget ? `${normalizedTarget}/${base}` : base;

	if (app.vault.getAbstractFileByPath(newPath)) {
		const dupPath = await duplicateItem(app, oldPath);


		const existingDup = app.vault.getAbstractFileByPath(dupPath);
		if (existingDup) {

			const dupBase = basename(dupPath);
			const finalPath = normalizedTarget ? `${normalizedTarget}/${dupBase}` : dupBase;
			if (normalizePath(dupPath) !== normalizePath(finalPath)) {
				await app.vault.rename(existingDup, finalPath);
				return normalizePath(finalPath);
			}
			return normalizePath(dupPath);
		}
	}
	if (file instanceof TFile) {
		if (app.vault.getAbstractFileByPath(newPath)) {

			const par = normalizedTarget;
			let counter = 1;
			const dotIdx = base.lastIndexOf(".");
			const nameWithoutExt = dotIdx !== -1 ? base.substring(0, dotIdx) : base;
			const ext = dotIdx !== -1 ? base.substring(dotIdx) : "";
			while (app.vault.getAbstractFileByPath(newPath)) {
				const candidate = `${nameWithoutExt} copy${counter > 1 ? ` ${counter}` : ""}${ext}`;
				newPath = par ? `${par}/${candidate}` : candidate;
				counter++;
			}
		}
		await app.vault.create(newPath, await app.vault.read(file));
		return normalizePath(newPath);
	} else if (file instanceof TFolder) {

		if (app.vault.getAbstractFileByPath(newPath)) {
			const par = normalizedTarget;
			let counter = 1;
			let candidate = base;
			while (app.vault.getAbstractFileByPath(newPath)) {
				candidate = `${base} copy${counter > 1 ? ` ${counter}` : ""}`;
				newPath = par ? `${par}/${candidate}` : candidate;
				counter++;
			}
		}
		await app.vault.createFolder(newPath);
		async function copyRecursively(srcFolder: TFolder, destPath: string) {
			for (const child of srcFolder.children) {
				const childDest = `${destPath}/${child.name}`;
				if (child instanceof TFile) {
					const content = await app.vault.read(child);
					await app.vault.create(childDest, content);
				} else if (child instanceof TFolder) {
					await app.vault.createFolder(childDest);
					await copyRecursively(child, childDest);
				}
			}
		}
		await copyRecursively(file, newPath);
		return normalizePath(newPath);
	}
	throw new Error("Unknown type");
}

export async function trashItem(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) throw new Error(`File not found: ${path}`);
	await app.fileManager.trashFile(file);
}

interface AdapterWithBasePath {
	getBasePath?: () => string;
}

interface ElectronWindow extends Window {
	require?: (id: string) => {
		shell?: {
			showItemInFolder: (path: string) => void;
		};
	};
}

interface AppWithShowInFolder {
	showInFolder?: (path: string) => void;
}

export async function showInFolder(app: App, path: string) {
	const adapter = app.vault.adapter as AdapterWithBasePath;
	const basePath: string | null = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
	const absolute = basePath ? `${basePath}/${path}`.replace(/\/\//g, "/") : path;
	try {
		const electron = (window as ElectronWindow).require?.("electron");
		if (electron?.shell?.showItemInFolder) {
			electron.shell.showItemInFolder(absolute);
			return;
		}
		const appWithShow = app as AppWithShowInFolder;
		if (appWithShow.showInFolder) {
			appWithShow.showInFolder(path);
			return;
		}
		await navigator.clipboard.writeText(absolute);
		new Notice(`Path copied: ${absolute}`);
	} catch (e) {
		console.error(e);
		try {
			await navigator.clipboard.writeText(path);
			new Notice("Path copied to clipboard");
		} catch (clipError) {
			console.error(clipError);
		}
	}
}
