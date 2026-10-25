import { describe, expect, it, vi } from "vitest";
import { graphTool } from "../src/scratch/graph";
import { paginate, type ScratchVm, type VmTarget } from "../src/scratch/vm-types";
import type { VmBlock } from "../shared/compiler";
function fixture() {
  const target = { id: "cat", isStage: false, variables: {}, comments: {}, blocks: { _blocks: {} as Record<string, VmBlock>, scripts: [] as string[],
    getScripts() { return this.scripts; },
    createBlock(block: VmBlock) { this._blocks[block.id] = block; if (block.topLevel) this.scripts.push(block.id); },
    deleteBlock(id: string) { delete this._blocks[id]; this.scripts = this.scripts.filter(i => i !== id); }, resetCache: vi.fn(),
  } } as unknown as VmTarget;
  const vm = { runtime: { getTargetForStage: () => ({ variables: {} }), emitProjectChanged: vi.fn() }, stopAll: vi.fn(), setEditingTarget: vi.fn(), emitWorkspaceUpdate: vi.fn(), emitTargetsUpdate: vi.fn(), extensionManager: { isExtensionLoaded: () => false } } as unknown as ScratchVm;
  return { vm, target };
}
const hat = { opcode: "event_whenflagclicked" };
describe("graph safety and limits", () => {
  it("replaces a full 10000-block target with one block instead of adding old+new counts", () => {
    const { vm, target } = fixture();
    for (let i = 0; i < 10000; i++) target.blocks.createBlock({ id: `old-${i}`, opcode: hat.opcode, parent: null, next: null, inputs: {}, fields: {}, shadow: false, topLevel: true });
    expect(() => graphTool(vm, target, { name: "add_scripts", args: { targetId: "cat", scripts: [[hat]] } })).toThrow(/10.000/);
    expect(vm.stopAll).not.toHaveBeenCalled();
    graphTool(vm, target, { name: "replace_scripts", args: { targetId: "cat", scripts: [[hat]] } });
    expect(Object.keys(target.blocks._blocks)).toHaveLength(1);
    expect(target.blocks.getScripts()).toHaveLength(1);
  });
  it("rejects deleting a referenced procedure before touching VM", () => {
    const { vm, target } = fixture();
    graphTool(vm, target, { name: "define_procedure", args: { targetId: "cat", name: "Do", parameters: [], body: [] } });
    const definition = target.blocks.getScripts()[0];
    graphTool(vm, target, { name: "add_scripts", args: { targetId: "cat", scripts: [[hat, { opcode: "procedures_call", fields: { PROCEDURE: "Do" } }]] } });
    vi.mocked(vm.stopAll).mockClear();
    expect(() => graphTool(vm, target, { name: "delete_script", args: { targetId: "cat", scriptId: definition } })).toThrow(/còn được gọi/);
    expect(vm.stopAll).not.toHaveBeenCalled();
    expect(target.blocks.getScripts()).toHaveLength(2);
  });
  it("paginate advances monotonically and never drops items under a byte budget", () => {
    const input = Array.from({ length: 30 }, (_, i) => ({ i, text: "x".repeat(100) }));
    const found = []; let offset: number | null = 0;
    while (offset !== null) { const page: { items: typeof input; nextOffset: number | null } = paginate(input, offset, 10, 500); found.push(...page.items); offset = page.nextOffset; }
    expect(found).toEqual(input);
  });
});
