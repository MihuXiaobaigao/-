import assert from "node:assert/strict";
import test from "node:test";
import { promptTemplates } from "../src/web/prompts.js";
import { normalizePageOcr } from "../src/web/vision.js";

test("OCR keeps reading blocks and normalized page coordinates", () => {
  const result = normalizePageOcr({
    text: "",
    confidence: 0.88,
    blocks: [
      {
        type: "title",
        text: "Attention in a noisy environment",
        bbox: [0.12, 0.08, 0.88, 0.16],
      },
      {
        type: "formula",
        text: "E = mc²",
        bbox: [0.24, 0.35, 0.76, 0.44],
      },
      { type: "paragraph", text: "Body text without a reliable box." },
      { type: "unknown-type", text: "Fallback paragraph." },
    ],
  });

  assert.equal(result.text, [
    "Attention in a noisy environment",
    "E = mc²",
    "Body text without a reliable box.",
    "Fallback paragraph.",
  ].join("\n\n"));
  assert.deepEqual(result.blocks.map((block) => block.type), [
    "title", "formula", "paragraph", "paragraph",
  ]);
  assert.deepEqual(result.blocks[0].boundingBox, { x: 0.12, y: 0.08, width: 0.76, height: 0.08 });
  assert.equal("boundingBox" in result.blocks[2], false);
  assert.equal(result.confidence, 0.88);
});

test("OCR prompt requests structured blocks without dropping plain text output", () => {
  assert.match(promptTemplates.ocr, /blocks/);
  assert.match(promptTemplates.ocr, /bbox/);
  assert.match(promptTemplates.ocr, /title.*heading.*paragraph.*formula/);
});
