export interface KanbanTag {
    id: string;
    name: string;
    color: string;
}

export interface KanbanProject {
    id: string;
    name: string;
    color: string;
}

export interface KanbanItem {
    id: string;
    content: string;
    description?: string;
    tags: string[];
    project?: string; // project id
    priority?: "low" | "medium" | "high" | "urgent";
    createdAt: number;
}

export interface KanbanCustomView {
    id: string;
    name: string;
    searchQuery: string;
    tags: string[];
    projects: string[];
}

export interface KanbanColumn {
    id: string;
    name: string;
    items: KanbanItem[];
}

export interface KanbanData {
    columns: KanbanColumn[];
    tags: KanbanTag[];
    projects: KanbanProject[];
    doneColumnId: string | null;
    customViews?: KanbanCustomView[];
    collapsedColumnIds?: string[];
}