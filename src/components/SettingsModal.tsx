import { useEffect, useRef, useState } from "react";
import { fetchModelList } from "../agent/loop";
import { defaultSettings } from "../agent/settings";
import { modelListRequestSchema } from "../../shared/provider";
import type { AISettings } from "../../shared/models";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onSave: (settings: AISettings) => void;
  onReset: () => void;
}

export function SettingsModal({ isOpen, onClose, settings, onSave, onReset }: SettingsModalProps) {
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fetchController = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDraft(settings); setShowKey(false); setError(""); setSuccess(""); setLoadingModels(false);
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { fetchController.current?.abort(); previousFocus?.focus(); };
  }, [isOpen, settings]);

  if (!isOpen) return null;

  function updateConnection(key: "baseUrl" | "apiKey" | "customModelsUrl", value: string) {
    fetchController.current?.abort();
    setLoadingModels(false); setError(""); setSuccess("");
    setDraft(previous => ({ ...previous, [key]: value, models: [] }));
  }

  function connection() {
    const result = modelListRequestSchema.safeParse({
      baseUrl: draft.baseUrl, apiKey: draft.apiKey, customModelsUrl: draft.customModelsUrl,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message || "Kiểm tra Custom URL và API key.");
      return null;
    }
    return result.data;
  }

  async function handleFetchModels() {
    const config = connection();
    if (!config) return;
    fetchController.current?.abort();
    const abort = new AbortController();
    fetchController.current = abort;
    setLoadingModels(true); setError(""); setSuccess("");
    try {
      const models = (await fetchModelList(config, abort.signal)).filter(model => model.length <= 200);
      if (abort.signal.aborted) return;
      if (!models.length) throw new Error("Không tìm thấy model ID hợp lệ.");
      setDraft(previous => ({ ...previous, models, model: models.includes(previous.model) ? previous.model : models[0] }));
      setSuccess(`Đã tải thành công ${models.length} model.`);
    } catch (error) {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "Không thể tải danh sách model.");
    } finally {
      if (!abort.signal.aborted) setLoadingModels(false);
    }
  }

  function handleSave() {
    const config = connection();
    if (!config) return;
    if (!draft.model.trim() || draft.model.trim().length > 200) {
      setError("Nhập model ID từ 1 đến 200 ký tự."); return;
    }
    onSave({ ...draft, ...config, customModelsUrl: config.customModelsUrl || "", model: draft.model.trim() });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialog} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          if (event.key !== "Tab") return;
          const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? []);
          const first = elements[0]; const last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <div className="modal-header">
          <div className="modal-title" id="settings-modal-title"><span className="modal-icon">⚙</span><div>
            <h3>Cài đặt AI & Thinking</h3>
            <p className="modal-subtitle">Kết nối AI trực tiếp bằng cấu hình trên web, không cần sửa .env</p>
          </div></div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Đóng cài đặt" title="Đóng (Esc)">✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="custom-url-input">Custom URL (API Base URL)</label>
            <input id="custom-url-input" className="form-input" type="url" value={draft.baseUrl}
              onChange={event => updateConnection("baseUrl", event.target.value)} placeholder="https://provider.example/v1" maxLength={2048} />
            <p className="form-hint">URL gốc của API tương thích Chat Completions, thường kết thúc bằng /v1. Dùng cho cả chat và tải model. HTTPS, hoặc HTTP localhost cho model local.</p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="api-key-input">API key</label>
            <div className="input-with-button">
              <input id="api-key-input" className="form-input" type={showKey ? "text" : "password"} value={draft.apiKey}
                onChange={event => updateConnection("apiKey", event.target.value)} placeholder="Nhập API key của bạn" autoComplete="off" spellCheck={false} maxLength={4096} />
              <button type="button" className="btn-secondary" onClick={() => setShowKey(!showKey)} aria-label={showKey ? "Ẩn API key" : "Hiện API key"} aria-pressed={showKey}>{showKey ? "Ẩn" : "Hiện"}</button>
            </div>
            <label className="remember-key"><input type="checkbox" checked={draft.rememberApiKey} onChange={event => setDraft({ ...draft, rememberApiKey: event.target.checked })} />Ghi nhớ API key trên trình duyệt này</label>
            <p className="form-hint">Mặc định key chỉ lưu trong phiên tab. Khi bật ghi nhớ, key được lưu trên thiết bị này (không mã hóa). Key gửi qua backend đến provider khi tải model hoặc chat; chỉ dùng URL bạn tin cậy.</p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="models-url-input">URL danh sách model riêng (tùy chọn)</label>
            <input id="models-url-input" className="form-input" type="url" value={draft.customModelsUrl}
              onChange={event => updateConnection("customModelsUrl", event.target.value)} placeholder="Để trống để dùng Custom URL + /models" maxLength={2048} />
            <p className="form-hint">API key chỉ được gửi nếu URL này cùng origin với Custom URL.</p>
            <button type="button" className="fetch-btn" disabled={loadingModels} onClick={handleFetchModels}>{loadingModels ? "Đang tải…" : "Tải danh sách model"}</button>
            {error && <div className="fetch-status-error" role="alert">{error}</div>}
            {success && <div className="fetch-status-success" role="status">{success}</div>}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="model-name-input">AI Model</label>
            {draft.models.length > 0 && <select className="form-select" value={draft.models.includes(draft.model) ? draft.model : ""}
              onChange={event => { if (event.target.value) setDraft({ ...draft, model: event.target.value }); }} aria-label="Chọn model từ danh sách">
              <option value="">-- Chọn model --</option>
              {draft.models.map(name => <option key={name} value={name}>{name}</option>)}
            </select>}
            <input id="model-name-input" className="form-input" type="text" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })}
              placeholder="Nhập model ID mà provider hỗ trợ" maxLength={200} />
            <p className="form-hint">Có thể nhập ID thủ công. Sau khi lưu, đổi model nhanh ngay bên dưới ô chat.</p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="reasoning-effort-select">Level Thinking (Mức độ suy nghĩ)</label>
            <select id="reasoning-effort-select" className="form-select" value={draft.reasoningEffort} onChange={event => setDraft({ ...draft, reasoningEffort: event.target.value as AISettings["reasoningEffort"] })}>
              <option value="">Tắt / Mặc định (Không gửi reasoning_effort)</option>
              <option value="low">Thấp (Low)</option><option value="medium">Trung bình (Medium)</option><option value="high">Cao (High)</option>
            </select>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-reset" onClick={() => { onReset(); setDraft(defaultSettings()); onClose(); }} title="Xóa cấu hình, API key và danh sách model đã lưu">Xóa cấu hình</button>
          <div className="footer-actions"><button type="button" className="btn-secondary" onClick={onClose}>Đóng</button>
            <button type="button" className="btn-primary" disabled={loadingModels} onClick={handleSave}>Lưu & Áp dụng</button></div>
        </div>
      </div>
    </div>
  );
}
