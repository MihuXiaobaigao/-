/* Runtime adaptation for Xiaomi Pad and iPad without changing the prototype data. */

(function installTabletRuntime() {
  "use strict";

  const STORAGE_KEY = "biandu.prototype.state.v1";
  const persistedFields = [
    "activeBookId",
    "readerBookmarked",
    "readerFont",
    "readerFontSize",
    "readerLineHeight",
    "readerParaSpacing",
    "readerMargin",
    "readerTextColor",
    "readerTheme",
    "readerBrightness",
    "readerBilingual",
    "readerPage",
    "userNoteText",
    "dictFilter",
    "selectedWordKey",
    "activeBoardId",
    "boardZoom",
    "boardPanX",
    "boardPanY",
    "boardColor",
    "boardStrokeWidth",
    "boardCustomStrokes",
    "boardStickyNotes",
    "boardInsertedImages",
    "boardLinkedNodes"
  ];

  function detectDevice() {
    const requested = new URLSearchParams(window.location.search).get("device");
    if (requested === "xiaomi" || requested === "ipad") {
      return requested;
    }

    const ua = navigator.userAgent || "";
    const isIPad =
      /iPad/i.test(ua) ||
      (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);

    return isIPad ? "ipad" : "xiaomi";
  }

  function readPersistedState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const key of persistedFields) {
        if (Object.prototype.hasOwnProperty.call(saved, key)) {
          STATE[key] = saved[key];
        }
      }
    } catch {
      // Reading from file:// or private browsing can reject storage access.
    }
  }

  let saveTimer = null;
  function persistState() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        const snapshot = {};
        for (const key of persistedFields) {
          snapshot[key] = STATE[key];
        }
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // The prototype remains usable when storage is unavailable.
      }
    }, 120);
  }

  function updateStatusClock() {
    const now = new Date();
    const date = document.getElementById("topBarDate");
    const clock = document.getElementById("topBarClock");
    if (date) {
      const monthDay = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
      const weekday = now.toLocaleDateString("zh-CN", { weekday: "long" });
      date.textContent = `${monthDay} ${weekday}`;
    }
    if (clock) {
      clock.textContent = now.toLocaleTimeString("zh-CN", {
        hour: "2-digit", minute: "2-digit", hour12: false
      });
      clock.dateTime = now.toISOString();
    }
  }

  function scheduleStatusClock() {
    updateStatusClock();
    const delay = 60_000 - (Date.now() % 60_000);
    window.setTimeout(scheduleStatusClock, delay + 50);
  }

  function syncViewport() {
    const viewport = window.visualViewport;
    const height = Math.round(viewport?.height || window.innerHeight);
    document.documentElement.style.setProperty("--app-height", `${height}px`);
    document.documentElement.dataset.orientation =
      height > window.innerWidth ? "portrait" : "landscape";
  }

  STATE.currentDevice = detectDevice();
  document.documentElement.dataset.device = STATE.currentDevice;
  readPersistedState();

  const previewView = new URLSearchParams(window.location.search).get("view");
  const previewViews = new Set([
    "library",
    "reader",
    "kb",
    "graph",
    "dict",
    "board",
    "settings"
  ]);
  if (previewView && previewViews.has(previewView)) {
    STATE.currentView = previewView;
    if (previewView === "kb") {
      const kbSubview = new URLSearchParams(window.location.search).get("kb");
      if (kbSubview === "ask" || kbSubview === "card") {
        STATE.kbSubView = kbSubview;
      }
    }
  }

  syncViewport();
  scheduleStatusClock();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateStatusClock();
  });

  window.addEventListener("resize", syncViewport, { passive: true });
  window.addEventListener("orientationchange", () => {
    window.setTimeout(syncViewport, 180);
  }, { passive: true });
  window.visualViewport?.addEventListener("resize", syncViewport, {
    passive: true
  });

  document.addEventListener("click", event => {
    if (event.target.closest("#boardContextToggleBtn")) {
      STATE.boardContextOpen = !STATE.boardContextOpen;
      renderApp();
      return;
    }

    if (event.target.closest("#boardContextCloseBtn")) {
      STATE.boardContextOpen = false;
      renderApp();
    }
  }, true);

  // Word lookup now follows the actual interaction promised by the prototype:
  // press and hold a token instead of relying on a normal click.
  let longPressTimer = null;
  let longPressStart = null;
  document.addEventListener("pointerdown", event => {
    const token = event.target.closest(".word-token");
    if (!token || event.pointerType === "mouse") return;

    longPressStart = { x: event.clientX, y: event.clientY };
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      if (STATE.currentView !== "reader") return;
      STATE.activePopupWord = token.getAttribute("data-word") || "attention";
      const pageNode = token.closest("[data-page]");
      STATE.__activeWordPage = pageNode ? Number(pageNode.getAttribute("data-page")) : STATE.readerPage;
      STATE.readerWordPopupOpen = true;
      STATE.__markWordFromLongPress = true;
      renderApp();
      showToast(`已标注 ${STATE.activePopupWord}，可查词并加入本地词典`);
    }, 460);
  }, true);

  document.addEventListener("pointermove", event => {
    if (!longPressStart) return;
    const distance = Math.hypot(
      event.clientX - longPressStart.x,
      event.clientY - longPressStart.y
    );
    if (distance > 12) {
      window.clearTimeout(longPressTimer);
      longPressStart = null;
    }
  }, true);

  const clearLongPress = () => {
    window.clearTimeout(longPressTimer);
    longPressStart = null;
  };
  document.addEventListener("pointerup", clearLongPress, true);
  document.addEventListener("pointercancel", clearLongPress, true);
  document.addEventListener("contextmenu", event => {
    if (event.target.closest(".word-token")) {
      event.preventDefault();
    }
  });

  // Pointer Events keep Apple Pencil, Xiaomi stylus and finger panning in the
  // same interaction model. Two touch points pinch-zoom the graph and canvas.
  const activeTouches = new Map();
  let pinch = null;

  function touchPoints(surface) {
    return Array.from(activeTouches.values()).filter(
      point => point.surface === surface
    );
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function applyZoom(surface, zoom) {
    if (surface === "graph") {
      STATE.graphZoom = Math.max(0.65, Math.min(1.6, zoom));
      const viewport = document.getElementById("graphViewport");
      if (viewport) {
        viewport.setAttribute(
          "transform",
          `translate(${STATE.graphPanX}, ${STATE.graphPanY}) scale(${STATE.graphZoom})`
        );
      }
      return;
    }

    STATE.boardZoom = Math.max(50, Math.min(140, zoom));
    const world = document.getElementById("boardWorld");
    const stage = document.getElementById("freeformStage");
    const label = document.getElementById("boardZoomLabel");
    const scale = STATE.boardZoom / 78;
    if (world) {
      world.style.transform =
        `translate(${STATE.boardPanX}px, ${STATE.boardPanY}px) scale(${scale.toFixed(3)})`;
    }
    if (stage) {
      const gridSize = Math.round(24 * scale);
      stage.style.backgroundSize =
        `${gridSize}px ${gridSize}px, ${gridSize * 5}px ${gridSize * 5}px, ${gridSize * 5}px ${gridSize * 5}px`;
    }
    if (label) label.textContent = `${Math.round(STATE.boardZoom)}%`;
  }

  document.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") return;

    // The runtime board and graph own their pointer gestures. The prototype
    // handlers must not consume the second finger before those controllers see it.
    if (event.target.closest("#bdStage")) return;
    if (event.target.closest("#graphCanvasWrap") && document.getElementById("realGraphSvg")) return;

    let surface = null;
    if (event.target.closest("#freeformStage")) surface = "board";
    if (event.target.closest("#graphCanvasWrap")) surface = "graph";
    if (!surface) return;

    activeTouches.set(event.pointerId, {
      surface,
      x: event.clientX,
      y: event.clientY
    });

    const points = touchPoints(surface);
    if (points.length === 2) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pinch = {
        surface,
        startDistance: distance(points[0], points[1]),
        startZoom: surface === "board" ? STATE.boardZoom : STATE.graphZoom
      };
    }
  }, true);

  document.addEventListener("pointermove", event => {
    const active = activeTouches.get(event.pointerId);
    if (!active) return;

    active.x = event.clientX;
    active.y = event.clientY;
    const points = touchPoints(active.surface);
    if (!pinch || pinch.surface !== active.surface || points.length < 2) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const ratio = distance(points[0], points[1]) / pinch.startDistance;
    applyZoom(active.surface, pinch.startZoom * ratio);
  }, true);

  function endTouch(event) {
    const active = activeTouches.get(event.pointerId);
    if (!active) return;
    activeTouches.delete(event.pointerId);
    if (pinch && touchPoints(pinch.surface).length < 2) {
      pinch = null;
      persistState();
    }
  }
  document.addEventListener("pointerup", endTouch, true);
  document.addEventListener("pointercancel", endTouch, true);

  document.addEventListener("click", persistState);
  document.addEventListener("change", persistState);
  document.addEventListener("pointerup", persistState, { passive: true });
  window.addEventListener("pagehide", persistState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistState();
  });

  navigator.storage?.persist?.().catch(() => {});

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();
