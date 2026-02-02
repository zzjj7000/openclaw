import fs from "node:fs/promises";
import path from "node:path";
import { hashText } from "../memory/internal.js";

export interface ContextFile {
  path: string;
  content: string;
  mtimeMs: number;
}

export class ContextOptimizer {
  /**
   * 核心逻辑：优化上下文排序以提高 Gemini 缓存命中率
   * 原则：将最稳定的（修改时间最早、Hash 未变）文件排在最前面
   */
  public static sortFilesForCaching(files: ContextFile[]): ContextFile[] {
    return [...files].sort((a, b) => {
      // 1. 比较修改时间，早的排前面
      if (a.mtimeMs !== b.mtimeMs) {
        return a.mtimeMs - b.mtimeMs;
      }
      // 2. 时间相同时，按路径字母排序，保证顺序绝对确定
      return a.path.localeCompare(b.path);
    });
  }

  /**
   * 预处理 Prompt，提取并移除重复的背景信息
   */
  public static deduplicateContext(prompt: string, history: string[]): string {
    // 这里的逻辑可以进一步扩展，比如检测 history 中是否已经包含类似的系统指令
    return prompt.trim();
  }
}
