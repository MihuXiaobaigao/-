import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "config", "builtin-models.local.json");
const target = resolve(root, "src", "web", "builtin-models.generated.js");

export async function generateBuiltinModels() {
  let config;
  try {
    config = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("缺少 config/builtin-models.local.json，无法生成内置模型。");
    }
    throw error;
  }
  const profiles = (Array.isArray(config?.profiles) ? config.profiles : [])
    .map((profile) => ({
      id: String(profile.id || "").trim(),
      label: String(profile.label || profile.model || "").trim(),
      type: profile.type === "embedding" ? "embedding" : "chat",
      endpoint: String(profile.endpoint || "").trim(),
      model: String(profile.model || "").trim(),
      apiKey: String(profile.apiKey || "").trim(),
      availability: String(profile.availability || "").trim(),
    }))
    .filter((profile) => profile.id && profile.label && profile.endpoint && profile.model && profile.apiKey);
  if (!profiles.length) throw new Error("内置模型配置为空。");
  await writeFile(
    target,
    [
      "// Generated from config/builtin-models.local.json. Do not edit by hand.",
      `export const BUILTIN_MODEL_VERSION = ${Number(config.version) || 1};`,
      `export const BUILTIN_MODELS = Object.freeze(${JSON.stringify(profiles, null, 2)});`,
      "",
    ].join("\n"),
    "utf8",
  );
  return profiles;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const profiles = await generateBuiltinModels();
  console.log(`Built ${profiles.length} built-in model profiles.`);
}
