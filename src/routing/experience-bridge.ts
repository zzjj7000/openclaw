import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

export interface ExperienceRecord {
  modelId: string;
  category: string;
  successCount: number;
  totalTokens: number;
  lastUsed: string;
}

export class ExperienceBridge {
  private static storagePath = path.join(CONFIG_DIR, "routing-experience.json");

  /**
   * 记录一次路由体验
   */
  public static async recordOutcome(modelId: string, category: string, tokens: number) {
    const data = await this.loadAll();
    const key = `${modelId}:${category}`;
    
    if (!data[key]) {
      data[key] = { modelId, category, successCount: 0, totalTokens: 0, lastUsed: "" };
    }
    
    data[key].successCount += 1;
    data[key].totalTokens += tokens;
    data[key].lastUsed = new Date().toISOString();
    
    await fs.writeFile(this.storagePath, JSON.stringify(data, null, 2));
  }

  /**
   * 获取某类任务的最佳模型建议
   */
  public static async getBestModel(category: string): Promise<string | null> {
    const data = await this.loadAll();
    let bestModel: string | null = null;
    let maxSuccess = -1;

    for (const key in data) {
      if (data[key].category === category && data[key].successCount > maxSuccess) {
        maxSuccess = data[key].successCount;
        bestModel = data[key].modelId;
      }
    }
    return bestModel;
  }

  private static async loadAll(): Promise<Record<string, ExperienceRecord>> {
    try {
      const content = await fs.readFile(this.storagePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }
}
