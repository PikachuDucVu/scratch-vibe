import { useEffect, useRef, useState } from "react";
import { fetchModelList } from "../agent/loop";
import { defaultSettings } from "../agent/settings";
import { modelListRequestSchema } from "../../shared/provider";
import { guessImageModel, type AISettings } from "../../shared/models";
import type { Lang } from "../i18n";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onSave: (settings: AISettings) => void;
  onReset: () => void;
  lang?: Lang;
}

const TEXT = {
  vi: {
    title: "Cài đặt AI & Thinking", subtitle: "Kết nối AI trực tiếp bằng cấu hình trên web, không cần sửa .env", close: "Đóng cài đặt", closeTitle: "Đóng (Esc)",
    url: "Custom URL (API Base URL)", urlHint: "URL gốc của API tương thích Chat Completions, thường kết thúc bằng /v1. Dùng cho cả chat, tải model và tạo ảnh/âm thanh. HTTPS, hoặc HTTP localhost cho model local.",
    key: "API key", keyPlaceholder: "Nhập API key của bạn", show: "Hiện", hide: "Ẩn", showKey: "Hiện API key", hideKey: "Ẩn API key",
    remember: "Ghi nhớ API key trên trình duyệt này", keyHint: "Mặc định key chỉ lưu trong phiên tab. Khi bật ghi nhớ, key được lưu trên thiết bị này (không mã hóa). Key gửi qua backend đến provider khi tải model, chat hoặc tạo media; chỉ dùng URL bạn tin cậy.",
    modelsUrl: "URL danh sách model riêng (tùy chọn)", modelsUrlPlaceholder: "Để trống để dùng Custom URL + /models", modelsUrlHint: "API key chỉ được gửi nếu URL này cùng origin với Custom URL.",
    fetch: "Tải danh sách model", fetching: "Đang tải…", loaded: (n: number) => `Đã tải thành công ${n} model.`, noModels: "Không tìm thấy model ID hợp lệ.", fetchFailed: "Không thể tải danh sách model.", checkConnection: "Kiểm tra Custom URL và API key.",
    model: "AI Model", chooseModel: "-- Chọn model --", chooseFromList: "Chọn model từ danh sách", modelPlaceholder: "Nhập model ID mà provider hỗ trợ", modelHint: "Có thể nhập ID thủ công. Sau khi lưu, đổi model nhanh ngay bên dưới ô chat.", modelError: "Nhập model ID từ 1 đến 200 ký tự.",
    thinking: "Level Thinking (Mức độ suy nghĩ)", thinkingOff: "Tắt / Mặc định (Không gửi reasoning_effort)", low: "Thấp (Low)", medium: "Trung bình (Medium)", high: "Cao (High)",
    media: "Tạo hình & âm thanh bằng AI", imageModel: "Model tạo ảnh", imagePlaceholder: "Ví dụ: gpt-image-2 (để trống: tự chọn từ danh sách)", imageHint: (guess: string) => guess ? `Để trống sẽ dùng ${guess}. Mỗi ảnh mất khoảng 1 phút và tính vào quota của bạn.` : "Dùng cho tool vẽ costume/phông nền bằng AI. Mỗi ảnh mất khoảng 1 phút và tính vào quota của bạn.",
    imageQuality: "Chất lượng ảnh", speechModel: "Model đọc chữ (TTS, tùy chọn)", speechPlaceholder: "Ví dụ: gpt-4o-mini-tts — để trống nếu provider không hỗ trợ", voice: "Giọng đọc",
    safety: "An toàn", maxSteps: "Số bước tối đa mỗi yêu cầu", maxStepsHint: "0 = không giới hạn (luôn có thể bấm Dừng). AI cũng tự dừng nếu lặp lại cùng một thao tác.",
    reset: "Xóa cấu hình", resetTitle: "Xóa cấu hình, API key và danh sách model đã lưu", cancel: "Đóng", save: "Lưu & Áp dụng",
  },
  en: {
    title: "AI & thinking settings", subtitle: "Connect AI right here on the web — no .env needed", close: "Close settings", closeTitle: "Close (Esc)",
    url: "Custom URL (API Base URL)", urlHint: "Base URL of a Chat Completions compatible API, usually ending in /v1. Used for chat, model lists and image/sound generation. HTTPS, or HTTP localhost for local models.",
    key: "API key", keyPlaceholder: "Enter your API key", show: "Show", hide: "Hide", showKey: "Show API key", hideKey: "Hide API key",
    remember: "Remember the API key in this browser", keyHint: "By default the key is kept for this tab session only. When remembered it is stored on this device (unencrypted). The key goes through the backend to the provider for model lists, chat and media; only use URLs you trust.",
    modelsUrl: "Custom model list URL (optional)", modelsUrlPlaceholder: "Leave empty to use Custom URL + /models", modelsUrlHint: "The API key is only sent if this URL has the same origin as the Custom URL.",
    fetch: "Load model list", fetching: "Loading…", loaded: (n: number) => `Loaded ${n} models.`, noModels: "No valid model IDs found.", fetchFailed: "Could not load the model list.", checkConnection: "Check the Custom URL and API key.",
    model: "AI Model", chooseModel: "-- Choose a model --", chooseFromList: "Choose a model from the list", modelPlaceholder: "Enter a model ID your provider supports", modelHint: "You can type an ID manually. After saving, switch models right below the chat box.", modelError: "Enter a model ID of 1 to 200 characters.",
    thinking: "Thinking level", thinkingOff: "Off / default (no reasoning_effort)", low: "Low", medium: "Medium", high: "High",
    media: "AI images & sounds", imageModel: "Image model", imagePlaceholder: "e.g. gpt-image-2 (empty: pick from the list)", imageHint: (guess: string) => guess ? `Empty uses ${guess}. Each image takes about a minute and uses your quota.` : "Used by the AI costume/backdrop drawing tool. Each image takes about a minute and uses your quota.",
    imageQuality: "Image quality", speechModel: "Text-to-speech model (optional)", speechPlaceholder: "e.g. gpt-4o-mini-tts — leave empty if unsupported", voice: "Voice",
    safety: "Safety", maxSteps: "Maximum steps per request", maxStepsHint: "0 = no limit (you can always press Stop). The AI also stops if it repeats the same action.",
    reset: "Clear settings", resetTitle: "Remove saved settings, API key and model list", cancel: "Close", save: "Save & apply",
  },
};

export function SettingsModal({ isOpen, onClose, settings, onSave, onReset, lang = "vi" }: SettingsModalProps) {
  const t = TEXT[lang];
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fetchController = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // Only a press that started on the backdrop may close the modal; a text selection dragged out of the dialog must not.
  const pressedBackdrop = useRef(false);

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
      setError(result.error.issues[0]?.message || t.checkConnection);
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
      if (!models.length) throw new Error(t.noModels);
      setDraft(previous => ({ ...previous, models, model: models.includes(previous.model) ? previous.model : models[0] }));
      setSuccess(t.loaded(models.length));
    } catch (error) {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : t.fetchFailed);
    } finally {
      if (!abort.signal.aborted) setLoadingModels(false);
    }
  }

  function handleSave() {
    const config = connection();
    if (!config) return;
    if (!draft.model.trim() || draft.model.trim().length > 200) {
      setError(t.modelError); return;
    }
    const maxSteps = Math.max(0, Math.min(500, Math.round(Number(draft.maxSteps) || 0)));
    onSave({ ...draft, ...config, customModelsUrl: config.customModelsUrl || "", model: draft.model.trim(), imageModel: draft.imageModel.trim().slice(0, 200), speechModel: draft.speechModel.trim().slice(0, 200), speechVoice: draft.speechVoice.trim().slice(0, 40) || "alloy", maxSteps });
    onClose();
  }
  const imageGuess = guessImageModel(draft.models);

  return (
    <div className="modal-backdrop" role="presentation"
      onMouseDown={event => { pressedBackdrop.current = event.target === event.currentTarget; }}
      onClick={event => { if (pressedBackdrop.current && event.target === event.currentTarget) onClose(); pressedBackdrop.current = false; }}>
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
            <h3>{t.title}</h3>
            <p className="modal-subtitle">{t.subtitle}</p>
          </div></div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label={t.close} title={t.closeTitle}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="custom-url-input">{t.url}</label>
            <input id="custom-url-input" className="form-input" type="url" value={draft.baseUrl}
              onChange={event => updateConnection("baseUrl", event.target.value)} placeholder="https://provider.example/v1" maxLength={2048} />
            <p className="form-hint">{t.urlHint}</p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="api-key-input">{t.key}</label>
            <div className="input-with-button">
              <input id="api-key-input" className="form-input" type={showKey ? "text" : "password"} value={draft.apiKey}
                onChange={event => updateConnection("apiKey", event.target.value)} placeholder={t.keyPlaceholder} autoComplete="off" spellCheck={false} maxLength={4096} />
              <button type="button" className="btn-secondary" onClick={() => setShowKey(!showKey)} aria-label={showKey ? t.hideKey : t.showKey} aria-pressed={showKey}>{showKey ? t.hide : t.show}</button>
            </div>
            <label className="remember-key"><input type="checkbox" checked={draft.rememberApiKey} onChange={event => setDraft({ ...draft, rememberApiKey: event.target.checked })} />{t.remember}</label>
            <p className="form-hint">{t.keyHint}</p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="models-url-input">{t.modelsUrl}</label>
            <input id="models-url-input" className="form-input" type="url" value={draft.customModelsUrl}
              onChange={event => updateConnection("customModelsUrl", event.target.value)} placeholder={t.modelsUrlPlaceholder} maxLength={2048} />
            <p className="form-hint">{t.modelsUrlHint}</p>
            <button type="button" className="fetch-btn" disabled={loadingModels} onClick={handleFetchModels}>{loadingModels ? t.fetching : t.fetch}</button>
            {error && <div className="fetch-status-error" role="alert">{error}</div>}
            {success && <div className="fetch-status-success" role="status">{success}</div>}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="model-name-input">{t.model}</label>
            {draft.models.length > 0 && <select className="form-select" value={draft.models.includes(draft.model) ? draft.model : ""}
              onChange={event => { if (event.target.value) setDraft({ ...draft, model: event.target.value }); }} aria-label={t.chooseFromList}>
              <option value="">{t.chooseModel}</option>
              {draft.models.map(name => <option key={name} value={name}>{name}</option>)}
            </select>}
            <input id="model-name-input" className="form-input" type="text" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })}
              placeholder={t.modelPlaceholder} maxLength={200} />
            <p className="form-hint">{t.modelHint}</p>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="reasoning-effort-select">{t.thinking}</label>
            <select id="reasoning-effort-select" className="form-select" value={draft.reasoningEffort} onChange={event => setDraft({ ...draft, reasoningEffort: event.target.value as AISettings["reasoningEffort"] })}>
              <option value="">{t.thinkingOff}</option>
              <option value="low">{t.low}</option><option value="medium">{t.medium}</option><option value="high">{t.high}</option>
            </select>
          </div>
          <fieldset className="form-section">
            <legend>{t.media}</legend>
            <div className="form-group">
              <label className="form-label" htmlFor="image-model-input">{t.imageModel}</label>
              <input id="image-model-input" className="form-input" type="text" list="image-model-options" value={draft.imageModel} onChange={event => setDraft({ ...draft, imageModel: event.target.value })} placeholder={t.imagePlaceholder} maxLength={200} />
              <datalist id="image-model-options">{draft.models.filter(m => /image|dall|imagen|flux/i.test(m)).map(m => <option key={m} value={m} />)}</datalist>
              <p className="form-hint">{t.imageHint(draft.imageModel ? "" : imageGuess)}</p>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="image-quality-select">{t.imageQuality}</label>
                <select id="image-quality-select" className="form-select" value={draft.imageQuality} onChange={event => setDraft({ ...draft, imageQuality: event.target.value as AISettings["imageQuality"] })}>
                  <option value="low">{t.low}</option><option value="medium">{t.medium}</option><option value="high">{t.high}</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="speech-voice-input">{t.voice}</label>
                <input id="speech-voice-input" className="form-input" type="text" value={draft.speechVoice} onChange={event => setDraft({ ...draft, speechVoice: event.target.value })} maxLength={40} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="speech-model-input">{t.speechModel}</label>
              <input id="speech-model-input" className="form-input" type="text" value={draft.speechModel} onChange={event => setDraft({ ...draft, speechModel: event.target.value })} placeholder={t.speechPlaceholder} maxLength={200} />
            </div>
          </fieldset>
          <fieldset className="form-section">
            <legend>{t.safety}</legend>
            <div className="form-group">
              <label className="form-label" htmlFor="max-steps-input">{t.maxSteps}</label>
              <input id="max-steps-input" className="form-input" type="number" min={0} max={500} step={1} value={draft.maxSteps} onChange={event => setDraft({ ...draft, maxSteps: Number(event.target.value) })} />
              <p className="form-hint">{t.maxStepsHint}</p>
            </div>
          </fieldset>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-reset" onClick={() => { onReset(); setDraft(defaultSettings()); onClose(); }} title={t.resetTitle}>{t.reset}</button>
          <div className="footer-actions"><button type="button" className="btn-secondary" onClick={onClose}>{t.cancel}</button>
            <button type="button" className="btn-primary" disabled={loadingModels} onClick={handleSave}>{t.save}</button></div>
        </div>
      </div>
    </div>
  );
}
