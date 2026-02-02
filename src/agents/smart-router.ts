import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";
import { modelExperience, ModelExperienceEngine } from "./model-experience.js";

const USAGE_STATS_FILE = "usage-stats.json";
const GEMINI_PRO_LIMIT = 240; // Adjusted based on 250 limit

interface ModelUsage {
    requests: number;
    inputTokens: number;
    outputTokens: number;
}

interface UsageStats {
    date: string;
    models: Record<string, ModelUsage>;
}

export class SmartRouter {
    private experience: ModelExperienceEngine;
    private usageFilePath: string;

    constructor() {
        this.experience = modelExperience;
        this.usageFilePath = path.join(CONFIG_DIR, USAGE_STATS_FILE);
    }

    private getTodayDate(): string {
        return new Date().toISOString().split("T")[0];
    }

    private loadUsage(): UsageStats {
        const today = this.getTodayDate();
        let data: UsageStats = { date: today, models: {} };

        if (fs.existsSync(this.usageFilePath)) {
            try {
                const content = JSON.parse(fs.readFileSync(this.usageFilePath, "utf-8"));
                if (content.date === today) {
                    // Compatible with old simple number format
                    if (content.models) {
                        for (const key in content.models) {
                            if (typeof content.models[key] === 'number') {
                                content.models[key] = { requests: content.models[key], inputTokens: 0, outputTokens: 0 };
                            }
                        }
                    }
                    data = content;
                }
            } catch (e) {
                console.warn("Failed to load usage stats, resetting.");
            }
        }
        return data;
    }

    private saveUsage(data: UsageStats) {
        try {
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true });
            }
            fs.writeFileSync(this.usageFilePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error("Failed to save usage stats:", e);
        }
    }

    public incrementUsage(modelId: string, inputTokens: number = 0, outputTokens: number = 0) {
        const stats = this.loadUsage();
        if (!stats.models[modelId]) {
            stats.models[modelId] = { requests: 0, inputTokens: 0, outputTokens: 0 };
        }
        stats.models[modelId].requests += 1;
        stats.models[modelId].inputTokens += inputTokens;
        stats.models[modelId].outputTokens += outputTokens;
        this.saveUsage(stats);
    }

    public getUsage(modelId: string): ModelUsage {
        const stats = this.loadUsage();
        return stats.models[modelId] || { requests: 0, inputTokens: 0, outputTokens: 0 };
    }

    public shouldConservePro(): boolean {
        const usage = this.getUsage("google/gemini-3-pro-preview");
        return usage.requests >= GEMINI_PRO_LIMIT;
    }

    public cleanupPrompt(prompt: string): string {
        const lower = prompt.trim().toLowerCase();
        const prefixes = [
            "!kimi", "kimi:", "kimi：",
            "!flash", "flash:", "flash：",
            "!pro", "pro:", "pro：",
            "!deepseek", "deepseek:", "deepseek：",
            "!gemini", "gemini:", "gemini："
        ];

        for (const prefix of prefixes) {
            if (lower.startsWith(prefix)) {
                let cleaned = prompt.trim().slice(prefix.length);
                cleaned = cleaned.replace(/^[:：\s]+/, "");
                return cleaned.trim();
            }
        }
        return prompt;
    }

    public selectModel(taskDescription: string, defaultModelId?: string): string {
        const lowerTask = taskDescription.toLowerCase();

        if (lowerTask.startsWith("!kimi") || lowerTask.startsWith("kimi:") || lowerTask.startsWith("kimi：")) {
            return "moonshot/kimi-k2-thinking";
        }
        if (lowerTask.startsWith("!flash") || lowerTask.startsWith("flash:") || lowerTask.startsWith("flash：")) {
            return "google/gemini-3-flash-preview";
        }
        if (lowerTask.startsWith("!pro") || lowerTask.startsWith("pro:") || lowerTask.startsWith("pro：")) {
            return "google/gemini-3-pro-preview";
        }
        if (lowerTask.startsWith("!deepseek") || lowerTask.startsWith("deepseek:") || lowerTask.startsWith("deepseek：")) {
            return "deepseek/deepseek-chat";
        }

        const category = this.experience.detectCategory(taskDescription);
        const conservePro = this.shouldConservePro();

        let championId: string | undefined;
        let maxScore = -1;

        const allModels = this.experience.getAllModels();
        for (const model of allModels) {
            if (model.totalUses > 5) {
                const score = model.scores[category] || 0;
                if (score > maxScore && score >= 80) {
                    maxScore = score;
                    championId = model.id;
                }
            }
        }

        if (championId) {
            if (championId === "google/gemini-3-pro-preview" && conservePro) {
                // Fallthrough
            } else {
                return championId;
            }
        }

        if (category === "architecture" || category === "creative") {
            const proUsage = this.getUsage("google/gemini-3-pro-preview");
            if (proUsage.requests < 250) {
                return "google/gemini-3-pro-preview";
            }
        }

        if (category === "backend" || category === "debugging" || category === "coding") {
            return "moonshot/kimi-k2-thinking";
        }

        if (category === "frontend") {
            return "moonshot/kimi-k2.5";
        }

        if (category === "general" || lowerTask.includes("simple") || lowerTask.includes("translate") || lowerTask.includes("weather")) {
            return "google/gemini-3-flash-preview";
        }

        return "google/gemini-3-flash-preview";
    }
}

export const smartRouter = new SmartRouter();
