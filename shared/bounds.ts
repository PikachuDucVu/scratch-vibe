// Rejects absurdly wide/deep JSON before schema validation. Zod 3 validates every array
// element before applying .max(), so huge arrays would cost memory/CPU (GHSA-mrhx-c7xc-m3w5).
export function withinNodeLimit(value: unknown, maxNodes = 50000, maxDepth = 64) {
  let nodes = 0;
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++nodes > maxNodes || depth > maxDepth) return false;
    if (item && typeof item === "object") for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return true;
}
