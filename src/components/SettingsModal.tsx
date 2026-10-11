import { useEffect, useState } from "react";
import { fetchModelList } from "../agent/loop";
import type { ReasoningEffortOption } from "../../shared/chat";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverConfig: { configured: boolean; model: string; reasoningEffort?: string } | null;
  currentModel: string;
  currentReasoningEffort: "" | ReasoningEffortOption;
  customModelsUrl: string;
  onSave: (settings: {
    model: string;
    reasoningEffort: "" | ReasoningEffortOption;
    customModelsUrl: string;
  }) => void;
  onReset: () => void;
}

const CACHED_MODELS_KEY = "scratch_vibe_cached_models";

export function SettingsModal({
  isOpen,
  onClose,
  serverConfig,
  currentModel,
  currentReasoningEffort,
  customModelsUrl,
  onSave,
  onReset,
}: SettingsModalProps) {
  const [modelInput, setModelInput] = useState(currentModel);
  const [reasoningInput, setReasoningInput] = useState<"" | ReasoningEffortOption>(currentReasoningEffort);
  const [urlInput, setUrlInput] = useState(customModelsUrl);

  const [modelList, setModelList] = useState<string[]>(() => {
    try {
      const cached = localStorage.getItem(CACHED_MODELS_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });

  const [loadingModels, setLoadingModels] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [fetchSuccess, setFetchSuccess] = useState("");

  // Sync state when modal opens
  useEffect(() => {
    if (isOpen) {
      setModelInput(currentModel);
      setReasoningInput(currentReasoningEffort);
      setUrlInput(customModelsUrl);
      setFetchError("");
      setFetchSuccess("");
    }
  }, [isOpen, currentModel, currentReasoningEffort, customModelsUrl]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  async function handleFetchModels() {
    setLoadingModels(true);
    setFetchError("");
    setFetchSuccess("");
    try {
      const models = await fetchModelList(urlInput);
      setModelList(models);
      try {
        localStorage.setItem(CACHED_MODELS_KEY, JSON.stringify(models));
      } catch { /* ignore storage quotas */ }
      setFetchSuccess(`Đã tải thành công ${models.length} model.`);
      if (!modelInput && models.length > 0) {
        setModelInput(models[0]);
      }
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Không thể tải danh sách model.");
    } finally {
      setLoadingModels(false);
    }
  }

  function handleSave() {
    const finalModel = modelInput.trim() || serverConfig?.model || "gpt-4.1";
    onSave({
      model: finalModel,
      reasoningEffort: reasoningInput,
      customModelsUrl: urlInput.trim(),
    });
    onClose();
  }

  function handleReset() {
    onReset();
    setModelInput(serverConfig?.model || "gpt-4.1");
    setReasoningInput((serverConfig?.reasoningEffort as "" | ReasoningEffortOption) || "");
    setUrlInput("");
    setFetchError("");
    setFetchSuccess("");
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title" id="settings-modal-title">
            <span className="modal-icon">⚙</span>
            <div>
              <h3>Cài đặt AI & Thinking</h3>
              <p className="modal-subtitle">Tùy chỉnh model, mức độ suy nghĩ và tải danh sách từ URL</p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            title="Đóng (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {/* Section 1: Custom URL for model list */}
          <div className="form-group">
            <label className="form-label" htmlFor="custom-url-input">
              <span>URL danh sách model (Custom URL)</span>
            </label>
            <p className="form-hint">
              Endpoint trả về danh sách model (OpenAI, OpenRouter, Ollama, v.v.). Để trống để dùng endpoint mặc định của server.
            </p>
            <div className="input-with-button">
              <input
                id="custom-url-input"
                className="form-input"
                type="url"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                placeholder="Ví dụ: https://openrouter.ai/api/v1/models hoặc để trống"
                disabled={loadingModels}
              />
              <button
                type="button"
                className="fetch-btn"
                disabled={loadingModels}
                onClick={handleFetchModels}
              >
                {loadingModels ? "Đang tải…" : "Tải danh sách"}
              </button>
            </div>
            {fetchError && <div className="fetch-status-error" role="alert">{fetchError}</div>}
            {fetchSuccess && <div className="fetch-status-success" role="status">{fetchSuccess}</div>}
          </div>

          {/* Section 2: AI Model selection & input */}
          <div className="form-group">
            <label className="form-label" htmlFor="model-name-input">
              <span>AI Model</span>
              {serverConfig?.model && (
                <small className="default-label">
                  Mặc định: <strong>{serverConfig.model}</strong>
                </small>
              )}
            </label>

            {modelList.length > 0 && (
              <div className="model-select-wrapper">
                <select
                  id="model-dropdown"
                  className="form-select"
                  value={modelList.includes(modelInput) ? modelInput : ""}
                  onChange={e => {
                    if (e.target.value) setModelInput(e.target.value);
                  }}
                  aria-label="Chọn model từ danh sách"
                >
                  <option value="">-- Chọn nhanh từ danh sách ({modelList.length} model) --</option>
                  {modelList.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            )}

            <input
              id="model-name-input"
              className="form-input"
              type="text"
              value={modelInput}
              onChange={e => setModelInput(e.target.value)}
              placeholder="Nhập ID model (ví dụ: gpt-4.1, o3-mini, deepseek-chat…)"
              maxLength={200}
            />
            <p className="form-hint">
              Bạn có thể chọn từ danh sách đã tải hoặc tự gõ bất kỳ model ID nào mà endpoint hỗ trợ.
            </p>
          </div>

          {/* Section 3: Level Thinking (Reasoning Effort) */}
          <div className="form-group">
            <label className="form-label" htmlFor="reasoning-effort-select">
              <span>Level Thinking (Mức độ suy nghĩ)</span>
            </label>
            <p className="form-hint">
              Áp dụng cho các model có khả năng suy nghĩ (reasoning/thinking) như o1, o3-mini, v.v.
            </p>
            <select
              id="reasoning-effort-select"
              className="form-select"
              value={reasoningInput}
              onChange={e => setReasoningInput(e.target.value as "" | ReasoningEffortOption)}
            >
              <option value="">Tắt / Mặc định (Không gửi reasoning_effort)</option>
              <option value="low">Thấp (Low - phản hồi nhanh, ít bước suy nghĩ)</option>
              <option value="medium">Trung bình (Medium - cân bằng)</option>
              <option value="high">Cao (High - suy nghĩ kỹ cho bài toán khó)</option>
            </select>
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn-reset"
            onClick={handleReset}
            title="Khôi phục model và level thinking về mặc định của server"
          >
            Khôi phục mặc định
          </button>
          <div className="footer-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Đóng
            </button>
            <button type="button" className="btn-primary" onClick={handleSave}>
              Lưu & Áp dụng
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
