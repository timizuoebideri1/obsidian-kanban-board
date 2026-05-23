import { App, PluginSettingTab, Setting } from "obsidian";
import type TimizuoKanbanPlugin from "./main";

export interface KanbanSettings {
    defaultView: "kanban" | "markdown";
    createFolderForProjects: boolean;
    createTaskFiles: boolean;
    baseProjectsFolder: string;
}

export const DEFAULT_SETTINGS: KanbanSettings = {
    defaultView: "kanban",
    createFolderForProjects: false,
    createTaskFiles: false,
    baseProjectsFolder: "Kanban Projects",
};

export class KanbanSettingTab extends PluginSettingTab {
    plugin: TimizuoKanbanPlugin;

    constructor(app: App, plugin: TimizuoKanbanPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Kanban Board Settings" });

        new Setting(containerEl)
            .setName("Default view")
            .setDesc("How to open kanban markdown files by default")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("kanban", "Kanban")
                    .addOption("markdown", "Markdown")
                    .setValue(this.plugin.settings.defaultView)
                    .onChange(async (value) => {
                        this.plugin.settings.defaultView = value as "kanban" | "markdown";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Create folder for projects")
            .setDesc("Automatically create a folder for new projects and place/move linked task files there")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.createFolderForProjects)
                    .onChange(async (value) => {
                        this.plugin.settings.createFolderForProjects = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Create file for tasks")
            .setDesc("Automatically create a markdown file for each new task and link to it")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.createTaskFiles)
                    .onChange(async (value) => {
                        this.plugin.settings.createTaskFiles = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Projects base folder")
            .setDesc("The base folder where all project folders and task files will be created")
            .addText((text) =>
                text
                    .setPlaceholder("Kanban Projects")
                    .setValue(this.plugin.settings.baseProjectsFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.baseProjectsFolder = value.trim() || "Kanban Projects";
                        await this.plugin.saveSettings();
                    })
            );
    }
}