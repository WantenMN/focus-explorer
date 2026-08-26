const MULTI_SEP = "\n";

export function encodeMultiPaths(paths: string[]): string {
	if (paths.length === 0) return "";
	if (paths.length === 1) return paths[0] ?? "";
	return paths.join(MULTI_SEP);
}

export function decodeMultiPaths(raw: string | null): string[] {
	if (!raw) return [];
	if (raw.includes(MULTI_SEP)) return raw.split(MULTI_SEP);
	return [raw];
}

export function isMultiPath(raw: string | null): boolean {
	return !!raw && raw.includes(MULTI_SEP);
}
