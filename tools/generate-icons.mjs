import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "assets", "icon.svg");
const source = await readFile(sourcePath, "utf8");

const baseGroup = /  <!-- 1\. App Icon Squircle Base -->[\s\S]*?  <\/g>\n\n/;
if (!baseGroup.test(source)) throw new Error("Could not find the icon background group.");

const fullBleed = source.replace(baseGroup, `  <!-- 1. Full-bleed background -->
  <rect x="0" y="0" width="1024" height="1024" fill="url(#bg-grad)" />
  <rect x="0" y="0" width="1024" height="1024" fill="url(#ambient-glow)" />

`);

const foreground = source
  .replace(baseGroup, "")
  .replace("</defs>", `</defs>
  <g transform="translate(51.2 51.2) scale(0.9)">`)
  .replace("</svg>", `  </g>
</svg>`);

async function render(svg, size, target) {
  await mkdir(resolve(target, ".."), { recursive: true });
  await sharp(Buffer.from(svg))
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toFile(target);
}

await Promise.all([
  render(source, 192, resolve(root, "assets", "icon-192.png")),
  render(source, 512, resolve(root, "assets", "icon-512.png")),
  render(fullBleed, 180, resolve(root, "assets", "icon-180.png")),
  render(fullBleed, 512, resolve(root, "assets", "icon-512-maskable.png")),
]);

const legacySizes = [
  ["mdpi", 48],
  ["hdpi", 72],
  ["xhdpi", 96],
  ["xxhdpi", 144],
  ["xxxhdpi", 192],
];
const foregroundSizes = [
  ["mdpi", 108],
  ["hdpi", 162],
  ["xhdpi", 216],
  ["xxhdpi", 324],
  ["xxxhdpi", 432],
];

for (const [density, size] of legacySizes) {
  const directory = resolve(root, "android", "app", "src", "main", "res", `mipmap-${density}`);
  await Promise.all([
    render(fullBleed, size, resolve(directory, "ic_launcher.png")),
    render(fullBleed, size, resolve(directory, "ic_launcher_round.png")),
  ]);
}

for (const [density, size] of foregroundSizes) {
  const directory = resolve(root, "android", "app", "src", "main", "res", `mipmap-${density}`);
  await render(foreground, size, resolve(directory, "ic_launcher_foreground.png"));
}

console.log("App icons generated from assets/icon.svg.");
