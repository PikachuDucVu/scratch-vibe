import { useEffect, useRef, useState } from "react";
import { ScratchEditor, type EditorHandle } from "./components/ScratchEditor";
import { ChatMarkdown } from "./components/ChatMarkdown";
import { SettingsModal } from "./components/SettingsModal";
import { runAgent, type ToolEvent } from "./agent/loop";
import type { ChatMessage } from "../shared/chat";
import type { AISettings } from "../shared/models";
import { providerConnectionSchema } from "../shared/provider";
import { defaultSettings, loadSettings, saveSettings } from "./agent/settings";

interface ProjectInfo { targets: { id: string; name: string; isStage: boolean }[] }
const examples = [
  "Cho mèo di chuyển bằng các phím mũi tên. Khi bấm cờ xanh, đưa mèo về giữa sân khấu.",
  "Thêm chương trình để mèo vẽ chuyển động hình vuông: lặp 4 lần, đi 100 bước rồi quay phải 90 độ.",
  "Tạo biến Điểm toàn cục, đặt bằng 0 khi bấm cờ xanh và tăng 1 khi nhấn phím space.",
];
const toolLabels: Record<string, string> = {
  get_variables: "Đọc biến/list", get_assets: "Đọc tài nguyên", get_procedures: "Đọc My Blocks", get_comments: "Đọc chú thích", get_runtime: "Đọc trạng thái chạy",
  replace_script: "Thay một script", delete_script: "Xóa script", insert_blocks: "Chèn block", update_block: "Sửa block", delete_block: "Xóa block", define_procedure: "Tạo My Block",
  add_sprite: "Thêm sprite", delete_sprite: "Xóa sprite", create_list: "Tạo list", create_broadcast: "Tạo thông điệp", set_variable: "Đặt giá trị biến", rename_variable: "Đổi tên biến", delete_variable: "Xóa biến/list", update_list: "Sửa list", set_monitor: "Hiện/ẩn biến", set_comment: "Viết chú thích", delete_comment: "Xóa chú thích",
  search_library: "Tìm thư viện", add_asset: "Thêm tài nguyên", manage_asset: "Chỉnh tài nguyên", create_costume: "Vẽ costume", load_extension: "Nạp extension",
  test_input: "Giả lập thao tác", wait_project: "Chờ chương trình", assert_state: "Kiểm tra kết quả", capture_stage: "Chụp sân khấu", get_costume_image: "Xem ảnh trang phục", list_files: "Đọc tệp tải lên", import_file: "Nhập tệp", export_project: "Xuất project", export_sprite: "Xuất sprite", save_snapshot: "Lưu snapshot", list_snapshots: "Đọc snapshots", restore_snapshot: "Khôi phục snapshot",
  get_project: "Đọc project", get_scripts: "Đọc block", add_scripts: "Thêm chương trình", replace_scripts: "Thay chương trình",
  set_sprite: "Chỉnh sprite", duplicate_sprite: "Nhân bản sprite", create_variable: "Tạo/cập nhật biến", run_project: "Chạy project", stop_project: "Dừng project",
};

export default function App() {
  const editor = useRef<EditorHandle>(null);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const history = useRef<ChatMessage[]>([]);
  const inputFile = useRef<HTMLInputElement>(null);
  const agentFiles = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<{ id: string; name: string }[]>([]);
  const chatEnd = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AISettings>(loadSettings);
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<Blob | null>(null);

  const activeModel = settings.model;
  const activeReasoningEffort = settings.reasoningEffort;
  const configured = providerConnectionSchema.safeParse({ baseUrl: settings.baseUrl, apiKey: settings.apiKey }).success;
  const availableModels = Array.from(new Set([activeModel, ...settings.models])).filter(Boolean);

  function handleSaveSettings(next: AISettings) {
    setSettings(next);
    const saved = saveSettings(next);
    setNotice(saved ? `Đã lưu cấu hình AI: Model "${next.model}".` : "Đã áp dụng cấu hình AI trong bộ nhớ. Không thể lưu vào trình duyệt; cần cấu hình lại khi tải lại trang.");
  }
  function handleResetSettings() {
    const next = defaultSettings();
    setSettings(next);
    saveSettings(next);
    setNotice("Đã xóa cấu hình AI và API key đã lưu trên trình duyệt.");
  }
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, tools, busy, streamingText]);
  function updateHistory(next: ChatMessage[]) { history.current = next; setMessages(next); }
  function updateTool(event: ToolEvent) { setTools(previous => {
    const index = previous.findIndex(tool => tool.id === event.id);
    return index < 0 ? [...previous, event] : previous.map((tool, i) => i === index ? event : tool);
  }); }
  async function locked(action: (handle: EditorHandle) => Promise<void>) {
    if (operation.current || !ready || !editor.current) return;
    operation.current = true;
    setBusy(true); setError(""); setNotice(""); setStreamingText(""); setStreamingReasoning("");
    try { await action(editor.current); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally {
      operation.current = false;
      controller.current = null;
      setBusy(false);
      setStopping(false);
      setStreamingText("");
      setStreamingReasoning("");
    }
  }
  async function submit() {
    const text = prompt.trim();
    if (!text || busy || !ready) return;
    if (!configured) { setShowSettings(true); return; }
    setPrompt(""); setTools([]); setStreamingText(""); setStreamingReasoning("");
    await locked(async handle => {
      const abort = new AbortController();
      controller.current = abort;
      const snapshot = await handle.exportProject();
      setUndo(snapshot);
      abort.signal.throwIfAborted();
      try {
        await runAgent({
          editor: handle, history: history.current, prompt: text, signal: abort.signal,
          onHistory: updateHistory, onTool: updateTool,
          onStream: (streamText, streamReason) => {
            setStreamingText(streamText);
            setStreamingReasoning(streamReason);
          },
          confirmTool: async (name, args) => window.confirm(`AI muốn thực hiện “${toolLabels[name] ?? name}”.\nThao tác có thể chạy chương trình/giả lập đầu vào, hoặc xóa/thay thế/nhập dữ liệu.\n${JSON.stringify(args, null, 2).slice(0, 1500)}\n\nCho phép? Có thể dùng Hoàn tác để khôi phục trước lượt AI.`),
          confirmReplace: async targetId => {
            const project = await handle.tool("get_project", {}) as ProjectInfo;
            const name = project.targets.find(target => target.id === targetId)?.name ?? targetId;
            return window.confirm(`Agent muốn thay thế TOÀN BỘ block của “${name}”.\nCode cũ trên target này sẽ bị xóa. Bạn có thể dùng Hoàn tác để khôi phục.\n\nCho phép thay thế?`);
          },
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: activeModel,
          reasoningEffort: activeReasoningEffort || null,
        });
        setNotice("Đã hoàn thành yêu cầu. Bạn có thể chỉnh tiếp block hoặc bấm cờ xanh trong Scratch.");
      } catch (error) {
        if (abort.signal.aborted) setNotice("Đã dừng agent. Các tool đã hoàn tất được giữ lại; dùng Hoàn tác nếu muốn khôi phục.");
        else throw error;
      }
    });
  }
  function cancel() { setStopping(true); controller.current?.abort(); }
  async function demo() {
    setTools([]);
    await locked(async handle => {
      setUndo(await handle.exportProject());
      const project = await handle.tool("get_project", {}) as ProjectInfo;
      const sprite = project.targets.find(target => !target.isStage);
      if (!sprite) throw new Error("Hãy thêm một sprite trong Scratch trước khi chạy demo.");
      const id = crypto.randomUUID();
      updateTool({ id, name: "add_scripts", status: "running" });
      try {
        const result = await handle.tool("add_scripts", { targetId: sprite.id, scripts: [[
          { opcode: "event_whenflagclicked" },
          { opcode: "motion_gotoxy", inputs: { X: 0, Y: 0 } },
          { opcode: "motion_pointindirection", inputs: { DIRECTION: 90 } },
          { opcode: "looks_sayforsecs", inputs: { MESSAGE: "Xin chào Scratch Vibe!", SECS: 1 } },
          { opcode: "control_repeat", inputs: { TIMES: 4, SUBSTACK: [
            { opcode: "motion_movesteps", inputs: { STEPS: 100 } },
            { opcode: "motion_turnright", inputs: { DEGREES: 90 } },
            { opcode: "control_wait", inputs: { DURATION: 0.4 } },
          ] } },
        ]] });
        updateTool({ id, name: "add_scripts", status: "success", detail: JSON.stringify(result) });
        await handle.tool("run_project", {});
        updateHistory([]);
        setNotice("Demo đã thêm block và bấm cờ xanh. Không cần API key. Dùng Hoàn tác để bỏ chương trình demo.");
      } catch (error) { updateTool({ id, name: "add_scripts", status: "error", detail: String(error) }); throw error; }
    });
  }
  async function uploadForAgent(files: FileList | null) {
    if (!files) return;
    await locked(async handle => {
      if (!handle.uploadFile) throw new Error("Editor chưa hỗ trợ tải tệp.");
      for (const file of Array.from(files)) {
        const uploaded = await handle.uploadFile(file);
        setUploads(previous => [...previous, uploaded]);
      }
      setNotice("Đã tải tệp vào tab. AI có thể dùng list_files/import_file; nhập tệp cần xác nhận.");
    });
  }
  async function restore() {
    if (!undo) return;
    const snapshot = undo;
    await locked(async handle => {
      await handle.loadProject(snapshot);
      setUndo(null); updateHistory([]); setTools([]);
      setNotice("Đã khôi phục project trước thao tác gần nhất. Hội thoại được làm mới vì target ID đã thay đổi.");
    });
  }
  async function download() {
    await locked(async handle => {
      const blob = await handle.exportProject();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "scratch-vibe.sb3"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function importProject(file: File) {
    if (!file.name.toLowerCase().endsWith(".sb3")) { setError("Chọn file Scratch .sb3."); return; }
    if (!window.confirm("Mở file này sẽ thay thế project hiện tại. Tiếp tục?")) return;
    await locked(async handle => {
      setUndo(await handle.exportProject());
      await handle.loadProject(file);
      updateHistory([]); setTools([]); setNotice(`Đã mở ${file.name}.`);
    });
  }
  return <div className="app">
    <header className="topbar">
      <div className="brand"><div className="brand-icon">✦</div><div><h1>Scratch <span>Vibe</span></h1><p>Ý tưởng của bạn. Block của Scratch.</p></div></div>
      <div className="toolbar">
        <span className={`status ${ready ? "online" : ""}`}><i />{ready ? "Editor sẵn sàng" : "Đang tải editor"}</span>
        <button disabled={!ready || busy} onClick={() => inputFile.current?.click()}>Mở .sb3</button>
        <button disabled={!ready || busy} onClick={download}>Lưu .sb3</button>
        <button disabled={!ready || busy} onClick={() => agentFiles.current?.click()}>Tệp cho AI{uploads.length ? ` (${uploads.length})` : ""}</button>
        <input hidden ref={agentFiles} type="file" aria-label="Tải tệp cho AI" multiple accept=".sb3,.sprite3,.svg,.png,.jpg,.jpeg,.wav,.mp3" onChange={event => { void uploadForAgent(event.target.files); event.target.value = ""; }} />
        <button disabled={!ready || busy || !undo} onClick={restore}>↶ Hoàn tác</button>
        <button type="button" disabled={busy} onClick={() => setShowSettings(true)} title="Cài đặt AI Model & Thinking">⚙ Cài đặt</button>
        <input hidden ref={inputFile} type="file" aria-label="Mở project Scratch" accept=".sb3" onChange={event => { const file = event.target.files?.[0]; if (file) void importProject(file); event.target.value = ""; }} />
      </div>
    </header>
    <main className="workspace">
      <section className="scratch-pane" aria-label="Scratch editor">
        <ScratchEditor ref={editor} onReady={() => setReady(true)} onError={message => { setError(message); setReady(false); }} locked={busy || !ready} lockLabel={!ready ? "Scratch chưa sẵn sàng · Kiểm tra thông báo nếu tải quá lâu" : undefined} />
      </section>
      <aside className="agent-pane">
        <div className="agent-heading"><div><span className="eyebrow">AI CODING AGENT</span><h2>Cùng tạo điều thú vị <span>✧</span></h2></div><div className="agent-heading-actions"><button type="button" className="icon-button" title="Cài đặt AI Model & Thinking" aria-label="Cài đặt AI" disabled={busy} onClick={() => setShowSettings(true)}>⚙</button><button className="icon-button" title="Hội thoại mới (không xóa project)" aria-label="Hội thoại mới" disabled={busy} onClick={() => { updateHistory([]); setTools([]); setError(""); setNotice(""); }}>＋</button></div></div>
        <div className="model-line"><span className="model-dot" /><span className="model-name" title={`Model: ${activeModel}`}>{configured ? activeModel : "Chế độ editor · chưa cấu hình AI"}</span>{configured && activeReasoningEffort && <span className="thinking-tag" title={`Thinking: ${activeReasoningEffort}`}>{activeReasoningEffort}</span>}<button type="button" className="model-edit-btn" disabled={busy} onClick={() => setShowSettings(true)} title="Tùy chỉnh model & level thinking">Đổi</button><span>Tool calling</span></div>
        <div className="conversation" aria-live="polite">
          {!messages.length && <div className="welcome">
            <div className="welcome-icon">✦</div><h3>Bắt đầu bằng một ý tưởng</h3><p>Mô tả điều bạn muốn làm. Agent sẽ đọc project và tạo block trực tiếp — bạn vẫn có thể kéo thả như bình thường.</p>
            <div className="examples">{examples.map((example, index) => <button key={example} disabled={busy} onClick={() => setPrompt(example)}><span>{["↗", "◇", "＋"][index]}</span>{example}</button>)}</div>
            <button className="demo-button" disabled={!ready || busy} onClick={demo}>▷ Thêm & chạy demo không cần API key</button>
          </div>}
          {messages.filter(message => message.role !== "tool" && typeof message.content === "string" && message.content).map((message, index) => <div key={index} className={`message ${message.role}`}><span className="message-label">{message.role === "user" ? "Bạn" : "✦ Scratch Vibe"}</span>{message.role === "assistant" ? <ChatMarkdown content={message.content ?? ""} /> : <p className="user-message-text">{typeof message.content === "string" ? message.content : ""}</p>}</div>)}
          {busy && Boolean(streamingText) && <div className="message assistant streaming"><span className="message-label">✦ Scratch Vibe <span className="stream-badge">● đang viết…</span></span><ChatMarkdown content={streamingText} /></div>}
          {!!tools.length && <div className="tool-log"><h3>Hoạt động của lượt gần nhất</h3>{tools.map(tool => <details key={tool.id} className={`tool ${tool.status}`}><summary><span>{tool.status === "running" ? "◌" : tool.status === "success" ? "✓" : "!"}</span>{toolLabels[tool.name] ?? tool.name}<small>{tool.status === "running" ? "Đang thực hiện" : tool.status === "success" ? "Hoàn tất" : tool.name === "assert_state" ? "Không đạt" : "Không thực hiện"}</small></summary><ToolDetail tool={tool} /></details>)}</div>}
          {busy && !streamingText && <div className="thinking"><span className="pulse" />{stopping ? "Đang dừng, chờ tool hiện tại hoàn tất…" : streamingReasoning ? `Đang suy nghĩ (${streamingReasoning.length} ký tự)…` : "Đang đọc project và xử lý…"}</div>}
          {notice && <div className="notice" role="status">{notice}</div>}
          {error && <div className="error" role="alert">{error}</div>}
          <div ref={chatEnd} />
        </div>
        <div className="composer-area">
          {!configured && <div className="setup-note">Bật chat AI: nhập Custom URL và API key trong <button type="button" className="setup-link" disabled={busy} onClick={() => setShowSettings(true)}>Cài đặt AI</button>. Không cần sửa .env hoặc khởi động lại server.</div>}
          <form onSubmit={event => { event.preventDefault(); void submit(); }}>
            <label className="sr-only" htmlFor="prompt">Mô tả yêu cầu lập trình Scratch</label>
            <textarea id="prompt" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={6000} disabled={busy} placeholder="Ví dụ: Tạo game mèo bắt bóng…" onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className="chat-model-picker">
              <label htmlFor="chat-model-select">AI Model</label>
              <select id="chat-model-select" value={activeModel} disabled={busy} onChange={event => handleSaveSettings({ ...settings, model: event.target.value })}>
                {availableModels.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
              <button type="button" className="model-edit-btn" disabled={busy} onClick={() => setShowSettings(true)} title="Tải thêm model hoặc nhập model ID">Cấu hình</button>
            </div>
            <div className="composer-bottom"><span>Enter để gửi · Shift Enter xuống dòng</span>{busy && controller.current ? <button type="button" className="stop-button" disabled={stopping} onClick={cancel}>■ Dừng agent</button> : <button className="send-button" type="submit" disabled={!ready || busy || !prompt.trim() || !configured}>Tạo với AI ↑</button>}</div>
          </form>
          <p className="safety-note">Có thể hoàn tác lượt gần nhất · Thay toàn bộ code cần bạn xác nhận</p>
        </div>
      </aside>
    </main>
    <footer>Scratch Vibe <span>Agent chỉ dùng tool được cho phép — không thực thi JavaScript do AI sinh.</span></footer>
    <SettingsModal
      isOpen={showSettings}
      onClose={() => setShowSettings(false)}
      settings={settings}
      onSave={handleSaveSettings}
      onReset={handleResetSettings}
    />
  </div>;
}

function ToolDetail({ tool }: { tool: ToolEvent }) {
  if ((tool.name === "capture_stage" || tool.name === "get_costume_image") && tool.status === "success" && tool.detail) {
    try { const result = JSON.parse(tool.detail); if (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(result.image)) return <img className="stage-capture" src={result.image} alt={tool.name === "capture_stage" ? "Ảnh sân khấu do tool chụp" : `Ảnh trang phục ${result.name ?? ""}`} />; } catch { /* display raw error below */ }
  }
  return <pre>{tool.detail ?? "Đang chờ Scratch…"}</pre>;
}
