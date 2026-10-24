export const PDF_READING_LAYOUT_VERSION = 8;

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/u;
const LATIN_WORD_RE = /[\p{Script=Latin}]+(?:[’'][\p{Script=Latin}]+)*(?:-[\p{Script=Latin}]+)*/gu;
const BULLET_RE = /^(?:[•·▪◦‣●]|[-–—])\s*(.+)$/u;
const ORDERED_ITEM_RE = /^(?:\d{1,3}[.)]|[a-zA-Z][.)])\s+\S/u;
const HEADING_NUMBER_RE = /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)+|[A-Z]\.|[IVX]+\.)\s+\S/u;
const CAPTION_RE = /^(?:figure|fig\.|table|algorithm|listing|formula|equation)\s*[A-Za-z]?\d+(?:[.:]|\s)/iu;
const NAMED_HEADING_RE = /^(?:abstract|contents|references|bibliography|appendix|acknowledg(?:e)?ments?|author biographies|ethical considerations|broader impact statement)\b/iu;
const TERMINAL_PUNCTUATION_RE = /[.!?。！？:;]$/u;
const MATH_FONT_RE = /(?:math|symbol|stix|cmmi|cmsy|cmex|msam|msbm|rsfs|txsy|wasy|eufm|esint)/iu;
const MATH_SYMBOL_RE = /[\p{Sm}\p{Sk}\u0370-\u03ff\u2070-\u209f]/gu;
const FORMULA_OPERATOR_RE = /[=<>≤≥≈≠±×÷∑∏∫√∞∂∇∈∉∩∪⊂⊃⊆⊇→←↔⟶⟵^_]/u;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function visibleLength(value) {
  return Array.from(String(value || "").replace(/\s+/g, "")).length;
}

function weightedMedian(entries) {
  const sorted = entries
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= total / 2) return entry.value;
  }
  return sorted.at(-1)?.value || 0;
}

function itemFontSize(item) {
  const transform = item.transform || [];
  const transformed = Math.hypot(finite(transform[2]), finite(transform[3]));
  return Math.max(0, finite(item.height), transformed);
}

function explicitHidden(item) {
  return item?.hiddenText === true || item?.isHidden === true || item?.hidden === true ||
    item?.visibility === "hidden" || item?.visibility === "invisible";
}

function normalizedItemText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isVerticalItem(item, styles) {
  const transform = item.transform || [];
  const style = styles?.[item.fontName];
  if (style?.vertical) return true;
  const horizontal = Math.abs(finite(transform[0])) + Math.abs(finite(transform[2]));
  const vertical = Math.abs(finite(transform[1])) + Math.abs(finite(transform[3]));
  return horizontal > 0 && vertical > horizontal * 3.2;
}

function isLikelyFormula(item, styles) {
  const text = String(item?.str || "").trim();
  if (!text) return false;
  const style = styles?.[item?.fontName];
  const fontIdentity = `${item?.fontName || ""} ${style?.fontFamily || ""}`;
  if (MATH_FONT_RE.test(fontIdentity) && !/^[A-Za-z][A-Za-z ,.'-]{28,}$/u.test(text)) return true;
  const compact = Array.from(text.replace(/\s+/gu, ""));
  if (!compact.length) return false;
  const symbols = text.match(MATH_SYMBOL_RE)?.length || 0;
  const hasOperator = FORMULA_OPERATOR_RE.test(text);
  if (symbols >= 2 && symbols / compact.length >= 0.08) return true;
  return hasOperator && symbols > 0 && compact.length <= 24;
}

function itemCenterInsideRegion(item, region) {
  const rect = region?.pdfRect || region;
  if (!rect || !Number.isFinite(Number(rect.x)) || !Number.isFinite(Number(rect.y))) return false;
  const left = Number(rect.x);
  const bottom = Number(rect.y);
  const right = left + Math.max(0, Number(rect.width));
  const top = bottom + Math.max(0, Number(rect.height));
  const centerX = item.x + item.width / 2;
  const centerY = item.y + item.size * 0.42;
  return centerX >= left && centerX <= right && centerY >= bottom && centerY <= top;
}

function shouldInsertSpace(previous, next) {
  if (!previous || !next) return false;
  if (/[([{“‘]$/u.test(previous) || /^[)\]},.;:!?%…”’]/u.test(next)) return false;
  if (CJK_RE.test(previous.at(-1) || "") && CJK_RE.test(next[0] || "")) return false;
  return true;
}

function joinLineItems(items) {
  const sorted = [...items].sort((left, right) => left.x - right.x || left.index - right.index);
  let output = "";
  let previousEnd = null;
  let previousSize = 0;
  let pendingSpace = false;

  for (const item of sorted) {
    const raw = String(item.str || "").replace(/\u00a0/g, " ");
    const piece = raw.replace(/\s+/g, " ").trim();
    if (!piece) {
      pendingSpace = true;
      previousEnd = item.x + item.width;
      continue;
    }
    const gap = previousEnd === null ? 0 : item.x - previousEnd;
    const gapThreshold = Math.max(0.7, Math.min(previousSize || item.size, item.size) * 0.17);
    const needsSpace = pendingSpace || gap > gapThreshold;
    if (!needsSpace && piece.length > 2 && output.endsWith(piece)) {
      previousEnd = item.x + item.width;
      previousSize = item.size;
      continue;
    }
    if (output && needsSpace && shouldInsertSpace(output, piece)) output += " ";
    output += piece;
    pendingSpace = /\s$/u.test(raw);
    previousEnd = item.x + item.width;
    previousSize = item.size;
  }

  return output
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?%])/gu, "$1")
    .replace(/([([{])\s+/gu, "$1")
    .replace(/\b([A-Z]{4,})\1\b/gu, "$1")
    .replace(/\bA P(?=\s*REPRINT\b)/u, "A PREPRINT")
    .trim();
}

function unionBounds(left, right) {
  if (!left) return { ...right };
  if (!right) return { ...left };
  return {
    left: Math.min(left.left, right.left),
    right: Math.max(left.right, right.right),
    bottom: Math.min(left.bottom, right.bottom),
    top: Math.max(left.top, right.top),
  };
}

function lineBoundingBox(line) {
  return line.bounds || {
    left: line.x,
    right: line.x + Math.max(0, line.width || 0),
    bottom: line.y - Math.max(line.fontSize || 0, 1) * 0.24,
    top: line.y + Math.max(line.fontSize || 0, 1) * 0.92,
  };
}

function publicBoundingBox(bounds) {
  if (!bounds) return null;
  return {
    left: bounds.left,
    bottom: bounds.bottom,
    right: bounds.right,
    top: bounds.top,
    width: Math.max(0, bounds.right - bounds.left),
    height: Math.max(0, bounds.top - bounds.bottom),
  };
}

export function reflowReadingBlocks(blocks, options = {}) {
  const source = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && String(block.text || "").trim())
    .map((block) => ({ ...block }));
  if (source.length < 2) {
    return {
      blocks: source.map((block, index) => ({ ...block, index })),
      text: source.map((block) => block.text).join("\n\n"),
    };
  }
  const sizes = source
    .filter((block) => block.type === "paragraph")
    .map((block) => finite(block.fontSize))
    .filter((size) => size > 0)
    .sort((left, right) => left - right);
  const bodySize = Number(options.bodySize) || sizes[Math.floor(sizes.length / 2)] || 10;
  const merged = [];
  for (const block of source) {
    const previous = merged.at(-1);
    if (previous?.type === "paragraph" && block.type === "paragraph" &&
        !TERMINAL_PUNCTUATION_RE.test(previous.text)) {
      const previousBox = previous.boundingBox;
      const blockBox = block.boundingBox;
      const previousLeft = previousBox?.left ?? finite(previous.x);
      const blockLeft = blockBox?.left ?? finite(block.x);
      const previousRight = previousBox?.right ?? previousLeft + finite(previous.width);
      const blockRight = blockBox?.right ?? blockLeft + finite(block.width);
      const overlap = Math.min(previousRight, blockRight) - Math.max(previousLeft, blockLeft);
      const verticalGap = previousBox && blockBox
        ? previousBox.bottom - blockBox.top
        : finite(previous.y) - finite(block.y);
      if (overlap >= bodySize && verticalGap <= bodySize * 2.65) {
        previous.text = appendWrappedText(previous.text, block.text);
        if (previousBox && blockBox) {
          previous.boundingBox = publicBoundingBox(unionBounds(previousBox, blockBox));
          previous.topY = previous.boundingBox.top;
          previous.bottomY = previous.boundingBox.bottom;
        }
        previous.lineCount = Number(previous.lineCount || 1) + Number(block.lineCount || 1);
        continue;
      }
    }
    merged.push(block);
  }
  return {
    blocks: merged.map((block, index) => ({ ...block, index })),
    text: merged.map((block) => block.text).join("\n\n"),
  };
}

function findLargestGap(intervals, minimumGap) {
  if (!Array.isArray(intervals) || intervals.length < 2) return null;
  const sorted = intervals
    .filter((interval) => interval && Number.isFinite(interval.start) && Number.isFinite(interval.end))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (sorted.length < 2) return null;
  let currentEnd = sorted[0].end;
  let best = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const interval = sorted[index];
    const gap = interval.start - currentEnd;
    if (gap >= minimumGap && (!best || gap > best.gap)) {
      best = { position: currentEnd + gap / 2, gap };
    }
    currentEnd = Math.max(currentEnd, interval.end);
  }
  return best;
}

function recursiveReadingOrder(lines, bodySize, cuts = { horizontal: 0, vertical: 0 }) {
  if (lines.length <= 1) return lines;
  const verticalGap = findLargestGap(
    lines.map((line) => ({ start: lineBoundingBox(line).left, end: lineBoundingBox(line).right })),
    Math.max(5, bodySize * 0.8),
  );
  const horizontalGap = findLargestGap(
    lines.map((line) => ({ start: lineBoundingBox(line).bottom, end: lineBoundingBox(line).top })),
    Math.max(4.5, bodySize * 0.58),
  );
  if (!verticalGap && !horizontalGap) {
    return [...lines].sort((left, right) => right.y - left.y || left.x - right.x);
  }
  const verticalScore = verticalGap ? verticalGap.gap / Math.max(1, bodySize) : -1;
  const horizontalScore = horizontalGap ? horizontalGap.gap / Math.max(1, bodySize) : -1;
  const useVertical = Boolean(verticalGap && verticalScore > horizontalScore);
  const cut = (useVertical ? verticalGap : horizontalGap).position;
  const first = [];
  const second = [];
  for (const line of lines) {
    const bounds = lineBoundingBox(line);
    const center = useVertical
      ? (bounds.left + bounds.right) / 2
      : (bounds.bottom + bounds.top) / 2;
    if (useVertical) (center < cut ? first : second).push(line);
    else (center > cut ? first : second).push(line);
  }
  if (!first.length || !second.length) {
    return [...lines].sort((left, right) => right.y - left.y || left.x - right.x);
  }
  if (useVertical) cuts.vertical += 1;
  else cuts.horizontal += 1;
  return [...recursiveReadingOrder(first, bodySize, cuts), ...recursiveReadingOrder(second, bodySize, cuts)];
}

function buildLines(content, options = {}) {
  const styles = content?.styles || {};
  const hiddenItemIndexes = options.hiddenItemIndexes instanceof Set
    ? options.hiddenItemIndexes
    : new Set(Array.isArray(options.hiddenItemIndexes) ? options.hiddenItemIndexes : []);
  const protectedRegions = Array.isArray(options.protectedRegions) ? options.protectedRegions : [];
  const pageWidth = Math.max(0, finite(options.pageWidth));
  const pageHeight = Math.max(0, finite(options.pageHeight));
  const outsideMargin = Math.max(3, Math.min(pageWidth || 600, pageHeight || 800) * 0.012);
  const filtered = { hidden: 0, zeroSize: 0, outOfPage: 0, duplicate: 0, tiny: 0, visualRegion: 0 };
  const duplicateBuckets = new Map();
  const items = [];
  let replacementCharacters = 0;

  for (let index = 0; index < (content?.items || []).length; index += 1) {
    const item = content.items[index];
    const transform = item?.transform || [];
    const str = String(item?.str || "");
    const size = itemFontSize(item || {});
    const x = finite(transform[4]);
    const y = finite(transform[5]);
    const width = Math.max(0, finite(item?.width));
    const bounds = { left: x, right: x + width, bottom: y - size * 0.24, top: y + size * 0.92 };
    const visibleText = str.trim().length > 0;
    if (explicitHidden(item) || hiddenItemIndexes.has(index)) {
      if (visibleText) filtered.hidden += 1;
      continue;
    }
    if (visibleText && size <= 0.08) {
      filtered.zeroSize += 1;
      continue;
    }
    if (visibleText && pageWidth > 0 && pageHeight > 0 &&
        (bounds.right < -outsideMargin || bounds.left > pageWidth + outsideMargin ||
          bounds.top < -outsideMargin || bounds.bottom > pageHeight + outsideMargin)) {
      filtered.outOfPage += 1;
      continue;
    }
    if (isVerticalItem(item || {}, styles)) continue;
    replacementCharacters += (str.match(/\ufffd/gu) || []).length;
    const candidate = {
      index, str, x, y, width, size,
      fontName: item?.fontName || "", hasEOL: Boolean(item?.hasEOL), bounds,
      formula: isLikelyFormula(item || {}, styles),
    };
    if (visibleText && protectedRegions.some((region) => itemCenterInsideRegion(candidate, region))) {
      filtered.visualRegion += 1;
      continue;
    }
    let duplicate = false;
    const key = normalizedItemText(str);
    if (visibleText && key) {
      const bucket = duplicateBuckets.get(key) || [];
      duplicate = bucket.some((other) => Math.abs(other.x - x) <= 1.35 &&
        Math.abs(other.y - y) <= 1.35 && Math.abs(other.size - size) <= 0.75 &&
        Math.abs(other.width - width) <= Math.max(1.5, width * 0.08));
      if (!duplicate) bucket.push(candidate);
      duplicateBuckets.set(key, bucket);
    }
    if (duplicate) {
      filtered.duplicate += 1;
      continue;
    }
    items.push(candidate);
  }

  items.sort((left, right) => right.y - left.y || left.x - right.x || left.index - right.index);

  const rawLines = [];
  for (const item of items) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of rawLines) {
      const tolerance = Math.max(2.8, Math.max(line.maxSize, item.size) * 0.58);
      const distance = Math.abs(line.baseline - item.y);
      if (distance <= tolerance && distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (!best) {
      best = { baseline: item.y, items: [], maxSize: item.size };
      rawLines.push(best);
    }
    best.items.push(item);
    best.maxSize = Math.max(best.maxSize, item.size);
  }

  const fragments = [];
  for (const rawLine of rawLines) {
    const ordered = [...rawLine.items].sort((left, right) => left.x - right.x);
    let fragment = [];
    let previous = null;
    for (const item of ordered) {
      const gap = previous ? item.x - (previous.x + previous.width) : 0;
      if (fragment.length && gap > Math.max(10, rawLine.maxSize * 1.8)) {
        fragments.push(fragment);
        fragment = [];
      }
      fragment.push(item);
      previous = item;
    }
    if (fragment.length) fragments.push(fragment);
  }

  let lines = fragments
    .map((fragment) => {
      const visibleItems = fragment.filter((item) => item.str.trim());
      const text = joinLineItems(fragment);
      if (!visibleItems.length || !text) return null;
      const dominantEntries = visibleItems.map((item) => ({ value: item.y, weight: visibleLength(item.str) }));
      const baseline = weightedMedian(dominantEntries) || visibleItems[0].y;
      const sizeEntries = visibleItems.map((item) => ({ value: item.size, weight: visibleLength(item.str) }));
      const fontSize = weightedMedian(sizeEntries) || Math.max(...visibleItems.map((item) => item.size));
      const fontMass = new Map();
      for (const item of visibleItems) {
        fontMass.set(item.fontName, (fontMass.get(item.fontName) || 0) + visibleLength(item.str));
      }
      const dominantFont = [...fontMass.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
      const bounds = visibleItems.reduce((value, item) => unionBounds(value, item.bounds), null);
      return {
        text,
        x: Math.min(...visibleItems.map((item) => item.x)),
        y: baseline,
        fontSize,
        maxSize: Math.max(...visibleItems.map((item) => item.size)),
        fontName: dominantFont,
        width: Math.max(0, bounds.right - bounds.left),
        height: Math.max(0, bounds.top - bounds.bottom),
        bounds,
        formulaItems: visibleItems
          .filter((item) => item.formula)
          .map((item) => item.str.trim())
          .filter(Boolean),
      };
    })
    .filter(Boolean);

  const sizeMass = new Map();
  for (const line of lines) {
    const key = (Math.round(line.fontSize * 10) / 10).toFixed(1);
    sizeMass.set(key, (sizeMass.get(key) || 0) + visibleLength(line.text));
  }
  const bodySize = Number([...sizeMass.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0]) || 10;
  const beforeTinyFilter = lines.length;
  lines = lines.filter((line) => line.fontSize > bodySize * 0.22);
  filtered.tiny += beforeTinyFilter - lines.length;
  const totalCharacters = lines.reduce((total, line) => total + line.text.length, 0);
  return {
    lines,
    bodySize,
    diagnostics: {
      filtered,
      replacementCharacterRatio: replacementCharacters / Math.max(1, totalCharacters + replacementCharacters),
      pageWidth,
      pageHeight,
    },
  };
}

function appendWrappedText(previous, next) {
  if (!previous) return next;
  if (/[‐‑-]$/u.test(previous) && /^[a-z]/u.test(next)) return `${previous}${next}`;
  return `${previous} ${next}`.replace(/\s+/gu, " ").trim();
}

function isFormulaLine(line) {
  const text = String(line?.text || "").trim();
  if (!text) return false;
  const formulaText = (line.formulaItems || []).join(" ");
  const formulaLength = visibleLength(formulaText);
  if (formulaLength > 0 && formulaLength / visibleLength(text) >= 0.52) return true;
  const mathSymbols = text.match(MATH_SYMBOL_RE)?.length || 0;
  const longWords = text.match(/[A-Za-z]{3,}/gu)?.length || 0;
  const equationShape = /[\p{L}\d)\]}]\s*[=≈≠≤≥<>]\s*[-\p{L}\d(\\√∫]/u.test(text);
  return equationShape && longWords <= 2 ||
    mathSymbols >= 2 && (FORMULA_OPERATOR_RE.test(text) || mathSymbols >= 4) && longWords <= 2;
}

function classifyLine(line, context) {
  const text = line.text.trim();
  if (!text) return null;
  if (isFormulaLine(line)) return { type: "formula", text, formulaProtected: true };
  if (/^arXiv:/iu.test(text)) return { type: "header", text };
  if (/^\d{1,4}$/u.test(text) && line.y <= context.minY + context.bodySize * 0.8) return null;
  const header = line.y >= context.maxY - context.bodySize * 2.25 && line.fontSize <= context.bodySize * 1.28;
  if (header && context.pageNumber > 1) return { type: "header", text };
  const topOfFirstPage = context.pageNumber === 1 && line.y >= context.maxY - context.bodySize * 7;
  if (topOfFirstPage && line.fontSize >= context.bodySize * 1.12) return { type: "title", text, headingLevel: 1 };
  const bullet = text.match(BULLET_RE);
  if (bullet) return { type: "list-item", text: bullet[1].trim() };
  if (ORDERED_ITEM_RE.test(text)) return { type: "list-item", text };
  const caption = text.match(CAPTION_RE);
  if (caption) {
    const rawKind = caption[0].trim().toLocaleLowerCase("en");
    const kind = rawKind.startsWith("fig") ? "figure" : rawKind.startsWith("tab") ? "table" :
      rawKind.startsWith("alg") ? "algorithm" : rawKind.startsWith("list") ? "listing" : "formula";
    const labelMatch = text.match(/^(figure|fig\.?|table|algorithm|listing|formula|equation)\s*([A-Za-z]?\d+)/iu);
    return { type: "caption", text, captionKind: kind, captionLabel: labelMatch ? `${labelMatch[1]} ${labelMatch[2]}` : text.slice(0, 32) };
  }
  if (line.fontSize >= context.bodySize * 1.48) return { type: "title", text, headingLevel: 1 };
  if (line.fontSize >= context.bodySize * 1.13 || NAMED_HEADING_RE.test(text)) {
    return { type: "heading", text, headingLevel: line.fontSize >= context.bodySize * 1.3 ? 2 : 3 };
  }
  if ((HEADING_NUMBER_RE.test(text) && line.fontName !== context.bodyFont) ||
      (HEADING_NUMBER_RE.test(text) && line.fontSize >= context.bodySize * 0.94 && text.length <= 120)) {
    return { type: "subheading", text, headingLevel: 4 };
  }
  if (line.fontSize <= context.bodySize * 0.9 && line.y < context.maxY * 0.2) return { type: "footnote", text };
  return { type: "paragraph", text };
}

function lineInSameColumn(block, line, bodySize) {
  const box = block.boundingBox;
  const lineBox = lineBoundingBox(line);
  const overlap = Math.max(0, Math.min(box.right, lineBox.right) - Math.max(box.left, lineBox.left));
  const overlapRatio = overlap / Math.max(1, lineBox.right - lineBox.left);
  return overlapRatio >= 0.24 || Math.abs(line.x - block.x) <= bodySize * 3;
}

function lineOverlapsBlockHorizontally(block, line) {
  const box = block.boundingBox;
  const lineBox = lineBoundingBox(line);
  return Math.min(box.right, lineBox.right) > Math.max(box.left, lineBox.left);
}

function appendLineToBlock(block, line, text) {
  const previousBounds = {
    left: block.boundingBox.left,
    right: block.boundingBox.right,
    bottom: block.boundingBox.bottom,
    top: block.boundingBox.top,
  };
  const bounds = unionBounds(previousBounds, lineBoundingBox(line));
  block.text = appendWrappedText(block.text, text);
  block.y = line.y;
  block.lastX = line.x;
  block.topY = bounds.top;
  block.bottomY = bounds.bottom;
  block.boundingBox = publicBoundingBox(bounds);
  block.lineCount = (block.lineCount || 1) + 1;
  return block;
}

function mergeBlocks(classifiedLines, bodySize) {
  const blocks = [];
  for (const entry of classifiedLines) {
    const previous = blocks.at(-1);
    const gap = previous ? previous.y - entry.line.y : Number.POSITIVE_INFINITY;
    const continuationGap = bodySize * 1.7;
    const sameColumn = previous ? lineInSameColumn(previous, entry.line, bodySize) : false;

    if (previous?.type === "list-item" && entry.block.type === "paragraph" &&
        sameColumn && gap <= continuationGap && entry.line.x >= previous.x - bodySize * 0.8) {
      appendLineToBlock(previous, entry.line, entry.block.text);
      continue;
    }
    if (previous?.type === "caption" && entry.block.type === "paragraph" &&
        sameColumn && gap <= bodySize * 1.65 && entry.line.x <= previous.x + bodySize * 2) {
      appendLineToBlock(previous, entry.line, entry.block.text);
      continue;
    }
    if (previous?.type === "paragraph" && entry.block.type === "paragraph") {
      const similarIndent = Math.abs(entry.line.x - (previous.lastX ?? previous.x)) <= bodySize * 4;
      const continuationMarks = !TERMINAL_PUNCTUATION_RE.test(previous.text) && gap <= bodySize * 2.65;
      if (sameColumn && (continuationMarks || (similarIndent && gap <= continuationGap))) {
        appendLineToBlock(previous, entry.line, entry.block.text);
        continue;
      }
    }
    if (previous?.type === "heading" && entry.block.type === "paragraph" &&
        sameColumn && gap <= bodySize * 1.4) {
      appendLineToBlock(previous, entry.line, entry.block.text);
      continue;
    }
    if (previous?.type === "title" && entry.block.type === "title" &&
        lineOverlapsBlockHorizontally(previous, entry.line) && gap <= bodySize * 2.2) {
      appendLineToBlock(previous, entry.line, entry.block.text);
      continue;
    }

    const box = lineBoundingBox(entry.line);
    blocks.push({
      ...entry.block,
      x: entry.line.x,
      lastX: entry.line.x,
      y: entry.line.y,
      topY: box.top,
      bottomY: box.bottom,
      boundingBox: publicBoundingBox(box),
      lineCount: 1,
      fontSize: entry.line.fontSize,
      fontName: entry.line.fontName,
    });
  }
  return blocks;
}

function applyDocumentStructure(blocks, pageNumber, inheritedSectionPath = []) {
  const headingStack = (Array.isArray(inheritedSectionPath) ? inheritedSectionPath : [])
    .map((text, index) => ({ level: Math.min(6, index + 1), text: String(text || "").trim() }))
    .filter((item) => item.text);
  for (const block of blocks) {
    if (block.type === "title") {
      block.headingLevel = 1;
      headingStack.length = 0;
      headingStack.push({ level: 1, text: block.text });
    } else if (block.type === "heading" || block.type === "subheading") {
      const level = Math.max(2, Math.min(6, Number(block.headingLevel) || 3));
      while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
      headingStack.push({ level, text: block.text });
      block.headingLevel = level;
    }
    block.sectionPath = headingStack.map((item) => item.text);
    block.sectionTitle = block.sectionPath.at(-1) || "";
    block.pageNumber = pageNumber;
  }
  blocks.forEach((block, index) => {
    block.blockId = `p${pageNumber}-b${index}`;
  });
  return blocks;
}

export function buildPdfReadingLayout(content, options = {}) {
  const built = buildLines(content, options);
  const cuts = { horizontal: 0, vertical: 0 };
  const lines = recursiveReadingOrder(built.lines, built.bodySize, cuts);
  if (!lines.length) {
    return {
      version: PDF_READING_LAYOUT_VERSION, text: "", blocks: [],
      quality: { ...built.diagnostics, readingOrder: "recursive-xy-cut", cuts },
    };
  }

  const sizeMass = new Map();
  const fontMass = new Map();
  for (const line of lines) {
    const weight = visibleLength(line.text);
    const sizeKey = (Math.round(line.fontSize * 10) / 10).toFixed(1);
    sizeMass.set(sizeKey, (sizeMass.get(sizeKey) || 0) + weight);
    fontMass.set(line.fontName, (fontMass.get(line.fontName) || 0) + weight);
  }
  const bodySize = built.bodySize || Number([...sizeMass.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0]) || 10;
  const bodyFont = [...fontMass.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  const ys = lines.map((line) => line.y);
  const context = {
    bodySize,
    bodyFont,
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    pageNumber: Number(options.pageNumber) || 1,
  };
  const classified = lines
    .map((line) => ({ line, block: classifyLine(line, context) }))
    .filter((entry) => entry.block);
  const pageNumber = Number(options.pageNumber) || 1;
  const blocks = applyDocumentStructure(
    mergeBlocks(classified, bodySize),
    pageNumber,
    options.inheritedSectionPath,
  );
  const text = blocks
    .filter((block) => !["header", "footer", "visual"].includes(block.type))
    .map((block) => block.type === "list-item" ? `• ${block.text}` : block.text)
    .join("\n\n");
  return {
    version: PDF_READING_LAYOUT_VERSION,
    text,
    blocks,
    sectionPath: blocks.at(-1)?.sectionPath || [],
    quality: {
      ...built.diagnostics,
      readingOrder: "recursive-xy-cut",
      cuts,
      lineCount: lines.length,
    },
  };
}

export function tokenizeLatinWords(text) {
  return Array.from(String(text || "").matchAll(LATIN_WORD_RE), (match) => match[0]);
}
