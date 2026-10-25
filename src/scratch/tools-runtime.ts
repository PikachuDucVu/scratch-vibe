import { executeVmTool, type ScratchVm } from "./vm-tools";
import { MUTATING_TOOLS, type ToolName } from "../../shared/tools";
import { uploadFile, type ToolServices } from "./files";

// Separate Vite entry: works in dev and production without modifying the
// upstream Scratch bundle. The same-origin editor bridge owns the VM.
const editorWindow = window.parent as Window & {
  __scratchVibeExecute?: (vm: ScratchVm, name: ToolName, args: unknown, services?: ToolServices) => Promise<unknown>;
  __scratchVibeMutating?: (name: ToolName) => boolean;
  __scratchVibeUpload?: typeof uploadFile;
};
if (editorWindow.location.origin === window.location.origin) {
  editorWindow.__scratchVibeExecute = executeVmTool;
  editorWindow.__scratchVibeMutating = name => MUTATING_TOOLS.has(name);
  editorWindow.__scratchVibeUpload = uploadFile;
  editorWindow.dispatchEvent(new Event("vibe:tools-ready"));
}
