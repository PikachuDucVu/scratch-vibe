import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { ScratchEditor, type EditorHandle } from "./components/ScratchEditor";
import { ChatMarkdown } from "./components/ChatMarkdown";
import { SettingsModal } from "./components/SettingsModal";
import { runAgent, type TokenUsage, type ToolEvent } from "./agent/loop";
import { generateCostume, generateSpeech, type CostumeArgs, type SpeechArgs } from "./agent/media";
import { diffInventory, type ChangeSummary, type Inventory } from "./agent/changes";
import { deleteConversation, listConversations, loadConversation, saveConversation, storageGet, storageSet, titleOf, type ConversationMeta, type SavedProject } from "./agent/storage";
import { IMAGE_URL_LIMIT, isToolImage, type AgentMode, type ChatMessage, type UserContent } from "../shared/chat";
import type { AISettings } from "../shared/models";
import { providerConnectionSchema } from "../shared/provider";
import { defaultSettings, loadSettings, saveSettings } from "./agent/settings";
import { DICTS, EXAMPLES, TEMPLATES, TOOL_LABELS, loadLang, saveLang, type Lang } from "./i18n";

interface ProjectInfo { targets: { id: string; name: string; isStage: boolean }[] }
interface Attachment { id: string; url: string; name: string }
const SOURCE_URL = "https://github.com/PikachuDucVu/scratch-vibe";
const MAX_UNDO = 20, MAX_UNDO_BYTES = 150 * 1024 * 1024;
type SpeechRecognitionLike = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
const Recognition = typeof window === "undefined" ? undefined : ((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;

// Downscales an attached image to a JPEG data URL under the chat image limit.
async function attachmentUrl(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    for (const side of [1024, 768, 512]) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.65, 0.5]) {
        const data = canvas.toDataURL("image/jpeg", quality);
        if (data.length <= IMAGE_URL_LIMIT) return data;
      }
    }
    throw new Error("Ảnh quá lớn.");
  } finally { URL.revokeObjectURL(url); }
}
const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

export default function App() {
  const editor = useRef<EditorHandle>(null);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const history = useRef<ChatMessage[]>([]);
  const inputFile = useRef<HTMLInputElement>(null);
  const agentFiles = useRef<HTMLInputElement>(null);
  const imageFiles = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const undoStack = useRef<Blob[]>([]);
  const conversationId = useRef<string>(crypto.randomUUID());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  // Change events right after a programmatic load are not user edits.
  const ignoreChangesUntil = useRef(0);
  const offered = useRef<SavedProject | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const [lang, setLang] = useState<Lang>(loadLang);
  const [editorLocale] = useState(lang);
  const t = DICTS[lang], toolLabels = TOOL_LABELS[lang];
  const [uploads, setUploads] = useState<{ id: string; name: string }[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AISettings>(loadSettings);
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undoCount, setUndoCount] = useState(0);
  const [mode, setMode] = useState<AgentMode>("build");
  const [planReady, setPlanReady] = useState(false);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [changes, setChanges] = useState<ChangeSummary | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [restoreOffer, setRestoreOffer] = useState<number | null>(null);
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareLink, setShareLink] = useState<{ url: string; days: number } | null>(null);
  const [listening, setListening] = useState(false);

  const activeModel = settings.model;
  const activeReasoningEffort = settings.reasoningEffort;
  const configured = providerConnectionSchema.safeParse({ baseUrl: settings.baseUrl, apiKey: settings.apiKey }).success;
  const availableModels = Array.from(new Set([activeModel, ...settings.models])).filter(Boolean);

  function handleSaveSettings(next: AISettings) {
    setSettings(next);
    const saved = saveSettings(next);
    setNotice(saved ? t.noticeSettings(next.model) : t.noticeSettingsMemory);
  }
  function handleResetSettings() {
    const next = defaultSettings();
    setSettings(next);
    saveSettings(next);
    setNotice(t.noticeReset);
  }
  function switchLanguage() {
    const next: Lang = lang === "vi" ? "en" : "vi";
    setLang(next); saveLang(next); document.documentElement.lang = next;
    setNotice(DICTS[next].noticeLanguage);
    dirty.current = true; scheduleAutosave(0);
  }
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => () => { controller.current?.abort(); recognition.current?.stop(); }, []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, tools, busy, streamingText, changes]);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/config", { signal: abort.signal }).then(r => r.ok ? r.json() : null).then(config => setShareEnabled(Boolean(config?.share))).catch(() => {});
    // Restore the last conversation and read the autosave before anything can overwrite it.
    void (async () => {
      const [list, current, saved] = await Promise.all([listConversations(), storageGet<string>("currentConversation"), storageGet<SavedProject>("project")]);
      setConversations(list);
      const conversation = current ? await loadConversation(current) : undefined;
      if (conversation) { conversationId.current = conversation.id; updateHistory(conversation.messages, false); }
      if (saved?.blob instanceof Blob) { offered.current = saved; setRestoreOffer(saved.savedAt); }
    })().catch(() => {});
    return () => abort.abort();
  }, []);

  function scheduleAutosave(delay = 2500) {
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(async () => {
      if (!dirty.current || !editor.current) return;
      if (operation.current) { scheduleAutosave(); return; } // Saved again after the operation.
      dirty.current = false;
      try { await storageSet("project", { blob: await editor.current.exportProject(), savedAt: Date.now() } satisfies SavedProject); }
      catch { dirty.current = true; }
    }, delay);
  }
  function onEditorChange() {
    if (Date.now() < ignoreChangesUntil.current) return;
    dirty.current = true; scheduleAutosave();
  }
  function updateHistory(next: ChatMessage[], persist = true) {
    history.current = next; setMessages(next);
    if (!persist || !next.length) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const id = conversationId.current;
      void saveConversation({ id, title: titleOf(next), updatedAt: Date.now(), messages: next }).then(list => { setConversations(list); return storageSet("currentConversation", id); }).catch(() => {});
    }, 600);
  }
  function updateTool(event: ToolEvent) { setTools(previous => {
    const index = previous.findIndex(tool => tool.id === event.id);
    return index < 0 ? [...previous, event] : previous.map((tool, i) => i === index ? event : tool);
  }); }
  async function locked(action: (handle: EditorHandle) => Promise<void>) {
    if (operation.current || !ready || !editor.current) return;
    operation.current = true;
    setBusy(true); setError(""); setNotice(""); setStreamingText(""); setStreamingReasoning(""); setShareLink(null);
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
  async function loadProject(handle: EditorHandle, project: Blob) {
    ignoreChangesUntil.current = Date.now() + 3000;
    await handle.loadProject(project);
    ignoreChangesUntil.current = Date.now() + 1500;
  }
  async function pushUndo(handle: EditorHandle) {
    const stack = undoStack.current;
    stack.push(await handle.exportProject());
    while (stack.length > MAX_UNDO || (stack.length > 1 && stack.reduce((sum, blob) => sum + blob.size, 0) > MAX_UNDO_BYTES)) stack.shift();
    setUndoCount(stack.length);
  }
  async function inventory(handle: EditorHandle) {
    try { return await handle.internal?.("inventory", {}) as Inventory | undefined; } catch { return undefined; }
  }
  async function summarize(handle: EditorHandle, before: Inventory | undefined) {
    const after = before && await inventory(handle);
    if (!before || !after) return;
    const summary = diffInventory(before, after, lang === "en"
      ? { stage: "Stage", added: "New sprite", removed: "Deleted", blocks: "blocks", changedBlocks: "edited", removedBlocks: "removed blocks", variables: "variables", costumes: "costumes", sounds: "sounds", renamed: "renamed from" }
      : { stage: "Sân khấu", added: "Sprite mới", removed: "Đã xóa", blocks: "block", changedBlocks: "block sửa", removedBlocks: "block", variables: "biến", costumes: "costume", sounds: "âm thanh", renamed: "đổi tên từ" });
    setChanges(summary);
    if (summary.highlight) void handle.internal?.("highlight", summary.highlight).catch(() => {});
  }
  async function submit(override?: { text: string; mode: AgentMode }) {
    const text = (override?.text ?? prompt).trim();
    const images = override ? [] : attachments;
    if ((!text && !images.length) || busy || !ready) return;
    if (!configured) { setShowSettings(true); return; }
    const turnMode = override?.mode ?? mode;
    const content: UserContent = images.length
      ? [{ type: "text", text: text || t.attachedImage }, ...images.map(a => ({ type: "image_url" as const, image_url: { url: a.url, detail: "high" as const } }))]
      : text;
    if (!override) { setPrompt(""); setAttachments([]); }
    setTools([]); setStreamingText(""); setStreamingReasoning(""); setUsage(null); setChanges(null); setPlanReady(false); setShowHistory(false);
    await locked(async handle => {
      const abort = new AbortController();
      controller.current = abort;
      const before = await inventory(handle);
      abort.signal.throwIfAborted();
      try {
        await runAgent({
          editor: handle, history: history.current, prompt: content, signal: abort.signal,
          onHistory: updateHistory, onTool: updateTool, onUsage: setUsage,
          onStream: (streamText, streamReason) => {
            setStreamingText(streamText);
            setStreamingReasoning(streamReason);
          },
          beforeMutation: () => pushUndo(handle),
          runProviderTool: (name, args, signal) => name === "generate_costume"
            ? generateCostume(handle, settings, args as unknown as CostumeArgs, signal)
            : generateSpeech(handle, settings, args as unknown as SpeechArgs, signal),
          confirmTool: async (name, args) => window.confirm(t.confirmTool(toolLabels[name] ?? name, JSON.stringify(args, null, 2).slice(0, 1500))),
          confirmReplace: async targetId => {
            const project = await handle.tool("get_project", { limit: 200 }) as ProjectInfo;
            const name = project.targets.find(target => target.id === targetId)?.name ?? targetId;
            return window.confirm(t.confirmReplace(name));
          },
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: activeModel,
          reasoningEffort: activeReasoningEffort || null,
          mode: turnMode, language: lang, maxSteps: settings.maxSteps,
        });
        setNotice(t.noticeDone);
        if (turnMode === "plan") setPlanReady(true);
      } catch (error) {
        if (abort.signal.aborted) setNotice(t.noticeStopped);
        else throw error;
      } finally {
        await summarize(handle, before);
        dirty.current = true; scheduleAutosave(500);
      }
    });
  }
  function cancel() { setStopping(true); controller.current?.abort(); }
  async function demo() {
    setTools([]); setChanges(null);
    await locked(async handle => {
      const before = await inventory(handle);
      await pushUndo(handle);
      const project = await handle.tool("get_project", {}) as ProjectInfo;
      const sprite = project.targets.find(target => !target.isStage);
      if (!sprite) throw new Error(t.addSprite);
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
        setNotice(t.noticeDemo);
        await summarize(handle, before);
        dirty.current = true; scheduleAutosave(500);
      } catch (error) { updateTool({ id, name: "add_scripts", status: "error", detail: String(error) }); throw error; }
    });
  }
  async function uploadForAgent(files: FileList | null) {
    if (!files) return;
    await locked(async handle => {
      if (!handle.uploadFile) throw new Error(t.noUploads);
      for (const file of Array.from(files)) {
        const uploaded = await handle.uploadFile(file);
        setUploads(previous => [...previous, uploaded]);
      }
      setNotice(t.noticeUploaded);
    });
  }
  async function addAttachments(files: File[]) {
    const images = files.filter(file => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type));
    if (images.length < files.length) setError(t.attachOnlyImages);
    if (attachments.length + images.length > 3) setError(t.attachLimit);
    const room = Math.max(0, 3 - attachments.length);
    const added: Attachment[] = [];
    for (const file of images.slice(0, room)) {
      try { added.push({ id: crypto.randomUUID(), name: file.name, url: await attachmentUrl(file) }); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }
    if (added.length) setAttachments(previous => [...previous, ...added].slice(0, 3));
  }
  function onPaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData.files);
    if (files.some(file => file.type.startsWith("image/"))) { event.preventDefault(); void addAttachments(files); }
  }
  function onDrop(event: DragEvent) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); void addAttachments(Array.from(event.dataTransfer.files));
  }
  function toggleVoice() {
    if (!Recognition) { setError(t.voiceUnsupported); return; }
    if (listening) { recognition.current?.stop(); return; }
    const r = new Recognition(), base = prompt ? `${prompt.trimEnd()} ` : "";
    r.lang = lang === "en" ? "en-US" : "vi-VN"; r.interimResults = true; r.continuous = false;
    r.onresult = event => setPrompt(base + Array.from(event.results).map(result => result[0].transcript).join(""));
    r.onend = () => { setListening(false); recognition.current = null; };
    r.onerror = () => { setListening(false); recognition.current = null; };
    recognition.current = r; setListening(true); r.start();
  }
  async function undoStep() {
    const snapshot = undoStack.current.at(-1);
    if (!snapshot) return;
    await locked(async handle => {
      await loadProject(handle, snapshot);
      undoStack.current.pop(); setUndoCount(undoStack.current.length);
      setTools([]); setChanges(null);
      if (history.current.length) updateHistory([...history.current, { role: "user", content: t.undoNote }]);
      setNotice(t.noticeUndo);
      dirty.current = true; scheduleAutosave(500);
    });
  }
  async function restoreAutosave() {
    const saved = offered.current;
    if (!saved) return;
    await locked(async handle => {
      await pushUndo(handle);
      await loadProject(handle, saved.blob);
      offered.current = null; setRestoreOffer(null);
      setNotice(t.noticeRestored);
    });
  }
  async function share() {
    await locked(async handle => {
      const blob = await handle.exportProject();
      const response = await fetch("/api/share", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((data as { error?: string }).error ?? t.shareFailed);
      setShareLink({ url: (data as { url: string }).url, days: (data as { expiresInDays?: number }).expiresInDays ?? 30 });
    });
  }
  async function openSharedProject(id: string) {
    await locked(async handle => {
      const response = await fetch(`/api/share/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? t.shareLoadFailed);
      await pushUndo(handle);
      await loadProject(handle, await response.blob());
      setNotice(t.noticeShared);
    });
    const url = new URL(location.href); url.searchParams.delete("share"); window.history.replaceState(null, "", url);
  }
  useEffect(() => {
    if (!ready) return;
    const id = new URLSearchParams(location.search).get("share");
    if (id && /^[A-Za-z0-9_-]{22}$/.test(id)) void openSharedProject(id);
  }, [ready]);
  async function download() {
    await locked(async handle => {
      const blob = await handle.exportProject();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "scratch-vibe.sb3"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function importProject(file: File) {
    if (!file.name.toLowerCase().endsWith(".sb3")) { setError(t.chooseSb3); return; }
    if (!window.confirm(t.confirmOpen)) return;
    await locked(async handle => {
      await pushUndo(handle);
      await loadProject(handle, file);
      updateHistory([]); setTools([]); setChanges(null); setNotice(t.noticeOpened(file.name));
      dirty.current = true; scheduleAutosave(500);
    });
  }
  function newConversation() {
    conversationId.current = crypto.randomUUID();
    void storageSet("currentConversation", conversationId.current).catch(() => {});
    updateHistory([], false); setTools([]); setError(""); setNotice(""); setChanges(null); setUsage(null); setPlanReady(false); setShowHistory(false);
  }
  async function openConversation(id: string) {
    const conversation = await loadConversation(id);
    if (!conversation) return;
    conversationId.current = id;
    void storageSet("currentConversation", id).catch(() => {});
    updateHistory(conversation.messages, false); setTools([]); setChanges(null); setUsage(null); setPlanReady(false); setShowHistory(false);
  }
  async function removeConversation(id: string) {
    setConversations(await deleteConversation(id));
    if (id === conversationId.current) newConversation();
  }

  const visible = messages.filter(message => message.role !== "tool" && !isToolImage(message) && (message.role === "user" || message.content));
  const lastAssistant = [...visible].reverse().find(message => message.role === "assistant");
  return <div className="app">
    <header className="topbar">
      <div className="brand"><div className="brand-icon">✦</div><div><h1>Scratch <span>Vibe</span></h1><p>{t.tagline}</p></div></div>
      <div className="toolbar">
        <span className={`status ${ready ? "online" : ""}`}><i />{ready ? t.editorReady : t.editorLoading}</span>
        <button disabled={!ready || busy} onClick={() => inputFile.current?.click()}>{t.open}</button>
        <button disabled={!ready || busy} onClick={download}>{t.save}</button>
        <button disabled={!ready || busy} onClick={() => agentFiles.current?.click()}>{t.agentFiles}{uploads.length ? ` (${uploads.length})` : ""}</button>
        <input hidden ref={agentFiles} type="file" aria-label={t.agentFilesLabel} multiple accept=".sb3,.sprite3,.svg,.png,.jpg,.jpeg,.wav,.mp3" onChange={event => { void uploadForAgent(event.target.files); event.target.value = ""; }} />
        {shareEnabled && <button disabled={!ready || busy} onClick={share} title={t.shareTitle}>{t.share}</button>}
        <button disabled={!ready || busy || !undoCount} onClick={undoStep} title={t.undoTitle}>{t.undo}{undoCount > 1 ? ` (${undoCount})` : ""}</button>
        <button type="button" disabled={busy} onClick={() => setShowSettings(true)} title={t.settingsTitle}>{t.settings}</button>
        <button type="button" className="lang-button" onClick={switchLanguage} title={t.languageTitle} aria-label={t.languageTitle}>{t.language}</button>
        <input hidden ref={inputFile} type="file" aria-label={t.openLabel} accept=".sb3" onChange={event => { const file = event.target.files?.[0]; if (file) void importProject(file); event.target.value = ""; }} />
      </div>
    </header>
    <main className="workspace">
      <section className="scratch-pane" aria-label="Scratch editor">
        <ScratchEditor ref={editor} locale={editorLocale} onReady={() => { ignoreChangesUntil.current = Date.now() + 3000; setReady(true); }} onChange={onEditorChange} onError={message => { setError(message); setReady(false); }} locked={busy || !ready} lockLabel={!ready ? "Scratch chưa sẵn sàng · Kiểm tra thông báo nếu tải quá lâu" : undefined} />
      </section>
      <aside className="agent-pane">
        <div className="agent-heading"><div><span className="eyebrow">{t.eyebrow}</span><h2>{t.heading} <span>✧</span></h2></div><div className="agent-heading-actions">
          <button type="button" className="icon-button" title={t.historyTitle} aria-label={t.history} aria-expanded={showHistory} disabled={busy} onClick={() => setShowHistory(!showHistory)}>🕘</button>
          <button type="button" className="icon-button" title={t.settingsTitle} aria-label={t.settingsLabel} disabled={busy} onClick={() => setShowSettings(true)}>⚙</button>
          <button className="icon-button" title={t.newChatTitle} aria-label={t.newChat} disabled={busy} onClick={newConversation}>＋</button>
        </div></div>
        {showHistory && <div className="history-panel" aria-label={t.history}>
          {!conversations.length && <p>{t.noHistory}</p>}
          {conversations.map(c => <div key={c.id} className={`history-item ${c.id === conversationId.current ? "active" : ""}`}>
            <button type="button" onClick={() => void openConversation(c.id)}><span>{c.title}</span><small>{new Date(c.updatedAt).toLocaleString(lang === "en" ? "en-US" : "vi-VN")}</small></button>
            <button type="button" className="history-delete" aria-label={t.deleteChat} title={t.deleteChat} onClick={() => void removeConversation(c.id)}>✕</button>
          </div>)}
        </div>}
        <div className="model-line"><span className="model-dot" /><span className="model-name" title={`Model: ${activeModel}`}>{configured ? activeModel : t.editorOnly}</span>{configured && activeReasoningEffort && <span className="thinking-tag" title={`Thinking: ${activeReasoningEffort}`}>{activeReasoningEffort}</span>}{usage && <span className="usage-tag" title={`prompt ${usage.promptTokens} · completion ${usage.completionTokens}`}>{t.tokens(formatTokens(usage.totalTokens))}</span>}<button type="button" className="model-edit-btn" disabled={busy} onClick={() => setShowSettings(true)} title={t.changeTitle}>{t.change}</button><span>{t.toolCalling}</span></div>
        <div className="conversation" aria-live="polite">
          {restoreOffer && <div className="restore-banner"><span>{t.restoreOffer(new Date(restoreOffer).toLocaleString(lang === "en" ? "en-US" : "vi-VN"))}</span><button type="button" disabled={!ready || busy} onClick={restoreAutosave}>{t.restore}</button><button type="button" className="link-button" onClick={() => { offered.current = null; setRestoreOffer(null); }}>{t.dismiss}</button></div>}
          {!messages.length && <div className="welcome">
            <div className="welcome-icon">✦</div><h3>{t.welcomeTitle}</h3><p>{t.welcomeText}</p>
            <h4 className="welcome-section">{t.templates}</h4>
            <div className="templates">{TEMPLATES[lang].map(template => <button key={template.title} disabled={busy} onClick={() => setPrompt(template.prompt)} title={template.prompt}><span>{template.icon}</span>{template.title}</button>)}</div>
            <h4 className="welcome-section">{t.examples}</h4>
            <div className="examples">{EXAMPLES[lang].map((example, index) => <button key={example} disabled={busy} onClick={() => setPrompt(example)}><span>{["↗", "◇", "＋"][index]}</span>{example}</button>)}</div>
            <button className="demo-button" disabled={!ready || busy} onClick={demo}>{t.demo}</button>
          </div>}
          {visible.map((message, index) => <div key={index} className={`message ${message.role}`}><span className="message-label">{message.role === "user" ? t.you : t.assistant}</span>
            {message.role === "assistant" ? <ChatMarkdown content={message.content ?? ""} /> : <UserContentView content={message.content as UserContent} />}
            {planReady && !busy && message === lastAssistant && <button type="button" className="plan-action" onClick={() => { setMode("build"); void submit({ text: t.runPlanPrompt, mode: "build" }); }}>{t.runPlan}</button>}
          </div>)}
          {busy && Boolean(streamingText) && <div className="message assistant streaming"><span className="message-label">{t.assistant} <span className="stream-badge">{t.writing}</span></span><ChatMarkdown content={streamingText} /></div>}
          {changes && <div className="changes-card"><h3>{t.changesTitle}</h3>{changes.lines.length ? <ul>{changes.lines.map(line => <li key={line}>{line}</li>)}</ul> : <p>{t.noChanges}</p>}{changes.highlight && <button type="button" className="link-button" onClick={() => void editor.current?.internal?.("highlight", changes.highlight!)}>{t.showInCode}</button>}</div>}
          {!!tools.length && <div className="tool-log"><h3>{t.activity}</h3>{tools.map(tool => <details key={tool.id} className={`tool ${tool.status}`}><summary><span>{tool.status === "running" ? "◌" : tool.status === "success" ? "✓" : "!"}</span>{toolLabels[tool.name] ?? tool.name}<small>{tool.status === "running" ? t.running : tool.status === "success" ? t.done : tool.name === "assert_state" ? t.failedCheck : t.notRun}</small></summary><ToolDetail tool={tool} waiting={t.waitingScratch} /></details>)}</div>}
          {busy && !streamingText && <div className="thinking"><span className="pulse" />{stopping ? t.stopping : streamingReasoning ? t.thinking(streamingReasoning.length) : t.working}</div>}
          {shareLink && <div className="share-link"><span>{t.shareReady(shareLink.days)}</span><input readOnly value={shareLink.url} onFocus={event => event.target.select()} aria-label={t.share} /><button type="button" onClick={() => { void navigator.clipboard?.writeText(shareLink.url); setNotice(t.copied); }}>{t.copy}</button></div>}
          {notice && <div className="notice" role="status">{notice}</div>}
          {error && <div className="error" role="alert">{error}</div>}
          <div ref={chatEnd} />
        </div>
        <div className="composer-area">
          {!configured && <div className="setup-note">{t.setupNote} <button type="button" className="setup-link" disabled={busy} onClick={() => setShowSettings(true)}>{t.setupLink}</button>{t.setupTail}</div>}
          <form onSubmit={event => { event.preventDefault(); void submit(); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={onDrop}>
            <label className="sr-only" htmlFor="prompt">{t.promptLabel}</label>
            {!!attachments.length && <div className="attachments">{attachments.map(a => <div key={a.id} className="attachment"><img src={a.url} alt={a.name} /><button type="button" aria-label={t.removeAttachment} onClick={() => setAttachments(previous => previous.filter(x => x.id !== a.id))}>✕</button></div>)}</div>}
            <textarea id="prompt" value={prompt} onChange={event => setPrompt(event.target.value)} onPaste={onPaste} maxLength={6000} disabled={busy} placeholder={listening ? t.listening : t.placeholder} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className="chat-model-picker">
              <label htmlFor="chat-model-select">{t.model}</label>
              <select id="chat-model-select" value={activeModel} disabled={busy} onChange={event => handleSaveSettings({ ...settings, model: event.target.value })}>
                {availableModels.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
              <button type="button" className="model-edit-btn" disabled={busy} onClick={() => setShowSettings(true)} title={t.configureTitle}>{t.configure}</button>
            </div>
            <div className="chat-model-picker">
              <label htmlFor="mode-select">{t.mode}</label>
              <select id="mode-select" value={mode} disabled={busy} onChange={event => setMode(event.target.value as AgentMode)} title={t.modeHints[mode]}>
                {(["build", "plan", "explain", "teach"] as const).map(m => <option key={m} value={m}>{t.modes[m]}</option>)}
              </select>
              <span className="mode-hint">{t.modeHints[mode]}</span>
            </div>
            <div className="composer-bottom"><span>{t.hint}</span><div className="composer-actions">
              <button type="button" className="composer-icon" disabled={busy || attachments.length >= 3} onClick={() => imageFiles.current?.click()} title={t.attachTitle} aria-label={t.attach}>📎</button>
              <input hidden ref={imageFiles} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" aria-label={t.attach} onChange={event => { void addAttachments(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              {Recognition && <button type="button" className={`composer-icon ${listening ? "listening" : ""}`} disabled={busy} onClick={toggleVoice} title={t.voiceTitle} aria-label={t.voice} aria-pressed={listening}>🎤</button>}
              {busy && controller.current ? <button type="button" className="stop-button" disabled={stopping} onClick={cancel}>{t.stop}</button> : <button className="send-button" type="submit" disabled={!ready || busy || (!prompt.trim() && !attachments.length) || !configured}>{t.send}</button>}
            </div></div>
          </form>
          <p className="safety-note">{t.safety}</p>
        </div>
      </aside>
    </main>
    <footer>Scratch Vibe <span>{t.footer} · <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">{t.source}</a> · <a href="/scratch-editor/vendor/scratch-gui/LICENSE" target="_blank" rel="noreferrer noopener">{t.scratchLicense}</a> · {t.trademark}</span></footer>
    <SettingsModal
      isOpen={showSettings}
      onClose={() => setShowSettings(false)}
      settings={settings}
      onSave={handleSaveSettings}
      onReset={handleResetSettings}
      lang={lang}
    />
  </div>;
}

function UserContentView({ content }: { content: UserContent }) {
  if (typeof content === "string") return <p className="user-message-text">{content}</p>;
  return <>
    {content.map((part, i) => part.type === "text" ? <p key={i} className="user-message-text">{part.text}</p> : null)}
    <div className="message-images">{content.map((part, i) => part.type === "image_url" ? <img key={i} src={part.image_url.url} alt="" /> : null)}</div>
  </>;
}

const IMAGE_TOOLS = new Set(["capture_stage", "get_costume_image", "generate_costume", "record_run"]);
function ToolDetail({ tool, waiting }: { tool: ToolEvent; waiting: string }) {
  if (IMAGE_TOOLS.has(tool.name) && tool.status === "success" && tool.detail) {
    try {
      const { image, ...rest } = JSON.parse(tool.detail);
      if (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) return <>
        <img className="stage-capture" src={image} alt={tool.name === "capture_stage" ? "Ảnh sân khấu do tool chụp" : `${tool.name} ${rest.name ?? ""}`} />
        {tool.name !== "capture_stage" && <pre>{JSON.stringify(rest, null, 1).slice(0, 4000)}</pre>}
      </>;
    } catch { /* display raw detail below */ }
  }
  return <pre>{tool.detail ?? waiting}</pre>;
}
