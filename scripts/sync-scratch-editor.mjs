import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, "node_modules/@scratch/scratch-gui-standalone");
const source = join(packageRoot, "dist");
const editor = join(root, "public/scratch-editor");
const vendor = join(editor, "vendor/scratch-gui");
const marker = join(root, ".cache/scratch-editor-assets.json");
// Scratch's prebuilt webpack publicPath is '/'. Unlike the exam-only editor,
// keep lazy chunks and static assets so costume editing/tutorials also work.
const fingerprint = createHash("sha256")
  .update(await readFile(fileURLToPath(import.meta.url)))
  .update(await readFile(join(packageRoot, "package.json")))
  .update(String((await stat(join(source, "scratch-gui-standalone.js"))).mtimeMs))
  .digest("hex");
const required = [
  join(vendor, "scratch-gui-standalone.js"), join(vendor, "LICENSE"),
  join(editor, "extension-worker.js"), join(editor, "static/blocks-media/repeat.svg"),
  join(root, "public/static/assets"), join(root, "public/chunks"),
];
try {
  const previous = JSON.parse(await readFile(marker, "utf8"));
  if (previous.fingerprint === fingerprint) {
    await Promise.all(required.map(path => stat(path)));
    console.log("Scratch editor assets are already up to date.");
    process.exit(0);
  }
} catch { /* First install or changed version. */ }

await Promise.all([vendor, join(editor, "static"), join(root, "public/static"), join(root, "public/chunks"), join(root, "public/libraries")].map(path => rm(path, { recursive: true, force: true })));
await mkdir(vendor, { recursive: true });
await mkdir(join(editor, "static/blocks-media"), { recursive: true });
await Promise.all([
  ...["scratch-gui-standalone.js", "scratch-gui-standalone.js.LICENSE.txt"].map(file => cp(join(source, file), join(vendor, file))),
  ...["extension-worker.js", "extension-worker.js.LICENSE.txt"].map(file => cp(join(source, file), join(editor, file))),
  ...["LICENSE", "TRADEMARK"].map(file => cp(join(packageRoot, file), join(vendor, file))),
  ...["static", "chunks", "libraries"].map(dir => cp(join(source, dir), join(root, "public", dir), { recursive: true })),
  cp(join(source, "static/blocks-media"), join(editor, "static/blocks-media"), { recursive: true }),
  cp(join(source, "static/blocks-media/default/repeat.svg"), join(editor, "static/blocks-media/repeat.svg")),
  ...(await readdir(source)).filter(file => file.endsWith(".hex")).map(file => cp(join(source, file), join(root, "public", file))),
]);
await mkdir(dirname(marker), { recursive: true });
await writeFile(marker, `${JSON.stringify({ fingerprint, generatedAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`Synced Scratch GUI bundle, lazy chunks, static assets and license notices to ${join(root, "public")}`);
