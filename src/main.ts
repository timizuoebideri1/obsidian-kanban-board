import { Plugin, TFile, MarkdownView, setIcon, WorkspaceLeaf } from "obsidian";
import { KanbanView, VIEW_TYPE_KANBAN } from "./view";
import { KanbanSettingTab, KanbanSettings, DEFAULT_SETTINGS } from "./settings";

export default class TimizuoKanbanPlugin extends Plugin {
    settings: KanbanSettings;

    async onload() {
        await this.loadSettings();

        this.registerView(
            VIEW_TYPE_KANBAN,
            (leaf) => new KanbanView(leaf)
        );

        // Ribbon icon: create new kanban board
        this.addRibbonIcon("columns", "New Kanban Board", async () => {
            await this.createKanbanBoard();
        });

        // Command: create new kanban board
        this.addCommand({
            id: "create-kanban-board",
            name: "Create new Kanban board",
            callback: async () => {
                await this.createKanbanBoard();
            },
        });

        // Command: open current file as kanban
        this.addCommand({
            id: "open-as-kanban",
            name: "Open current file as Kanban",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension !== "md") return false;
                if (!checking) {
                    this.openAsKanban(file);
                }
                return true;
            },
        });

        this.addSettingTab(new KanbanSettingTab(this.app, this));

        // Auto-open kanban files in kanban view instead of markdown
        this.registerEvent(
            this.app.workspace.on("file-open", (file) => {
                if (!file || file.extension !== "md") return;
                void this.maybeRedirectToKanban(file);
            })
        );

        // Inject "Open as Kanban" button into markdown views of kanban files
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                this.updateMarkdownViewAction(leaf);
            })
        );
    }

    async createKanbanBoard() {
        // Always create a new board with a unique file name
        let baseName = "Kanban Board";
        let fileName = `${baseName}.md`;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(fileName)) {
            counter++;
            fileName = `${baseName} ${counter}.md`;
        }

        const defaultContent = `---
kanban-plugin: basic
done-column: done
kanban-tags:
  - {id: bug, name: Bug, color: "#ff6b6b"}
  - {id: feature, name: Feature, color: "#51cf66"}
  - {id: chore, name: Chore, color: "#339af0"}
---

## Backlog
- [ ] First task

## In Progress

## Done
`;

        const file = await this.app.vault.create(fileName, defaultContent);
        await this.openAsKanban(file);
    }

    async openAsKanban(file: TFile) {
        // If there's already a kanban view for this file, reveal it
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN);
        for (const leaf of existing) {
            if (leaf.view instanceof KanbanView && (leaf.view as KanbanView).file === file) {
                this.app.workspace.revealLeaf(leaf);
                return;
            }
        }

        // Reuse the active leaf or open a new tab
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: VIEW_TYPE_KANBAN });
        const view = leaf.view as KanbanView;
        await view.loadFile(file);
    }

    /** Called on every file-open; silently swaps markdown → kanban for kanban files. */
    private async maybeRedirectToKanban(file: TFile): Promise<void> {
        // Step 1: Detect kanban frontmatter.
        // Try the metadata cache first (fast); fall back to a direct file read
        // in case the cache hasn't been populated yet for this file.
        const isKanban = await this.isKanbanFile(file);
        if (!isKanban) return;

        // Step 2: Find the leaf currently showing this file as a MarkdownView.
        // We iterate all leaves because the "active" view may already have
        // transitioned by the time this async chain runs.
        let targetLeaf: WorkspaceLeaf | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (
                leaf.view instanceof MarkdownView &&
                (leaf.view as MarkdownView).file === file
            ) {
                targetLeaf = leaf;
            }
        });

        if (!targetLeaf) return;

        // Step 3: If the user explicitly chose "Open as Markdown" from the kanban
        // view, a suppress flag will be set on the leaf. Honour that and skip
        // the redirect (clearing the flag so future opens are handled normally).
        const suppressFlag = "_suppressKanbanRedirect";
        if ((targetLeaf as WorkspaceLeaf & Record<string, unknown>)[suppressFlag]) {
            (targetLeaf as WorkspaceLeaf & Record<string, unknown>)[suppressFlag] = false;
            return;
        }

        // Step 4: Swap the leaf in-place to the kanban view.
        await (targetLeaf as WorkspaceLeaf).setViewState({
            type: VIEW_TYPE_KANBAN,
            active: true,
        });
        await ((targetLeaf as WorkspaceLeaf).view as KanbanView).loadFile(file);
    }

    /** Returns true if the file has `kanban-plugin` in its frontmatter. */
    private async isKanbanFile(file: TFile): Promise<boolean> {
        // Fast path: metadata cache already has the frontmatter
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter) {
            return !!cache.frontmatter["kanban-plugin"];
        }
        // Slow path: cache not ready yet – read the raw file content
        try {
            const content = await this.app.vault.cachedRead(file);
            return /^---[\s\S]*?\nkanban-plugin:/m.test(content);
        } catch {
            return false;
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<KanbanSettings>);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private updateMarkdownViewAction(leaf: WorkspaceLeaf | null): void {
        // Remove any existing injected buttons
        document.querySelectorAll(".kanban-md-action").forEach((el) => el.remove());

        if (!leaf) return;
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) return;

        const file = view.file;
        if (!file) return;

        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter?.["kanban-plugin"]) return;

        const inject = () => {
            const actionsEl = view.containerEl.querySelector(".view-actions");
            if (!actionsEl) return;

            const btn = actionsEl.createEl("button", {
                cls: "clickable-icon view-action kanban-md-action",
            });
            setIcon(btn, "columns");
            btn.setAttribute("aria-label", "Open as Kanban");
            btn.addEventListener("click", async () => {
                await leaf.setViewState({ type: VIEW_TYPE_KANBAN });
                const kanbanView = leaf.view as KanbanView;
                await kanbanView.loadFile(file);
            });
        };

        inject();
        // Retry once after a frame in case the header isn't rendered yet
        if (!document.querySelector(".kanban-md-action")) {
            requestAnimationFrame(() => inject());
        }
    }
}