# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # esbuild watch mode (dev)
npm run build    # tsc type-check + esbuild production bundle
npm run lint     # eslint
```

The production build emits `main.js` (CJS bundle, minified, no sourcemap). Dev builds include inline sourcemaps. The `obsidian` module and CodeMirror sub-packages are externals (provided by Obsidian at runtime).

## Architecture

This is an Obsidian plugin that provides a kanban board view backed by plain markdown files with YAML frontmatter.

### Data flow

1. **Markdown file** — the single source of truth. Columns are `##` headings, items are `- [ ]` list entries. YAML frontmatter stores `kanban-plugin`, `kanban-tags` (tag definitions with id/name/color), and `done-column`.
2. **`parser.ts`** — `parseMarkdown(content)` reads a markdown string into a `KanbanData` struct; `serializeMarkdown(data)` writes it back. Tags on items use inline `#tag-id` syntax.
3. **`view.ts` — `KanbanView`** (an Obsidian `ItemView`) renders the board, handles inline editing, tag picker, column menus, and saves changes back to the markdown file via the parser. Saves are debounced (300ms).
4. **`main.ts` — `TimizuoKanbanPlugin`** registers the view, ribbon icon, commands, settings tab, and injects an "Open as Kanban" button into markdown views of files with `kanban-plugin` frontmatter.

### Types (`types.ts`)

- `KanbanTag` — `{ id, name, color }`
- `KanbanItem` — `{ id, content, tags[], createdAt }`
- `KanbanColumn` — `{ id, name, items[] }`
- `KanbanData` — `{ columns[], tags[], doneColumnId }`

### Key patterns

- The view type constant is `VIEW_TYPE_KANBAN = "kanban-view"`.
- Item IDs and column IDs are generated from names (lowercase, spaces → hyphens) for columns, or random alphanumeric for items.
- Tag colors are picked from a 12-color palette.
- `AGENTS.md` has comprehensive Obsidian plugin conventions (register helpers, settings persistence, mobile considerations, release process). Read it for general plugin development rules not specific to this codebase.