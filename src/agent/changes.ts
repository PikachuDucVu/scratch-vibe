// Compares two editor inventories (before/after an agent turn) to show what the AI changed.
export interface InventoryTarget { id: string; name: string; isStage: boolean; blocks: Record<string, string>; variables: string[]; costumes: string[]; sounds: string[] }
export interface Inventory { targets: InventoryTarget[] }
export interface ChangeSummary { lines: string[]; highlight?: { targetId: string; blockIds: string[] } }

const label = (value: string) => value.replace(/#[^#]*$/, "").replace(/^[^:]*:/, "");
function setDiff(before: string[], after: string[]) {
  const a = new Set(before), b = new Set(after);
  return { added: after.filter(x => !a.has(x)), removed: before.filter(x => !b.has(x)) };
}
export function diffInventory(before: Inventory, after: Inventory, text: { stage: string; added: string; removed: string; blocks: string; changedBlocks: string; removedBlocks: string; variables: string; costumes: string; sounds: string; renamed: string }): ChangeSummary {
  const lines: string[] = [];
  let highlight: ChangeSummary["highlight"];
  const old = new Map(before.targets.map(t => [t.id, t]));
  const name = (t: InventoryTarget) => t.isStage ? text.stage : t.name;
  for (const target of after.targets) {
    const prev = old.get(target.id);
    if (!prev) { lines.push(`${text.added}: ${name(target)}`); continue; }
    old.delete(target.id);
    const parts: string[] = [];
    if (prev.name !== target.name && !target.isStage) parts.push(`${text.renamed} “${prev.name}”`);
    const added = Object.keys(target.blocks).filter(id => !(id in prev.blocks));
    const changed = Object.keys(target.blocks).filter(id => id in prev.blocks && prev.blocks[id] !== target.blocks[id]);
    const removed = Object.keys(prev.blocks).filter(id => !(id in target.blocks));
    if (added.length) parts.push(`+${added.length} ${text.blocks}`);
    if (changed.length) parts.push(`${changed.length} ${text.changedBlocks}`);
    if (removed.length) parts.push(`−${removed.length} ${text.removedBlocks}`);
    for (const [kind, key] of [[text.variables, "variables"], [text.costumes, "costumes"], [text.sounds, "sounds"]] as const) {
      const d = setDiff(prev[key], target[key]);
      if (d.added.length) parts.push(`+${kind}: ${d.added.map(label).join(", ")}`);
      if (d.removed.length) parts.push(`−${kind}: ${d.removed.map(label).join(", ")}`);
    }
    if (parts.length) lines.push(`${name(target)}: ${parts.join(" · ")}`);
    if (!highlight && (added.length || changed.length)) highlight = { targetId: target.id, blockIds: [...added, ...changed].slice(0, 500) };
  }
  for (const target of old.values()) lines.push(`${text.removed}: ${name(target)}`);
  return { lines, highlight };
}
