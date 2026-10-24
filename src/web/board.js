import {
  createId, deleteRecord, getAll, getRecord, putRecord, saveEvidence,
  saveKnowledgeEdge, titleKey, upsertKnowledgeNode,
} from "./repository.js";
import { createPdfFromJpegPages } from "./artifact-export.js";
import { recognizeHandwritingBoard } from "./vision.js";

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function pathFromPoints(points) {
  if (!points?.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} l 0.1 0.1`;
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    const mx = (point.x + next.x) / 2;
    const my = (point.y + next.y) / 2;
    path += ` Q ${point.x.toFixed(2)} ${point.y.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = points.at(-1);
  return `${path} L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pointerPoint(event, point) {
  const pressure = event.pointerType === "pen"
    ? Math.max(0.05, Math.min(1, finiteNumber(event.pressure, 0.5) || 0.5))
    : 0.5;
  return {
    ...point,
    pressure,
    tiltX: finiteNumber(event.tiltX),
    tiltY: finiteNumber(event.tiltY),
    twist: finiteNumber(event.twist),
    altitudeAngle: finiteNumber(event.altitudeAngle),
    azimuthAngle: finiteNumber(event.azimuthAngle),
    width: finiteNumber(event.width),
    height: finiteNumber(event.height),
    timeStamp: finiteNumber(event.timeStamp, Date.now()),
  };
}

function isHardwareEraser(event) {
  return event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) === 32);
}

function isBarrelButton(event) {
  return event.pointerType === "pen" && (event.button === 2 || (event.buttons & 2) === 2);
}

function likelyPalmContact(event) {
  return event.pointerType === "touch" && Math.max(finiteNumber(event.width), finiteNumber(event.height)) >= 32;
}

function tiltScale(point, brush) {
  if (brush !== "pencil") return 1;
  const tiltX = finiteNumber(point.tiltX);
  const tiltY = finiteNumber(point.tiltY);
  const altitude = finiteNumber(point.altitudeAngle, Number.NaN);
  const tilt = Number.isFinite(altitude)
    ? Math.max(0, Math.min(1, (Math.PI / 2 - altitude) / (Math.PI / 2)))
    : Math.min(1, Math.hypot(tiltX, tiltY) / 90);
  return 1 + tilt * 0.48;
}

function pressureOutlinePath(points, strokeWidth, brush = "pen") {
  if (!points?.length) return "";
  const left = [];
  const right = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const pressure = Math.max(0.05, Math.min(1, finiteNumber(points[index].pressure, 0.5)));
    const radius = Math.max(0.35, strokeWidth * (0.24 + pressure * 1.02) * tiltScale(points[index], brush) / 2);
    const nx = (-dy / length) * radius;
    const ny = (dx / length) * radius;
    left.push([points[index].x + nx, points[index].y + ny]);
    right.unshift([points[index].x - nx, points[index].y - ny]);
  }
  const outline = [...left, ...right];
  return outline.map(([x, y], index) => `${index ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ") + " Z";
}

function strokeMarkup(stroke) {
  const points = stroke.points || [];
  const width = finiteNumber(stroke.width, 3);
  const opacity = finiteNumber(stroke.opacity, 1);
  const pressureValues = points.map((point) => finiteNumber(point.pressure, 0.5));
  const pressureMin = pressureValues.length ? Math.min(...pressureValues) : 0.5;
  const pressureMax = pressureValues.length ? Math.max(...pressureValues) : 0.5;
  const attributes = `data-element-id="${stroke.id}" data-pressure-min="${pressureMin.toFixed(3)}" data-pressure-max="${pressureMax.toFixed(3)}"`;
  if (points.length === 1) {
    const radius = Math.max(0.5, width * (0.24 + finiteNumber(points[0].pressure, 0.5) * 1.02) * tiltScale(points[0], stroke.brush) / 2);
    return `<g ${attributes} class="bd-stroke"><circle cx="${points[0].x}" cy="${points[0].y}" r="${radius.toFixed(2)}" fill="${esc(stroke.color)}" opacity="${opacity}" /></g>`;
  }
  return `<g ${attributes} class="bd-stroke"><path d="${pressureOutlinePath(points, width, stroke.brush)}" fill="${esc(stroke.color)}" opacity="${opacity}" /></g>`;
}

function elementBounds(element) {
  if (!element) return null;
  if (element.type === "stroke") {
    const points = element.points || [];
    if (!points.length) return null;
    const xs = points.map((point) => finiteNumber(point.x));
    const ys = points.map((point) => finiteNumber(point.y));
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (element.type === "line") {
    return {
      x: Math.min(finiteNumber(element.x1), finiteNumber(element.x2)),
      y: Math.min(finiteNumber(element.y1), finiteNumber(element.y2)),
      width: Math.abs(finiteNumber(element.x2) - finiteNumber(element.x1)),
      height: Math.abs(finiteNumber(element.y2) - finiteNumber(element.y1)),
    };
  }
  return {
    x: finiteNumber(element.x),
    y: finiteNumber(element.y),
    width: finiteNumber(element.width, element.type === "sticky" ? 250 : element.type === "image" ? 320 : 180),
    height: finiteNumber(element.height, element.type === "sticky" ? 180 : element.type === "image" ? 220 : 120),
  };
}

function boardContentBounds(board, margin = 120) {
  const bounds = (board?.elements || []).map(elementBounds).filter(Boolean);
  if (!bounds.length) return { x: 0, y: 0, width: 3000, height: 2200 };
  const left = Math.max(0, Math.min(...bounds.map((item) => item.x)) - margin);
  const top = Math.max(0, Math.min(...bounds.map((item) => item.y)) - margin);
  const right = Math.min(3000, Math.max(...bounds.map((item) => item.x + item.width)) + margin);
  const bottom = Math.min(2200, Math.max(...bounds.map((item) => item.y + item.height)) + margin);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function pointInBounds(point, bounds, padding = 0) {
  return Boolean(bounds) &&
    point.x >= bounds.x - padding && point.x <= bounds.x + bounds.width + padding &&
    point.y >= bounds.y - padding && point.y <= bounds.y + bounds.height + padding;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = ((currentPoint.y > point.y) !== (previousPoint.y > point.y)) &&
      point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
        ((previousPoint.y - currentPoint.y) || Number.EPSILON) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function boardText(board) {
  return [board.title, board.quote, board.ocrText,
    ...(board.elements || []).filter((item) => item.type === "text" || item.type === "sticky").map((item) => item.text)]
    .filter(Boolean).join("\n");
}

export function createBoardController(app) {
  const state = {
    boards: [], loaded: false, loading: false, active: null, editorOpen: false, tool: "pen",
    color: "#1F4037", width: 3, zoom: 1, panX: 0, panY: 0,
    undo: [], redo: [], saveTimer: null, saveChain: Promise.resolve(),
    pendingSaves: new Map(), knowledgeSignatures: new Map(), assets: new Map(), drawing: null,
    gesture: null, touchPoints: new Map(), ignoredPointers: new Set(),
    penPointerId: null, erasingPointerId: null, selectedIds: new Set(),
    lastPenActivityAt: 0, barrelGesture: null, lastInkTool: "pen",
    suppressedTouchPoints: new Map(),
  };

  function fs() { return app.features(); }
  function currentBook(board = state.active) {
    return fs()?.books?.find((book) => book.id === board?.bookId) || null;
  }

  async function refresh(preferredId) {
    if (state.loading) return;
    state.loading = true;
    try {
      state.boards = (await getAll("boards")).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const uiState = fs()?.state;
      const targetId = preferredId || uiState?.activeBoardId;
      state.active = state.boards.find((item) => item.id === targetId) || state.boards[0] || null;
      if (uiState && state.active) uiState.activeBoardId = state.active.id;
      if (state.active) {
        state.zoom = Number(state.active.viewport?.zoom) || 1;
        state.panX = Number(state.active.viewport?.panX) || 0;
        state.panY = Number(state.active.viewport?.panY) || 0;
        await hydrateAssets(state.active);
      }
      state.penPointerId = null;
      state.erasingPointerId = null;
      state.selectedIds.clear();
      state.ignoredPointers.clear();
      state.touchPoints.clear();
      state.suppressedTouchPoints.clear();
      state.gesture = null;
      state.loaded = true;
      if (uiState?.currentView === "board") app.renderApp();
    } finally {
      state.loading = false;
    }
  }

  async function hydrateAssets(board) {
    for (const element of board.elements || []) {
      if (element.type !== "image" || !element.assetId || state.assets.has(element.assetId)) continue;
      const asset = await getRecord("assets", element.assetId);
      if (asset?.blob) state.assets.set(element.assetId, URL.createObjectURL(asset.blob));
    }
  }

  async function openBoard(boardId) {
    const board = state.boards.find((item) => item.id === boardId);
    if (!board) return;
    if (state.active && state.active.id !== board.id) await persist(state.active, true);
    state.active = board;
    state.editorOpen = true;
    state.zoom = Number(board.viewport?.zoom) || 1;
    state.panX = Number(board.viewport?.panX) || 0;
    state.panY = Number(board.viewport?.panY) || 0;
    state.undo = [];
    state.redo = [];
    state.selectedIds.clear();
    await hydrateAssets(board);
    const uiState = fs()?.state;
    if (uiState) uiState.activeBoardId = board.id;
    app.renderApp();
  }

  function closeEditor() {
    state.editorOpen = false;
    document.body.classList.remove("board-immersive");
    app.renderApp();
  }

  function dataUrlFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取图片失败。"));
      reader.readAsDataURL(blob);
    });
  }

  async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1200);
  }

  async function exportBoardFile(board = state.active) {
    if (!board) return;
    const assets = [];
    for (const element of board.elements || []) {
      if (element.type !== "image" || !element.assetId) continue;
      if (assets.some((item) => item.id === element.assetId)) continue;
      const asset = await getRecord("assets", element.assetId);
      if (!asset?.blob) continue;
      assets.push({
        id: asset.id,
        name: asset.name || "画板图片",
        mime: asset.mime || asset.blob.type || "image/png",
        dataUrl: await dataUrlFromBlob(asset.blob),
      });
    }
    const payload = {
      format: "biandu-board",
      version: 1,
      exportedAt: new Date().toISOString(),
      board: JSON.parse(JSON.stringify(board)),
      assets,
    };
    const safeTitle = String(board.title || "便读画板").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${safeTitle}.biandu-board.json`);
    app.toast("画板文件已导出，包含笔迹、文字和图片");
  }

  async function importBoardFile(file) {
    if (!file) return;
    const payload = JSON.parse(await file.text());
    const source = payload?.format === "biandu-board" ? payload.board : payload;
    if (!source || !Array.isArray(source.elements)) throw new Error("不是有效的便读画板文件。");
    const now = new Date().toISOString();
    const boardId = createId("board");
    const assetMap = new Map();
    for (const asset of Array.isArray(payload?.assets) ? payload.assets : []) {
      if (!asset?.dataUrl) continue;
      const blob = await dataUrlToBlob(asset.dataUrl);
      const assetId = createId("asset");
      await putRecord("assets", {
        id: assetId,
        kind: "board-image",
        name: String(asset.name || "导入图片"),
        mime: String(asset.mime || blob.type || "image/png"),
        blob,
        boardId,
        createdAt: now,
      });
      assetMap.set(String(asset.id), assetId);
    }
    const elements = source.elements.map((element) => {
      const clone = JSON.parse(JSON.stringify(element));
      clone.id = createId(element.type === "stroke" ? "stroke" : "element");
      if (clone.assetId && assetMap.has(String(clone.assetId))) clone.assetId = assetMap.get(String(clone.assetId));
      return clone;
    });
    const board = {
      id: boardId,
      title: `导入 · ${String(source.title || "画板").slice(0, 80)}`,
      bookId: source.bookId || null,
      page: Number(source.page) || null,
      quote: String(source.quote || ""),
      sourceId: source.bookId || null,
      knowledgeNodeIds: [],
      elements,
      ocrText: String(source.ocrText || ""),
      paperStyle: ["plain", "grid", "dots", "dark"].includes(source.paperStyle) ? source.paperStyle : "plain",
      viewport: source.viewport || { zoom: 1, panX: 0, panY: 0 },
      createdAt: now,
      updatedAt: now,
    };
    await putRecord("boards", board);
    state.boards.unshift(board);
    state.active = board;
    state.editorOpen = true;
    state.loaded = true;
    const uiState = fs()?.state;
    if (uiState) uiState.activeBoardId = board.id;
    window.dispatchEvent(new CustomEvent("biandu:local-data-changed", { detail: { kind: "board", id: board.id } }));
    app.renderApp();
    app.toast("画板已导入并保存在本机");
  }

  function setSaveStatus(text) {
    const badge = document.getElementById("boardSaveStatusBadge");
    if (badge) badge.textContent = text;
  }

  async function persistNow(board, viewport) {
    board.viewport = viewport;
    board.updatedAt = new Date().toISOString();

    // The user's drawing is committed first in its own durable transaction.
    // Knowledge indexing is useful but must never be able to prevent the
    // canvas itself from being saved.
    await putRecord("boards", board);
    setSaveStatus("● 画板已保存到本机");
    const index = state.boards.findIndex((item) => item.id === board.id);
    if (index >= 0) state.boards[index] = board;

    try {
      await syncBoardKnowledge(board);
      board.updatedAt = new Date().toISOString();
      await putRecord("boards", board);
      setSaveStatus("● 画板与知识关联已保存");
    } catch (error) {
      console.warn("Board knowledge sync failed after board save", error);
      setSaveStatus("● 画板已保存 · 知识关联稍后重试");
      app.toast("画板已经安全保存；知识关联暂时失败，之后会自动补全");
    }
  }

  function drainPending(boardId) {
    const pending = state.pendingSaves.get(boardId);
    if (!pending) return state.saveChain;
    state.pendingSaves.delete(boardId);
    const run = state.saveChain.catch(() => {}).then(() => persistNow(pending.board, pending.viewport));
    state.saveChain = run.catch((error) => console.warn("Board background save failed", error));
    return run;
  }

  async function flush() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const boardIds = [...state.pendingSaves.keys()];
    let firstError = null;
    for (const boardId of boardIds) {
      try { await drainPending(boardId); }
      catch (error) { firstError ||= error; }
    }
    await state.saveChain;
    if (firstError) throw firstError;
  }

  function persist(board = state.active, immediate = false) {
    if (!board) return Promise.resolve();
    window.clearTimeout(state.saveTimer);
    // Capture the viewport when the change happens. A delayed save can run
    // after the user has switched boards, and must never inherit the next
    // board's zoom or pan values.
    state.pendingSaves.set(board.id, {
      board,
      viewport: { zoom: state.zoom, panX: state.panX, panY: state.panY },
    });
    if (immediate) return drainPending(board.id);
    state.saveTimer = window.setTimeout(() => {
      flush().catch((error) => app.toast(`画板保存失败：${error.message}`));
    }, 350);
    return Promise.resolve();
  }

  async function syncBoardKnowledge(board) {
    const text = boardText(board).trim();
    if (!text) return;
    if (state.knowledgeSignatures.get(board.id) === text) return;
    const evidence = await saveEvidence({
      id: `evidence-board-${board.id}`, kind: "canvas-recognition",
      bookId: board.bookId, sourceId: board.bookId || board.id,
      sourceTitle: currentBook(board)?.title || board.title, page: board.page,
      locator: { page: board.page || undefined },
      excerpt: text, permanent: true,
    });
    const node = await upsertKnowledgeNode({
      kind: "canvas", title: board.knowledgeNodeTitle || board.title,
      summary: text.slice(0, 1200), evidenceIds: [evidence.id],
    });
    board.knowledgeNodeIds = [node.id];
    const bookNode = (await getAll("knowledgeNodes")).find((item) => titleKey(item.title) === titleKey(currentBook(board)?.title));
    if (bookNode) await saveKnowledgeEdge({
      fromNodeId: node.id, toNodeId: bookNode.id, relation: "derived-from",
      rationale: "画板由该书籍页面批注创建", evidenceIds: [evidence.id], confidence: 1,
    });
    state.knowledgeSignatures.set(board.id, text);
  }

  async function createBoard(input, options = {}) {
    if (state.active) await persist(state.active, true);
    const count = state.boards.filter((board) => board.bookId === input.bookId && board.page === input.page).length;
    const now = new Date().toISOString();
    const baseTitle = input.title || `第 ${input.page || 1} 页批注 ${count + 1}`;
    const board = {
      id: createId("board"), title: count ? `${baseTitle} · ${count + 1}` : baseTitle,
      bookId: input.bookId || null, page: Number(input.page) || null,
      quote: String(input.quote || "").trim(), sourceId: input.bookId || null,
      knowledgeNodeIds: [],
      elements: Array.isArray(input.elements) ? JSON.parse(JSON.stringify(input.elements)) : [],
      ocrText: "",
      paperStyle: "plain",
      viewport: { zoom: 1, panX: 0, panY: 0 }, createdAt: now, updatedAt: now,
    };
    await putRecord("boards", board);
    state.boards.unshift(board);
    state.loaded = true;
    state.active = board;
    state.zoom = 1; state.panX = 0; state.panY = 0; state.undo = []; state.redo = [];
    const uiState = fs()?.state;
    if (uiState) uiState.activeBoardId = board.id;
    const opensEditor = options.openEditor !== false &&
      (options.navigate !== false || uiState?.currentView === "board");
    if (opensEditor) state.editorOpen = true;
    if (options.navigate !== false) app.switchView("board", { boardId: board.id });
    else if (uiState?.currentView === "board" && opensEditor) app.renderApp();
    try {
      await syncBoardKnowledge(board);
      board.updatedAt = new Date().toISOString();
      await putRecord("boards", board);
    } catch (error) {
      console.warn("New board knowledge sync failed after board save", error);
      app.toast("新画板已保存；知识关联暂时失败，之后会自动补全");
    }
    return board;
  }

  function pushUndo() {
    if (!state.active) return;
    state.undo.push(JSON.stringify(state.active.elements || []));
    if (state.undo.length > 40) state.undo.shift();
    state.redo = [];
  }

  function undo() {
    if (!state.active || !state.undo.length) return;
    state.redo.push(JSON.stringify(state.active.elements));
    state.active.elements = JSON.parse(state.undo.pop());
    app.renderApp();
    persist();
  }

  function redo() {
    if (!state.active || !state.redo.length) return;
    state.undo.push(JSON.stringify(state.active.elements));
    state.active.elements = JSON.parse(state.redo.pop());
    app.renderApp();
    persist();
  }

  function renderStrokes(board) {
    return (board.elements || []).filter((item) => item.type === "stroke").map(strokeMarkup).join("");
  }

  function renderElements(board) {
    return (board.elements || []).filter((item) => item.type !== "stroke").map((element) => {
      const common = `data-element-id="${element.id}"`;
      if (element.type === "image") {
        const url = state.assets.get(element.assetId);
        return `<g ${common} transform="translate(${element.x},${element.y})"><rect width="${element.width}" height="${element.height}" rx="12" fill="#fff" stroke="#d8d0c1"/><image href="${url || ""}" width="${element.width}" height="${element.height}" preserveAspectRatio="xMidYMid meet" opacity="${url ? 1 : 0}"/></g>`;
      }
      if (element.type === "sticky") {
        return `<g ${common} transform="translate(${element.x},${element.y})"><rect width="${element.width || 250}" height="${element.height || 180}" rx="10" fill="#FFF1B8" stroke="#E4CC70"/><foreignObject x="14" y="12" width="${(element.width || 250) - 28}" height="${(element.height || 180) - 24}"><div xmlns="http://www.w3.org/1999/xhtml" style="font:15px/1.55 sans-serif;color:#4d421e;white-space:pre-wrap;">${esc(element.text || "双击编辑便签")}</div></foreignObject></g>`;
      }
      if (element.type === "text") {
        return `<g ${common} transform="translate(${element.x},${element.y})"><foreignObject width="${element.width || 360}" height="${element.height || 120}"><div xmlns="http://www.w3.org/1999/xhtml" style="font:18px/1.55 serif;color:${esc(element.color || "#1F4037")};white-space:pre-wrap;">${esc(element.text || "双击编辑文字")}</div></foreignObject></g>`;
      }
      if (element.type === "line") {
        return `<path ${common} d="M ${element.x1} ${element.y1} L ${element.x2} ${element.y2}" stroke="${esc(element.color || "#1F4037")}" stroke-width="${element.width || 2}" marker-end="url(#boardArrow)" />`;
      }
      if (element.type === "rectangle") {
        return `<rect ${common} x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="5" fill="${esc(element.fill || "none")}" stroke="${esc(element.color || "#1F4037")}" stroke-width="${element.strokeWidth || 2}" />`;
      }
      if (element.type === "ellipse") {
        return `<ellipse ${common} cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${Math.abs(element.width / 2)}" ry="${Math.abs(element.height / 2)}" fill="${esc(element.fill || "none")}" stroke="${esc(element.color || "#1F4037")}" stroke-width="${element.strokeWidth || 2}" />`;
      }
      return "";
    }).join("");
  }

  function renderSelectionBoxes(board) {
    if (!state.selectedIds.size) return "";
    const boxes = (board.elements || [])
      .filter((element) => state.selectedIds.has(element.id))
      .map(elementBounds)
      .filter(Boolean);
    return boxes.map((box) => `<rect class="bd-selection-box" x="${box.x - 8}" y="${box.y - 8}" width="${box.width + 16}" height="${box.height + 16}" rx="6" />`).join("");
  }

  function renderList() {
    if (!state.boards.length) return `<div style="padding:18px;border:1px dashed var(--border-hairline);border-radius:8px;color:var(--text-muted);font-size:12.5px;">还没有批注画板。从阅读页选中文字，点击“新建画板”即可。</div>`;
    return state.boards.slice(0, 40).map((board) =>
      `<button class="btn btn-sm board-list-item ${board.id === state.active?.id ? "btn-primary" : ""}" data-board-id="${board.id}" style="justify-content:flex-start;text-align:left;min-height:48px;width:100%;overflow:hidden;"><span style="display:flex;flex-direction:column;gap:2px;min-width:0;"><strong style="max-width:100%;overflow:hidden;text-overflow:ellipsis;">${esc(board.title)}</strong><small style="opacity:.75;">${board.page ? `第 ${board.page} 页` : "自由画板"} · ${new Date(board.updatedAt).toLocaleDateString("zh-CN")}</small></span></button>`
    ).join("");
  }

  function boardIcon(name) {
    const common = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    if (name === "back") return `<svg ${common}><path d="M15 18l-6-6 6-6"/></svg>`;
    if (name === "list") return `<svg ${common}><rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M8 4v16M3.5 9h17"/></svg>`;
    if (name === "context") return `<svg ${common}><rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M15 4v16"/></svg>`;
    if (name === "book") return `<svg ${common}><path d="M3.5 5.5A8.2 8.2 0 0 1 12 7v12a8.2 8.2 0 0 0-8.5-1.5z"/><path d="M20.5 5.5A8.2 8.2 0 0 0 12 7v12a8.2 8.2 0 0 1 8.5-1.5z"/></svg>`;
    if (name === "fit") return `<svg ${common}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/></svg>`;
    if (name === "export") return `<svg ${common}><path d="M12 3v12M7.5 10.5L12 15l4.5-4.5"/><path d="M5 20h14"/></svg>`;
    if (name === "pdf") return `<svg ${common}><path d="M6 2.8h7l5 5V21H6z"/><path d="M13 2.8v5h5"/><path d="M8.5 12h7M8.5 15.5h7M8.5 18h4"/></svg>`;
    if (name === "undo") return `<svg ${common}><path d="M9 7L4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6v1"/></svg>`;
    if (name === "redo") return `<svg ${common}><path d="M15 7l5 5-5 5"/><path d="M20 12h-9a6 6 0 0 0-6 6v1"/></svg>`;
    if (name === "select") return `<svg ${common}><path d="M5 3.8l13.5 8-6 1.5-2.6 5.8z"/><path d="M13 13l4.5 4.5"/></svg>`;
    if (name === "pen") return `<svg ${common}><path d="M17.8 3.2a2.1 2.1 0 0 1 3 3L8.5 18.5 4 20l1.5-4.5z"/><path d="M14.8 6.2l3 3"/></svg>`;
    if (name === "pencil") return `<svg ${common}><path d="M4 20l4.2-1 11.5-11.5-3.2-3.2L5 15.8z"/><path d="M14.5 5.3l4.2 4.2M4 20l1.2-4.2"/></svg>`;
    if (name === "highlighter") return `<svg ${common}><path d="M14.5 3.5l6 6-8.8 8.8H6v-5.7z"/><path d="M4 21h9M14.4 5.1l4.5 4.5"/></svg>`;
    if (name === "eraser") return `<svg ${common}><path d="M18 20H8.5l-4.7-4.7a2 2 0 0 1 0-2.8L12 4.3a2 2 0 0 1 2.8 0l4.9 4.9a2 2 0 0 1 0 2.8L12 19.7"/><path d="M9.5 7.2l7.3 7.3"/></svg>`;
    if (name === "lasso") return `<svg ${common}><path d="M4 11.5c0-3.6 3.6-6.5 8-6.5s8 2.9 8 6.5-3.6 6.5-8 6.5c-1.4 0-2.8-.3-4-.8"/><circle cx="6" cy="18" r="2"/><path d="M7 15.7c.2 1 .7 1.8 1.5 2.4"/></svg>`;
    if (name === "text") return `<svg ${common}><path d="M5 5h14M12 5v14M8.5 19h7"/></svg>`;
    if (name === "sticky") return `<svg ${common}><path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5"/><path d="M8 13h8M8 16h5"/></svg>`;
    if (name === "image") return `<svg ${common}><rect x="3.5" y="4" width="17" height="16" rx="2.5"/><circle cx="8.5" cy="9" r="1.5"/><path d="M4.5 17l4.7-4.7 3.2 3.2 2.1-2.1 4.7 4.6"/></svg>`;
    if (name === "line") return `<svg ${common}><path d="M5 19L19 5"/><path d="M12.5 5H19v6.5"/></svg>`;
    if (name === "rectangle") return `<svg ${common}><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
    if (name === "ellipse") return `<svg ${common}><ellipse cx="12" cy="12" rx="8.5" ry="6.5"/></svg>`;
    if (name === "more") return `<svg ${common}><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>`;
    if (name === "close") return `<svg ${common}><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    if (name === "plus") return `<svg ${common}><path d="M12 5v14M5 12h14"/></svg>`;
    return "";
  }

  function renderBoardGallery() {
    const cards = state.boards.map((board) => {
      const book = currentBook(board);
      return `<article class="bd-gallery-card">
        <button class="bd-gallery-open" data-open-board-id="${board.id}" type="button" aria-label="打开画板 ${esc(board.title)}">
          <span class="bd-gallery-preview">
            <svg viewBox="0 0 3000 2200" aria-hidden="true">${renderStrokes(board)}${renderElements(board)}</svg>
          </span>
          <span class="bd-gallery-meta">
            <strong>${esc(board.title)}</strong>
            <small>${book ? `《${esc(book.title)}》 · 第 ${board.page} 页` : "独立画板"} · ${new Date(board.updatedAt).toLocaleString("zh-CN")}</small>
          </span>
        </button>
        <div class="bd-gallery-exports">
          <button class="bd-gallery-export" data-export-board-id="${board.id}" type="button" title="导出可编辑画板" aria-label="导出可编辑画板">${boardIcon("export")}</button>
          <button class="bd-gallery-export" data-pdf-board-id="${board.id}" type="button" title="导出 PDF" aria-label="导出 PDF">${boardIcon("pdf")}</button>
        </div>
      </article>`;
    }).join("");
    return `
      <div class="page-scroll bd-gallery-page">
        <header class="bd-gallery-head">
          <div><h1 class="serif-title">我的画板</h1><p>${state.boards.length ? `${state.boards.length} 张画板只保存在当前平板` : "用一张空白画板开始记录，也可以导入已有画板文件。"}</p></div>
          <div class="bd-gallery-actions">
            <input id="boardGalleryImportInput" type="file" accept=".biandu-board,.json,application/json" hidden />
            <button class="btn" id="boardGalleryImportBtn" type="button">${boardIcon("export")}<span>导入画板</span></button>
            <button class="btn btn-primary" id="boardGalleryCreateBtn" type="button">${boardIcon("plus")}<span>添加画板</span></button>
          </div>
        </header>
        ${state.boards.length ? `<div class="bd-gallery-grid">${cards}</div>` : `
          <section class="bd-gallery-empty">
            <span>${boardIcon("list")}</span>
            <h2 class="serif-title">还没有画板</h2>
            <p>点击“添加画板”进入全屏画板；也可以在阅读页选中句子后直接创建画板笔记。</p>
            <button class="btn btn-primary" id="boardGalleryEmptyCreateBtn" type="button">${boardIcon("plus")}<span>添加画板</span></button>
          </section>`}
      </div>`;
  }

  function render() {
    if (!state.loaded) {
      refresh();
      return `<div class="page-scroll"><section class="card" style="padding:40px;text-align:center;">正在从本机读取画板…</section></div>`;
    }
    if (!state.editorOpen || !state.active) return renderBoardGallery();
    const board = state.active;
    const book = currentBook(board);
    const primaryTools = [["pen", "钢笔"], ["image", "图片"], ["text", "文本框"], ["sticky", "便签"]];
    const moreTools = [["select", "选择"], ["pencil", "铅笔"], ["line", "箭头"], ["rectangle", "矩形"], ["ellipse", "椭圆"]];
    const inkColors = ["#1F4037", "#737373", "#E05F60", "#F08A7A", "#F2B544", "#D9D2C4", "#2D7FF9", "#252B28"];
    const paperStyle = ["plain", "grid", "dots", "dark"].includes(board.paperStyle) ? board.paperStyle : "plain";
    return `
      <div class="bd-shell bd-shell-focus">
        <header class="bd-header">
          <div class="bd-topbar-pill">
            <button class="bd-header-icon" id="boardBackReaderBtn" type="button" title="返回我的画板" aria-label="返回我的画板">${boardIcon("back")}</button>
            <button class="bd-header-icon" id="boardListToggleBtn" type="button" title="全部画板" aria-label="全部画板">${boardIcon("list")}</button>
            <span class="bd-topbar-divider"></span>
            <button class="bd-header-icon" id="boardUndoBtn" type="button" title="撤销" aria-label="撤销" ${state.undo.length ? "" : "disabled"}>${boardIcon("undo")}</button>
            <button class="bd-header-icon" id="boardRedoBtn" type="button" title="重做" aria-label="重做" ${state.redo.length ? "" : "disabled"}>${boardIcon("redo")}</button>
            <span class="bd-topbar-divider"></span>
            <button class="bd-header-icon" id="boardContextToggleBtn" type="button" title="画板上下文" aria-label="画板上下文">${boardIcon("context")}</button>
            <button class="bd-header-icon" id="boardFitCanvasBtn" type="button" title="适应屏幕" aria-label="适应屏幕">${boardIcon("fit")}</button>
            <button class="bd-header-icon bd-export-action" id="boardExportFileBtn" type="button" title="导出画板" aria-label="导出画板">${boardIcon("export")}</button>
          </div>
          <div class="bd-title-block"><h1>${esc(board.title)}</h1><span>${book ? `《${esc(book.title)}》 · 第 ${board.page} 页` : "独立画板"} · <b id="boardSaveStatusBadge">已保存到本机</b></span></div>
        </header>
        <div class="bd-layout">
          <aside class="bd-sidebar">
            <div class="bd-side-title"><strong>全部画板</strong><span>${state.boards.length}</span><button class="bd-header-icon" id="boardListCloseBtn" type="button" aria-label="关闭画板列表">${boardIcon("close")}</button></div>
            <button class="bd-create-board" id="createBlankBoardBtn" type="button">${boardIcon("plus")}<span>新建空白画板</span></button>
            <div class="bd-list">${renderList()}</div>
          </aside>
          <main class="bd-main">
            <div id="bdStage" class="bd-stage bd-paper-${paperStyle}" tabindex="0">
              <div id="boardViewport" class="bd-world" style="transform:translate(${state.panX}px,${state.panY}px) scale(${state.zoom});transform-origin:0 0;">
                <svg width="3000" height="2200" viewBox="0 0 3000 2200" xmlns="http://www.w3.org/2000/svg">
                  <defs><marker id="boardArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#1F4037"/></marker></defs>
                  ${renderStrokes(board)}${renderElements(board)}${renderSelectionBoxes(board)}
                </svg>
              </div>
              <div class="bd-board-rail" role="toolbar" aria-label="画板工具">
                ${primaryTools.map(([id, label]) => `<button class="bd-rail-tool ${state.tool === id ? "is-active" : ""}" data-board-tool="${id}" type="button" title="${label}" aria-label="${label}">${boardIcon(id)}</button>`).join("")}
                <button class="bd-rail-tool" data-board-action="context" type="button" title="画板上下文" aria-label="画板上下文">${boardIcon("book")}</button>
                <span class="bd-rail-divider"></span>
                <div class="bd-marker-stack" aria-label="荧光笔颜色">
                  ${inkColors.map((color) => `<button class="bd-marker ${state.color === color ? "is-active" : ""}" data-board-color="${color}" type="button" style="--marker:${color}" aria-label="颜色 ${color}"><span></span></button>`).join("")}
                </div>
                <span class="bd-rail-divider"></span>
                <button class="bd-rail-tool ${state.tool === "eraser" ? "is-active" : ""}" data-board-tool="eraser" type="button" title="橡皮" aria-label="橡皮">${boardIcon("eraser")}</button>
                <button class="bd-rail-tool ${state.tool === "lasso" ? "is-active" : ""}" data-board-tool="lasso" type="button" title="套索" aria-label="套索">${boardIcon("lasso")}</button>
                <button class="bd-rail-tool" id="boardMoreToolsBtn" type="button" title="更多工具" aria-label="更多工具">${boardIcon("more")}</button>
              </div>
              <div class="bd-more-panel" id="boardMorePanel">
                <div class="bd-more-tools">${moreTools.map(([id, label]) => `<button class="bd-more-tool ${state.tool === id ? "is-active" : ""}" data-board-tool="${id}" type="button" title="${label}" aria-label="${label}">${boardIcon(id)}</button>`).join("")}</div>
                <div class="bd-more-controls">
                <label class="bd-width">笔宽 <input id="boardWidthRange" type="range" min="1" max="14" value="${state.width}" /></label>
                <label class="bd-paper">纸张 <select id="boardPaperStyle">${[["plain", "空白"], ["grid", "方格"], ["dots", "点阵"], ["dark", "深色"]].map(([value, label]) => `<option value="${value}" ${paperStyle === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
                ${state.selectedIds.size ? `<span class="bd-selection-tools"><b>已选 ${state.selectedIds.size}</b><button class="btn btn-sm" id="boardDuplicateBtn">复制</button><button class="btn btn-sm btn-terracotta" id="boardDeleteSelectionBtn">删除</button></span>` : ""}
                <span class="bd-zoom"><button class="bd-zoom-btn" id="boardZoomOutBtn" type="button" aria-label="缩小">−</button><b id="boardZoomLabel">${Math.round(state.zoom * 100)}%</b><button class="bd-zoom-btn" id="boardZoomInBtn" type="button" aria-label="放大">＋</button></span>
                <div class="bd-export-row"><button class="btn btn-sm" id="boardExportPdfBtn" type="button">导出 PDF</button><button class="btn btn-sm" id="boardExportPngBtn" type="button">导出 PNG</button></div>
                </div>
              </div>
              <input id="boardImageInput" type="file" accept="image/*" hidden />
            </div>
          </main>
          <aside class="bd-context">
            <div class="bd-context-head"><h3>画板上下文</h3><button class="bd-header-icon" id="boardContextCloseBtn" type="button" aria-label="关闭画板上下文">${boardIcon("close")}</button></div>
            <div><span>关联原文</span><p>${esc(board.quote || "这是一张独立画板，没有绑定原文选段。")}</p></div>
            <div><span>知识节点</span><p>${(board.knowledgeNodeIds || []).length ? "已自动关联到知识库" : "添加文字或便签后自动建立关联"}</p></div>
            <div><span>识别文字</span><textarea id="boardOcrText" rows="7" placeholder="可手动补充关键词，也可让 AI 识别当前画板的手写与思维结构。">${esc(board.ocrText || "")}</textarea><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px;"><button class="btn btn-sm btn-tonal" id="recognizeBoardAiBtn">AI 识别手写</button><button class="btn btn-sm" id="saveBoardOcrBtn">保存文字</button></div><small id="boardOcrMeta" style="display:block;margin-top:6px;color:var(--text-muted);">${board.ocrMeta?.recognizedAt ? `识别于 ${new Date(board.ocrMeta.recognizedAt).toLocaleString("zh-CN")}${Number.isFinite(board.ocrMeta.confidence) ? ` · 置信度 ${Math.round(board.ocrMeta.confidence * 100)}%` : ""}` : "仅发送当前这一张画板图像"}</small></div>
            <div><span>页面提示</span><p>手写轨迹与图片直接保存在本机；不会因为清理 PDF 原文而丢失。</p></div>
          </aside>
        </div>
      </div>`;
  }

  function screenToWorld(clientX, clientY) {
    const stage = document.getElementById("bdStage");
    const rect = stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.panX) / state.zoom,
      y: (clientY - rect.top - state.panY) / state.zoom,
    };
  }

  function setZoom(next, centerX, centerY) {
    const stage = document.getElementById("bdStage");
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cx = centerX ?? rect.width / 2;
    const cy = centerY ?? rect.height / 2;
    const worldX = (cx - state.panX) / state.zoom;
    const worldY = (cy - state.panY) / state.zoom;
    state.zoom = Math.max(0.22, Math.min(4, next));
    state.panX = cx - worldX * state.zoom;
    state.panY = cy - worldY * state.zoom;
    updateWorldTransform();
    const label = document.getElementById("boardZoomLabel");
    if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
    persist();
  }

  function updateWorldTransform() {
    const world = document.getElementById("boardViewport");
    if (world) world.style.transform = `translate(${state.panX}px,${state.panY}px) scale(${state.zoom})`;
  }

  function askElementText(type, initial = "") {
    const root = document.getElementById("modalRoot");
    root.innerHTML = `<div class="modal-backdrop" id="boardTextBackdrop"><div class="modal-card" style="max-width:560px;" onclick="event.stopPropagation()"><h2 class="serif-title" style="font-size:19px;margin-bottom:10px;">${type === "sticky" ? "新建便签" : "新建文字"}</h2><textarea id="boardElementText" rows="6" style="width:100%;padding:12px;border:1px solid var(--border-strong);border-radius:7px;font:inherit;line-height:1.6;" placeholder="输入这里的文字或思维导图关键词…">${esc(initial)}</textarea><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;"><button class="btn" id="cancelBoardTextBtn">取消</button><button class="btn btn-primary" id="saveBoardTextBtn">放置到画板</button></div></div></div>`;
    document.getElementById("cancelBoardTextBtn").onclick = () => { root.innerHTML = ""; };
    document.getElementById("boardTextBackdrop").onclick = (event) => { if (event.target.id === "boardTextBackdrop") root.innerHTML = ""; };
    document.getElementById("saveBoardTextBtn").onclick = () => {
      const text = document.getElementById("boardElementText").value.trim();
      if (!text) return;
      const stage = document.getElementById("bdStage");
      const rect = stage.getBoundingClientRect();
      const world = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
      pushUndo();
      state.active.elements.push({
        id: createId("element"), type, text,
        x: Math.round(world.x), y: Math.round(world.y),
        width: type === "sticky" ? 250 : 380, height: type === "sticky" ? 180 : 120,
        createdAt: new Date().toISOString(),
      });
      root.innerHTML = "";
      app.renderApp();
      persist();
    };
    requestAnimationFrame(() => document.getElementById("boardElementText")?.focus());
  }

  async function addImage(file) {
    if (!file?.type?.startsWith("image/")) return;
    const assetId = createId("asset");
    await putRecord("assets", {
      id: assetId, kind: "board-image", name: file.name, mime: file.type,
      blob: file, createdAt: new Date().toISOString(),
    });
    state.assets.set(assetId, URL.createObjectURL(file));
    const stage = document.getElementById("bdStage");
    const rect = stage.getBoundingClientRect();
    const world = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    pushUndo();
    state.active.elements.push({
      id: createId("element"), type: "image", assetId,
      x: Math.round(world.x - 160), y: Math.round(world.y - 110),
      width: 320, height: 220, createdAt: new Date().toISOString(),
    });
    app.renderApp();
    await persist(state.active, true);
  }

  function eraseAt(clientX, clientY) {
    const point = screenToWorld(clientX, clientY);
    const threshold = 16 / state.zoom;
    let target = null;
    let nearest = Infinity;
    for (const stroke of state.active.elements.filter((item) => item.type === "stroke")) {
      for (const candidate of stroke.points) {
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        if (distance < threshold && distance < nearest) { target = stroke; nearest = distance; }
      }
    }
    if (!target) target = elementHitAt(point);
    if (target) {
      pushUndo();
      state.active.elements = state.active.elements.filter((item) => item.id !== target.id);
      document.querySelector(`#boardViewport [data-element-id="${target.id}"]`)?.remove();
      persist();
    }
  }

  function selectedElements() {
    return (state.active?.elements || []).filter((element) => state.selectedIds.has(element.id));
  }

  function clearSelection() {
    state.selectedIds.clear();
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
    const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
  }

  function elementHitAt(point) {
    const elements = state.active?.elements || [];
    const threshold = 14 / state.zoom;
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index];
      if (element.type === "stroke") {
        const points = element.points || [];
        if (points.some((candidate, pointIndex) => pointIndex > 0 &&
          distanceToSegment(point, points[pointIndex - 1], candidate) <= threshold + finiteNumber(element.width, 3) / 2)) return element;
        continue;
      }
      if (element.type === "line") {
        if (distanceToSegment(point, { x: element.x1, y: element.y1 }, { x: element.x2, y: element.y2 }) <= threshold) return element;
        continue;
      }
      if (pointInBounds(point, elementBounds(element), threshold)) return element;
    }
    return null;
  }

  function updateSelectionPreview() {
    const svg = document.querySelector("#boardViewport svg");
    if (!svg) return;
    svg.querySelectorAll(".bd-selection-box").forEach((node) => node.remove());
    svg.insertAdjacentHTML("beforeend", renderSelectionBoxes(state.active));
  }

  function startElementMove(event, element) {
    if (!element) return;
    if (event.shiftKey) {
      if (state.selectedIds.has(element.id)) state.selectedIds.delete(element.id);
      else state.selectedIds.add(element.id);
    } else if (!state.selectedIds.has(element.id)) {
      clearSelection();
      state.selectedIds.add(element.id);
    }
    const origin = selectedElements().map((item) => ({
      id: item.id,
      baseTransform: document.querySelector(`#boardViewport [data-element-id="${item.id}"]`)?.getAttribute("transform") || "",
      x: item.x,
      y: item.y,
      x1: item.x1,
      y1: item.y1,
      x2: item.x2,
      y2: item.y2,
      points: item.type === "stroke" ? item.points.map((point) => ({ ...point })) : null,
    }));
    state.gesture = {
      type: "move-elements",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
    };
    try { document.getElementById("bdStage")?.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers may not capture. */ }
  }

  function applyElementMove(event) {
    if (state.gesture?.type !== "move-elements") return;
    const dx = (event.clientX - state.gesture.startX) / state.zoom;
    const dy = (event.clientY - state.gesture.startY) / state.zoom;
    for (const origin of state.gesture.origin) {
      const element = state.active.elements.find((item) => item.id === origin.id);
      if (!element) continue;
      if (element.type === "stroke") {
        element.points = origin.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
      } else if (element.type === "line") {
        element.x1 = origin.x1 + dx; element.y1 = origin.y1 + dy;
        element.x2 = origin.x2 + dx; element.y2 = origin.y2 + dy;
      } else {
        element.x = origin.x + dx; element.y = origin.y + dy;
      }
      const visual = document.querySelector(`#boardViewport [data-element-id="${origin.id}"]`);
      if (visual) {
        const offset = `translate(${dx} ${dy})`;
        visual.setAttribute("transform", `${origin.baseTransform} ${offset}`.trim());
      }
    }
  }

  function deleteSelection() {
    if (!state.selectedIds.size) return;
    pushUndo();
    state.active.elements = state.active.elements.filter((element) => !state.selectedIds.has(element.id));
    clearSelection();
    app.renderApp();
    persist();
  }

  function duplicateSelection() {
    if (!state.selectedIds.size) return;
    pushUndo();
    const copies = selectedElements().map((element) => {
      const copy = JSON.parse(JSON.stringify(element));
      copy.id = createId("element");
      if (copy.type === "stroke") copy.points = copy.points.map((point) => ({ ...point, x: point.x + 28, y: point.y + 28 }));
      else if (copy.type === "line") {
        copy.x1 += 28; copy.y1 += 28; copy.x2 += 28; copy.y2 += 28;
      } else {
        copy.x += 28; copy.y += 28;
      }
      return copy;
    });
    state.active.elements.push(...copies);
    clearSelection();
    copies.forEach((element) => state.selectedIds.add(element.id));
    app.renderApp();
    persist();
  }

  function selectionPreviewMarkup(kind, payload) {
    const svg = document.querySelector("#boardViewport svg");
    if (!svg) return;
    let preview = document.getElementById("boardGesturePreview");
    if (!preview) {
      svg.insertAdjacentHTML("beforeend", `<g id="boardGesturePreview" pointer-events="none"></g>`);
      preview = document.getElementById("boardGesturePreview");
    }
    if (kind === "lasso") {
      const path = payload.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ") + (payload.length > 2 ? " Z" : "");
      preview.innerHTML = `<path d="${path}" fill="rgba(47,94,82,.08)" stroke="#2F5E52" stroke-width="1.5" stroke-dasharray="7 6" />`;
    } else if (kind === "rectangle") {
      preview.innerHTML = `<rect x="${payload.x}" y="${payload.y}" width="${payload.width}" height="${payload.height}" fill="none" stroke="#2F5E52" stroke-width="1.5" stroke-dasharray="7 6" />`;
    } else if (kind === "ellipse") {
      preview.innerHTML = `<ellipse cx="${payload.x + payload.width / 2}" cy="${payload.y + payload.height / 2}" rx="${Math.abs(payload.width / 2)}" ry="${Math.abs(payload.height / 2)}" fill="none" stroke="#2F5E52" stroke-width="1.5" stroke-dasharray="7 6" />`;
    }
  }

  function exportPng() {
    const sourceSvg = document.querySelector("#boardViewport svg");
    if (!sourceSvg) return;
    const clone = sourceSvg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.insertAdjacentHTML("afterbegin", '<rect width="3000" height="2200" fill="#f8f5ed"/>');
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 2400; canvas.height = 1760;
      const context = canvas.getContext("2d");
      context.fillStyle = "#f8f5ed"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((png) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(png);
        link.download = `${state.active.title || "便读画板"}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }, "image/png");
    };
    image.onerror = () => { URL.revokeObjectURL(url); app.toast("画板图片导出失败。"); };
    image.src = url;
  }

  async function boardToDataUrl(maxDimension = 1800, options = {}) {
    const board = options.board || state.active;
    if (!board) throw new Error("画板尚未加载完成。");
    const backgroundColor = options.backgroundColor || "#f8f5ed";
    const view = options.bounds || { x: 0, y: 0, width: 3000, height: 2200 };
    const scale = Math.min(options.maxScale || 1, maxDimension / view.width, maxDimension / view.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(view.width * scale));
    canvas.height = Math.max(1, Math.round(view.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    const xAt = (value) => (finiteNumber(value) - view.x) * scale;
    const yAt = (value) => (finiteNumber(value) - view.y) * scale;

    function wrappedLines(value, width) {
      const lines = [];
      for (const paragraph of String(value || "").split("\n")) {
        let current = "";
        for (const character of paragraph) {
          const next = current + character;
          if (current && context.measureText(next).width > width) {
            lines.push(current);
            current = character;
          } else current = next;
        }
        lines.push(current);
      }
      return lines;
    }

    async function loadImage(url) {
      if (!url) return null;
      const image = new Image();
      image.src = url;
      try { await image.decode(); return image; } catch { return null; }
    }

    for (const element of board.elements || []) {
      if (element.type === "stroke" && element.points?.length) {
        context.globalAlpha = finiteNumber(element.opacity, 1);
        context.strokeStyle = element.color || state.color;
        for (let index = 1; index < element.points.length; index += 1) {
          const previous = element.points[index - 1];
          const point = element.points[index];
          const pressure = (finiteNumber(previous.pressure, 0.5) + finiteNumber(point.pressure, 0.5)) / 2;
          context.lineWidth = Math.max(0.6, finiteNumber(element.width, 3) * (0.24 + pressure * 1.02) * scale);
          context.beginPath();
          context.moveTo(xAt(previous.x), yAt(previous.y));
          context.lineTo(xAt(point.x), yAt(point.y));
          context.stroke();
        }
        continue;
      }
      if (element.type === "line") {
        context.globalAlpha = 1;
        context.strokeStyle = element.color || state.color;
        context.lineWidth = Math.max(1, finiteNumber(element.width, 2) * scale);
        context.beginPath();
        context.moveTo(xAt(element.x1), yAt(element.y1));
        context.lineTo(xAt(element.x2), yAt(element.y2));
        context.stroke();
        continue;
      }
      if (element.type === "rectangle" || element.type === "ellipse") {
        context.globalAlpha = 1;
        context.strokeStyle = element.color || state.color;
        context.lineWidth = Math.max(1, finiteNumber(element.strokeWidth, finiteNumber(element.width, 2)) * scale);
        const x = xAt(element.x);
        const y = yAt(element.y);
        const width = finiteNumber(element.width) * scale;
        const height = finiteNumber(element.height) * scale;
        context.beginPath();
        if (element.type === "rectangle") context.rect(x, y, width, height);
        else context.ellipse(x + width / 2, y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
        context.stroke();
        continue;
      }
      if (element.type === "text" || element.type === "sticky") {
        const x = xAt(element.x);
        const y = yAt(element.y);
        const width = finiteNumber(element.width, element.type === "sticky" ? 250 : 380) * scale;
        const height = finiteNumber(element.height, element.type === "sticky" ? 180 : 120) * scale;
        if (element.type === "sticky") {
          context.fillStyle = "#fff1b8";
          context.fillRect(x, y, width, height);
          context.strokeStyle = "#e4cc70";
          context.lineWidth = 2;
          context.strokeRect(x, y, width, height);
        }
        context.globalAlpha = 1;
        context.fillStyle = element.type === "sticky" ? "#4d421e" : (element.color || "#1f4037");
        const fontSize = Math.max(12, (element.type === "sticky" ? 15 : 18) * scale);
        context.font = `${fontSize}px serif`;
        const lines = wrappedLines(element.text || "", width - 24);
        lines.slice(0, Math.max(1, Math.floor((height - 16) / (fontSize * 1.45)))).forEach((line, index) => {
          context.fillText(line, x + 12, y + fontSize + index * fontSize * 1.45);
        });
        continue;
      }
      if (element.type === "image") {
        const image = await loadImage(state.assets.get(element.assetId));
        if (image) {
          context.globalAlpha = 1;
          context.drawImage(image, xAt(element.x), yAt(element.y),
            finiteNumber(element.width, 320) * scale, finiteNumber(element.height, 220) * scale);
        }
      }
    }
    context.globalAlpha = 1;
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  function bytesFromDataUrl(dataUrl) {
    const binary = atob(String(dataUrl || "").split(",").at(-1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function exportBoardPdf(board = state.active) {
    if (!board) throw new Error("画板尚未加载完成。");
    await hydrateAssets(board);
    const bounds = boardContentBounds(board);
    const scale = Math.min(2, 2400 / bounds.width, 2400 / bounds.height);
    const imageWidth = Math.max(1, Math.round(bounds.width * scale));
    const imageHeight = Math.max(1, Math.round(bounds.height * scale));
    const dataUrl = await boardToDataUrl(2400, {
      board,
      backgroundColor: "#ffffff",
      bounds,
      maxScale: 2,
    });
    const image = bytesFromDataUrl(dataUrl);
    const pageWidth = 842;
    const pageHeight = pageWidth * imageHeight / imageWidth;
    const pdf = createPdfFromJpegPages([image], imageWidth, imageHeight, {
      pageWidth,
      pageHeight,
    });
    const safeTitle = String(board.title || "便读画板").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
    downloadBlob(pdf, `${safeTitle}.pdf`);
    app.toast("画板 PDF 已导出");
  }

  async function recognizeBoard() {
    if (!state.active) return null;
    const button = document.getElementById("recognizeBoardAiBtn");
    if (button?.disabled) return null;
    if (!state.active.elements?.length && !state.active.ocrText) throw new Error("画板还是空的。");
    if (button) { button.disabled = true; button.textContent = "正在识别…"; }
    try {
      const dataUrl = await boardToDataUrl(1800);
      const result = await recognizeHandwritingBoard(dataUrl);
      if (!result.transcript.trim()) throw new Error("没有识别到可确认的文字；原始手写笔迹仍完整保留。");
      state.active.ocrText = result.transcript;
      state.active.ocrMeta = { method: result.recognitionModel || "configured-model", recognizedAt: new Date().toISOString(), ...result };
      await persist(state.active, true);
      app.renderApp();
      app.toast(`画板手写已识别并写入知识库${result.confidence ? `（置信度 ${Math.round(result.confidence * 100)}%）` : ""}`);
      return result;
    } catch (error) {
      app.toast(`画板识别失败：${error.message}`);
      throw error;
    } finally {
      if (button) { button.disabled = false; button.textContent = "AI 识别手写"; }
    }
  }

  function bind() {
    document.body.classList.toggle("board-immersive", state.editorOpen);
    if (!window.__bianduBoardFlushBound) {
      window.__bianduBoardFlushBound = true;
      const flushActiveBoard = () => flush().catch((error) => console.warn("Board page-hide save failed", error));
      window.addEventListener("pagehide", flushActiveBoard);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushActiveBoard();
      });
    }
    document.getElementById("createBlankBoardBtn")?.addEventListener("click", () => {
      createBoard({ title: "自由画板", page: null, quote: "" });
    });
    document.getElementById("boardBackReaderBtn")?.addEventListener("click", async () => {
      await flush();
      closeEditor();
    });
    const createGalleryBoard = () => createBoard({ title: "自由画板", page: null, quote: "" }, { openEditor: true });
    document.getElementById("boardGalleryCreateBtn")?.addEventListener("click", createGalleryBoard);
    document.getElementById("boardGalleryEmptyCreateBtn")?.addEventListener("click", createGalleryBoard);
    document.getElementById("boardGalleryImportBtn")?.addEventListener("click", () => {
      document.getElementById("boardGalleryImportInput")?.click();
    });
    document.getElementById("boardGalleryImportInput")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try { await importBoardFile(file); }
      catch (error) { app.toast(`画板导入失败：${error.message}`); }
    });
    document.querySelectorAll("[data-open-board-id]").forEach((button) => {
      button.addEventListener("click", () => openBoard(button.getAttribute("data-open-board-id")));
    });
    document.querySelectorAll("[data-export-board-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const board = state.boards.find((item) => item.id === button.getAttribute("data-export-board-id"));
        if (board) await exportBoardFile(board);
      });
    });
    document.querySelectorAll("[data-pdf-board-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const board = state.boards.find((item) => item.id === button.getAttribute("data-pdf-board-id"));
        if (!board) return;
        try { await exportBoardPdf(board); }
        catch (error) { app.toast(`PDF 导出失败：${error.message}`); }
      });
    });
    const boardShell = document.querySelector(".bd-shell");
    document.getElementById("boardListToggleBtn")?.addEventListener("click", () => {
      boardShell?.classList.toggle("is-list-open");
      boardShell?.classList.remove("is-context-open");
    });
    document.getElementById("boardListCloseBtn")?.addEventListener("click", () => {
      boardShell?.classList.remove("is-list-open");
    });
    document.getElementById("boardContextToggleBtn")?.addEventListener("click", () => {
      boardShell?.classList.toggle("is-context-open");
      boardShell?.classList.remove("is-list-open");
    });
    document.getElementById("boardContextCloseBtn")?.addEventListener("click", () => {
      boardShell?.classList.remove("is-context-open");
    });
    document.getElementById("boardMoreToolsBtn")?.addEventListener("click", () => {
      document.getElementById("boardMorePanel")?.classList.toggle("is-open");
    });
    document.querySelectorAll('[data-board-action="context"]').forEach((button) => {
      button.addEventListener("click", () => {
        boardShell?.classList.toggle("is-context-open");
        boardShell?.classList.remove("is-list-open");
      });
    });
    document.getElementById("boardUndoBtn")?.addEventListener("click", undo);
    document.getElementById("boardRedoBtn")?.addEventListener("click", redo);
    document.getElementById("boardDeleteSelectionBtn")?.addEventListener("click", deleteSelection);
    document.getElementById("boardDuplicateBtn")?.addEventListener("click", duplicateSelection);
    document.getElementById("boardPaperStyle")?.addEventListener("change", (event) => {
      state.active.paperStyle = ["plain", "grid", "dots", "dark"].includes(event.target.value) ? event.target.value : "plain";
      app.renderApp();
      persist(state.active, true);
    });
    document.getElementById("boardFitCanvasBtn")?.addEventListener("click", () => {
      state.zoom = 1; state.panX = 0; state.panY = 0; updateWorldTransform();
      const label = document.getElementById("boardZoomLabel"); if (label) label.textContent = "100%";
      persist();
    });
    document.getElementById("boardExportFileBtn")?.addEventListener("click", () => exportBoardFile(state.active));
    document.getElementById("boardExportPdfBtn")?.addEventListener("click", () => {
      exportBoardPdf(state.active).catch((error) => app.toast(`PDF 导出失败：${error.message}`));
    });
    document.getElementById("boardExportPngBtn")?.addEventListener("click", exportPng);
    document.getElementById("boardZoomInBtn")?.addEventListener("click", () => setZoom(state.zoom * 1.18));
    document.getElementById("boardZoomOutBtn")?.addEventListener("click", () => setZoom(state.zoom / 1.18));
    document.getElementById("boardWidthRange")?.addEventListener("input", (event) => { state.width = Number(event.target.value); });
    document.querySelectorAll("[data-board-color]").forEach((button) => button.addEventListener("click", () => {
      state.color = button.getAttribute("data-board-color");
      if (button.classList.contains("bd-marker")) {
        state.tool = "highlighter";
        syncActiveTool();
      }
      document.querySelectorAll("[data-board-color]").forEach((item) => item.classList.toggle("is-active", item === button));
    }));
    document.querySelectorAll("[data-board-tool]").forEach((button) => button.addEventListener("click", () => {
      state.tool = button.getAttribute("data-board-tool");
      if (button.closest("#boardMorePanel") && !["text", "sticky", "image"].includes(state.tool)) {
        document.getElementById("boardMorePanel")?.classList.remove("is-open");
      }
      if (state.tool === "text" || state.tool === "sticky") askElementText(state.tool);
      if (state.tool === "image") document.getElementById("boardImageInput")?.click();
      if (!["select", "lasso"].includes(state.tool)) clearSelection();
      if (state.tool !== "text" && state.tool !== "sticky" && state.tool !== "image") {
        document.querySelectorAll("[data-board-tool]").forEach((item) => item.classList.toggle("is-active", item === button));
      }
    }));
    const handleBoardShortcut = (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if ((event.key === "Delete" || event.key === "Backspace") && state.selectedIds.size) {
        event.preventDefault();
        deleteSelection();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && state.selectedIds.size) {
        event.preventDefault();
        duplicateSelection();
      }
    };
    if (!window.__bianduBoardShortcutBound) {
      window.__bianduBoardShortcutBound = true;
      window.addEventListener("keydown", handleBoardShortcut);
    }
    document.querySelectorAll(".board-list-item").forEach((button) => button.addEventListener("click", async () => {
      await persist(state.active, true);
      await openBoard(button.getAttribute("data-board-id"));
      document.querySelector(".bd-shell")?.classList.remove("is-list-open");
    }));
    document.getElementById("boardImageInput")?.addEventListener("change", (event) => addImage(event.target.files?.[0]));
    document.getElementById("saveBoardOcrBtn")?.addEventListener("click", async () => {
      state.active.ocrText = document.getElementById("boardOcrText")?.value.trim() || "";
      await persist(state.active, true);
      app.toast("画板文字已写入知识库证据");
    });
    document.getElementById("recognizeBoardAiBtn")?.addEventListener("click", () => recognizeBoard().catch(() => {}));

    const stage = document.getElementById("bdStage");
    if (!stage) return;
    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      setZoom(state.zoom * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    stage.addEventListener("dblclick", (event) => {
      const elementId = event.target.closest("[data-element-id]")?.getAttribute("data-element-id");
      const element = state.active.elements.find((item) => item.id === elementId);
      if (element && (element.type === "text" || element.type === "sticky")) {
        const root = document.getElementById("modalRoot");
        const value = window.prompt("编辑画板文字", element.text || "");
        if (value !== null && value.trim()) {
          pushUndo(); element.text = value.trim(); app.renderApp(); persist();
        }
        root.innerHTML = "";
      }
    });
    function currentTouchPoints() {
      return [...state.touchPoints.values()];
    }

    function cancelDrawingForPinch() {
      const drawing = state.drawing;
      if (drawing?.type === "stroke") {
        state.active.elements = state.active.elements.filter((item) => item.id !== drawing.id);
        document.querySelector(`#boardViewport [data-element-id="${drawing.id}"]`)?.remove();
        if (drawing.undoPushed) state.undo.pop();
      }
      state.drawing = null;
      state.gesture = null;
    }

    function beginPinch() {
      const points = currentTouchPoints();
      if (points.length < 2) return;
      const rect = stage.getBoundingClientRect();
      const first = points[0];
      const second = points[1];
      const centerX = (first.x + second.x) / 2 - rect.left;
      const centerY = (first.y + second.y) / 2 - rect.top;
      cancelDrawingForPinch();
      state.gesture = {
        type: "pinch", startDistance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        startZoom: state.zoom, worldX: (centerX - state.panX) / state.zoom,
        worldY: (centerY - state.panY) / state.zoom,
      };
    }

    function updatePinch() {
      const points = currentTouchPoints();
      if (state.gesture?.type !== "pinch" || points.length < 2) return;
      const rect = stage.getBoundingClientRect();
      const first = points[0];
      const second = points[1];
      const centerX = (first.x + second.x) / 2 - rect.left;
      const centerY = (first.y + second.y) / 2 - rect.top;
      const ratio = Math.hypot(first.x - second.x, first.y - second.y) / state.gesture.startDistance;
      state.zoom = Math.max(0.22, Math.min(4, state.gesture.startZoom * ratio));
      state.panX = centerX - state.gesture.worldX * state.zoom;
      state.panY = centerY - state.gesture.worldY * state.zoom;
      updateWorldTransform();
      const label = document.getElementById("boardZoomLabel");
      if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
    }

    function capturePointer(pointerId) {
      try { stage.setPointerCapture(pointerId); } catch { /* Synthetic tests and cancelled pointers may not be capturable. */ }
    }

    function markPenActivity() {
      state.lastPenActivityAt = performance.now();
    }

    function penInputIsRecent(graceMs = 220) {
      return performance.now() - finiteNumber(state.lastPenActivityAt, 0) < graceMs;
    }

    function clearTouchInteraction() {
      if (state.gesture?.type === "pan" && state.gesture.inputType === "touch") {
        state.panX = finiteNumber(state.gesture.panX, state.panX);
        state.panY = finiteNumber(state.gesture.panY, state.panY);
        updateWorldTransform();
      }
      state.touchPoints.clear();
      state.suppressedTouchPoints.clear();
      if (state.gesture?.inputType === "touch") state.gesture = null;
      cancelDrawingForPinch();
    }

    function startPan(event, inputType) {
      state.gesture = {
        type: "pan", inputType, startX: event.clientX, startY: event.clientY,
        panX: state.panX, panY: state.panY, pointerId: event.pointerId,
      };
      capturePointer(event.pointerId);
    }

    function syncActiveTool() {
      document.querySelectorAll("[data-board-tool]").forEach((item) =>
        item.classList.toggle("is-active", item.getAttribute("data-board-tool") === state.tool)
      );
    }

    function startStroke(event) {
      pushUndo();
      const point = pointerPoint(event, screenToWorld(event.clientX, event.clientY));
      const brush = ["pencil", "highlighter"].includes(state.tool) ? state.tool : "pen";
      const width = brush === "highlighter" ? Math.max(10, state.width * 2.2) : brush === "pencil" ? Math.max(1, state.width * 0.68) : state.width;
      const stroke = {
        id: createId("stroke"), type: "stroke", brush, color: state.color, width,
        opacity: brush === "highlighter" ? 0.3 : brush === "pencil" ? 0.78 : 1,
        pointerType: event.pointerType || "mouse", points: [point],
        createdAt: new Date().toISOString(),
      };
      state.active.elements.push(stroke);
      state.drawing = { ...stroke, pointerId: event.pointerId, undoPushed: true };
      const svg = document.querySelector("#boardViewport svg");
      svg?.insertAdjacentHTML("beforeend", strokeMarkup(stroke));
      capturePointer(event.pointerId);
    }

    function coalescedEvents(event) {
      let samples = [];
      try { samples = Array.from(event.getCoalescedEvents?.() || []); } catch { samples = []; }
      if (!samples.some((sample) => sample.timeStamp === event.timeStamp)) samples.push(event);
      return samples;
    }

    function appendStrokeSamples(samples) {
      if (!state.drawing || state.drawing.type !== "stroke") return;
      for (const sample of samples) {
        const point = pointerPoint(sample, screenToWorld(sample.clientX, sample.clientY));
        const previous = state.drawing.points.at(-1);
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.08 &&
            Math.abs(point.pressure - previous.pressure) < 0.01) continue;
        state.drawing.points.push(point);
      }
      const visual = document.querySelector(`#boardViewport [data-element-id="${state.drawing.id}"]`);
      if (visual) visual.outerHTML = strokeMarkup(state.drawing);
    }

    stage.addEventListener("contextmenu", (event) => {
      if (event.pointerType === "pen" || state.penPointerId !== null) event.preventDefault();
    });
    stage.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "pen") markPenActivity();
    });

    stage.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".bd-hint")) return;
      if (event.target.closest(".bd-board-rail, .bd-more-panel")) return;
      document.getElementById("boardMorePanel")?.classList.remove("is-open");
      if (event.pointerType === "touch") {
        if (state.penPointerId !== null || likelyPalmContact(event)) {
          state.ignoredPointers.add(event.pointerId);
          event.preventDefault();
          return;
        }
        if (penInputIsRecent()) {
          state.suppressedTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (state.suppressedTouchPoints.size >= 2) {
            const points = [...state.suppressedTouchPoints.entries()].slice(0, 2);
            state.touchPoints.clear();
            for (const [pointerId, point] of points) {
              state.touchPoints.set(pointerId, point);
              state.ignoredPointers.delete(pointerId);
            }
            state.suppressedTouchPoints.clear();
            event.preventDefault();
            beginPinch();
            capturePointer(event.pointerId);
            return;
          }
          state.ignoredPointers.add(event.pointerId);
          event.preventDefault();
          capturePointer(event.pointerId);
          return;
        }
        state.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (state.touchPoints.size >= 2) {
          event.preventDefault();
          beginPinch();
        } else if (state.tool === "pen" || state.tool === "select") {
          startPan(event, "touch");
        }
        capturePointer(event.pointerId);
        return;
      }

      if (event.pointerType === "pen") {
        markPenActivity();
        event.preventDefault();
        if (state.penPointerId !== null) return;
        state.penPointerId = event.pointerId;
        if (state.touchPoints.size || state.gesture?.inputType === "touch") clearTouchInteraction();
      }

      if (isHardwareEraser(event)) {
        state.erasingPointerId = event.pointerId;
        eraseAt(event.clientX, event.clientY);
        capturePointer(event.pointerId);
        return;
      }
      if (isBarrelButton(event)) {
        state.barrelGesture = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          returnTool: state.tool,
        };
        if (state.tool !== "eraser") state.lastInkTool = state.tool;
        state.erasingPointerId = event.pointerId;
        state.tool = "eraser";
        syncActiveTool();
        eraseAt(event.clientX, event.clientY);
        capturePointer(event.pointerId);
        return;
      }
      if (state.tool === "text" || state.tool === "sticky" || state.tool === "image") return;
      if (state.tool === "eraser") {
        state.erasingPointerId = event.pointerId;
        eraseAt(event.clientX, event.clientY);
        capturePointer(event.pointerId);
        return;
      }
      if (state.tool === "select") {
        const targetId = event.target.closest("[data-element-id]")?.getAttribute("data-element-id");
        const element = state.active.elements.find((item) => item.id === targetId) || elementHitAt(screenToWorld(event.clientX, event.clientY));
        if (element) startElementMove(event, element);
        else {
          clearSelection();
          startPan(event, event.pointerType || "mouse");
        }
        return;
      }
      if (state.tool === "lasso") {
        const point = screenToWorld(event.clientX, event.clientY);
        state.gesture = { type: "lasso", pointerId: event.pointerId, points: [point] };
        capturePointer(event.pointerId);
        return;
      }
      if (state.tool === "rectangle" || state.tool === "ellipse") {
        const point = screenToWorld(event.clientX, event.clientY);
        state.gesture = { type: "shape", shape: state.tool, pointerId: event.pointerId, start: point, current: point };
        capturePointer(event.pointerId);
        return;
      }
      if (state.tool === "line") {
        const point = screenToWorld(event.clientX, event.clientY);
        state.drawing = { type: "line", start: point, pointerId: event.pointerId };
        capturePointer(event.pointerId);
        return;
      }
      startStroke(event);
    });

    stage.addEventListener("pointermove", (event) => {
      if (event.pointerType === "pen") markPenActivity();
      if (state.suppressedTouchPoints.has(event.pointerId)) {
        state.suppressedTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.preventDefault();
        return;
      }
      if (state.ignoredPointers.has(event.pointerId)) {
        event.preventDefault();
        return;
      }
      if (state.touchPoints.has(event.pointerId)) {
        if (state.penPointerId !== null) return;
        state.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (state.gesture?.type === "pinch") {
          event.preventDefault();
          updatePinch();
          return;
        }
      }
      if (state.erasingPointerId === event.pointerId) {
        event.preventDefault();
        if (state.barrelGesture?.pointerId === event.pointerId &&
            Math.hypot(event.clientX - state.barrelGesture.startX,
              event.clientY - state.barrelGesture.startY) > 7) {
          state.barrelGesture.moved = true;
        }
        for (const sample of coalescedEvents(event)) eraseAt(sample.clientX, sample.clientY);
        return;
      }
      if (state.gesture?.type === "move-elements" && state.gesture.pointerId === event.pointerId) {
        event.preventDefault();
        applyElementMove(event);
        return;
      }
      if (state.gesture?.type === "lasso" && state.gesture.pointerId === event.pointerId) {
        event.preventDefault();
        const point = screenToWorld(event.clientX, event.clientY);
        const previous = state.gesture.points.at(-1);
        if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 2) state.gesture.points.push(point);
        selectionPreviewMarkup("lasso", state.gesture.points);
        return;
      }
      if (state.gesture?.type === "shape" && state.gesture.pointerId === event.pointerId) {
        event.preventDefault();
        state.gesture.current = screenToWorld(event.clientX, event.clientY);
        const start = state.gesture.start;
        const current = state.gesture.current;
        selectionPreviewMarkup(state.gesture.shape, {
          x: Math.min(start.x, current.x), y: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y),
        });
        return;
      }
      if (state.gesture?.type === "pan" && state.gesture.pointerId === event.pointerId) {
        state.panX = state.gesture.panX + event.clientX - state.gesture.startX;
        state.panY = state.gesture.panY + event.clientY - state.gesture.startY;
        updateWorldTransform();
        return;
      }
      if (!state.drawing || state.drawing.pointerId !== event.pointerId || state.drawing.type === "line") return;
      event.preventDefault();
      appendStrokeSamples(coalescedEvents(event));
    });
    stage.addEventListener("pointerrawupdate", (event) => {
      if (event.pointerType !== "pen" || !state.drawing ||
          state.drawing.pointerId !== event.pointerId || state.drawing.type !== "stroke") return;
      markPenActivity();
      event.preventDefault();
      appendStrokeSamples(coalescedEvents(event));
    });

    const finish = (event) => {
      if (event.pointerType === "pen") markPenActivity();
      state.suppressedTouchPoints.delete(event.pointerId);
      if (state.ignoredPointers.delete(event.pointerId)) return;
      const wasTouch = state.touchPoints.delete(event.pointerId);
      if (wasTouch && state.gesture?.type === "pinch") {
        if (state.touchPoints.size < 2) {
          state.gesture = null;
          persist();
        }
        return;
      }
      if (state.gesture?.type === "pan" && state.gesture.pointerId === event.pointerId) {
        state.gesture = null;
        if (state.penPointerId === event.pointerId) state.penPointerId = null;
        persist();
        return;
      }
      if (state.erasingPointerId === event.pointerId) {
        state.erasingPointerId = null;
        if (state.barrelGesture?.pointerId === event.pointerId) {
          const gesture = state.barrelGesture;
          state.barrelGesture = null;
          state.tool = event.type === "pointercancel"
            ? gesture.returnTool
            : gesture.returnTool === "eraser"
              ? (state.lastInkTool || "pen")
              : gesture.moved ? gesture.returnTool : "eraser";
          if (state.tool !== "eraser") state.lastInkTool = state.tool;
          syncActiveTool();
        }
        if (state.penPointerId === event.pointerId) state.penPointerId = null;
        persist();
        return;
      }
      if (state.gesture?.type === "move-elements" && state.gesture.pointerId === event.pointerId) {
        state.gesture = null;
        document.getElementById("boardGesturePreview")?.remove();
        if (state.penPointerId === event.pointerId) state.penPointerId = null;
        app.renderApp();
        persist();
        return;
      }
      if (state.gesture?.type === "lasso" && state.gesture.pointerId === event.pointerId) {
        const polygon = state.gesture.points;
        clearSelection();
        if (polygon.length > 2) {
          for (const element of state.active.elements) {
            const bounds = elementBounds(element);
            if (!bounds) continue;
            const probes = element.type === "stroke"
              ? element.points
              : element.type === "line"
                ? [{ x: element.x1, y: element.y1 }, { x: element.x2, y: element.y2 }]
                : [
                    { x: bounds.x, y: bounds.y },
                    { x: bounds.x + bounds.width, y: bounds.y },
                    { x: bounds.x, y: bounds.y + bounds.height },
                    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
                    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
                  ];
            if (probes.some((point) => pointInPolygon(point, polygon))) state.selectedIds.add(element.id);
          }
        }
        state.gesture = null;
        document.getElementById("boardGesturePreview")?.remove();
        if (state.penPointerId === event.pointerId) state.penPointerId = null;
        app.renderApp();
        return;
      }
      if (state.gesture?.type === "shape" && state.gesture.pointerId === event.pointerId) {
        const start = state.gesture.start;
        const current = state.gesture.current || start;
        const width = Math.abs(current.x - start.x);
        const height = Math.abs(current.y - start.y);
        if (event.type !== "pointercancel" && width > 6 && height > 6) {
          pushUndo();
          state.active.elements.push({
            id: createId("element"),
            type: state.gesture.shape,
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            width,
            height,
            color: state.color,
            strokeWidth: state.width,
            fill: "none",
            createdAt: new Date().toISOString(),
          });
          app.renderApp();
          persist();
        }
        state.gesture = null;
        document.getElementById("boardGesturePreview")?.remove();
        if (state.penPointerId === event.pointerId) state.penPointerId = null;
        return;
      }
      if (state.drawing?.pointerId === event.pointerId && state.drawing.type === "line") {
        const end = screenToWorld(event.clientX, event.clientY);
        const start = state.drawing.start;
        if (event.type !== "pointercancel" && Math.hypot(end.x - start.x, end.y - start.y) > 8) {
          pushUndo();
          state.active.elements.push({
            id: createId("element"), type: "line", x1: start.x, y1: start.y,
            x2: end.x, y2: end.y, color: state.color, width: state.width,
            createdAt: new Date().toISOString(),
          });
          app.renderApp();
          persist();
        }
        state.drawing = null;
        if (state.penPointerId === event.pointerId) state.penPointerId = null;
        return;
      }
      if (state.drawing?.pointerId === event.pointerId && state.drawing.type === "stroke") {
        const target = state.active.elements.find((item) => item.id === state.drawing.id);
        if (target) {
          target.points = state.drawing.points;
          target.pointerType = state.drawing.pointerType;
        }
        state.drawing = null;
        persist();
      }
      if (state.penPointerId === event.pointerId) state.penPointerId = null;
      if (wasTouch) persist();
    };
    stage.addEventListener("pointerup", finish);
    stage.addEventListener("pointercancel", finish);
  }

  return { render, bind, refresh, createBoard, recognizeBoard, flush, getActive: () => state.active, getState: () => state };
}
