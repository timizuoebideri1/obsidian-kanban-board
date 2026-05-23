import {
    ItemView,
    WorkspaceLeaf,
    TFile,
    MarkdownRenderer,
    Component,
    setIcon,
    Notice,
} from "obsidian";
import type { KanbanData, KanbanItem, KanbanTag, KanbanProject, KanbanCustomView } from "./types";
import { parseMarkdown, serializeMarkdown } from "./parser";
import type TimizuoKanbanPlugin from "./main";

export const VIEW_TYPE_KANBAN = "kanban-view";

interface DragItemState {
    itemId: string;
    sourceColumnId: string;
}

export class KanbanView extends ItemView {
    plugin: TimizuoKanbanPlugin;
    private data: KanbanData = { columns: [], tags: [], projects: [], doneColumnId: null };
    file: TFile | null = null;
    private saveTimeout: number | null = null;
    /** ID of the column currently being dragged (column reorder) */
    private dragSourceId: string | null = null;
    /** Item currently being dragged */
    private dragItem: DragItemState | null = null;
    /** Currently open item detail sidebar */
    private activeItemSidebar: HTMLElement | null = null;

    // Active filters state
    private filterSearch = "";
    private filterTags: string[] = [];
    private filterProjects: string[] = [];
    private filterPriorities: ("low" | "medium" | "high" | "urgent")[] = [];
    private activeCustomViewId: string | null = null;
    private columnsEl: HTMLElement | null = null;
    private pillsContainer: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: TimizuoKanbanPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_KANBAN;
    }

    getDisplayText(): string {
        return this.file?.basename ?? "Kanban";
    }

    getIcon(): string {
        return "columns";
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.contentEl.addClass("kanban-view");

        this.addAction("file-text", "Open as Markdown", () => {
            void this.switchToMarkdown();
        });

        // Register undo/redo keydown listener
        this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
            if (this.app.workspace.getActiveViewOfType(KanbanView) !== this) return;

            const isMod = e.ctrlKey || e.metaKey;
            if (isMod && e.key.toLowerCase() === "z") {
                const activeTag = document.activeElement?.tagName.toLowerCase();
                if (activeTag === "input" || activeTag === "textarea") {
                    return;
                }

                e.preventDefault();
                if (e.shiftKey) {
                    this.redo();
                } else {
                    this.undo();
                }
            } else if (isMod && e.key.toLowerCase() === "y") {
                const activeTag = document.activeElement?.tagName.toLowerCase();
                if (activeTag === "input" || activeTag === "textarea") {
                    return;
                }
                e.preventDefault();
                this.redo();
            }
        });
    }

    async onClose(): Promise<void> {
        this.contentEl.empty();
    }

    private undoStack: string[] = [];
    private redoStack: string[] = [];

    pushHistoryState(): void {
        if (!this.data) return;
        const state = serializeMarkdown(this.data);
        if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== state) {
            this.undoStack.push(state);
            if (this.undoStack.length > 50) {
                this.undoStack.shift();
            }
            this.redoStack = []; // Clear redo stack on new action
        }
    }

    undo(): void {
        const previousState = this.undoStack.pop();
        if (!previousState) {
            new Notice("Nothing to undo");
            return;
        }

        const currentState = serializeMarkdown(this.data);
        this.redoStack.push(currentState);
        if (this.redoStack.length > 50) {
            this.redoStack.shift();
        }

        this.data = parseMarkdown(previousState);
        this.debouncedSave();
        void this.render();
        new Notice("Undo action");
    }

    redo(): void {
        const nextState = this.redoStack.pop();
        if (!nextState) {
            new Notice("Nothing to redo");
            return;
        }

        const currentState = serializeMarkdown(this.data);
        this.undoStack.push(currentState);
        if (this.undoStack.length > 50) {
            this.undoStack.shift();
        }

        this.data = parseMarkdown(nextState);
        this.debouncedSave();
        void this.render();
        new Notice("Redo action");
    }

    async loadFile(file: TFile): Promise<void> {
        this.file = file;
        const content = await this.app.vault.read(file);
        this.data = parseMarkdown(content);
        await this.render();
    }

    async render(): Promise<void> {
        // Capture scroll positions before wiping the DOM
        let horizontalScroll = 0;
        const scrollPositions = new Map<string, number>();
        if (this.columnsEl) {
            horizontalScroll = this.columnsEl.scrollLeft;
            const columns = this.columnsEl.querySelectorAll(".kanban-column");
            columns.forEach((col) => {
                const colId = col.getAttr("data-column-id");
                const itemsEl = col.querySelector(".kanban-items");
                if (colId && itemsEl) {
                    scrollPositions.set(colId, itemsEl.scrollTop);
                }
            });
        }

        // Close any open sidebar before wiping the DOM
        this.closeItemSidebar();

        const container = this.contentEl;
        container.empty();
        container.addClass("kanban-view");

        // Board title — click to rename
        const header = container.createDiv("kanban-header");
        const titleEl = header.createEl("h2", {
            text: this.file?.basename ?? "Kanban",
            cls: "kanban-board-title",
            title: "Click to rename board",
        });
        titleEl.addEventListener("click", () => {
            this.startInlineEdit(titleEl, this.file?.basename ?? "", async (newName) => {
                if (!this.file || !newName.trim()) return;
                const dir = this.file.parent?.path ?? "";
                const newPath = dir ? `${dir}/${newName.trim()}.md` : `${newName.trim()}.md`;
                try {
                    await this.app.fileManager.renameFile(this.file, newPath);
                    // file reference is automatically updated by Obsidian after rename
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (this.leaf as any).updateHeader();
                } catch (e) {
                    console.error("Kanban: rename failed", e);
                }
                void this.render();
            });
        });

        const addColBtn = header.createEl("button", {
            text: "+ Add Column",
            cls: "kanban-add-column-btn",
        });
        addColBtn.addEventListener("click", () => this.addColumn());

        // Filter bar
        this.renderFilterBar(container);

        // Columns container
        this.columnsEl = container.createDiv("kanban-columns");
        this.renderColumns();

        // Restore horizontal scroll
        if (horizontalScroll > 0) {
            this.columnsEl.scrollLeft = horizontalScroll;
        }

        // Restore vertical scroll for each column
        if (scrollPositions.size > 0) {
            const restoreVerticalScrolls = () => {
                if (!this.columnsEl) return;
                const columns = this.columnsEl.querySelectorAll(".kanban-column");
                columns.forEach((col) => {
                    const colId = col.getAttr("data-column-id");
                    if (colId) {
                        const scrollPos = scrollPositions.get(colId);
                        if (scrollPos !== undefined) {
                            const itemsEl = col.querySelector(".kanban-items");
                            if (itemsEl) {
                                itemsEl.scrollTop = scrollPos;
                            }
                        }
                    }
                });
            };

            // Restore immediately
            restoreVerticalScrolls();

            // Also restore on next frame to account for async markdown rendering / layout shifts
            requestAnimationFrame(() => {
                restoreVerticalScrolls();
            });
        }
    }

    private renderColumns(): void {
        if (!this.columnsEl) return;
        this.columnsEl.empty();
        for (const column of this.data.columns) {
            this.renderColumn(this.columnsEl, column);
        }
    }

    private renderColumn(parent: HTMLElement, column: import("./types").KanbanColumn): void {
        const colEl = parent.createDiv("kanban-column");
        const isDone = this.data.doneColumnId === column.id;
        const isCollapsed = this.data.collapsedColumnIds?.includes(column.id) ?? false;

        if (isDone) {
            colEl.addClass("is-done-column");
        }

        if (isCollapsed) {
            colEl.addClass("is-collapsed");
            colEl.addEventListener("click", (e) => {
                const target = e.target as HTMLElement;
                if (target.closest("button") || target.closest("input") || target.closest(".kanban-item")) return;
                this.toggleColumnCollapse(column.id);
            });
        }

        // Make the column draggable
        colEl.setAttr("draggable", "true");
        colEl.setAttr("data-column-id", column.id);

        colEl.addEventListener("dragstart", (e: DragEvent) => {
            this.dragSourceId = column.id;
            colEl.addClass("kanban-column-dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", column.id);
            }
        });

        colEl.addEventListener("dragend", () => {
            this.dragSourceId = null;
            // Clean up any lingering drag-over classes
            parent.querySelectorAll(".kanban-column-drag-over").forEach((el) =>
                el.removeClass("kanban-column-drag-over")
            );
            colEl.removeClass("kanban-column-dragging");
        });

        colEl.addEventListener("dragover", (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            if (this.dragSourceId && this.dragSourceId !== column.id) {
                // Remove highlight from all siblings first
                parent.querySelectorAll(".kanban-column-drag-over").forEach((el) =>
                    el.removeClass("kanban-column-drag-over")
                );
                colEl.addClass("kanban-column-drag-over");
            }
        });


        colEl.addEventListener("dragleave", (e: DragEvent) => {
            // Only remove when the pointer truly leaves this column element
            if (!colEl.contains(e.relatedTarget as Node)) {
                colEl.removeClass("kanban-column-drag-over");
            }
        });

        colEl.addEventListener("drop", (e: DragEvent) => {
            e.preventDefault();
            colEl.removeClass("kanban-column-drag-over");
            if (!this.dragSourceId || this.dragSourceId === column.id) return;

            const sourceIdx = this.data.columns.findIndex((c) => c.id === this.dragSourceId);
            const targetIdx = this.data.columns.findIndex((c) => c.id === column.id);
            if (sourceIdx === -1 || targetIdx === -1) return;

            this.pushHistoryState();
            // Reorder: remove source and insert at target position
            const [sourceCol] = this.data.columns.splice(sourceIdx, 1);
            this.data.columns.splice(targetIdx, 0, sourceCol!);

            this.dragSourceId = null;
            this.debouncedSave();
            void this.render();
        });

        // Column header
        const colHeader = colEl.createDiv("kanban-column-header");

        // Collapse toggle chevron
        const toggleBtn = colHeader.createEl("button", {
            cls: "kanban-icon-btn kanban-collapse-toggle clickable-icon",
        });
        setIcon(toggleBtn, isCollapsed ? "chevron-right" : "chevron-down");
        toggleBtn.setAttr("title", isCollapsed ? "Expand column" : "Collapse column");
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleColumnCollapse(column.id);
        });

        if (isDone) {
            const doneIcon = colHeader.createSpan({ cls: "kanban-done-icon" });
            setIcon(doneIcon, "check-circle");
        }

        const nameEl = colHeader.createSpan({ text: column.name, cls: "kanban-column-name" });

        // Filter items
        const filteredItems = column.items.filter((item) => {
            if (this.filterSearch) {
                const query = this.filterSearch.toLowerCase();
                const matchesContent = item.content.toLowerCase().includes(query);
                const matchesDesc = item.description ? item.description.toLowerCase().includes(query) : false;
                if (!matchesContent && !matchesDesc) return false;
            }
            if (this.filterTags.length > 0) {
                const matchesTag = item.tags.some((t) => this.filterTags.includes(t));
                if (!matchesTag) return false;
            }
            if (this.filterProjects.length > 0) {
                if (!item.project || !this.filterProjects.includes(item.project)) return false;
            }
            if (this.filterPriorities.length > 0) {
                const priority = item.priority || "low";
                if (!this.filterPriorities.includes(priority)) return false;
            }
            return true;
        });

        const hasFilters = this.filterSearch || this.filterTags.length > 0 || this.filterProjects.length > 0 || this.filterPriorities.length > 0;
        const countBadge = colHeader.createSpan({
            text: hasFilters ? `${filteredItems.length} / ${column.items.length}` : String(column.items.length),
            cls: "kanban-column-count",
        });
        if (hasFilters) {
            countBadge.addClass("has-active-filters");
        }

        const headerActions = colHeader.createDiv("kanban-column-actions");

        // Menu button
        const menuBtn = headerActions.createEl("button", {
            cls: "kanban-icon-btn clickable-icon",
        });
        setIcon(menuBtn, "more-horizontal");
        menuBtn.addEventListener("click", (e) => this.showColumnMenu(e, column, nameEl));

        // Delete button
        const deleteColBtn = headerActions.createEl("button", {
            cls: "kanban-icon-btn clickable-icon",
        });
        setIcon(deleteColBtn, "trash-2");
        deleteColBtn.addEventListener("click", () => this.deleteColumn(column.id));

        // Items
        const itemsEl = colEl.createDiv("kanban-items");
        for (const item of filteredItems) {
            this.renderItem(itemsEl, item, column);
        }

        // ── Items drop zone ─────────────────────────────────────────────
        itemsEl.addEventListener("dragover", (e: DragEvent) => {
            if (!this.dragItem) return; // only handle item drags
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            itemsEl.addClass("kanban-items-drag-over");
            this.updateDropIndicator(itemsEl, e.clientY);
        });

        itemsEl.addEventListener("dragleave", (e: DragEvent) => {
            if (!this.dragItem) return;
            if (!itemsEl.contains(e.relatedTarget as Node)) {
                itemsEl.removeClass("kanban-items-drag-over");
                itemsEl.querySelectorAll(".kanban-drop-indicator").forEach((el) => el.remove());
            }
        });

        itemsEl.addEventListener("drop", (e: DragEvent) => {
            if (!this.dragItem) return;
            e.preventDefault();
            e.stopPropagation();
            itemsEl.removeClass("kanban-items-drag-over");

            const { itemId, sourceColumnId } = this.dragItem;
            this.dragItem = null;

            // Clean up indicators
            document.querySelectorAll(".kanban-drop-indicator").forEach((el) => el.remove());

            const srcCol = this.data.columns.find((c) => c.id === sourceColumnId);
            const dstCol = this.data.columns.find((c) => c.id === column.id);
            if (!srcCol || !dstCol) return;

            const itemIdx = srcCol.items.findIndex((i) => i.id === itemId);
            if (itemIdx === -1) return;

            this.pushHistoryState();
            const [movedItem] = srcCol.items.splice(itemIdx, 1);
            if (!movedItem) return;

            // Determine insert target based on pointer position (safe for filtered views)
            const targetItemId = this.getDropTargetItemId(itemsEl, e.clientY);
            if (targetItemId) {
                const targetIdx = dstCol.items.findIndex((i) => i.id === targetItemId);
                if (targetIdx !== -1) {
                    dstCol.items.splice(targetIdx, 0, movedItem);
                } else {
                    dstCol.items.push(movedItem);
                }
            } else {
                dstCol.items.push(movedItem);
            }

            this.debouncedSave();
            void this.render();
        });

        // Add item input
        const addItemRow = colEl.createDiv("kanban-add-item");
        const addInput = addItemRow.createEl("input", {
            type: "text",
            placeholder: "+ Add item...",
            cls: "kanban-add-input",
        });
        addInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && addInput.value.trim()) {
                void this.addItem(column.id, addInput.value.trim());
                addInput.value = "";
            }
        });
    }

    private renderItem(parent: HTMLElement, item: KanbanItem, column: import("./types").KanbanColumn): void {
        const itemEl = parent.createDiv("kanban-item");
        itemEl.setAttr("data-item-id", item.id);
        itemEl.setAttr("draggable", "true");

        if (this.data.doneColumnId === column.id) {
            itemEl.addClass("is-done");
        }

        // ── Item drag-and-drop ──────────────────────────────────────────
        itemEl.addEventListener("dragstart", (e: DragEvent) => {
            // Don't fire item drag if we're dragging a column
            e.stopPropagation();
            this.dragItem = { itemId: item.id, sourceColumnId: column.id };
            itemEl.addClass("kanban-item-dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", item.id);
            }
        });

        itemEl.addEventListener("dragend", () => {
            this.dragItem = null;
            itemEl.removeClass("kanban-item-dragging");
            // Clean up any drop indicators
            document.querySelectorAll(".kanban-drop-indicator").forEach((el) => el.remove());
            document.querySelectorAll(".kanban-items-drag-over").forEach((el) =>
                el.removeClass("kanban-items-drag-over")
            );
        });

        // ── Content row ─────────────────────────────────────────────────
        const row = itemEl.createDiv("kanban-item-row");

        // Content — click opens the sidebar, not inline edit
        const contentEl = row.createSpan({ cls: "kanban-item-content" });
        MarkdownRenderer.render(this.app, item.content, contentEl, this.file?.path ?? "", new Component());
        contentEl.addEventListener("click", () => {
            this.openItemSidebar(item, column);
        });

        // Delete button
        const deleteBtn = row.createEl("button", {
            cls: "kanban-icon-btn kanban-delete-item clickable-icon",
        });
        setIcon(deleteBtn, "x");
        deleteBtn.addEventListener("click", () => {
            this.pushHistoryState();
            column.items = column.items.filter((i) => i.id !== item.id);
            this.debouncedSave();
            void this.render();
        });

        // Project row (top)
        const projectRow = itemEl.createDiv("kanban-item-project-row");

        // Description indicator
        if (item.description) {
            const descIndicator = projectRow.createSpan({ cls: "kanban-item-desc-indicator" });
            setIcon(descIndicator, "align-left");
            descIndicator.setAttr("title", "Has description");
        }

        if (item.project) {
            const proj = this.data.projects.find((p) => p.id === item.project);
            if (proj) {
                const projBadge = projectRow.createSpan({
                    text: proj.name,
                    cls: "kanban-project-badge",
                });
                projBadge.style.borderColor = proj.color;
                projBadge.style.color = proj.color;
            }
        }

        // Priority badge
        if (item.priority) {
            const priorityBadge = projectRow.createSpan({
                cls: `kanban-priority-badge priority-${item.priority}`,
                title: `Priority: ${item.priority.charAt(0).toUpperCase() + item.priority.slice(1)}`,
            });
            const flagIcon = priorityBadge.createSpan("kanban-priority-icon");
            setIcon(flagIcon, "flag");
            priorityBadge.createSpan({ text: item.priority.charAt(0).toUpperCase() + item.priority.slice(1) });
            priorityBadge.addEventListener("click", (e) => {
                e.stopPropagation();
                this.showPriorityPicker(e, item);
            });
        }

        // Add priority button (always visible on hover if no priority is set)
        if (!item.priority) {
            const addPriorityBtn = projectRow.createEl("button", {
                cls: "kanban-add-priority-btn clickable-icon",
            });
            setIcon(addPriorityBtn, "flag");
            addPriorityBtn.setAttr("title", "Assign priority");
            addPriorityBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.showPriorityPicker(e, item);
            });
        }

        // Add project button (always visible on hover)
        const addProjectBtn = projectRow.createEl("button", {
            cls: "kanban-add-project-btn clickable-icon",
        });
        setIcon(addProjectBtn, "folder");
        addProjectBtn.setAttr("title", "Assign project");
        addProjectBtn.addEventListener("click", (e) => this.showProjectPicker(e, item));

        // Tags row (below project row)
        const tagsRow = itemEl.createDiv("kanban-item-tags");

        for (const tagId of item.tags) {
            const tag = this.data.tags.find((t) => t.id === tagId);
            if (tag) {
                const tagEl = tagsRow.createSpan({
                    text: tag.name,
                    cls: "kanban-tag",
                });
                tagEl.style.backgroundColor = tag.color;

                const removeBtn = tagEl.createSpan({ cls: "kanban-tag-remove" });
                setIcon(removeBtn, "x");
                removeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    item.tags = item.tags.filter((t) => t !== tagId);
                    this.debouncedSave();
                    void this.render();
                });
            }
        }

        // Add tag button
        const addTagBtn = tagsRow.createEl("button", {
            cls: "kanban-add-tag-btn clickable-icon",
        });
        setIcon(addTagBtn, "tag");
        addTagBtn.addEventListener("click", (e) => this.showTagPicker(e, item));
    }

    private openItemSidebar(item: KanbanItem, column: import("./types").KanbanColumn): void {
        // Close any existing sidebar first
        this.closeItemSidebar();

        // Backdrop
        const backdrop = this.contentEl.createDiv("kanban-sidebar-backdrop");
        backdrop.addEventListener("click", () => this.closeItemSidebar());

        // Panel
        const panel = this.contentEl.createDiv("kanban-item-sidebar");
        this.activeItemSidebar = panel;

        // Trigger animation on next frame
        requestAnimationFrame(() => panel.addClass("is-open"));

        // ── Header ──────────────────────────────────────────────────────
        const header = panel.createDiv("kanban-sidebar-header");

        const titleWrapper = header.createDiv("kanban-sidebar-title-wrap");
        const columnBadge = titleWrapper.createSpan({
            text: column.name,
            cls: "kanban-sidebar-column-badge",
        });
        if (this.data.doneColumnId === column.id) columnBadge.addClass("is-done");

        // Editable title
        const titleEl = titleWrapper.createEl("h2", {
            text: item.content,
            cls: "kanban-sidebar-title",
            title: "Click to rename",
        });
        titleEl.addEventListener("click", () => {
            this.startInlineEdit(titleEl, item.content, (newContent) => {
                this.pushHistoryState();
                item.content = newContent;
                this.debouncedSave();
                void this.render();
                // Refresh the sidebar title without closing
                titleEl.textContent = newContent;
            });
        });

        const closeBtn = header.createEl("button", { cls: "kanban-sidebar-close kanban-icon-btn" });
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", () => this.closeItemSidebar());

        // ── Meta row ────────────────────────────────────────────────────
        const meta = panel.createDiv("kanban-sidebar-meta");
        const createdDate = new Date(item.createdAt).toLocaleDateString(undefined, {
            year: "numeric", month: "short", day: "numeric",
        });
        const metaDate = meta.createDiv("kanban-sidebar-meta-item");
        const calIcon = metaDate.createSpan("kanban-sidebar-meta-icon");
        setIcon(calIcon, "calendar");
        metaDate.createSpan({ text: createdDate, cls: "kanban-sidebar-meta-text" });

        // ── Tags ────────────────────────────────────────────────────────
        const tagsSection = panel.createDiv("kanban-sidebar-tags");
        const tagsLabel = tagsSection.createDiv("kanban-sidebar-section-label");
        tagsLabel.createSpan({ text: "Tags" });

        const tagsRow = tagsSection.createDiv("kanban-sidebar-tags-row");
        const renderSidebarTags = () => {
            tagsRow.empty();
            for (const tagId of item.tags) {
                const tag = this.data.tags.find((t) => t.id === tagId);
                if (tag) {
                    const tagEl = tagsRow.createSpan({ text: tag.name, cls: "kanban-tag" });
                    tagEl.style.backgroundColor = tag.color;
                    const rmBtn = tagEl.createSpan({ cls: "kanban-tag-remove" });
                    setIcon(rmBtn, "x");
                    rmBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        this.pushHistoryState();
                        item.tags = item.tags.filter((t) => t !== tagId);
                        this.debouncedSave();
                        void this.render();
                        renderSidebarTags();
                    });
                }
            }
            const addTagBtn = tagsRow.createEl("button", { cls: "kanban-add-tag-btn clickable-icon", attr: { style: "opacity:0.6" } });
            setIcon(addTagBtn, "plus");
            addTagBtn.addEventListener("click", (e) => {
                this.showTagPicker(e, item);
            });
        };
        renderSidebarTags();

        // ── Project ─────────────────────────────────────────────────────
        const projSection = panel.createDiv("kanban-sidebar-tags");
        const projLabel = projSection.createDiv("kanban-sidebar-section-label");
        projLabel.createSpan({ text: "Project" });

        const projRow = projSection.createDiv("kanban-sidebar-tags-row");
        const renderSidebarProject = () => {
            projRow.empty();
            if (item.project) {
                const proj = this.data.projects.find((p) => p.id === item.project);
                if (proj) {
                    const badge = projRow.createSpan({ text: proj.name, cls: "kanban-project-badge" });
                    badge.style.borderColor = proj.color;
                    badge.style.color = proj.color;
                    const rmBtn = badge.createSpan({ cls: "kanban-tag-remove" });
                    setIcon(rmBtn, "x");
                    rmBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        this.pushHistoryState();
                        item.project = undefined;
                        await this.handleTaskFileMove(item);
                        await this.updateLinkedTaskFileMetadata(item);
                        this.debouncedSave();
                        void this.render();
                        renderSidebarProject();
                    });
                }
            }
            const addProjBtn = projRow.createEl("button", { cls: "kanban-add-tag-btn clickable-icon", attr: { style: "opacity:0.6" } });
            setIcon(addProjBtn, "folder");
            addProjBtn.addEventListener("click", (e) => {
                this.showProjectPicker(e, item, renderSidebarProject);
            });
        };
        renderSidebarProject();

        // ── Priority ────────────────────────────────────────────────────
        const prioSection = panel.createDiv("kanban-sidebar-tags");
        const prioLabel = prioSection.createDiv("kanban-sidebar-section-label");
        prioLabel.createSpan({ text: "Priority" });

        const prioRow = prioSection.createDiv("kanban-sidebar-priority-row");
        const priorities: ("low" | "medium" | "high" | "urgent")[] = ["low", "medium", "high", "urgent"];
        
        const renderPriorityPills = () => {
            prioRow.empty();
            const currentPriority = item.priority || "low";
            
            for (const p of priorities) {
                const pill = prioRow.createEl("button", {
                    text: p.charAt(0).toUpperCase() + p.slice(1),
                    cls: `kanban-priority-pill priority-${p} ${currentPriority === p ? "is-active" : ""}`
                });
                
                pill.addEventListener("click", async () => {
                    if (item.priority === p) return;
                    this.pushHistoryState();
                    item.priority = p;
                    await this.updateLinkedTaskFileMetadata(item);
                    this.debouncedSave();
                    void this.render();
                    renderPriorityPills();
                });
            }
        };
        renderPriorityPills();

        // ── Description ─────────────────────────────────────────────────
        const descSection = panel.createDiv("kanban-sidebar-desc");
        const descHeader = descSection.createDiv("kanban-sidebar-section-label");
        descHeader.createSpan({ text: "Description" });
        const tabBar = descHeader.createDiv("kanban-sidebar-tabs");
        const editTab = tabBar.createEl("button", { text: "Edit", cls: "kanban-sidebar-tab is-active" });
        const previewTab = tabBar.createEl("button", { text: "Preview", cls: "kanban-sidebar-tab" });

        const descBody = descSection.createDiv("kanban-sidebar-desc-body");

        // Edit view
        const textarea = descBody.createEl("textarea", {
            cls: "kanban-sidebar-textarea",
            attr: { placeholder: "Add a description… (Markdown supported)" },
        });
        textarea.value = item.description ?? "";

        // Preview view
        const preview = descBody.createDiv("kanban-sidebar-preview");
        preview.style.display = "none";

        const switchTab = (mode: "edit" | "preview") => {
            if (mode === "preview") {
                editTab.removeClass("is-active");
                previewTab.addClass("is-active");
                textarea.style.display = "none";
                preview.style.display = "";
                preview.empty();
                const md = textarea.value || "*No description yet.*";
                void MarkdownRenderer.render(this.app, md, preview, this.file?.path ?? "", new Component());
            } else {
                previewTab.removeClass("is-active");
                editTab.addClass("is-active");
                preview.style.display = "none";
                textarea.style.display = "";
                textarea.focus();
            }
        };

        editTab.addEventListener("click", () => switchTab("edit"));
        previewTab.addEventListener("click", () => switchTab("preview"));

        // Auto-save on textarea change
        textarea.addEventListener("input", () => {
            item.description = textarea.value || undefined;
            this.debouncedSave();
        });

        // ── Escape key closes sidebar ────────────────────────────────────
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === "Escape") this.closeItemSidebar();
        };
        document.addEventListener("keydown", keyHandler);
        // Store handler on element for cleanup
        (panel as HTMLElement & { _kbKeyHandler?: (e: KeyboardEvent) => void })._kbKeyHandler = keyHandler;
    }

    private closeItemSidebar(): void {
        if (!this.activeItemSidebar) return;
        const panel = this.activeItemSidebar;
        // Retrieve and remove key handler
        const kbEl = panel as HTMLElement & { _kbKeyHandler?: (e: KeyboardEvent) => void };
        if (kbEl._kbKeyHandler) {
            document.removeEventListener("keydown", kbEl._kbKeyHandler);
        }
        panel.removeClass("is-open");
        // Remove after transition
        setTimeout(() => {
            panel.remove();
            this.contentEl.querySelector(".kanban-sidebar-backdrop")?.remove();
        }, 280);
        this.activeItemSidebar = null;
    }

    private showProjectPicker(event: MouseEvent, item: KanbanItem, onPick?: () => void): void {
        // Remove any existing picker
        document.querySelector(".kanban-project-picker")?.remove();

        const picker = document.body.createDiv("kanban-project-picker");

        const input = picker.createEl("input", {
            type: "text",
            placeholder: "Search or create project...",
            cls: "kanban-tag-picker-input",
        });

        const list = picker.createDiv("kanban-tag-picker-list");

        const renderProjectList = (filter: string) => {
            list.empty();
            const filtered = filter
                ? this.data.projects.filter((p) =>
                      p.name.toLowerCase().includes(filter.toLowerCase())
                  )
                : this.data.projects;

            for (const proj of filtered) {
                const opt = list.createDiv("kanban-tag-picker-option");
                const swatch = opt.createSpan("kanban-tag-swatch");
                swatch.style.backgroundColor = proj.color;
                opt.createSpan({ text: proj.name });
                if (item.project === proj.id) {
                    opt.addClass("is-selected");
                }
                opt.addEventListener("click", async () => {
                    item.project = item.project === proj.id ? undefined : proj.id;
                    await this.handleTaskFileMove(item);
                    await this.updateLinkedTaskFileMetadata(item);
                    this.debouncedSave();
                    picker.remove();
                    if (onPick) onPick();
                    void this.render();
                });
            }

            if (filter && !this.data.projects.some((p) => p.name === filter)) {
                const createOpt = list.createDiv(
                    "kanban-tag-picker-option kanban-tag-picker-create"
                );
                createOpt.createSpan({ text: `Create project "${filter}"` });
                createOpt.addEventListener("click", async () => {
                    const newProj: KanbanProject = {
                        id: filter.toLowerCase().replace(/\s+/g, "-"),
                        name: filter,
                        color: this.randomTagColor(),
                    };
                    this.data.projects.push(newProj);
                    item.project = newProj.id;
                    await this.handleTaskFileMove(item);
                    await this.updateLinkedTaskFileMetadata(item);
                    this.debouncedSave();
                    picker.remove();
                    if (onPick) onPick();
                    void this.render();
                });
            }
        };

        renderProjectList("");

        input.addEventListener("input", () => {
            renderProjectList(input.value);
        });

        // Position picker near the button
        const target = event.target as HTMLElement;
        const rect = target.getBoundingClientRect();
        picker.style.position = "fixed";
        picker.style.top = `${rect.bottom + 4}px`;
        picker.style.left = `${rect.left}px`;

        input.focus();

        // Close on outside click
        const closeHandler = (e: MouseEvent) => {
            if (!picker.contains(e.target as Node)) {
                picker.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);

        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                picker.remove();
                document.removeEventListener("keydown", keyHandler);
            }
        };
        document.addEventListener("keydown", keyHandler);
    }

    private showPriorityPicker(event: MouseEvent, item: KanbanItem, onPick?: () => void): void {
        // Remove any existing picker
        document.querySelector(".kanban-priority-picker")?.remove();

        const picker = document.body.createDiv("kanban-priority-picker");
        const list = picker.createDiv("kanban-tag-picker-list");

        // Clear option
        const clearOpt = list.createDiv("kanban-tag-picker-option");
        clearOpt.createSpan({ text: "None (Clear)" });
        if (!item.priority) {
            clearOpt.addClass("is-selected");
        }
        clearOpt.addEventListener("click", async () => {
            item.priority = undefined;
            await this.updateLinkedTaskFileMetadata(item);
            this.debouncedSave();
            picker.remove();
            if (onPick) onPick();
            void this.render();
        });

        const priorities: ("low" | "medium" | "high" | "urgent")[] = ["low", "medium", "high", "urgent"];

        for (const p of priorities) {
            const opt = list.createDiv("kanban-tag-picker-option");
            if (item.priority === p) {
                opt.addClass("is-selected");
            }
            opt.createSpan({ text: p.charAt(0).toUpperCase() + p.slice(1) });
            opt.addEventListener("click", async () => {
                item.priority = p;
                await this.updateLinkedTaskFileMetadata(item);
                this.debouncedSave();
                picker.remove();
                if (onPick) onPick();
                void this.render();
            });
        }

        // Position picker near the button/badge
        const target = event.target as HTMLElement;
        const rect = target.getBoundingClientRect();
        picker.style.position = "fixed";
        picker.style.top = `${rect.bottom + 4}px`;
        picker.style.left = `${rect.left}px`;

        // Close on outside click
        const closeHandler = (e: MouseEvent) => {
            if (!picker.contains(e.target as Node)) {
                picker.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);

        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                picker.remove();
                document.removeEventListener("keydown", keyHandler);
            }
        };
        document.addEventListener("keydown", keyHandler);
    }

    private showTagPicker(event: MouseEvent, item: KanbanItem): void {
        // Remove any existing picker
        document.querySelector(".kanban-tag-picker")?.remove();

        const picker = document.body.createDiv("kanban-tag-picker");

        const input = picker.createEl("input", {
            type: "text",
            placeholder: "Search or create tag...",
            cls: "kanban-tag-picker-input",
        });

        const list = picker.createDiv("kanban-tag-picker-list");

        const renderTagList = (filter: string) => {
            list.empty();
            const availableTags = this.data.tags.filter(
                (t) => !item.tags.includes(t.id)
            );
            const filtered = filter
                ? availableTags.filter((t) =>
                      t.name.toLowerCase().includes(filter.toLowerCase())
                  )
                : availableTags;

            for (const tag of filtered) {
                const opt = list.createDiv("kanban-tag-picker-option");
                const swatch = opt.createSpan("kanban-tag-swatch");
                swatch.style.backgroundColor = tag.color;
                opt.createSpan({ text: tag.name });
                opt.addEventListener("click", () => {
                    item.tags.push(tag.id);
                    this.debouncedSave();
                    picker.remove();
                    void this.render();
                });
            }

            if (filter && !this.data.tags.some((t) => t.name === filter)) {
                const createOpt = list.createDiv(
                    "kanban-tag-picker-option kanban-tag-picker-create"
                );
                createOpt.createSpan({ text: `Create tag "${filter}"` });
                createOpt.addEventListener("click", () => {
                    const newTag: KanbanTag = {
                        id: filter.toLowerCase().replace(/\s+/g, "-"),
                        name: filter,
                        color: this.randomTagColor(),
                    };
                    this.data.tags.push(newTag);
                    item.tags.push(newTag.id);
                    this.debouncedSave();
                    picker.remove();
                    void this.render();
                });
            }
        };

        renderTagList("");

        input.addEventListener("input", () => {
            renderTagList(input.value);
        });

        // Position picker near the button
        const target = event.target as HTMLElement;
        const rect = target.getBoundingClientRect();
        picker.style.position = "fixed";
        picker.style.top = `${rect.bottom + 4}px`;
        picker.style.left = `${rect.left}px`;

        // Focus input
        input.focus();

        // Close on outside click
        const closeHandler = (e: MouseEvent) => {
            if (!picker.contains(e.target as Node)) {
                picker.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);

        // Close on escape
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                picker.remove();
                document.removeEventListener("keydown", keyHandler);
            }
        };
        document.addEventListener("keydown", keyHandler);
    }

    private showColumnMenu(event: MouseEvent, column: import("./types").KanbanColumn, nameEl: HTMLElement): void {
        document.querySelector(".kanban-column-menu")?.remove();

        const menu = document.body.createDiv("kanban-column-menu");
        const isDone = this.data.doneColumnId === column.id;

        const editTitleOpt = menu.createDiv("kanban-column-menu-option");
        editTitleOpt.createSpan({ text: "Edit Title" });
        editTitleOpt.addEventListener("click", () => {
            menu.remove();
            this.startInlineEdit(nameEl, column.name, (newName) => {
                this.pushHistoryState();
                column.name = newName;
                column.id = newName.toLowerCase().replace(/\s+/g, "-");
                this.debouncedSave();
                void this.render();
            });
        });

        const markDoneOpt = menu.createDiv("kanban-column-menu-option");
        if (isDone) {
            markDoneOpt.createSpan({ text: "Unmark as Done" });
            markDoneOpt.addEventListener("click", () => {
                this.pushHistoryState();
                this.data.doneColumnId = null;
                this.debouncedSave();
                menu.remove();
                void this.render();
            });
        } else {
            markDoneOpt.createSpan({ text: "Mark as Done" });
            markDoneOpt.addEventListener("click", () => {
                this.pushHistoryState();
                this.data.doneColumnId = column.id;
                this.debouncedSave();
                menu.remove();
                void this.render();
            });
        }

        const target = event.target as HTMLElement;
        const rect = target.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${rect.left}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) {
                menu.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);

        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                menu.remove();
                document.removeEventListener("keydown", keyHandler);
            }
        };
        document.addEventListener("keydown", keyHandler);
    }

    private async ensureFolderExists(path: string): Promise<void> {
        if (!path || path === "/" || path === ".") return;
        const parts = path.split("/").filter(Boolean);
        let currentPath = "";
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const abstractFile = this.app.vault.getAbstractFileByPath(currentPath);
            if (!abstractFile) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (e) {
                    console.error("Failed to create folder segment:", currentPath, e);
                }
            }
        }
    }

    private async handleTaskFileMove(item: KanbanItem): Promise<void> {
        const file = this.file;
        if (!file || !this.plugin.settings.createFolderForProjects) return;

        const match = item.content.trim().match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
        if (!match || !match[1]) return;

        const linkPath = match[1].trim();
        const taskFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
        if (!taskFile) return;

        const baseFolder = this.plugin.settings.baseProjectsFolder.trim() || "Kanban Projects";
        let projectFolder = baseFolder;
        if (item.project) {
            const proj = this.data.projects.find((p) => p.id === item.project);
            if (proj) {
                projectFolder = `${baseFolder}/${proj.name}`;
            }
        }

        await this.ensureFolderExists(projectFolder);

        const destFolder = this.app.vault.getAbstractFileByPath(projectFolder);
        if (destFolder) {
            const newPath = `${projectFolder}/${taskFile.name}`;
            if (taskFile.path !== newPath) {
                try {
                    let uniquePath = newPath;
                    let counter = 1;
                    const baseName = taskFile.basename;
                    while (this.app.vault.getAbstractFileByPath(uniquePath)) {
                        uniquePath = `${projectFolder}/${baseName} ${counter}.md`;
                        counter++;
                    }
                    await this.app.fileManager.renameFile(taskFile, uniquePath);
                    const actualFileName = uniquePath.split("/").pop()?.replace(/\.md$/, "") ?? taskFile.basename;
                    item.content = `[[${actualFileName}]]`;
                } catch (e) {
                    console.error("Failed to move task file", e);
                }
            }
        }
    }

    private async updateLinkedTaskFileMetadata(item: KanbanItem): Promise<void> {
        if (!this.plugin.settings.createTaskFiles) return;

        const match = item.content.trim().match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
        if (!match || !match[1]) return;

        const linkPath = match[1].trim();
        const taskFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, this.file?.path ?? "");
        if (!taskFile) return;

        try {
            await this.app.fileManager.processFrontMatter(taskFile, (frontmatter) => {
                if (item.priority) {
                    frontmatter["priority"] = item.priority;
                } else {
                    delete frontmatter["priority"];
                }

                if (item.project) {
                    const proj = this.data.projects.find((p) => p.id === item.project);
                    frontmatter["project"] = proj ? proj.name : item.project;
                } else {
                    delete frontmatter["project"];
                }
            });
        } catch (e) {
            console.error("Failed to update task file frontmatter", e);
        }
    }

    private async addItem(columnId: string, content: string): Promise<void> {
        const column = this.data.columns.find((c) => c.id === columnId);
        if (!column) return;

        this.pushHistoryState();

        // Auto-assign project if exactly one project is selected in the project filters
        let assignedProject: string | undefined = undefined;
        if (this.filterProjects.length === 1) {
            assignedProject = this.filterProjects[0];
        }

        let finalContent = content;
        if (this.plugin.settings.createTaskFiles) {
            const safeName = content.replace(/[\\/:*?"<>|]/g, "").trim();
            if (safeName) {
                const baseFolder = this.plugin.settings.baseProjectsFolder.trim() || "Kanban Projects";
                let folderPath = baseFolder;
                if (assignedProject && this.plugin.settings.createFolderForProjects) {
                    const proj = this.data.projects.find((p) => p.id === assignedProject);
                    if (proj) {
                        folderPath = `${baseFolder}/${proj.name}`;
                    }
                }

                await this.ensureFolderExists(folderPath);

                const fullPath = `${folderPath}/${safeName}.md`;
                let uniquePath = fullPath;
                let counter = 1;
                while (this.app.vault.getAbstractFileByPath(uniquePath)) {
                    uniquePath = `${folderPath}/${safeName} ${counter}.md`;
                    counter++;
                }

                try {
                    let fmString = "---\npriority: low\n";
                    if (assignedProject) {
                        const proj = this.data.projects.find((p) => p.id === assignedProject);
                        fmString += `project: ${proj ? proj.name : assignedProject}\n`;
                    }
                    fmString += "---\n";
                    const fileContent = `${fmString}# ${safeName}\n\n`;
                    await this.app.vault.create(uniquePath, fileContent);
                    const actualFileName = uniquePath.split("/").pop()?.replace(/\.md$/, "") ?? safeName;
                    finalContent = `[[${actualFileName}]]`;
                } catch (e) {
                    console.error("Failed to create task file", e);
                }
            }
        }

        column.items.push({
            id: Math.random().toString(36).substring(2, 10),
            content: finalContent,
            tags: [],
            project: assignedProject,
            priority: "low",
            createdAt: Date.now(),
        });
        this.debouncedSave();
        void this.render();
    }

    private addColumn(): void {
        this.pushHistoryState();
        const name = `Column ${this.data.columns.length + 1}`;
        this.data.columns.push({
            id: name.toLowerCase().replace(/\s+/g, "-"),
            name,
            items: [],
        });
        this.debouncedSave();
        void this.render();
    }

    private deleteColumn(columnId: string): void {
        const column = this.data.columns.find((c) => c.id === columnId);
        if (!column) return;

        const confirmDelete = confirm(
            `Are you sure you want to delete the column "${column.name}" and all of its ${column.items.length} items? This action can be undone using Ctrl+Z.`
        );
        if (!confirmDelete) return;

        this.pushHistoryState();
        this.data.columns = this.data.columns.filter((c) => c.id !== columnId);
        this.debouncedSave();
        void this.render();
    }

    private toggleColumnCollapse(columnId: string): void {
        if (!this.data.collapsedColumnIds) {
            this.data.collapsedColumnIds = [];
        }
        if (this.data.collapsedColumnIds.includes(columnId)) {
            this.data.collapsedColumnIds = this.data.collapsedColumnIds.filter((id) => id !== columnId);
        } else {
            this.data.collapsedColumnIds.push(columnId);
        }
        this.debouncedSave();
        void this.render();
    }

    private debouncedSave(): void {
        if (this.saveTimeout) {
            window.clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = window.setTimeout(() => {
            void this.save();
        }, 300);
    }

    private async save(): Promise<void> {
        if (!this.file) return;
        const markdown = serializeMarkdown(this.data);
        await this.app.vault.modify(this.file, markdown);
    }

    private async switchToMarkdown(): Promise<void> {
        if (!this.file) return;
        // Set a flag so the file-open handler in main.ts skips the
        // auto-redirect back to kanban for this one open.
        (this.leaf as WorkspaceLeaf & Record<string, unknown>)["_suppressKanbanRedirect"] = true;
        await this.leaf.openFile(this.file);
    }

    private startInlineEdit(
        displayEl: HTMLElement,
        currentValue: string,
        onSave: (newValue: string) => void
    ): void {
        const input = document.createElement("input");
        input.type = "text";
        input.value = currentValue;
        input.className = "kanban-inline-edit";
        displayEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;

        const commit = () => {
            if (committed) return;
            committed = true;
            const newValue = input.value.trim();
            if (newValue && newValue !== currentValue) {
                onSave(newValue);
            } else {
                void this.render();
            }
        };

        input.addEventListener("blur", () => commit());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                commit();
            } else if (e.key === "Escape") {
                committed = true;
                void this.render();
            }
        });
    }

    /**
     * Returns the index at which a dragged item should be inserted into
     * `itemsEl`, based on the current pointer Y coordinate.
     */
    private getDropIndex(itemsEl: HTMLElement, clientY: number): number {
        const cards = Array.from(
            itemsEl.querySelectorAll<HTMLElement>(".kanban-item:not(.kanban-item-dragging)")
        );
        for (let i = 0; i < cards.length; i++) {
            const rect = cards[i]!.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                return i;
            }
        }
        return cards.length;
    }

    /**
     * Renders (or repositions) the blue drop-indicator line inside `itemsEl`
     * based on the current pointer Y position.
     */
    private updateDropIndicator(itemsEl: HTMLElement, clientY: number): void {
        // Remove existing indicators in this container
        itemsEl.querySelectorAll(".kanban-drop-indicator").forEach((el) => el.remove());

        const cards = Array.from(
            itemsEl.querySelectorAll<HTMLElement>(".kanban-item:not(.kanban-item-dragging)")
        );

        const indicator = document.createElement("div");
        indicator.className = "kanban-drop-indicator";

        for (let i = 0; i < cards.length; i++) {
            const rect = cards[i]!.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                // Insert before this card
                itemsEl.insertBefore(indicator, cards[i]!);
                return;
            }
        }
        // Append after all cards
        itemsEl.appendChild(indicator);
    }

    private getDropTargetItemId(itemsEl: HTMLElement, clientY: number): string | null {
        const cards = Array.from(
            itemsEl.querySelectorAll<HTMLElement>(".kanban-item:not(.kanban-item-dragging)")
        );
        for (let i = 0; i < cards.length; i++) {
            const rect = cards[i]!.getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) {
                return cards[i]!.getAttr("data-item-id");
            }
        }
        return null;
    }

    private renderFilterBar(parent: HTMLElement): void {
        parent.querySelector(".kanban-filter-bar")?.remove();

        const filterBar = parent.createDiv("kanban-filter-bar");

        // Search icon and input
        const searchWrap = filterBar.createDiv("kanban-filter-search-wrap");
        const searchIcon = searchWrap.createSpan("kanban-filter-search-icon");
        setIcon(searchIcon, "search");

        const searchInput = searchWrap.createEl("input", {
            type: "text",
            placeholder: "Filter tasks...",
            cls: "kanban-filter-search-input",
        });
        searchInput.value = this.filterSearch;
        searchInput.addEventListener("input", () => {
            this.filterSearch = searchInput.value;
            this.updateActiveFilterPills();
            this.renderColumns();
        });

        // Filters group (Tags, Projects, Views)
        const filtersGroup = filterBar.createDiv("kanban-filter-group");

        // Tags filter button
        const tagsBtn = filtersGroup.createEl("button", {
            cls: "kanban-filter-btn",
        });
        setIcon(tagsBtn, "tag");
        tagsBtn.createSpan({ text: "Tags" });
        tagsBtn.addEventListener("click", (e) => this.showTagsFilterPicker(e, tagsBtn));

        // Projects filter button
        const projsBtn = filtersGroup.createEl("button", {
            cls: "kanban-filter-btn",
        });
        setIcon(projsBtn, "folder");
        projsBtn.createSpan({ text: "Projects" });
        projsBtn.addEventListener("click", (e) => this.showProjectsFilterPicker(e, projsBtn));

        // Priority filter button
        const prioBtn = filtersGroup.createEl("button", {
            cls: "kanban-filter-btn",
        });
        setIcon(prioBtn, "flag");
        prioBtn.createSpan({ text: "Priority" });
        prioBtn.addEventListener("click", (e) => this.showPrioritiesFilterPicker(e, prioBtn));

        // Views dropdown (for custom views)
        const viewsBtn = filtersGroup.createEl("button", {
            cls: "kanban-filter-btn kanban-views-btn",
        });
        setIcon(viewsBtn, "eye");
        viewsBtn.createSpan({ text: this.activeCustomViewId ? `View: ${this.getActiveCustomViewName()}` : "Views" });
        viewsBtn.addEventListener("click", (e) => this.showCustomViewsMenu(e, viewsBtn));

        // Active filter pills row
        this.pillsContainer = filterBar.createDiv("kanban-filter-pills");
        this.updateActiveFilterPills();
    }

    private updateActiveFilterPills(): void {
        if (!this.pillsContainer) return;
        this.pillsContainer.empty();

        const hasFilters = this.filterSearch || 
                           this.filterTags.length > 0 || 
                           this.filterProjects.length > 0 || 
                           this.filterPriorities.length > 0;

        if (!hasFilters) {
            return;
        }

        // Active Search Pill
        if (this.filterSearch) {
            const pill = this.pillsContainer.createSpan({ cls: "kanban-filter-pill" });
            pill.createSpan({ text: `Search: "${this.filterSearch}"`, cls: "kanban-filter-pill-text" });
            const remove = pill.createSpan({ cls: "kanban-filter-pill-remove" });
            setIcon(remove, "x");
            remove.addEventListener("click", () => {
                this.filterSearch = "";
                const input = this.contentEl.querySelector(".kanban-filter-search-input") as HTMLInputElement;
                if (input) input.value = "";
                this.updateActiveFilterPills();
                this.renderColumns();
            });
        }

        // Active Tag Pills
        for (const tagId of this.filterTags) {
            const tag = this.data.tags.find((t) => t.id === tagId);
            if (tag) {
                const pill = this.pillsContainer.createSpan({ cls: "kanban-filter-pill" });
                const swatch = pill.createSpan({ cls: "kanban-tag-swatch" });
                swatch.style.backgroundColor = tag.color;
                pill.createSpan({ text: `Tag: ${tag.name}`, cls: "kanban-filter-pill-text" });
                const remove = pill.createSpan({ cls: "kanban-filter-pill-remove" });
                setIcon(remove, "x");
                remove.addEventListener("click", () => {
                    this.filterTags = this.filterTags.filter((t) => t !== tagId);
                    this.updateActiveFilterPills();
                    this.renderColumns();
                });
            }
        }

        // Active Project Pills
        for (const projId of this.filterProjects) {
            const proj = this.data.projects.find((p) => p.id === projId);
            if (proj) {
                const pill = this.pillsContainer.createSpan({ cls: "kanban-filter-pill" });
                const swatch = pill.createSpan({ cls: "kanban-tag-swatch" });
                swatch.style.backgroundColor = proj.color;
                pill.createSpan({ text: `Proj: ${proj.name}`, cls: "kanban-filter-pill-text" });
                const remove = pill.createSpan({ cls: "kanban-filter-pill-remove" });
                setIcon(remove, "x");
                remove.addEventListener("click", () => {
                    this.filterProjects = this.filterProjects.filter((p) => p !== projId);
                    this.updateActiveFilterPills();
                    this.renderColumns();
                });
            }
        }

        // Active Priority Pills
        for (const p of this.filterPriorities) {
            const pill = this.pillsContainer.createSpan({ cls: "kanban-filter-pill" });
            const colorMap: Record<string, string> = {
                low: "var(--text-muted)",
                medium: "#e8590c",
                high: "#e03131",
                urgent: "#c92a2a"
            };
            const swatch = pill.createSpan({ cls: "kanban-tag-swatch" });
            swatch.style.backgroundColor = colorMap[p] || "#888888";
            pill.createSpan({ text: `Priority: ${p.charAt(0).toUpperCase() + p.slice(1)}`, cls: "kanban-filter-pill-text" });
            const remove = pill.createSpan({ cls: "kanban-filter-pill-remove" });
            setIcon(remove, "x");
            remove.addEventListener("click", () => {
                this.filterPriorities = this.filterPriorities.filter((item) => item !== p);
                this.updateActiveFilterPills();
                this.renderColumns();
            });
        }

        // Save view option
        const saveViewBtn = this.pillsContainer.createEl("button", {
            text: "+ Save as view",
            cls: "kanban-filter-save-view-btn",
        });
        saveViewBtn.addEventListener("click", () => this.promptSaveCustomView());

        // Clear all trigger
        const clearBtn = this.pillsContainer.createEl("button", {
            text: "Clear all",
            cls: "kanban-filter-clear-btn",
        });
        clearBtn.addEventListener("click", () => {
            this.filterSearch = "";
            this.filterTags = [];
            this.filterProjects = [];
            this.filterPriorities = [];
            this.activeCustomViewId = null;
            const input = this.contentEl.querySelector(".kanban-filter-search-input") as HTMLInputElement;
            if (input) input.value = "";

            const viewsBtnSpan = this.contentEl.querySelector(".kanban-views-btn span") as HTMLSpanElement;
            if (viewsBtnSpan) viewsBtnSpan.textContent = "Views";

            this.updateActiveFilterPills();
            this.renderColumns();
        });
    }

    private promptSaveCustomView(): void {
        if (!this.pillsContainer) return;

        this.pillsContainer.querySelector(".kanban-filter-save-form")?.remove();

        const form = this.pillsContainer.createDiv("kanban-filter-save-form");
        const input = form.createEl("input", {
            type: "text",
            placeholder: "View name...",
            cls: "kanban-filter-save-input",
        });

        const saveBtn = form.createEl("button", {
            text: "Save",
            cls: "kanban-filter-save-confirm-btn",
        });

        const cancelBtn = form.createEl("button", {
            text: "Cancel",
            cls: "kanban-filter-save-cancel-btn",
        });

        input.focus();

        const submit = () => {
            const name = input.value.trim();
            if (!name) return;

            const newView: KanbanCustomView = {
                id: Math.random().toString(36).substring(2, 10),
                name,
                searchQuery: this.filterSearch,
                tags: [...this.filterTags],
                projects: [...this.filterProjects],
            };

            if (!this.data.customViews) {
                this.data.customViews = [];
            }
            this.data.customViews.push(newView);
            this.activeCustomViewId = newView.id;

            this.debouncedSave();
            form.remove();

            const viewsBtnSpan = this.contentEl.querySelector(".kanban-views-btn span") as HTMLSpanElement;
            if (viewsBtnSpan) viewsBtnSpan.textContent = `View: ${name}`;

            this.updateActiveFilterPills();
        };

        saveBtn.addEventListener("click", submit);
        cancelBtn.addEventListener("click", () => form.remove());
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                submit();
            } else if (e.key === "Escape") {
                form.remove();
            }
        });
    }

    private showTagsFilterPicker(event: MouseEvent, buttonEl: HTMLElement): void {
        document.querySelector(".kanban-filter-dropdown")?.remove();

        const dropdown = document.body.createDiv("kanban-filter-dropdown");
        dropdown.createDiv({ text: "Filter by Tags", cls: "kanban-dropdown-title" });

        const list = dropdown.createDiv("kanban-dropdown-list");

        for (const tag of this.data.tags) {
            const item = list.createDiv("kanban-dropdown-item");
            const checkbox = item.createEl("input", {
                type: "checkbox",
                cls: "kanban-dropdown-checkbox",
            });
            checkbox.checked = this.filterTags.includes(tag.id);

            const swatch = item.createSpan("kanban-tag-swatch");
            swatch.style.backgroundColor = tag.color;

            item.createSpan({ text: tag.name });

            const toggle = () => {
                if (this.filterTags.includes(tag.id)) {
                    this.filterTags = this.filterTags.filter((t) => t !== tag.id);
                } else {
                    this.filterTags.push(tag.id);
                }
                checkbox.checked = this.filterTags.includes(tag.id);
                this.updateActiveFilterPills();
                this.renderColumns();
            };

            item.addEventListener("click", (e) => {
                if (e.target !== checkbox) {
                    toggle();
                }
            });
            checkbox.addEventListener("change", () => {
                toggle();
            });
        }

        if (this.data.tags.length === 0) {
            list.createDiv({ text: "No tags available", cls: "kanban-dropdown-empty" });
        }

        const rect = buttonEl.getBoundingClientRect();
        dropdown.style.position = "fixed";
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.left = `${rect.left}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!dropdown.contains(e.target as Node) && !buttonEl.contains(e.target as Node)) {
                dropdown.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);
    }

    private showProjectsFilterPicker(event: MouseEvent, buttonEl: HTMLElement): void {
        document.querySelector(".kanban-filter-dropdown")?.remove();

        const dropdown = document.body.createDiv("kanban-filter-dropdown");
        dropdown.createDiv({ text: "Filter by Projects", cls: "kanban-dropdown-title" });

        const list = dropdown.createDiv("kanban-dropdown-list");

        for (const proj of this.data.projects) {
            const item = list.createDiv("kanban-dropdown-item");
            const checkbox = item.createEl("input", {
                type: "checkbox",
                cls: "kanban-dropdown-checkbox",
            });
            checkbox.checked = this.filterProjects.includes(proj.id);

            const swatch = item.createSpan("kanban-tag-swatch");
            swatch.style.backgroundColor = proj.color;

            item.createSpan({ text: proj.name });

            const toggle = () => {
                if (this.filterProjects.includes(proj.id)) {
                    this.filterProjects = this.filterProjects.filter((p) => p !== proj.id);
                } else {
                    this.filterProjects.push(proj.id);
                }
                checkbox.checked = this.filterProjects.includes(proj.id);
                this.updateActiveFilterPills();
                this.renderColumns();
            };

            item.addEventListener("click", (e) => {
                if (e.target !== checkbox) {
                    toggle();
                }
            });
            checkbox.addEventListener("change", () => {
                toggle();
            });
        }

        if (this.data.projects.length === 0) {
            list.createDiv({ text: "No projects available", cls: "kanban-dropdown-empty" });
        }

        const rect = buttonEl.getBoundingClientRect();
        dropdown.style.position = "fixed";
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.left = `${rect.left}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!dropdown.contains(e.target as Node) && !buttonEl.contains(e.target as Node)) {
                dropdown.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);
    }

    private showPrioritiesFilterPicker(event: MouseEvent, buttonEl: HTMLElement): void {
        document.querySelector(".kanban-filter-dropdown")?.remove();

        const dropdown = document.body.createDiv("kanban-filter-dropdown");
        dropdown.createDiv({ text: "Filter by Priorities", cls: "kanban-dropdown-title" });

        const list = dropdown.createDiv("kanban-dropdown-list");

        const priorities: ("low" | "medium" | "high" | "urgent")[] = ["low", "medium", "high", "urgent"];
        const colorMap: Record<string, string> = {
            low: "var(--text-muted)",
            medium: "#e8590c",
            high: "#e03131",
            urgent: "#c92a2a"
        };

        for (const p of priorities) {
            const item = list.createDiv("kanban-dropdown-item");
            const checkbox = item.createEl("input", {
                type: "checkbox",
                cls: "kanban-dropdown-checkbox",
            });
            checkbox.checked = this.filterPriorities.includes(p);

            const swatch = item.createSpan("kanban-tag-swatch");
            swatch.style.backgroundColor = colorMap[p] || "#888888";

            item.createSpan({ text: p.charAt(0).toUpperCase() + p.slice(1) });

            const toggle = () => {
                if (this.filterPriorities.includes(p)) {
                    this.filterPriorities = this.filterPriorities.filter((item) => item !== p);
                } else {
                    this.filterPriorities.push(p);
                }
                checkbox.checked = this.filterPriorities.includes(p);
                this.updateActiveFilterPills();
                this.renderColumns();
            };

            item.addEventListener("click", (e) => {
                if (e.target !== checkbox) {
                    toggle();
                }
            });
            checkbox.addEventListener("change", () => {
                toggle();
            });
        }

        const rect = buttonEl.getBoundingClientRect();
        dropdown.style.position = "fixed";
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.left = `${rect.left}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!dropdown.contains(e.target as Node) && !buttonEl.contains(e.target as Node)) {
                dropdown.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);
    }

    private showCustomViewsMenu(event: MouseEvent, buttonEl: HTMLElement): void {
        document.querySelector(".kanban-filter-dropdown")?.remove();

        const dropdown = document.body.createDiv("kanban-filter-dropdown");
        dropdown.createDiv({ text: "Saved Views", cls: "kanban-dropdown-title" });

        const list = dropdown.createDiv("kanban-dropdown-list");

        const customViews = this.data.customViews || [];

        for (const view of customViews) {
            const item = list.createDiv("kanban-dropdown-item kanban-view-item");
            if (this.activeCustomViewId === view.id) {
                item.addClass("is-selected");
            }

            const label = item.createSpan({ text: view.name, cls: "kanban-view-item-label" });

            label.addEventListener("click", () => {
                this.activeCustomViewId = view.id;
                this.filterSearch = view.searchQuery;
                this.filterTags = [...view.tags];
                this.filterProjects = [...view.projects];

                const input = this.contentEl.querySelector(".kanban-filter-search-input") as HTMLInputElement;
                if (input) input.value = this.filterSearch;

                const labelSpan = buttonEl.querySelector("span") as HTMLSpanElement;
                if (labelSpan) labelSpan.textContent = `View: ${view.name}`;

                this.updateActiveFilterPills();
                this.renderColumns();
                dropdown.remove();
            });

            const deleteBtn = item.createSpan({ cls: "kanban-view-item-delete clickable-icon" });
            setIcon(deleteBtn, "trash-2");
            deleteBtn.addEventListener("click", (e) => {
                e.stopPropagation();

                this.data.customViews = this.data.customViews?.filter((v) => v.id !== view.id) || [];
                if (this.activeCustomViewId === view.id) {
                    this.activeCustomViewId = null;
                    this.filterSearch = "";
                    this.filterTags = [];
                    this.filterProjects = [];

                    const input = this.contentEl.querySelector(".kanban-filter-search-input") as HTMLInputElement;
                    if (input) input.value = "";

                    const labelSpan = buttonEl.querySelector("span") as HTMLSpanElement;
                    if (labelSpan) labelSpan.textContent = "Views";

                    this.updateActiveFilterPills();
                    this.renderColumns();
                }

                this.debouncedSave();
                dropdown.remove();
            });
        }

        if (customViews.length === 0) {
            list.createDiv({ text: "No saved views", cls: "kanban-dropdown-empty" });
        }

        const rect = buttonEl.getBoundingClientRect();
        dropdown.style.position = "fixed";
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.left = `${rect.left}px`;

        const closeHandler = (e: MouseEvent) => {
            if (!dropdown.contains(e.target as Node) && !buttonEl.contains(e.target as Node)) {
                dropdown.remove();
                document.removeEventListener("click", closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", closeHandler);
        }, 0);
    }

    private getActiveCustomViewName(): string {
        if (!this.activeCustomViewId || !this.data.customViews) return "";
        const view = this.data.customViews.find((v) => v.id === this.activeCustomViewId);
        return view ? view.name : "";
    }

    private randomTagColor(): string {
        const colors = [
            "#ff6b6b", "#f06595", "#cc5de8", "#845ef7",
            "#5c7cfa", "#339af0", "#22b8cf", "#20c997",
            "#51cf66", "#94d82d", "#fcc419", "#ff922b",
        ];
        return colors[Math.floor(Math.random() * colors.length)]!;
    }
}