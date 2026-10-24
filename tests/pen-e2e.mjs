import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const configuredBaseUrl = process.env.BIANDU_BASE_URL || "";
const baseUrl = configuredBaseUrl || "http://127.0.0.1:4175";
const pdfPath = resolve("tests/fixtures/reading-sample.pdf");
let server;

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Wait for the local server.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Static server did not start at ${url}`);
}

async function readBoards(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolveDb, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolveDb(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolveRows, reject) => {
      const request = db.transaction("boards", "readonly").objectStore("boards").getAll();
      request.onsuccess = () => resolveRows(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

try {
  if (!configuredBaseUrl) {
    server = spawn(process.execPath, ["tools/serve.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "4175" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForServer(baseUrl);
  }

  const browser = await chromium.launch({ headless: true, executablePath: edgePath });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`${baseUrl}/index.html?device=xiaomi&view=board`, { waitUntil: "networkidle" });
    const blankButton = page.locator("#boardGalleryCreateBtn, #boardGalleryEmptyCreateBtn").first();
    if (await blankButton.count()) await blankButton.click();
    await page.waitForSelector("#bdStage");
    await page.waitForFunction(() => Boolean(window.BianDuRuntime.board.getActive()));

    await page.evaluate(() => {
      const stage = document.getElementById("bdStage");
      const rect = stage.getBoundingClientRect();
      const fire = (target, type, init) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 11,
        pointerType: "pen", isPrimary: true, ...init,
      }));

      // A resting palm can arrive just before the pen tip. Pen hover marks the
      // surface as pen-active, so the palm must be rejected before it moves the canvas.
      fire(stage, "pointermove", {
        clientX: rect.left + 90, clientY: rect.top + 100,
        button: -1, buttons: 0, pressure: 0,
      });
      stage.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 20,
        pointerType: "touch", isPrimary: false, clientX: rect.left + 280,
        clientY: rect.top + 210, button: 0, buttons: 1, pressure: 0.5,
        width: 90, height: 110,
      }));
      stage.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, composed: true, pointerId: 20,
        pointerType: "touch", isPrimary: false, clientX: rect.left + 360,
        clientY: rect.top + 260, button: -1, buttons: 1, pressure: 0.5,
        width: 90, height: 110,
      }));

      fire(stage, "pointerdown", {
        clientX: rect.left + 90, clientY: rect.top + 100, button: 0, buttons: 1,
        pressure: 0.18, tiltX: 18, tiltY: -12, twist: 24, width: 2.2, height: 2.2,
      });
      fire(stage, "pointermove", {
        clientX: rect.left + 150, clientY: rect.top + 130, button: -1, buttons: 1,
        pressure: 0.82, tiltX: 23, tiltY: -8, twist: 31, width: 2.8, height: 2.8,
      });
      fire(stage, "pointerrawupdate", {
        clientX: rect.left + 188, clientY: rect.top + 150, button: -1, buttons: 1,
        pressure: 0.64, tiltX: 20, tiltY: -7, twist: 30, width: 2.6, height: 2.6,
      });

      // A palm contact arrives while the pen is down. It must neither pan nor
      // create a second stroke, and the pen must continue writing.
      stage.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 21,
        pointerType: "touch", isPrimary: false, clientX: rect.left + 260,
        clientY: rect.top + 210, button: 0, buttons: 1, pressure: 0.5,
      }));
      stage.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, composed: true, pointerId: 21,
        pointerType: "touch", isPrimary: false, clientX: rect.left + 360,
        clientY: rect.top + 260, button: -1, buttons: 1, pressure: 0.5,
      }));

      fire(stage, "pointermove", {
        clientX: rect.left + 225, clientY: rect.top + 170, button: -1, buttons: 1,
        pressure: 0.46, tiltX: 14, tiltY: -6, twist: 28, width: 2.5, height: 2.5,
      });
      fire(stage, "pointerup", {
        clientX: rect.left + 225, clientY: rect.top + 170, button: 0, buttons: 0,
        pressure: 0, tiltX: 14, tiltY: -6, twist: 28,
      });
      stage.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 21,
        pointerType: "touch", isPrimary: false, clientX: rect.left + 360,
        clientY: rect.top + 260, button: 0, buttons: 0,
      }));
    });
    await page.waitForTimeout(700);

    const penState = await page.evaluate(() => {
      const state = window.BianDuRuntime.board.getState();
      const strokes = state.active.elements.filter((item) => item.type === "stroke");
      return {
        strokes, panX: state.panX, panY: state.panY,
        visual: document.querySelector(`#boardViewport [data-element-id="${strokes[0]?.id}"]`)?.outerHTML || "",
      };
    });
    assert.equal(penState.strokes.length, 1, "Palm contact must not create a second stroke");
    assert.equal(penState.strokes[0].pointerType, "pen");
    assert.ok(penState.strokes[0].points.length >= 4, "Raw and coalesced pen samples should be retained");
    assert.ok(Math.min(...penState.strokes[0].points.map((point) => point.pressure)) < 0.25);
    assert.ok(Math.max(...penState.strokes[0].points.map((point) => point.pressure)) > 0.8);
    assert.ok(penState.strokes[0].points.some((point) => point.tiltX === 23 && point.twist === 31));
    assert.match(penState.visual, /data-pressure-max="0\.820"/);
    assert.match(penState.visual, /<path /, "Pressure should render as a variable-width outline");
    assert.equal(penState.panX, 0, "Palm must not pan while the pen is down");
    assert.equal(penState.panY, 0, "Palm must not pan while the pen is down");

    // A short barrel-button press toggles the eraser. Holding and moving
    // erases temporarily, then restores the previous drawing tool.
    const barrelState = await page.evaluate(() => {
      const state = window.BianDuRuntime.board.getState();
      state.tool = "highlighter";
      const stage = document.getElementById("bdStage");
      const rect = stage.getBoundingClientRect();
      stage.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 61,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 2,
        clientX: rect.left + 500, clientY: rect.top + 300, pressure: 0.3,
      }));
      stage.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 61,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 0,
        clientX: rect.left + 500, clientY: rect.top + 300, pressure: 0,
      }));
      const shortToggle = state.tool;
      document.querySelector(".bd-marker").click();
      stage.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 62,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 2,
        clientX: rect.left + 500, clientY: rect.top + 320, pressure: 0.3,
      }));
      stage.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, composed: true, pointerId: 62,
        pointerType: "pen", isPrimary: true, button: -1, buttons: 2,
        clientX: rect.left + 560, clientY: rect.top + 350, pressure: 0.3,
      }));
      stage.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 62,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 0,
        clientX: rect.left + 560, clientY: rect.top + 350, pressure: 0,
      }));
      return { shortToggle, heldTool: state.tool, panX: state.panX, panY: state.panY };
    });
    assert.equal(barrelState.shortToggle, "eraser", "A short pen-button press should switch to eraser");
    assert.equal(barrelState.heldTool, "highlighter", "Temporary erase should restore the previous brush");
    assert.equal(barrelState.panX, 0, "Pen-button erase must not pan the canvas");
    assert.equal(barrelState.panY, 0, "Pen-button erase must not pan the canvas");

    const savedBoard = (await readBoards(page)).find((board) => board.elements.some((item) => item.id === penState.strokes[0].id));
    assert.ok(savedBoard, "Pen stroke should be persisted to IndexedDB");
    const persistedStroke = savedBoard.elements.find((item) => item.type === "stroke");
    assert.equal(persistedStroke.pointerType, "pen");
    assert.ok(persistedStroke.points.every((point) => "tiltX" in point && "twist" in point && "timeStamp" in point));

    // After the pen lifts, two fingers still pan/zoom normally.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const stageBox = await page.locator("#bdStage").boundingBox();
    const centerX = stageBox.x + stageBox.width / 2;
    const centerY = stageBox.y + stageBox.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: centerX - 35, y: centerY, id: 31 }, { x: centerX + 35, y: centerY, id: 32 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: centerX - 85, y: centerY, id: 31 }, { x: centerX + 85, y: centerY, id: 32 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => window.BianDuRuntime.board.getState().zoom > 1.05);

    // Stress the hardware eraser contract used by styluses that expose button 5.
    await page.evaluate(() => {
      const stage = document.getElementById("bdStage");
      const rect = stage.getBoundingClientRect();
      const stroke = window.BianDuRuntime.board.getState().active.elements.find((item) => item.type === "stroke");
      const point = stroke.points[1];
      stage.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 41,
        pointerType: "pen", isPrimary: true, button: 5, buttons: 32,
        clientX: rect.left + point.x * window.BianDuRuntime.board.getState().zoom + window.BianDuRuntime.board.getState().panX,
        clientY: rect.top + point.y * window.BianDuRuntime.board.getState().zoom + window.BianDuRuntime.board.getState().panY,
        pressure: 0.4,
      }));
      stage.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 41,
        pointerType: "pen", isPrimary: true, button: 5, buttons: 0,
        pressure: 0,
      }));
    });
    await page.waitForTimeout(500);
    assert.equal(
      await page.evaluate(() => window.BianDuRuntime.board.getState().active.elements.filter((item) => item.type === "stroke").length),
      0,
      "Hardware eraser contact should remove the stroke",
    );

    // Return to a fresh board and verify pen long-press word lookup does not
    // initiate canvas panning. The reader surface is separate from the board.
    await page.click("#boardBackReaderBtn");
    await page.waitForSelector(".bd-gallery-page");
    await page.evaluate(() => window.BianDuRuntime.app.switchView("library"));
    await page.waitForSelector("#openImportPdfBtn");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.click("#openImportPdfBtn");
    const chooser = await chooserPromise;
    await chooser.setFiles(pdfPath);
    const card = page.locator('.book-card-item[data-book-id^="pdf-"]').first();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await card.click();
    await page.waitForSelector("#bookDetailContinueBtn");
    await page.click("#bookDetailContinueBtn");
    await page.waitForSelector('.real-reader-text .word-token[data-word="information"]');
    await page.locator('.real-reader-text .word-token[data-word="information"]').first().dispatchEvent("pointerdown", {
      pointerId: 51, pointerType: "pen", isPrimary: true, button: 0, buttons: 1,
      clientX: 200, clientY: 220, pressure: 0.35,
    });
    await page.waitForTimeout(560);
    const lookup = await page.evaluate(() => ({
      word: window.BianDuFeatures.state.activePopupWord,
      open: window.BianDuFeatures.state.readerWordPopupOpen,
    }));
    assert.equal(lookup.word, "information");
    assert.equal(lookup.open, true);
    await page.locator('.real-reader-text .word-token[data-word="information"]').first().dispatchEvent("pointerup", {
      pointerId: 51, pointerType: "pen", isPrimary: true, button: 0, buttons: 0,
      clientX: 200, clientY: 220, pressure: 0,
    });

    await page.evaluate(() => {
      window.BianDuFeatures.state.readerViewMode = "original";
      window.BianDuFeatures.renderApp();
    });
    await page.waitForSelector("#readerInkCanvas");
    await page.waitForFunction(() => document.getElementById("readerInkCanvas")?.dataset.bound === "true");
    const pdfInk = await page.evaluate(async () => {
      const canvas = document.getElementById("readerInkCanvas");
      const rect = canvas.getBoundingClientRect();
      const fire = (type, init) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 71,
        pointerType: "pen", isPrimary: true, ...init,
      }));
      fire("pointerdown", {
        clientX: rect.left + 120, clientY: rect.top + 160,
        button: 0, buttons: 1, pressure: 0.16,
        tiltX: 20, tiltY: -9, twist: 35,
      });
      fire("pointermove", {
        clientX: rect.left + 210, clientY: rect.top + 210,
        button: -1, buttons: 1, pressure: 0.76,
        tiltX: 25, tiltY: -7, twist: 42,
      });
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 72,
        pointerType: "touch", isPrimary: false, clientX: rect.left + 280,
        clientY: rect.top + 260, button: 0, buttons: 1, pressure: 0.5,
        width: 90, height: 100,
      }));
      fire("pointerup", {
        clientX: rect.left + 210, clientY: rect.top + 210,
        button: 0, buttons: 0, pressure: 0, tiltX: 25, tiltY: -7, twist: 42,
      });
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 75,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 2,
        clientX: rect.left + 320, clientY: rect.top + 300, pressure: 0.3,
      }));
      canvas.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 75,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 0,
        clientX: rect.left + 320, clientY: rect.top + 300, pressure: 0,
      }));
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      const book = window.BianDuFeatures.currentImportedBook();
      const strokes = book.pdfInkAnnotations?.[String(book.page)] || [];
      return {
        count: strokes.length,
        stroke: strokes[0],
        switchedTool: window.BianDuFeatures.state.readerPdfTool,
      };
    });
    assert.equal(pdfInk.count, 1, "Palm/finger contact must not create a PDF ink stroke");
    assert.equal(pdfInk.stroke.pointerType, "pen");
    assert.ok(Math.min(...pdfInk.stroke.points.map((point) => point.pressure)) < 0.2);
    assert.ok(Math.max(...pdfInk.stroke.points.map((point) => point.pressure)) > 0.7);
    assert.ok(pdfInk.stroke.points.some((point) => point.tiltX === 25 && point.twist === 42));
    assert.equal(pdfInk.switchedTool, "eraser", "PDF pen button click should switch to eraser");

    await page.evaluate(() => {
      window.BianDuFeatures.state.readerViewMode = "text";
      window.BianDuFeatures.renderApp();
      window.BianDuRuntime.reader.createAnnotationBoard();
    });
    await page.waitForSelector("#readerInlineBoardCanvas");
    const inlinePen = await page.evaluate(async () => {
      const canvas = document.getElementById("readerInlineBoardCanvas");
      const rect = canvas.getBoundingClientRect();
      const fire = (type, init) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 81,
        pointerType: "pen", isPrimary: true, ...init,
      }));
      fire("pointerdown", {
        clientX: rect.left + 80, clientY: rect.top + 70,
        button: 0, buttons: 1, pressure: 0.2,
        tiltX: 14, tiltY: -6, twist: 18,
      });
      fire("pointermove", {
        clientX: rect.left + 190, clientY: rect.top + 120,
        button: -1, buttons: 1, pressure: 0.72,
        tiltX: 19, tiltY: -4, twist: 26,
      });
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 82,
        pointerType: "touch", isPrimary: false, clientX: rect.left + 260,
        clientY: rect.top + 150, button: 0, buttons: 1, pressure: 0.5,
        width: 88, height: 104,
      }));
      fire("pointerup", {
        clientX: rect.left + 190, clientY: rect.top + 120,
        button: 0, buttons: 0, pressure: 0, tiltX: 19, tiltY: -4, twist: 26,
      });
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, pointerId: 83,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 2,
        clientX: rect.left + 280, clientY: rect.top + 180, pressure: 0.3,
      }));
      canvas.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, composed: true, pointerId: 83,
        pointerType: "pen", isPrimary: true, button: 2, buttons: 0,
        clientX: rect.left + 280, clientY: rect.top + 180, pressure: 0,
      }));
      const drawing = window.BianDuRuntime.reader.getState().inlineBoard;
      return { count: drawing.strokes.length, stroke: drawing.strokes[0], switchedTool: drawing.tool };
    });
    assert.equal(inlinePen.count, 1, "Inline board must reject palm contacts");
    assert.equal(inlinePen.stroke.pointerType, "pen");
    assert.ok(Math.max(...inlinePen.stroke.points.map((point) => point.pressure)) > 0.7);
    assert.ok(inlinePen.stroke.points.some((point) => point.tiltX === 19 && point.twist === 26));
    assert.equal(inlinePen.switchedTool, "eraser", "Inline board pen button should switch to eraser");

    assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join(" | ")}`);
    console.log("Xiaomi Focus Pen Pro simulation passed: low-latency sampling, pressure and tilt, palm rejection, pen-button switching, PDF and inline-board ink, two-finger zoom, hardware eraser and pen long-press lookup.");
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  if (server) {
    server.kill();
    await new Promise((resolvePromise) => server.once("exit", resolvePromise));
  }
}
