import { App, PluginSettingTab, Setting } from "obsidian";
import type TimizuoKanbanPlugin from "./main";

export interface KanbanSettings {
    defaultView: "kanban" | "markdown";
}

export const DEFAULT_SETTINGS: KanbanSettings = {
    defaultView: "kanban",
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
    }
}