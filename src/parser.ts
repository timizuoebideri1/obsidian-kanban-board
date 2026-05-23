import { parseYaml, stringifyYaml } from "obsidian";
import type { KanbanData, KanbanColumn, KanbanItem, KanbanTag, KanbanProject, KanbanCustomView } from "./types";

const FRONTMATTER_KEY = "kanban-plugin";
const TAGS_KEY = "kanban-tags";
const PROJECTS_KEY = "kanban-projects";
const VIEWS_KEY = "kanban-views";
const DONE_COLUMN_KEY = "done-column";
const COLLAPSED_COLUMNS_KEY = "collapsed-columns";

export function parseMarkdown(content: string): KanbanData {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let tags: KanbanTag[] = [];
    let projects: KanbanProject[] = [];
    let customViews: KanbanCustomView[] = [];
    let doneColumnId: string | null = null;
    let collapsedColumnIds: string[] = [];

    if (frontmatterMatch) {
        try {
            const fm = parseYaml(frontmatterMatch[1]!) as Record<string, unknown>;
            const rawTags = fm[TAGS_KEY];
            if (Array.isArray(rawTags)) {
                tags = rawTags.map((t: unknown) => {
                    const tag = t as Record<string, unknown>;
                    return {
                        id: String(tag["id"] ?? ""),
                        name: String(tag["name"] ?? tag["id"] ?? ""),
                        color: String(tag["color"] ?? "#888888"),
                    };
                });
            }
            const rawProjects = fm[PROJECTS_KEY];
            if (Array.isArray(rawProjects)) {
                projects = rawProjects.map((p: unknown) => {
                    const proj = p as Record<string, unknown>;
                    return {
                        id: String(proj["id"] ?? ""),
                        name: String(proj["name"] ?? proj["id"] ?? ""),
                        color: String(proj["color"] ?? "#5c7cfa"),
                    };
                });
            }
            const rawViews = fm[VIEWS_KEY];
            if (Array.isArray(rawViews)) {
                customViews = rawViews.map((v: unknown) => {
                    const view = v as Record<string, unknown>;
                    return {
                        id: String(view["id"] ?? ""),
                        name: String(view["name"] ?? ""),
                        searchQuery: String(view["searchQuery"] ?? ""),
                        tags: Array.isArray(view["tags"]) ? (view["tags"] as string[]).map(String) : [],
                        projects: Array.isArray(view["projects"]) ? (view["projects"] as string[]).map(String) : [],
                    };
                });
            }
            if (typeof fm[DONE_COLUMN_KEY] === "string") {
                doneColumnId = fm[DONE_COLUMN_KEY] as string;
            }
            const rawCollapsed = fm[COLLAPSED_COLUMNS_KEY];
            if (Array.isArray(rawCollapsed)) {
                collapsedColumnIds = rawCollapsed.map(String);
            } else if (typeof rawCollapsed === "string") {
                collapsedColumnIds = [rawCollapsed];
            }
        } catch {
            // Invalid frontmatter, proceed with defaults
        }
    }

    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    const columns = parseColumns(body, projects);

    return { columns, tags, projects, doneColumnId, customViews, collapsedColumnIds };
}

function parseColumns(body: string, projects: import("./types").KanbanProject[]): KanbanColumn[] {
    const columns: KanbanColumn[] = [];
    const lines = body.split("\n");
    let currentColumn: KanbanColumn | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const headingMatch = line.match(/^##\s+(.+)/);
        if (headingMatch) {
            const id = headingMatch[1]!.toLowerCase().replace(/\s+/g, "-");
            currentColumn = { id, name: headingMatch[1]!, items: [] };
            columns.push(currentColumn);
            continue;
        }

        const itemMatch = line.match(/^- \[(.)\] (.+)/);
        if (itemMatch && currentColumn) {
            const rawContent = itemMatch[2]!;
            const { content, tagIds, projectId, priority } = extractMetadata(rawContent, projects);
            let description: string | undefined;
            const descriptionLines: string[] = [];
            while (i + 1 < lines.length) {
                const nextLine = lines[i + 1]!;
                
                // 1. Check if it's a legacy HTML comment description
                const descMatch = nextLine.match(/^\s*<!--desc:(.*)-->\s*$/);
                if (descMatch) {
                    try {
                        descriptionLines.push(atob(descMatch[1]!.trim()));
                    } catch {
                        descriptionLines.push(descMatch[1]!.trim());
                    }
                    i++; // consume the legacy comment line
                    continue;
                }
                
                // 2. Check if the next line is a new column or a top-level item
                if (nextLine.match(/^##\s+/) || nextLine.match(/^- \[(.)\]/)) {
                    break;
                }
                
                // 3. Check if the next line has indentation (spaces or tabs)
                const indentMatch = nextLine.match(/^(\s+)(.*)$/);
                if (indentMatch) {
                    // Strip up to two spaces or one tab of indentation
                    const stripped = nextLine.replace(/^ {1,2}|^\t/, "");
                    descriptionLines.push(stripped);
                    i++; // consume the indented description line
                    continue;
                }
                
                break;
            }
            if (descriptionLines.length > 0) {
                description = descriptionLines.join("\n");
            }
            currentColumn.items.push({
                id: generateId(),
                content: content.trim(),
                description,
                tags: tagIds,
                project: projectId,
                priority,
                createdAt: Date.now(),
            });
        }
    }

    return columns;
}

function extractMetadata(
    rawContent: string,
    projects: import("./types").KanbanProject[]
): { content: string; tagIds: string[]; projectId: string | undefined; priority: "low" | "medium" | "high" | "urgent" | undefined } {
    const tagIds: string[] = [];
    let projectId: string | undefined;
    let priority: "low" | "medium" | "high" | "urgent" | undefined = undefined;

    // Extract !priority token (case insensitive)
    const priorityRegex = /!(low|medium|high|urgent)\b/gi;
    const priorityMatch = priorityRegex.exec(rawContent);
    if (priorityMatch) {
        priority = priorityMatch[1]!.toLowerCase() as "low" | "medium" | "high" | "urgent";
    }

    // Strip !priority token from visible content
    let content = rawContent.replace(/!(low|medium|high|urgent)\b/gi, "");

    // Extract @project token (only the first match wins)
    const projectRegex = /@([\w-]+)/g;
    let projectMatch: RegExpExecArray | null;
    while ((projectMatch = projectRegex.exec(content)) !== null) {
        const candidate = projectMatch[1]!;
        if (projects.some((p) => p.id === candidate)) {
            projectId = candidate;
            break;
        }
    }

    // Strip @project tokens from visible content
    content = content.replace(/@[\w-]+/g, "");

    // Extract #tag tokens
    const tagRegex = /#([\w-]+)/g;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = tagRegex.exec(content)) !== null) {
        const tagId = match[1]!;
        if (!seen.has(tagId)) {
            tagIds.push(tagId);
            seen.add(tagId);
        }
    }
    content = content.replace(tagRegex, "").trim();

    return { content, tagIds, projectId, priority };
}

export function serializeMarkdown(data: KanbanData): string {
    const frontmatter: Record<string, unknown> = {};
    frontmatter[FRONTMATTER_KEY] = "basic";

    if (data.tags.length > 0) {
        frontmatter[TAGS_KEY] = data.tags.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
        }));
    }

    if (data.projects.length > 0) {
        frontmatter[PROJECTS_KEY] = data.projects.map((p) => ({
            id: p.id,
            name: p.name,
            color: p.color,
        }));
    }

    if (data.doneColumnId) {
        frontmatter[DONE_COLUMN_KEY] = data.doneColumnId;
    }

    if (data.collapsedColumnIds && data.collapsedColumnIds.length > 0) {
        frontmatter[COLLAPSED_COLUMNS_KEY] = data.collapsedColumnIds;
    }

    if (data.customViews && data.customViews.length > 0) {
        frontmatter[VIEWS_KEY] = data.customViews.map((v) => ({
            id: v.id,
            name: v.name,
            searchQuery: v.searchQuery,
            tags: v.tags,
            projects: v.projects,
        }));
    }

    const yaml = stringifyYaml(frontmatter);
    let markdown = `---\n${yaml}---\n\n`;

    for (const column of data.columns) {
        markdown += `## ${column.name}\n`;
        for (const item of column.items) {
            const tagStr = item.tags.length > 0 ? " " + item.tags.map((t) => `#${t}`).join(" ") : "";
            const projStr = item.project ? ` @${item.project}` : "";
            const prioStr = item.priority ? ` !${item.priority}` : "";
            markdown += `- [ ] ${item.content}${tagStr}${projStr}${prioStr}\n`;
            if (item.description) {
                const indentedDesc = item.description
                    .split("\n")
                    .map((line) => `  ${line}`)
                    .join("\n");
                markdown += `${indentedDesc}\n`;
            }
        }
        markdown += "\n";
    }

    return markdown.trim() + "\n";
}

function generateId(): string {
    return Math.random().toString(36).substring(2, 10);
}