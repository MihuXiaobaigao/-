import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { generateBuiltinModels } from "./build-builtin-models.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "www");
if (!output.startsWith(`${root}${sep}`)) throw new Error("Refusing to build outside the project directory.");

await generateBuiltinModels();
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const files = [
  "index.html", "tablet.css", "tablet.js", "features.css", "features.js",
  "runtime.css", "manifest.webmanifest", "sw.js",
];
for (const file of files) await copyFile(join(root, file), join(output, file));
for (const directory of ["assets", "src/web", "vendor/pdfjs"]) {
  await cp(join(root, directory), join(output, directory), { recursive: true });
}

async function relativeFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await relativeFiles(join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

const pdfjsFiles = (await relativeFiles(join(output, "vendor", "pdfjs")))
  .map((file) => `./vendor/pdfjs/${file}`);
await writeFile(
  join(output, "vendor", "pdfjs", "offline-manifest.json"),
  JSON.stringify(pdfjsFiles, null, 2),
  "utf8",
);

const hash = createHash("sha256");
for (const relative of (await relativeFiles(output)).filter((file) => file !== "sw.js")) {
  hash.update(relative);
  hash.update(await readFile(join(output, relative)));
}
const buildId = hash.digest("hex").slice(0, 12);
const serviceWorkerPath = join(output, "sw.js");
const serviceWorker = await readFile(serviceWorkerPath, "utf8");
if (!serviceWorker.includes("__BUILD_ID__")) throw new Error("Service worker build token is missing.");
await writeFile(serviceWorkerPath, serviceWorker.replaceAll("__BUILD_ID__", buildId), "utf8");

console.log(`PWA assets built in ${output} (${pdfjsFiles.length} PDF.js offline resources, cache ${buildId}).`);
