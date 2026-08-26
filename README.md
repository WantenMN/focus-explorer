# Focus Explorer

An Obsidian file explorer with **folder focus** at its core.

## Folder focus

Right-click any folder → **Focus** to show only that folder's subtree. Everything outside it is hidden, so you can work on one area of your vault without distraction.

- **Focus bar** (always visible at the top): `Focus:` plus a search input.
  - Click the input to open a folder list (parents → children), type to fuzzy-search the whole vault, click or press Enter to focus.
  - Clear button empties the search and re-lists all folders.
  - History button shows recently focused folders for instant re-focus; each entry can be removed individually.
  - Close button exits focus mode.
- **Focus state** is persisted across restarts, and follows renames/deletions automatically.
- Focused files and folders are created directly inside the focused folder (ignores Obsidian's new-file location setting while focused).

## File tree

- Tree view with indentation guides and expand/collapse chevrons, folders first.
- **New file / New folder** inline input at the correct position and depth.
- **Rename** (`F2`), **Duplicate**, **Delete** (trash with confirmation).
- **Copy / Cut / Paste** with multi-select support.
- **Drag & drop** with hover-to-expand, auto-scroll, and a drop range indicator.
- **Selection**: single click, `Ctrl/Cmd` toggle, `Shift` range.
- **Auto reveal** the active file (header toggle).
- **Keyboard**: `F2`, `Delete`, `Ctrl/Cmd+C/X/V`, arrow keys, `Enter`.
- Shows only supported file types: `.md`, `.canvas`, `.base`.
- Middle-click a file to open it in a new tab.

## Context menu

New file / New folder, Focus / Clear focus, Expand all, Rename, Duplicate, Copy path (relative/absolute), Show in system explorer, Copy / Cut / Paste, Delete.

## License

[AGPL-3.0](LICENSE)