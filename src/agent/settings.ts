import { parseModelList, type AISettings } from "../../shared/models";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "../../shared/provider";

const SETTINGS_KEY = "scratch_vibe_ai_settings";
const API_KEY = "scratch_vibe_api_key";
const legacyKeys = ["scratch_vibe_custom_model", "scratch_vibe_reasoning_effort", "scratch_vibe_models_url", "scratch_vibe_cached_models"];

export function defaultSettings(): AISettings {
  return {
    baseUrl: DEFAULT_BASE_URL, apiKey: "", rememberApiKey: false,
    model: DEFAULT_MODEL, reasoningEffort: "", customModelsUrl: "", models: [],
    imageModel: "", imageQuality: "medium", speechModel: "", speechVoice: "alloy", maxSteps: 0,
  };
}

export function loadSettings(): AISettings {
  const settings = defaultSettings();
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") as Partial<AISettings> | null;
    if (stored && typeof stored === "object") {
      for (const key of ["baseUrl", "model", "customModelsUrl", "imageModel", "speechModel", "speechVoice"] as const) {
        if (typeof stored[key] === "string") settings[key] = stored[key].slice(0, 2048);
      }
      if (["low", "medium", "high"].includes(stored.imageQuality ?? "")) settings.imageQuality = stored.imageQuality!;
      if (Number.isInteger(stored.maxSteps) && stored.maxSteps! >= 0 && stored.maxSteps! <= 500) settings.maxSteps = stored.maxSteps!;
      if (["low", "medium", "high"].includes(stored.reasoningEffort ?? "")) {
        settings.reasoningEffort = stored.reasoningEffort!;
      }
      settings.models = parseModelList(stored.models).filter(model => model.length <= 200);
    } else {
      // Keep existing non-secret preferences when upgrading from env-based setup.
      settings.model = localStorage.getItem(legacyKeys[0]) || settings.model;
      const effort = localStorage.getItem(legacyKeys[1]);
      if (effort === "low" || effort === "medium" || effort === "high") settings.reasoningEffort = effort;
      settings.customModelsUrl = localStorage.getItem(legacyKeys[2]) || "";
    }
    settings.apiKey = localStorage.getItem(API_KEY) || "";
    settings.rememberApiKey = Boolean(settings.apiKey);
  } catch { /* Settings remain usable when storage is unavailable or corrupt. */ }
  try {
    const sessionKey = sessionStorage.getItem(API_KEY);
    if (sessionKey) { settings.apiKey = sessionKey; settings.rememberApiKey = false; }
  } catch { /* Session storage may be disabled. */ }
  return settings;
}

export function saveSettings(settings: AISettings): boolean {
  try {
    // Remove old persisted credentials first, even if later writes fail.
    localStorage.removeItem(API_KEY);
    sessionStorage.removeItem(API_KEY);
    const { apiKey, rememberApiKey, ...preferences } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(preferences));
    if (apiKey) (rememberApiKey ? localStorage : sessionStorage).setItem(API_KEY, apiKey);
    legacyKeys.forEach(key => localStorage.removeItem(key));
    return true;
  } catch {
    return false;
  }
}
