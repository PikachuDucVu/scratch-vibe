import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { parseTool } from "../../shared/tools";

export interface EditorHandle {
  tool(name: string, args: unknown): Promise<unknown>;
  exportProject(): Promise<Blob>;
  loadProject(project: Blob): Promise<void>;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; expected: string }

export const ScratchEditor = forwardRef<EditorHandle, { onReady(): void; onError(message: string): void; locked: boolean; lockLabel?: string }>(function ScratchEditor({ onReady, onError, locked, lockLabel }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef(new Map<string, Pending>());
  const ready = useRef(false);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const request = useCallback((type: string, expected: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []) => {
    if (!ready.current || !frame.current?.contentWindow) return Promise.reject(new Error("Scratch chưa sẵn sàng."));
    const requestId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        ready.current = false;
        const message = "Scratch hết thời gian chờ; thao tác đang chạy có thể chưa kết thúc. Hãy tải lại trang trước khi tiếp tục.";
        callbacks.current.onError(message);
        reject(new Error(message));
      }, 90000);
      pending.current.set(requestId, { resolve, reject, timer, expected });
      try { frame.current!.contentWindow!.postMessage({ type, requestId, ...payload }, window.location.origin, transfer); }
      catch (error) { clearTimeout(timer); pending.current.delete(requestId); reject(error); }
    });
  }, []);
  useImperativeHandle(ref, () => ({
    async tool(name, args) {
      const validated = parseTool(name, args);
      return request("scratch:tool", "scratch:result", { name, args: validated });
    },
    async exportProject() {
      const data = await request("scratch:export", "scratch:exported") as ArrayBuffer;
      return new Blob([data], { type: "application/x.scratch.sb3" });
    },
    async loadProject(project) {
      if (project.size > 50 * 1024 * 1024) throw new Error("File .sb3 vượt 50 MB.");
      const buffer = await project.arrayBuffer();
      await request("scratch:loadProject", "scratch:loaded", { project: buffer }, [buffer]);
    },
  }), [request]);
  useEffect(() => {
    const requests = pending.current;
    const startupTimer = setTimeout(() => {
      if (!ready.current) callbacks.current.onError("Scratch tải quá lâu. Kiểm tra mạng/CDN rồi tải lại trang.");
    }, 60000);
    function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "scratch:ready") {
        ready.current = true;
        clearTimeout(startupTimer);
        callbacks.current.onReady();
        return;
      }
      if (data.type === "scratch:error" && data.requestId === "startup" && typeof data.message === "string") {
        callbacks.current.onError(data.message); return;
      }
      const item = requests.get(data.requestId);
      if (!item) return;
      if (data.type !== item.expected && data.type !== "scratch:error") return;
      if (data.type === "scratch:exported" && !(data.project instanceof ArrayBuffer)) return;
      requests.delete(data.requestId);
      clearTimeout(item.timer);
      if (data.type === "scratch:error") item.reject(new Error(typeof data.message === "string" ? data.message : "Scratch request thất bại."));
      else item.resolve(data.type === "scratch:exported" ? data.project : data.result);
    }
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      clearTimeout(startupTimer);
      ready.current = false;
      for (const item of requests.values()) { clearTimeout(item.timer); item.reject(new Error("Editor đã đóng.")); }
      requests.clear();
    };
  }, []);
  return <div className="editor-host">
    <iframe ref={frame} src="/scratch-editor/index.html" title="Trình lập trình Scratch" allow="microphone" inert={locked} tabIndex={locked ? -1 : 0} />
    {locked && <div className="editor-lock" aria-label="Editor tạm khóa"><span>{lockLabel ?? "Agent đang thao tác · Nhấn Dừng để chỉnh tay"}</span></div>}
  </div>;
});
