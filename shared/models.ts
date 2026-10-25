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
  // Image generation for generate_costume; empty means "pick an image model from the list".
  imageModel: string;
  imageQuality: "low" | "medium" | "high";
  // Text-to-speech for generate_speech; empty means disabled.
  speechModel: string;
  speechVoice: string;
  // 0 = no step limit.
  maxSteps: number;
}
// Best guess at an image model among the provider's models (e.g. gpt-image-2, *-image-*).
export function guessImageModel(models: string[]) {
  return models.find(m => /^gpt-image/i.test(m)) ?? models.find(m => /(^|[-_])image([-_]|$)|dall-?e|imagen|flux/i.test(m)) ?? "";
}
