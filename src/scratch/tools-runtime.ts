import { executeVmTool, type ScratchVm } from "./vm-tools";
import type { ToolName } from "../../shared/tools";

// Separate Vite entry: works in dev and production without modifying the
// upstream Scratch bundle. The same-origin editor bridge owns the VM.
const editorWindow = window.parent as Window & {
  __scratchVibeExecute?: (vm: ScratchVm, name: ToolName, args: unknown) => Promise<unknown>;
};
if (editorWindow.location.origin === window.location.origin) {
  editorWindow.__scratchVibeExecute = executeVmTool;
  editorWindow.dispatchEvent(new Event("vibe:tools-ready"));
}
