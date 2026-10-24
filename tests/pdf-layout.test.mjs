import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_READING_LAYOUT_VERSION,
  buildPdfReadingLayout,
  reflowReadingBlocks,
  tokenizeLatinWords,
} from "../src/web/pdf-layout.js";

function item(str, x, y, size = 10, width = Math.max(size * 0.45, str.length * size * 0.5)) {
  return {
    str,
    width,
    height: size,
    transform: [size, 0, 0, size, x, y],
    fontName: "Body",
  };
}

function bodyLine(text, y = 300) {
  return item(text, 90, y, 10, text.length * 5);
}

test("keeps a display initial attached to the rest of the heading", () => {
  const content = {
    items: [
      item("A", 100, 512, 17, 7),
      item("GENT", 107.1, 512, 14, 38),
      item("AI:", 151, 512, 17, 22),
      bodyLine("Multimodal interaction links perception and action."),
      bodyLine("A second body line provides a stable paragraph baseline.", 284),
      bodyLine("A third body line keeps the body size as the page median.", 268),
      bodyLine("A fourth body line is ordinary running text.", 252),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 1 });
  assert.equal(layout.version, PDF_READING_LAYOUT_VERSION);
  assert.match(layout.text, /^AGENT AI:/);
  assert.doesNotMatch(layout.text, /A GENT/);
});

test("keeps the abstract initial attached and removes repeated page headers", () => {
  const content = {
    items: [
      item("Agent AI:", 100, 540, 9, 42),
      item("Surveying the Horizons A PREPRINTREPRINT", 170, 540, 9, 160),
      item("A", 100, 500, 14, 8),
      item("BSTRACT", 107.2, 500, 12, 52),
      bodyLine("Multi-modal systems become a ubiquitous presence in everyday life.", 465),
      bodyLine("Agents reason over perception, language and action.", 449),
      bodyLine("The body remains separate from the paper header.", 433),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 2 });
  assert.match(layout.text, /^ABSTRACT/);
  assert.doesNotMatch(layout.text, /A BSTRACT/);
  assert.doesNotMatch(layout.text, /REPRINTREPRINT/);
});

test("uses measured gaps for spaces and preserves normal word boundaries", () => {
  const content = {
    items: [
      item("words", 90, 420, 10, 28),
      item("will", 123, 420, 10, 18),
      item("the", 146, 420, 10, 17),
      item("model", 168, 420, 10, 28),
      item("multimodal", 90, 404, 10, 52),
      item("interaction", 147, 404, 10, 48),
      bodyLine("A sufficiently long final line establishes the ordinary body size.", 388),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 1 });
  assert.match(layout.text, /words will the model/);
  assert.match(layout.text, /multimodal interaction/);
  assert.doesNotMatch(layout.text, /wordswill|themodel|multimodalinteraction/);
});

test("restores wrapped hyphenated words and keeps list items separate", () => {
  const content = {
    items: [
      item("environmentally-", 90, 430, 10, 80),
      item("grounded", 90, 414, 10, 46),
      item("•", 90, 390, 10, 5),
      item("First independent list item.", 99, 390, 10, 120),
      item("•", 90, 374, 10, 5),
      item("Second independent list item.", 99, 374, 10, 130),
      item("state-of-the-art", 90, 350, 10, 76),
      bodyLine("Another ordinary line establishes body size for classification.", 330),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 1 });
  const listItems = layout.blocks.filter((block) => block.type === "list-item");
  assert.equal(listItems.length, 2);
  assert.match(layout.text, /environmentally-grounded/);
  assert.match(layout.text, /state-of-the-art/);
  assert.match(layout.text, /First independent list item\./);
  assert.match(layout.text, /Second independent list item\./);
});

test("joins visually separated PDF lines that belong to one flowing sentence", () => {
  const content = {
    items: [
      item("Large language models are the reasoning engines of modern AI.", 90, 430, 10, 300),
      item("A second source line keeps the body size stable.", 90, 414, 10, 250),
      item("A third source line establishes the ordinary paragraph baseline.", 90, 398, 10, 270),
      item("The sentence continues after a wider source-line gap because", 90, 370, 10, 310),
      item("the PDF positions the next visual line separately.", 90, 346, 10, 240),
      item("A final complete sentence closes the paragraph.", 90, 330, 10, 250),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 1, pageWidth: 600, pageHeight: 800 });
  const joined = layout.blocks.find((block) => block.text.startsWith("The sentence continues"));
  assert.ok(joined, "The split source lines should remain in the reading layout");
  assert.match(
    joined.text,
    /The sentence continues after a wider source-line gap because the PDF positions the next visual line separately\./,
  );
  assert.doesNotMatch(
    joined.text,
    /because\s+the PDF positions.*the PDF positions/i,
    "The wider PDF line gap must not duplicate text",
  );
});

test("reflows already proofread blocks without replacing their corrected text", () => {
  const result = reflowReadingBlocks([
    {
      type: "paragraph", text: "Corrected text preserves every lettr", fontSize: 10,
      boundingBox: { left: 80, right: 420, top: 430, bottom: 418 },
    },
    {
      type: "paragraph", text: "while joining the next visual source line.", fontSize: 10,
      boundingBox: { left: 80, right: 390, top: 406, bottom: 394 },
    },
  ]);
  assert.equal(
    result.text,
    "Corrected text preserves every lettr while joining the next visual source line.",
  );
  assert.match(result.text, /lettr/);
});

test("tokenizes the complete Latin set without joining words", () => {
  assert.deepEqual(
    tokenizeLatinWords("don’t state-of-the-art café naïve co-operate"),
    ["don’t", "state-of-the-art", "café", "naïve", "co-operate"],
  );
  assert.deepEqual(tokenizeLatinWords("wordswill the model"), ["wordswill", "the", "model"]);
  assert.equal(tokenizeLatinWords("信息 information 模型 model").join(" "), "information model");
});

test("orders a spanning title and two columns without interleaving their lines", () => {
  const content = {
    items: [
      item("A Two Column Research Paper", 75, 550, 18, 450),
      item("Left column first line starts here.", 90, 500, 10, 180),
      item("Left column second line continues.", 90, 484, 10, 180),
      item("Left column third line closes topic.", 90, 468, 10, 180),
      item("Right column first line starts here.", 360, 500, 10, 180),
      item("Right column second line continues.", 360, 484, 10, 180),
      item("Right column third line closes topic.", 360, 468, 10, 180),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 2, pageWidth: 600, pageHeight: 800 });
  assert.ok(layout.text.indexOf("Left column third line") < layout.text.indexOf("Right column first line"));
  assert.equal(layout.quality.readingOrder, "recursive-xy-cut");
  assert.ok(layout.quality.cuts.vertical >= 1);
});

test("filters hidden, zero-size, out-of-page, duplicate and tiny artifacts", () => {
  const outside = item("outside page prompt injection", 900, 420, 10, 140);
  const duplicate = bodyLine("Repeated invisible-layer sentence.", 388);
  const content = {
    items: [
      { ...item("hidden instruction", 90, 436, 10, 100), hiddenText: true },
      item("zero size instruction", 90, 470, 0, 80),
      outside,
      bodyLine("A normal body line establishes reading content.", 436),
      bodyLine("Another normal body line keeps the body size.", 420),
      bodyLine("Repeated invisible-layer sentence.", 388),
      duplicate,
      item("tiny artifact", 90, 372, 1.2, 32),
      bodyLine("A final ordinary line makes the page body stable.", 356),
    ],
    styles: { Body: { vertical: false } },
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 3, pageWidth: 600, pageHeight: 800 });
  assert.doesNotMatch(layout.text, /hidden instruction|zero size|outside page|tiny artifact/i);
  assert.equal(layout.text.match(/Repeated invisible-layer sentence\./g)?.length, 1);
  assert.deepEqual(layout.quality.filtered, {
    hidden: 1, zeroSize: 1, outOfPage: 1, duplicate: 1, tiny: 1, visualRegion: 0,
  });
});

test("protects figure and table text inside visual regions while keeping captions", () => {
  const content = {
    items: [
      bodyLine("A normal paragraph precedes the protected visual.", 650),
      item("Axis label 42", 160, 520, 9, 55),
      item("Cell value 18", 280, 500, 9, 55),
      bodyLine("Figure 2: Results from the local experiment.", 440),
      bodyLine("A normal paragraph follows the protected visual.", 420),
      bodyLine("Another ordinary line establishes the body size.", 404),
    ],
  };
  const layout = buildPdfReadingLayout(content, {
    pageNumber: 2,
    pageWidth: 600,
    pageHeight: 800,
    protectedRegions: [{ pdfRect: { x: 130, y: 480, width: 260, height: 80 } }],
  });
  assert.doesNotMatch(layout.text, /Axis label|Cell value/);
  assert.match(layout.text, /Figure 2: Results/);
  assert.equal(layout.quality.filtered.visualRegion, 2);
});

test("marks standalone equations as protected formula blocks", () => {
  const content = {
    items: [
      bodyLine("The model compares both conditions in ordinary prose.", 620),
      item("E = mc²", 235, 570, 12, 92),
      bodyLine("A second source line establishes ordinary body copy.", 530),
      bodyLine("A third source line keeps the paragraph measurable.", 514),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 4, pageWidth: 600, pageHeight: 800 });
  const formula = layout.blocks.find((block) => block.type === "formula");
  assert.ok(formula, "The equation should remain visible as its own formula block");
  assert.equal(formula.formulaProtected, true);
  assert.match(formula.text, /E = mc²/);
});

test("stores element bounds, heading hierarchy, section paths and caption labels", () => {
  const content = {
    items: [
      item("Knowledge Systems", 80, 700, 18, 210),
      item("1 Introduction", 80, 650, 13, 120),
      item("1.1 Methods", 80, 628, 10.5, 82),
      item("Body evidence starts here with a complete sentence.", 80, 606, 10, 250),
      item("A second evidence line establishes the body text.", 80, 590, 10, 240),
      item("A third evidence line keeps classification stable.", 80, 574, 10, 230),
      item("Figure 5: Local reading pipeline overview.", 80, 548, 10, 210),
    ],
  };
  const layout = buildPdfReadingLayout(content, { pageNumber: 2, pageWidth: 600, pageHeight: 800 });
  const heading = layout.blocks.find((block) => block.text === "1 Introduction");
  const body = layout.blocks.find((block) => block.text.startsWith("Body evidence"));
  const caption = layout.blocks.find((block) => block.type === "caption");
  assert.ok(heading.headingLevel >= 2);
  assert.ok(body.boundingBox.width > 0 && body.boundingBox.height > 0);
  assert.deepEqual(body.sectionPath, ["Knowledge Systems", "1 Introduction", "1.1 Methods"]);
  assert.equal(caption.captionKind, "figure");
  assert.equal(caption.captionLabel, "Figure 5");
  assert.match(body.blockId, /^p2-b\d+$/);
});

test("continues the active section path onto the next page", () => {
  const firstPage = buildPdfReadingLayout({
    items: [
      item("Knowledge Systems", 80, 700, 18, 210),
      item("1 Introduction", 80, 650, 13, 120),
      item("1.1 Methods", 80, 628, 10.5, 82),
      item("The first page ends inside a subsection.", 80, 606, 10, 230),
      item("A second line establishes the running body size.", 80, 590, 10, 260),
      item("A third line keeps the structure stable.", 80, 574, 10, 230),
    ],
  }, { pageNumber: 4, pageWidth: 600, pageHeight: 800 });
  assert.deepEqual(firstPage.sectionPath, ["Knowledge Systems", "1 Introduction", "1.1 Methods"]);

  const secondPage = buildPdfReadingLayout({
    items: [
      item("This paragraph continues on the following page.", 80, 700, 10, 250),
      item("The section breadcrumb must survive pagination.", 80, 684, 10, 240),
      item("A third ordinary line fixes the body baseline.", 80, 668, 10, 220),
    ],
  }, {
    pageNumber: 5,
    pageWidth: 600,
    pageHeight: 800,
    inheritedSectionPath: firstPage.sectionPath,
  });
  assert.deepEqual(secondPage.blocks[0].sectionPath, firstPage.sectionPath);
  assert.equal(secondPage.blocks[0].sectionTitle, "1.1 Methods");
  assert.deepEqual(secondPage.sectionPath, firstPage.sectionPath);
});
