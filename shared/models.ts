import type { ReasoningEffortOption } from "./chat";

export function parseModelList(data: unknown): string[] {
  let rawList: unknown[] = [];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) rawList = obj.data;
    else if (Array.isArray(obj.models)) rawList = obj.models;
    else if (Array.isArray(obj.model_list)) rawList = obj.model_list;
    else if (Array.isArray(obj.items)) rawList = obj.items;
  }
  const result: string[] = [];
  for (const item of rawList) {
    if (typeof item === "string" && item.trim()) {
      result.push(item.trim());
    } else if (item && typeof item === "object") {
      const entry = item as Record<string, unknown>;
      const id = entry.id ?? entry.name ?? entry.model;
      if (typeof id === "string" && id.trim()) {
        result.push(id.trim());
      }
    }
  }
  return Array.from(new Set(result));
}

export interface AISettings {
  baseUrl: string;
  apiKey: string;
  rememberApiKey: boolean;
  model: string;
  reasoningEffort: "" | ReasoningEffortOption;
  customModelsUrl: string;
  models: string[];
}
