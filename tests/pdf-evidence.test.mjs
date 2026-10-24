import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPageEvidenceLocator,
  rankEvidence,
  splitLongText,
} from "../src/web/knowledge-engine.js";

test("splits long evidence without losing English sentence spaces", () => {
  const chunks = splitLongText(
    "Agents perceive their environment. They plan grounded actions. Evidence remains traceable.",
    46,
  );
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => !/\.\p{Script=Latin}/u.test(chunk)));
  assert.equal(chunks.join(" "), "Agents perceive their environment. They plan grounded actions. Evidence remains traceable.");
});

test("links evidence chunks to blocks, section paths, bounds and visual captions", () => {
  const page = {
    number: 7,
    text: "Methods\n\nAlpha evidence sentence with detail.\n\nFigure 3: Architecture overview.",
    readingLayoutVersion: 4,
    readingQuality: { readingOrder: "recursive-xy-cut" },
    readingBlocks: [
      {
        index: 0, blockId: "p7-b0", type: "heading", text: "Methods",
        sectionPath: ["Methods"], boundingBox: { left: 10, right: 80, bottom: 700, top: 720, width: 70, height: 20 },
      },
      {
        index: 1, blockId: "p7-b1", type: "paragraph", text: "Alpha evidence sentence with detail.",
        sectionPath: ["Methods"], boundingBox: { left: 10, right: 210, bottom: 660, top: 680, width: 200, height: 20 },
        visualRegionIds: ["visual-2"],
      },
      {
        index: 2, blockId: "p7-b2", type: "caption", text: "Figure 3: Architecture overview.",
        sectionPath: ["Methods"], boundingBox: { left: 10, right: 220, bottom: 620, top: 640, width: 210, height: 20 },
      },
    ],
    visualRegions: [{
      id: "visual-2", regionId: "visual-2", visualKind: "figure",
      captionLabel: "Figure 3", captionText: "Figure 3: Architecture overview.",
      captionBlockIndex: 2, pdfRect: { x: 10, y: 645, width: 220, height: 100 },
    }],
  };
  const chunk = "Alpha evidence sentence with detail.";
  const result = buildPageEvidenceLocator(page, chunk, { paragraphId: "p7-1", startOffset: 0 });
  assert.deepEqual(result.locator.blockIds, ["p7-b1"]);
  assert.deepEqual(result.locator.sectionPath, ["Methods"]);
  assert.equal(result.locator.boundingBox.left, 10);
  assert.deepEqual(result.locator.visualRegionIds, ["visual-2"]);
  assert.equal(result.metadata.visualRegions[0].captionLabel, "Figure 3");
});

test("stale source evidence is excluded from knowledge retrieval", () => {
  const base = {
    permanent: true, kind: "source-excerpt", sourceTitle: "Book", capturedAt: "2026-01-01T00:00:00Z",
  };
  const ranked = rankEvidence("alpha evidence", [
    { ...base, id: "active", excerpt: "alpha evidence active", active: true },
    { ...base, id: "stale", excerpt: "alpha evidence stale", active: false, stale: true },
  ]);
  assert.deepEqual(ranked.map((item) => item.id), ["active"]);
});
