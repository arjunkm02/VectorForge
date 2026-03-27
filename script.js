"use strict";
// =============================================================================
// VectorForge — Browser Design Editor
// =============================================================================
// Architecture:
//   AppController
//     ├── StateManager    (elements, undo/redo, selection, clipboard)
//     ├── CanvasEngine    (render loop, scene graph, viewport transforms)
//     ├── ToolManager     (select, rect, circle, line, text, image tools)
//     ├── EventManager    (mouse, keyboard, resize observers)
//     └── UIManager       (layers panel, properties panel, toolbar)
// =============================================================================

// =============================================================================
// SECTION 1: EventEmitter — cross-class communication bus
// =============================================================================
class EventEmitter {
  constructor() {
    this._h = {};
  }
  on(ev, fn) {
    (this._h[ev] = this._h[ev] || []).push(fn);
    return this;
  }
  off(ev, fn) {
    if (this._h[ev]) this._h[ev] = this._h[ev].filter((f) => f !== fn);
  }
  emit(ev, ...a) {
    (this._h[ev] || []).slice().forEach((f) => f(...a));
  }
  once(ev, fn) {
    const wrap = (...a) => {
      fn(...a);
      this.off(ev, wrap);
    };
    return this.on(ev, wrap);
  }
}

// =============================================================================
// SECTION 2: Utils
// =============================================================================
const Utils = {
  uuid() {
    return (
      "el_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36)
    );
  },
  clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  },
  degToRad(d) {
    return (d * Math.PI) / 180;
  },
  radToDeg(r) {
    return (r * 180) / Math.PI;
  },

  // Rotate point (px,py) around (cx,cy) by angle radians
  rotatePoint(px, py, cx, cy, angle) {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const dx = px - cx,
      dy = py - cy;
    return { x: cx + c * dx - s * dy, y: cy + s * dx + c * dy };
  },

  // Point-in-rotated-rect hit test
  pointInElement(wx, wy, el) {
    if (el.type === "line") return Utils.pointNearLine(wx, wy, el, 6);
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const cos = Math.cos(-el.rotation),
      sin = Math.sin(-el.rotation);
    const dx = wx - cx,
      dy = wy - cy;
    const lx = cos * dx - sin * dy;
    const ly = sin * dx + cos * dy;
    if (el.type === "circle") {
      const rx = el.width / 2,
        ry = el.height / 2;
      return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
    }
    return (
      lx >= -el.width / 2 &&
      lx <= el.width / 2 &&
      ly >= -el.height / 2 &&
      ly <= el.height / 2
    );
  },

  pointNearLine(wx, wy, el, thresh) {
    const dx = el.x2 - el.x,
      dy = el.y2 - el.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Utils.dist(wx, wy, el.x, el.y) <= thresh;
    const t = Utils.clamp(((wx - el.x) * dx + (wy - el.y) * dy) / lenSq, 0, 1);
    return Utils.dist(wx, wy, el.x + t * dx, el.y + t * dy) <= thresh;
  },

  dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  },

  // AABB of all elements (for fit-to-page)
  boundingBox(elements) {
    if (!elements.length) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    elements.forEach((el) => {
      const corners = Utils.elementCorners(el);
      corners.forEach(({ x, y }) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      });
    });
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  },

  elementCorners(el) {
    if (el.type === "line")
      return [
        { x: el.x, y: el.y },
        { x: el.x2, y: el.y2 },
      ];
    const cx = el.x + el.width / 2,
      cy = el.y + el.height / 2;
    return [
      [el.x, el.y],
      [el.x + el.width, el.y],
      [el.x + el.width, el.y + el.height],
      [el.x, el.y + el.height],
    ].map(([px, py]) => Utils.rotatePoint(px, py, cx, cy, el.rotation));
  },

  // Shallow clone preserving all props
  clone(el) {
    return Object.assign({}, el);
  },

  // Generate element display name
  typeName(type) {
    return (
      {
        rect: "Rectangle",
        circle: "Ellipse",
        line: "Line",
        text: "Text",
        image: "Image",
      }[type] || type
    );
  },

  // Round to n decimal places
  round(v, n = 1) {
    return Math.round(v * 10 ** n) / 10 ** n;
  },

  // Snap value to grid
  snapToGrid(v, size) {
    return Math.round(v / size) * size;
  },

  // Debounce
  debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  },
};

// =============================================================================
// SECTION 3: Element Factory — canonical element shapes
// =============================================================================
const ElementFactory = {
  defaults: {
    fill: "#7c6ffa",
    stroke: "transparent",
    strokeWidth: 0,
    opacity: 1,
    rotation: 0,
    visible: true,
    locked: false,
    shadow: false,
    shadowColor: "rgba(0,0,0,0.4)",
    shadowBlur: 12,
    shadowOffsetX: 4,
    shadowOffsetY: 4,
  },

  create(type, props = {}) {
    const base = {
      id: Utils.uuid(),
      type,
      name: Utils.typeName(type),
      x: 100,
      y: 100,
      width: 120,
      height: 80,
      ...ElementFactory.defaults,
    };

    const overrides = {
      rect: { fill: "#7c6ffa", strokeWidth: 0, cornerRadius: 0 },
      circle: { fill: "#fa6f8f", strokeWidth: 0 },
      line: {
        x: 100,
        y: 200,
        x2: 300,
        y2: 200,
        width: 200,
        height: 0,
        stroke: "#7c6ffa",
        strokeWidth: 2,
        fill: "transparent",
      },
      text: {
        text: "Double-click to edit",
        fontSize: 18,
        fontFamily: "Syne",
        fontWeight: "400",
        textAlign: "left",
        fill: "#e6e6f0",
        stroke: "transparent",
        strokeWidth: 0,
        width: 220,
        height: 30,
        lineHeight: 1.4,
      },
      image: { src: null, objectFit: "cover", fill: "#222235", strokeWidth: 0 },
    };

    return { ...base, ...(overrides[type] || {}), ...props };
  },
};

// =============================================================================
// SECTION 4: StateManager — single source of truth
// =============================================================================
class StateManager extends EventEmitter {
  constructor() {
    super();
    this.elements = []; // ordered bottom→top
    this.selectedIds = new Set();
    this.clipboard = [];
    this._undoStack = [];
    this._redoStack = [];
    this._maxHistory = 60;
    this._snapshots = 0;
  }

  // ── snapshot / history ─────────────────────────────────────────────────────
  _snapshot() {
    return JSON.stringify(this.elements);
  }

  commit() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > this._maxHistory) this._undoStack.shift();
    this._redoStack = [];
    this.emit("history");
  }

  undo() {
    if (!this._undoStack.length) return;
    this._redoStack.push(this._snapshot());
    this.elements = JSON.parse(this._undoStack.pop());
    this.selectedIds.clear();
    this.emit("change");
    this.emit("selection");
    this.emit("history");
  }

  redo() {
    if (!this._redoStack.length) return;
    this._undoStack.push(this._snapshot());
    this.elements = JSON.parse(this._redoStack.pop());
    this.selectedIds.clear();
    this.emit("change");
    this.emit("selection");
    this.emit("history");
  }

  canUndo() {
    return this._undoStack.length > 0;
  }
  canRedo() {
    return this._redoStack.length > 0;
  }

  // ── element CRUD ───────────────────────────────────────────────────────────
  add(el) {
    this.commit();
    this.elements.push(el);
    this.emit("change", el);
    return el;
  }

  remove(ids) {
    this.commit();
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    this.elements = this.elements.filter((e) => !set.has(e.id));
    set.forEach((id) => this.selectedIds.delete(id));
    this.emit("change");
    this.emit("selection");
  }

  update(id, props, noCommit = false) {
    const el = this.byId(id);
    if (!el) return;
    if (!noCommit) this.commit();
    Object.assign(el, props);
    this.emit("change", el);
  }

  updateSilent(id, props) {
    const el = this.byId(id);
    if (el) {
      Object.assign(el, props);
      this.emit("change", el);
    }
  }

  byId(id) {
    return this.elements.find((e) => e.id === id);
  }
  getAll() {
    return this.elements;
  }

  // ── z-order ────────────────────────────────────────────────────────────────
  bringForward(id) {
    const i = this.elements.findIndex((e) => e.id === id);
    if (i < this.elements.length - 1) {
      this.commit();
      [this.elements[i], this.elements[i + 1]] = [
        this.elements[i + 1],
        this.elements[i],
      ];
      this.emit("change");
    }
  }
  sendBackward(id) {
    const i = this.elements.findIndex((e) => e.id === id);
    if (i > 0) {
      this.commit();
      [this.elements[i - 1], this.elements[i]] = [
        this.elements[i],
        this.elements[i - 1],
      ];
      this.emit("change");
    }
  }
  bringToFront(id) {
    const i = this.elements.findIndex((e) => e.id === id);
    if (i !== -1 && i !== this.elements.length - 1) {
      this.commit();
      this.elements.push(this.elements.splice(i, 1)[0]);
      this.emit("change");
    }
  }
  sendToBack(id) {
    const i = this.elements.findIndex((e) => e.id === id);
    if (i > 0) {
      this.commit();
      this.elements.unshift(this.elements.splice(i, 1)[0]);
      this.emit("change");
    }
  }

  // ── selection ──────────────────────────────────────────────────────────────
  select(ids, additive = false) {
    if (!additive) this.selectedIds.clear();
    (Array.isArray(ids) ? ids : [ids]).forEach((id) =>
      this.selectedIds.add(id),
    );
    this.emit("selection");
  }

  deselect(id) {
    if (id) this.selectedIds.delete(id);
    else this.selectedIds.clear();
    this.emit("selection");
  }

  selectAll() {
    this.elements.forEach((e) => this.selectedIds.add(e.id));
    this.emit("selection");
  }

  getSelected() {
    return this.elements.filter((e) => this.selectedIds.has(e.id));
  }

  isSelected(id) {
    return this.selectedIds.has(id);
  }

  // ── clipboard ──────────────────────────────────────────────────────────────
  copy() {
    this.clipboard = this.getSelected().map((e) =>
      JSON.parse(JSON.stringify(e)),
    );
  }

  paste() {
    if (!this.clipboard.length) return;
    this.commit();
    this.selectedIds.clear();
    this.clipboard = this.clipboard.map((e) => {
      const fresh = { ...e, id: Utils.uuid(), x: e.x + 20, y: e.y + 20 };
      if (e.type === "line") {
        fresh.x2 = e.x2 + 20;
        fresh.y2 = e.y2 + 20;
      }
      this.elements.push(fresh);
      this.selectedIds.add(fresh.id);
      return fresh; // shift next paste
    });
    this.emit("change");
    this.emit("selection");
  }

  // ── persistence ────────────────────────────────────────────────────────────
  serialize() {
    return JSON.stringify({ version: 1, elements: this.elements }, null, 2);
  }

  deserialize(json) {
    try {
      const data = JSON.parse(json);
      this.commit();
      this.elements = data.elements || [];
      this.selectedIds.clear();
      this.emit("change");
      this.emit("selection");
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// SECTION 5: CanvasEngine — rendering, viewport, scene graph
// =============================================================================
const HANDLE_SIZE = 7;
const ROTATE_OFFSET = 28;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 40;
const GRID_SIZE = 20;

class CanvasEngine extends EventEmitter {
  constructor(canvas, state) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = state;
    this.viewport = { panX: 0, panY: 0, zoom: 1 };
    this.dirty = true;
    this._raf = null;
    this._imgCache = new Map(); // id → HTMLImageElement
    this.showGrid = true;
    this.snapLines = { x: null, y: null }; // snap guide lines in world coords
  }

  // ── viewport ───────────────────────────────────────────────────────────────
  screenToWorld(sx, sy) {
    const { panX, panY, zoom } = this.viewport;
    return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
  }

  worldToScreen(wx, wy) {
    const { panX, panY, zoom } = this.viewport;
    return { x: wx * zoom + panX, y: wy * zoom + panY };
  }

  setZoom(zoom, pivot = null) {
    const { panX, panY } = this.viewport;
    const prev = this.viewport.zoom;
    this.viewport.zoom = Utils.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (pivot) {
      // Zoom toward pivot (screen coords)
      this.viewport.panX =
        pivot.x - (pivot.x - panX) * (this.viewport.zoom / prev);
      this.viewport.panY =
        pivot.y - (pivot.y - panY) * (this.viewport.zoom / prev);
    }
    this.markDirty();
    this.emit("viewport");
  }

  pan(dx, dy) {
    this.viewport.panX += dx;
    this.viewport.panY += dy;
    this.markDirty();
    this.emit("viewport");
  }

  fitToContent() {
    const els = this.state.getAll();
    if (!els.length) return;
    const bb = Utils.boundingBox(els);
    if (!bb) return;
    const pad = 80;
    const scaleX = (this.canvas.width - pad * 2) / bb.width;
    const scaleY = (this.canvas.height - pad * 2) / bb.height;
    const zoom = Utils.clamp(Math.min(scaleX, scaleY), MIN_ZOOM, MAX_ZOOM);
    this.viewport.zoom = zoom;
    this.viewport.panX =
      (this.canvas.width - bb.width * zoom) / 2 - bb.x * zoom;
    this.viewport.panY =
      (this.canvas.height - bb.height * zoom) / 2 - bb.y * zoom;
    this.markDirty();
    this.emit("viewport");
  }

  // ── rendering loop ─────────────────────────────────────────────────────────
  markDirty() {
    this.dirty = true;
  }

  startLoop() {
    const tick = () => {
      if (this.dirty) {
        this.dirty = false;
        this._render();
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stopLoop() {
    cancelAnimationFrame(this._raf);
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.markDirty();
  }

  // ── main render ────────────────────────────────────────────────────────────
  _render() {
    const { ctx, canvas } = this;
    const { panX, panY, zoom } = this.viewport;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // ── Phase 1: world-space drawing ──────────────────────────────────────
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    if (this.showGrid) this._drawGrid();

    const elements = this.state.getAll();
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!el.visible) continue;
      ctx.save();
      ctx.globalAlpha = el.opacity ?? 1;
      this._applyElementTransform(el);
      this._drawElement(el);
      ctx.restore();
    }

    ctx.restore();

    // ── Phase 2: screen-space overlay ────────────────────────────────────
    this._drawSelectionOverlay();
    this._drawSnapGuides();
  }

  _applyElementTransform(el) {
    if (el.type === "line") return; // lines drawn in world space directly
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    this.ctx.translate(cx, cy);
    this.ctx.rotate(el.rotation);
    this.ctx.translate(-el.width / 2, -el.height / 2);
  }

  // ── element drawing ────────────────────────────────────────────────────────
  _drawElement(el) {
    const { ctx } = this;

    if (el.shadow) {
      ctx.shadowColor = el.shadowColor;
      ctx.shadowBlur = el.shadowBlur / this.viewport.zoom;
      ctx.shadowOffsetX = el.shadowOffsetX / this.viewport.zoom;
      ctx.shadowOffsetY = el.shadowOffsetY / this.viewport.zoom;
    }

    switch (el.type) {
      case "rect":
        this._drawRect(el);
        break;
      case "circle":
        this._drawCircle(el);
        break;
      case "line":
        this._drawLine(el);
        break;
      case "text":
        this._drawText(el);
        break;
      case "image":
        this._drawImage(el);
        break;
    }

    // reset shadow
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  _drawRect(el) {
    const { ctx } = this;
    const {
      width: w,
      height: h,
      fill,
      stroke,
      strokeWidth,
      cornerRadius = 0,
    } = el;

    ctx.beginPath();
    if (cornerRadius > 0) {
      const r = Math.min(cornerRadius, w / 2, h / 2);
      ctx.moveTo(r, 0);
      ctx.lineTo(w - r, 0);
      ctx.quadraticCurveTo(w, 0, w, r);
      ctx.lineTo(w, h - r);
      ctx.quadraticCurveTo(w, h, w - r, h);
      ctx.lineTo(r, h);
      ctx.quadraticCurveTo(0, h, 0, h - r);
      ctx.lineTo(0, r);
      ctx.quadraticCurveTo(0, 0, r, 0);
      ctx.closePath();
    } else {
      ctx.rect(0, 0, w, h);
    }

    if (fill && fill !== "transparent") {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke && stroke !== "transparent" && strokeWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  _drawCircle(el) {
    const { ctx } = this;
    const { width: w, height: h, fill, stroke, strokeWidth } = el;
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (fill && fill !== "transparent") {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke && stroke !== "transparent" && strokeWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  _drawLine(el) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x2, el.y2);
    ctx.strokeStyle = el.stroke || "#7c6ffa";
    ctx.lineWidth = el.strokeWidth || 2;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  _drawText(el) {
    const { ctx } = this;
    const {
      text,
      fontSize,
      fontFamily,
      fontWeight,
      textAlign,
      fill,
      width,
      height,
      lineHeight = 1.4,
    } = el;
    if (!text) return;

    ctx.font = `${fontWeight || 400} ${fontSize || 16}px ${fontFamily || "sans-serif"}`;
    ctx.fillStyle = fill || "#e6e6f0";
    ctx.textAlign = textAlign || "left";
    ctx.textBaseline = "top";

    // Word-wrap
    const lines = this._wrapText(ctx, text, width);
    const lh = (fontSize || 16) * lineHeight;
    lines.forEach((line, i) => {
      const tx =
        textAlign === "center" ? width / 2 : textAlign === "right" ? width : 0;
      ctx.fillText(line, tx, i * lh);
    });
  }

  _wrapText(ctx, text, maxWidth) {
    if (!maxWidth) return [text];
    const words = text.split(" ");
    const lines = [];
    let cur = "";
    for (const word of words) {
      const test = cur ? cur + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [text];
  }

  _drawImage(el) {
    const { ctx } = this;
    if (!el.src) {
      // Placeholder
      ctx.fillStyle = "#222235";
      ctx.fillRect(0, 0, el.width, el.height);
      ctx.fillStyle = "#5e5e7a";
      ctx.font = "12px Syne, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No image", el.width / 2, el.height / 2);
      return;
    }

    let img = this._imgCache.get(el.id);
    if (!img) {
      img = new Image();
      img.onload = () => {
        this._imgCache.set(el.id, img);
        this.markDirty();
      };
      img.src = el.src;
      this._imgCache.set(el.id, img);
    }

    if (img.complete && img.naturalWidth > 0) {
      ctx.save();
      ctx.rect(0, 0, el.width, el.height);
      ctx.clip();
      const { sx, sy, sw, sh } = this._computeImageFit(el, img);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, el.width, el.height);
      ctx.restore();
    }
  }

  _computeImageFit(el, img) {
    const iw = img.naturalWidth,
      ih = img.naturalHeight;
    const ew = el.width,
      eh = el.height;
    let sx = 0,
      sy = 0,
      sw = iw,
      sh = ih;
    if (el.objectFit === "cover") {
      const scale = Math.max(ew / iw, eh / ih);
      const dw = ew / scale,
        dh = eh / scale;
      sx = (iw - dw) / 2;
      sy = (ih - dh) / 2;
      sw = dw;
      sh = dh;
    }
    return { sx, sy, sw, sh };
  }

  // ── grid ───────────────────────────────────────────────────────────────────
  _drawGrid() {
    const {
      ctx,
      canvas,
      viewport: { panX, panY, zoom },
    } = this;
    if (zoom < 0.2) return;

    // Convert screen bounds to world bounds for culling
    const wLeft = -panX / zoom;
    const wTop = -panY / zoom;
    const wRight = (canvas.width - panX) / zoom;
    const wBottom = (canvas.height - panY) / zoom;

    const step = GRID_SIZE;
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();

    const startX = Math.floor(wLeft / step) * step;
    const startY = Math.floor(wTop / step) * step;

    for (let x = startX; x <= wRight; x += step) {
      ctx.moveTo(x, wTop);
      ctx.lineTo(x, wBottom);
    }
    for (let y = startY; y <= wBottom; y += step) {
      ctx.moveTo(wLeft, y);
      ctx.lineTo(wRight, y);
    }
    ctx.stroke();

    // Major grid (every 100px)
    if (zoom >= 0.3) {
      const major = GRID_SIZE * 5;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      for (let x = Math.floor(wLeft / major) * major; x <= wRight; x += major) {
        ctx.moveTo(x, wTop);
        ctx.lineTo(x, wBottom);
      }
      for (let y = Math.floor(wTop / major) * major; y <= wBottom; y += major) {
        ctx.moveTo(wLeft, y);
        ctx.lineTo(wRight, y);
      }
      ctx.stroke();
    }
  }

  // ── selection overlay ──────────────────────────────────────────────────────
  _drawSelectionOverlay() {
    const selected = this.state.getSelected();
    if (!selected.length) return;

    if (selected.length === 1) {
      this._drawSingleSelectionBox(selected[0]);
    } else {
      this._drawMultiSelectionBox(selected);
    }
  }

  _drawSingleSelectionBox(el) {
    const { ctx } = this;
    if (el.type === "line") {
      this._drawLineSelection(el);
      return;
    }

    const { panX, panY, zoom } = this.viewport;
    const cx = (el.x + el.width / 2) * zoom + panX;
    const cy = (el.y + el.height / 2) * zoom + panY;
    const hw = (el.width / 2) * zoom;
    const hh = (el.height / 2) * zoom;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(el.rotation);

    // Dashed bounding box
    ctx.beginPath();
    ctx.rect(-hw, -hh, el.width * zoom, el.height * zoom);
    ctx.strokeStyle = "#7c6ffa";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw 8 resize handles
    const handles = [
      [-hw, -hh],
      [0, -hh],
      [hw, -hh],
      [hw, 0],
      [hw, hh],
      [0, hh],
      [-hw, hh],
      [-hw, 0],
    ];
    handles.forEach(([hx, hy]) => this._drawHandle(ctx, hx, hy));

    // Rotation handle (above top-center)
    const rhy = -hh - ROTATE_OFFSET;
    ctx.beginPath();
    ctx.moveTo(0, -hh);
    ctx.lineTo(0, rhy);
    ctx.strokeStyle = "#7c6ffa";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    this._drawRotateHandle(ctx, 0, rhy);

    ctx.restore();

    // Dimension label
    this._drawDimensionLabel(el, cx, cy, hh);
  }

  _drawLineSelection(el) {
    const { ctx } = this;
    const { panX, panY, zoom } = this.viewport;
    const s1 = this.worldToScreen(el.x, el.y);
    const s2 = this.worldToScreen(el.x2, el.y2);

    ctx.save();
    this._drawHandle(ctx, s1.x, s1.y);
    this._drawHandle(ctx, s2.x, s2.y);
    // Midpoint
    this._drawHandle(ctx, (s1.x + s2.x) / 2, (s1.y + s2.y) / 2);
    ctx.restore();
  }

  _drawHandle(ctx, hx, hy) {
    ctx.beginPath();
    ctx.rect(
      hx - HANDLE_SIZE / 2,
      hy - HANDLE_SIZE / 2,
      HANDLE_SIZE,
      HANDLE_SIZE,
    );
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#7c6ffa";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  }

  _drawRotateHandle(ctx, hx, hy) {
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_SIZE / 2 + 1, 0, Math.PI * 2);
    ctx.fillStyle = "#7c6ffa";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  }

  _drawMultiSelectionBox(elements) {
    const { ctx } = this;
    const bb = Utils.boundingBox(elements);
    if (!bb) return;

    const { panX, panY, zoom } = this.viewport;
    const sx = bb.x * zoom + panX;
    const sy = bb.y * zoom + panY;
    const sw = bb.width * zoom;
    const sh = bb.height * zoom;

    ctx.save();
    ctx.strokeStyle = "#7c6ffa";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawDimensionLabel(el, cx, cy, hh) {
    const { ctx } = this;
    const label = `${Math.round(el.width)} × ${Math.round(el.height)}`;
    const lx = cx,
      ly = cy + hh + 18;
    ctx.font = '10px "Space Mono", monospace';
    ctx.fillStyle = "#7c6ffa";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx, ly);
  }

  // ── rubber-band selection rect ─────────────────────────────────────────────
  drawMarquee(x, y, w, h) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = "rgba(124,111,250,0.08)";
    ctx.strokeStyle = "#7c6ffa";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 2]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── snap guides ────────────────────────────────────────────────────────────
  _drawSnapGuides() {
    const {
      ctx,
      snapLines,
      viewport: { panX, panY, zoom },
    } = this;
    if (!snapLines.x && !snapLines.y) return;

    ctx.save();
    ctx.strokeStyle = "#fa6f8f";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    if (snapLines.x !== null) {
      const sx = snapLines.x * zoom + panX;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.canvas.height);
      ctx.stroke();
    }
    if (snapLines.y !== null) {
      const sy = snapLines.y * zoom + panY;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(this.canvas.width, sy);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── hit testing ────────────────────────────────────────────────────────────
  // Returns { type: 'handle'|'rotate'|'element'|'none', id?, handle? }
  hitTest(sx, sy) {
    const wp = this.screenToWorld(sx, sy);

    // 1. Check selection handles first (screen space)
    const selected = this.state.getSelected();
    if (selected.length === 1) {
      const el = selected[0];
      if (el.type !== "line") {
        const hit = this._hitTestHandles(el, sx, sy);
        if (hit) return hit;
      } else {
        const hit = this._hitTestLineHandles(el, sx, sy);
        if (hit) return hit;
      }
    }

    // 2. Hit test elements (reverse z-order = top first)
    const elements = this.state.getAll();
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (!el.visible || el.locked) continue;
      if (Utils.pointInElement(wp.x, wp.y, el)) {
        return { type: "element", id: el.id };
      }
    }

    return { type: "none" };
  }

  _hitTestHandles(el, sx, sy) {
    const { panX, panY, zoom } = this.viewport;
    const cx = (el.x + el.width / 2) * zoom + panX;
    const cy = (el.y + el.height / 2) * zoom + panY;
    const hw = (el.width / 2) * zoom;
    const hh = (el.height / 2) * zoom;

    // Transform screen point to element-rotated space
    const tp = Utils.rotatePoint(sx, sy, cx, cy, -el.rotation);
    const lx = tp.x - cx;
    const ly = tp.y - cy;

    const near = (hx, hy) => Math.hypot(lx - hx, ly - hy) <= HANDLE_SIZE + 2;

    const handles = [
      { id: "nw", x: -hw, y: -hh },
      { id: "n", x: 0, y: -hh },
      { id: "ne", x: hw, y: -hh },
      { id: "e", x: hw, y: 0 },
      { id: "se", x: hw, y: hh },
      { id: "s", x: 0, y: hh },
      { id: "sw", x: -hw, y: hh },
      { id: "w", x: -hw, y: 0 },
    ];
    for (const h of handles) {
      if (near(h.x, h.y)) return { type: "handle", id: el.id, handle: h.id };
    }

    // Rotation handle
    const rhy = -hh - ROTATE_OFFSET;
    if (near(0, rhy)) return { type: "rotate", id: el.id };

    return null;
  }

  _hitTestLineHandles(el, sx, sy) {
    const s1 = this.worldToScreen(el.x, el.y);
    const s2 = this.worldToScreen(el.x2, el.y2);
    const near = (p) => Math.hypot(sx - p.x, sy - p.y) <= HANDLE_SIZE + 2;
    if (near(s1)) return { type: "handle", id: el.id, handle: "p1" };
    if (near(s2)) return { type: "handle", id: el.id, handle: "p2" };
    return null;
  }

  // ── handle geometry (world coords) ────────────────────────────────────────
  getHandlePositions(el) {
    const { x, y, width: w, height: h, rotation } = el;
    const cx = x + w / 2,
      cy = y + h / 2;
    const r = (px, py) => Utils.rotatePoint(px, py, cx, cy, rotation);
    return {
      nw: r(x, y),
      n: r(x + w / 2, y),
      ne: r(x + w, y),
      e: r(x + w, y + h / 2),
      se: r(x + w, y + h),
      s: r(x + w / 2, y + h),
      sw: r(x, y + h),
      w: r(x, y + h / 2),
      rot: r(x + w / 2, y - ROTATE_OFFSET / this.viewport.zoom),
      center: { x: cx, y: cy },
    };
  }

  // ── export ─────────────────────────────────────────────────────────────────
  exportPNG() {
    // Render to an offscreen canvas with transparent bg
    const els = this.state.getAll();
    if (!els.length) return;
    const bb = Utils.boundingBox(els);
    if (!bb) return;

    const pad = 40;
    const off = document.createElement("canvas");
    off.width = bb.width + pad * 2;
    off.height = bb.height + pad * 2;
    const ctx = off.getContext("2d");

    // Temporarily shift viewport
    const savedVP = { ...this.viewport };
    this.canvas = off;
    this.ctx = ctx;
    this.viewport = { panX: -bb.x + pad, panY: -bb.y + pad, zoom: 1 };
    this.dirty = true;
    this._render();

    // Restore
    this.canvas = document.getElementById("main-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.viewport = savedVP;
    this.markDirty();

    return off.toDataURL("image/png");
  }
}

// =============================================================================
// SECTION 6: Tools
// =============================================================================

// ── SelectTool ─────────────────────────────────────────────────────────────
class SelectTool {
  constructor(app) {
    this.app = app;
    this.name = "select";
    this._mode = null; // 'move'|'resize'|'rotate'|'marquee'
    this._startWorld = null;
    this._startProps = null; // snapshot of element(s) at drag start
    this._handle = null;
    this._rotCenter = null;
    this._rotInitAngle = 0;
    this._rotInitRot = 0;
    this._marquee = null;
    this._moved = false;
  }

  get cursor() {
    return this._mode === "rotate" ? "crosshair" : "default";
  }

  onMouseDown(wp, sp, e) {
    const { engine, state } = this.app;
    const hit = engine.hitTest(sp.x, sp.y);
    this._moved = false;
    this._startWorld = { ...wp };

    if (hit.type === "rotate") {
      const el = state.byId(hit.id);
      const cx = el.x + el.width / 2;
      const cy = el.y + el.height / 2;
      this._mode = "rotate";
      this._rotCenter = { x: cx, y: cy };
      this._rotInitAngle = Math.atan2(wp.y - cy, wp.x - cx);
      this._rotInitRot = el.rotation;
      this._startProps = { id: hit.id };
    } else if (hit.type === "handle") {
      const el = state.byId(hit.id);
      this._mode = "resize";
      this._handle = hit.handle;
      this._startProps = JSON.parse(JSON.stringify(el));
    } else if (hit.type === "element") {
      if (!state.isSelected(hit.id)) {
        state.select(hit.id, e.shiftKey || e.metaKey || e.ctrlKey);
      } else if (e.shiftKey || e.metaKey || e.ctrlKey) {
        state.deselect(hit.id);
        return;
      }
      this._mode = "move";
      this._startProps = state.getSelected().map((el) => Utils.clone(el));
    } else {
      if (!e.shiftKey) state.deselect();
      this._mode = "marquee";
      this._marquee = { x: sp.x, y: sp.y, w: 0, h: 0 };
    }
    engine.markDirty();
  }

  onMouseMove(wp, sp, e) {
    const { engine, state } = this.app;
    if (!this._mode) return;
    this._moved = true;

    const dx = wp.x - this._startWorld.x;
    const dy = wp.y - this._startWorld.y;

    if (this._mode === "move") {
      this._startProps.forEach((snap) => {
        const el = state.byId(snap.id);
        if (!el || el.locked) return;
        const nx = snap.x + dx;
        const ny = snap.y + dy;
        // Snap
        const { sx, sy, snapX, snapY } = this._snapPos(
          nx,
          ny,
          el,
          state.getSelected(),
        );
        state.updateSilent(snap.id, {
          x: sx,
          y: sy,
          ...(el.type === "line" ? { x2: snap.x2 + dx, y2: snap.y2 + dy } : {}),
        });
        engine.snapLines = { x: snapX, y: snapY };
      });
    } else if (this._mode === "resize") {
      const snap = this._startProps;
      const el = state.byId(snap.id);
      if (!el) return;
      this._applyResize(el, snap, this._handle, wp);
    } else if (this._mode === "rotate") {
      const el = state.byId(this._startProps.id);
      if (!el) return;
      const { x: cx, y: cy } = this._rotCenter;
      const angle = Math.atan2(wp.y - cy, wp.x - cx);
      let newRot = this._rotInitRot + (angle - this._rotInitAngle);
      if (e.shiftKey)
        newRot = Math.round(newRot / (Math.PI / 12)) * (Math.PI / 12); // 15° steps
      state.updateSilent(el.id, { rotation: newRot });
    } else if (this._mode === "marquee") {
      this._marquee.w = sp.x - this._marquee.x;
      this._marquee.h = sp.y - this._marquee.y;
      this._updateMarqueeSelection();
    }

    engine.markDirty();
  }

  onMouseUp(wp, sp, e) {
    const { engine, state } = this.app;

    if (this._mode === "move" && this._moved) state.commit();
    if (this._mode === "resize") state.commit();
    if (this._mode === "rotate") state.commit();

    if (this._mode === "marquee") {
      engine.markDirty();
    }

    engine.snapLines = { x: null, y: null };
    this._mode = null;
    this._marquee = null;
    this._startProps = null;
    engine.markDirty();
  }

  // Draw marquee rect if active
  drawOverlay() {
    if (this._mode !== "marquee" || !this._marquee) return;
    this.app.engine.drawMarquee(
      this._marquee.x,
      this._marquee.y,
      this._marquee.w,
      this._marquee.h,
    );
  }

  // ── snap logic ─────────────────────────────────────────────────────────────
  _snapPos(nx, ny, movingEl, selected) {
    const SNAP = 8;
    const { state, engine } = this.app;
    const others = state
      .getAll()
      .filter((e) => !selected.find((s) => s.id === e.id));
    let snapX = null,
      snapY = null;
    let sx = nx,
      sy = ny;

    // Snap edges and center of movingEl to others
    const candidates = [
      { val: nx, key: "x" },
      { val: nx + movingEl.width, key: "x" },
      { val: nx + movingEl.width / 2, key: "x" },
    ];

    others.forEach((o) => {
      const pts = [o.x, o.x + o.width / 2, o.x + o.width];
      candidates.forEach((c) => {
        pts.forEach((p) => {
          if (Math.abs(c.val - p) < SNAP / engine.viewport.zoom) {
            sx = nx + (p - c.val);
            snapX = p;
          }
        });
      });

      const yPts = [o.y, o.y + o.height / 2, o.y + o.height];
      [ny, ny + movingEl.height / 2, ny + movingEl.height].forEach((yv, yi) => {
        yPts.forEach((p) => {
          if (Math.abs(yv - p) < SNAP / engine.viewport.zoom) {
            sy = ny + (p - yv);
            snapY = p;
          }
        });
      });
    });

    return { sx, sy, snapX, snapY };
  }

  // ── resize logic (handles rotation-aware resizing) ─────────────────────────
  _applyResize(el, snap, handle, wp) {
    const { state } = this.app;
    const rot = snap.rotation;
    const cos = Math.cos(rot),
      sin = Math.sin(rot);
    const cx0 = snap.x + snap.width / 2;
    const cy0 = snap.y + snap.height / 2;

    // Anchor = opposite handle world position (from original element)
    const anchors = {
      se: [snap.x, snap.y],
      sw: [snap.x + snap.width, snap.y],
      ne: [snap.x, snap.y + snap.height],
      nw: [snap.x + snap.width, snap.y + snap.height],
      n: [snap.x + snap.width / 2, snap.y + snap.height],
      s: [snap.x + snap.width / 2, snap.y],
      e: [snap.x, snap.y + snap.height / 2],
      w: [snap.x + snap.width, snap.y + snap.height / 2],
    };

    const [alx, aly] = anchors[handle] || [snap.x, snap.y];
    const anchor = Utils.rotatePoint(alx, aly, cx0, cy0, rot);

    // Vector from anchor to mouse, projected on element axes
    const vx = wp.x - anchor.x,
      vy = wp.y - anchor.y;
    let newW = vx * cos + vy * sin;
    let newH = -vx * sin + vy * cos;

    // Edge handles only change one dimension
    if (handle === "n" || handle === "s") newW = snap.width;
    if (handle === "e" || handle === "w") newH = snap.height;

    // Flip: ensure positive dimensions
    const flipX = newW < 0;
    const flipY = newH < 0;
    newW = Math.abs(newW);
    newH = Math.abs(newH);
    newW = Math.max(newW, 4);
    newH = Math.max(newH, 4);

    // New center = anchor + (newW/2)*axisX + (newH/2)*axisY
    // (possibly inverted for flipped sides)
    const signX = flipX ? -1 : 1,
      signY = flipY ? -1 : 1;
    const newCx =
      anchor.x + signX * (newW / 2) * cos - signY * (newH / 2) * sin;
    const newCy =
      anchor.y + signX * (newW / 2) * sin + signY * (newH / 2) * cos;

    state.updateSilent(el.id, {
      x: newCx - newW / 2,
      y: newCy - newH / 2,
      width: newW,
      height: newH,
    });
  }

  _updateMarqueeSelection() {
    const { engine, state } = this.app;
    if (!this._marquee) return;
    const { x, y, w, h } = this._marquee;
    const x1 = Math.min(x, x + w),
      y1 = Math.min(y, y + h);
    const x2 = Math.max(x, x + w),
      y2 = Math.max(y, y + h);

    const ids = state
      .getAll()
      .filter((el) => {
        if (!el.visible || el.locked) return false;
        // Check if any corner of element is inside marquee
        const corners = Utils.elementCorners(el);
        return corners.some((c) => {
          const sc = engine.worldToScreen(c.x, c.y);
          return sc.x >= x1 && sc.x <= x2 && sc.y >= y1 && sc.y <= y2;
        });
      })
      .map((el) => el.id);

    state.select(ids);
  }
}

// ── DrawTool base class ─────────────────────────────────────────────────────
class DrawTool {
  constructor(app, type) {
    this.app = app;
    this.type = type;
    this.name = type;
    this._preview = null;
    this._start = null;
  }
  get cursor() {
    return "crosshair";
  }

  onMouseDown(wp) {
    this._start = { ...wp };
    this._preview = ElementFactory.create(this.type, {
      x: wp.x,
      y: wp.y,
      width: 1,
      height: 1,
    });
    // Temporarily add to state for preview
    this.app.state.elements.push(this._preview);
    this.app.engine.markDirty();
  }

  onMouseMove(wp) {
    if (!this._preview) return;
    const { x, y } = this._start;
    let nx = Math.min(x, wp.x),
      ny = Math.min(y, wp.y);
    let nw = Math.abs(wp.x - x),
      nh = Math.abs(wp.y - y);
    if (nw < 1) nw = 1;
    if (nh < 1) nh = 1;
    Object.assign(this._preview, { x: nx, y: ny, width: nw, height: nh });
    this.app.engine.markDirty();
  }

  onMouseUp(wp) {
    if (!this._preview) return;
    const el = this._preview;
    // Remove temp element and re-add via state (triggers commit)
    this.app.state.elements = this.app.state.elements.filter(
      (e) => e.id !== el.id,
    );
    if (el.width > 4 && el.height > 4) {
      this.app.state.add(el);
      this.app.state.select(el.id);
      this.app.tools.set("select");
    }
    this._preview = null;
    this._start = null;
    this.app.engine.markDirty();
  }
}

// ── LineTool ────────────────────────────────────────────────────────────────
class LineTool {
  constructor(app) {
    this.app = app;
    this.name = "line";
    this._el = null;
  }
  get cursor() {
    return "crosshair";
  }

  onMouseDown(wp) {
    this._el = ElementFactory.create("line", {
      x: wp.x,
      y: wp.y,
      x2: wp.x,
      y2: wp.y,
    });
    this.app.state.elements.push(this._el);
    this.app.engine.markDirty();
  }

  onMouseMove(wp) {
    if (!this._el) return;
    this._el.x2 = wp.x;
    this._el.y2 = wp.y;
    this._el.width = Math.abs(wp.x - this._el.x);
    this._el.height = Math.abs(wp.y - this._el.y);
    this.app.engine.markDirty();
  }

  onMouseUp() {
    if (!this._el) return;
    const el = this._el;
    this.app.state.elements = this.app.state.elements.filter(
      (e) => e.id !== el.id,
    );
    const len = Utils.dist(el.x, el.y, el.x2, el.y2);
    if (len > 4) {
      this.app.state.add(el);
      this.app.state.select(el.id);
      this.app.tools.set("select");
    }
    this._el = null;
    this.app.engine.markDirty();
  }
}

// ── TextTool ────────────────────────────────────────────────────────────────
class TextTool {
  constructor(app) {
    this.app = app;
    this.name = "text";
  }
  get cursor() {
    return "text";
  }

  onMouseDown(wp) {
    const el = ElementFactory.create("text", { x: wp.x, y: wp.y });
    this.app.state.add(el);
    this.app.state.select(el.id);
    this.app.tools.set("select");
    this.app.ui.openTextEditor(el.id);
  }
  onMouseMove() {}
  onMouseUp() {}
}

// ── ImageTool ────────────────────────────────────────────────────────────────
class ImageTool {
  constructor(app) {
    this.app = app;
    this.name = "image";
  }
  get cursor() {
    return "copy";
  }

  onMouseDown(wp) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const el = ElementFactory.create("image", {
          x: wp.x,
          y: wp.y,
          width: 200,
          height: 150,
          src: ev.target.result,
        });
        this.app.state.add(el);
        this.app.state.select(el.id);
        this.app.tools.set("select");
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }
  onMouseMove() {}
  onMouseUp() {}
}

// ── ToolManager ─────────────────────────────────────────────────────────────
class ToolManager extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this._map = {
      select: new SelectTool(app),
      rect: new DrawTool(app, "rect"),
      circle: new DrawTool(app, "circle"),
      line: new LineTool(app),
      text: new TextTool(app),
      image: new ImageTool(app),
    };
    this.current = this._map.select;
  }

  set(name) {
    if (!this._map[name]) return;
    this.current = this._map[name];
    this.app.canvas.style.cursor = this.current.cursor;
    this.emit("change", name);
  }

  get name() {
    return this.current.name;
  }

  onMouseDown(wp, sp, e) {
    this.current.onMouseDown?.(wp, sp, e);
  }
  onMouseMove(wp, sp, e) {
    this.current.onMouseMove?.(wp, sp, e);
  }
  onMouseUp(wp, sp, e) {
    this.current.onMouseUp?.(wp, sp, e);
  }
  drawOverlay() {
    this.current.drawOverlay?.();
  }
}

// =============================================================================
// SECTION 7: EventManager — all input handling
// =============================================================================
class EventManager {
  constructor(app) {
    this.app = app;
    this._isPanning = false;
    this._panStart = null;
    this._panVP = null;
    this._isMouseDown = false;
    this._spaceHeld = false;
  }

  bind() {
    const { canvas } = this.app;

    canvas.addEventListener("mousedown", this._onMouseDown.bind(this));
    canvas.addEventListener("mousemove", this._onMouseMove.bind(this));
    canvas.addEventListener("mouseup", this._onMouseUp.bind(this));
    canvas.addEventListener("wheel", this._onWheel.bind(this), {
      passive: false,
    });
    canvas.addEventListener("dblclick", this._onDblClick.bind(this));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("keydown", this._onKeyDown.bind(this));
    window.addEventListener("keyup", this._onKeyUp.bind(this));
    window.addEventListener("resize", this._onResize.bind(this));

    // Drag-and-drop image onto canvas
    canvas.addEventListener("dragover", (e) => e.preventDefault());
    canvas.addEventListener("drop", this._onDrop.bind(this));
  }

  _coords(e) {
    const rect = this.app.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wp = this.app.engine.screenToWorld(sx, sy);
    return { sx, sy, wp };
  }

  _onMouseDown(e) {
    this._isMouseDown = true;
    const { sx, sy, wp } = this._coords(e);

    if (e.button === 1 || (e.button === 0 && this._spaceHeld)) {
      this._isPanning = true;
      this._panStart = { x: e.clientX, y: e.clientY };
      this._panVP = { ...this.app.engine.viewport };
      this.app.canvas.style.cursor = "grabbing";
      return;
    }

    if (e.button === 0) {
      this.app.tools.onMouseDown(wp, { x: sx, y: sy }, e);
    }
  }

  _onMouseMove(e) {
    const { sx, sy, wp } = this._coords(e);

    if (this._isPanning) {
      const dx = e.clientX - this._panStart.x;
      const dy = e.clientY - this._panStart.y;
      this.app.engine.viewport.panX = this._panVP.panX + dx;
      this.app.engine.viewport.panY = this._panVP.panY + dy;
      this.app.engine.markDirty();
      this.app.engine.emit("viewport");
      return;
    }

    if (this._isMouseDown) {
      this.app.tools.onMouseMove(wp, { x: sx, y: sy }, e);
    }

    this.app.engine.markDirty();
  }

  _onMouseUp(e) {
    this._isMouseDown = false;

    if (this._isPanning) {
      this._isPanning = false;
      this.app.canvas.style.cursor = this.app.tools.current.cursor;
      return;
    }

    const { sx, sy, wp } = this._coords(e);
    this.app.tools.onMouseUp(wp, { x: sx, y: sy }, e);
  }

  _onWheel(e) {
    e.preventDefault();
    const { sx, sy } = this._coords(e);

    if (e.ctrlKey || e.metaKey) {
      // Pinch zoom
      const delta = -e.deltaY * 0.01;
      const newZ = this.app.engine.viewport.zoom * (1 + delta);
      this.app.engine.setZoom(newZ, { x: sx, y: sy });
    } else {
      // Pan
      this.app.engine.pan(-e.deltaX, -e.deltaY);
    }
  }

  _onDblClick(e) {
    const { sx, sy, wp } = this._coords(e);
    const hit = this.app.engine.hitTest(sx, sy);
    if (hit.type === "element") {
      const el = this.app.state.byId(hit.id);
      if (el && (el.type === "text" || el.type === "image")) {
        this.app.ui.openTextEditor(el.id);
      }
    }
  }

  _onKeyDown(e) {
    // Ignore if focus is in input
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;

    const ctrl = e.ctrlKey || e.metaKey;

    if (e.code === "Space") {
      this._spaceHeld = true;
      this.app.canvas.style.cursor = "grab";
    }

    // Tool shortcuts
    const toolKeys = {
      v: "select",
      r: "rect",
      e: "circle",
      l: "line",
      t: "text",
      i: "image",
    };
    if (!ctrl && toolKeys[e.key]) {
      e.preventDefault();
      this.app.tools.set(toolKeys[e.key]);
      return;
    }

    if (ctrl && e.key === "z") {
      e.preventDefault();
      this.app.state.undo();
      return;
    }
    if (ctrl && (e.key === "y" || e.key === "Z")) {
      e.preventDefault();
      this.app.state.redo();
      return;
    }
    if (ctrl && e.key === "c") {
      e.preventDefault();
      this.app.state.copy();
      return;
    }
    if (ctrl && e.key === "v") {
      e.preventDefault();
      this.app.state.paste();
      return;
    }
    if (ctrl && e.key === "a") {
      e.preventDefault();
      this.app.state.selectAll();
      return;
    }
    if (ctrl && e.key === "d") {
      e.preventDefault();
      this._duplicate();
      return;
    }
    if (ctrl && e.key === "g") {
      e.preventDefault();
      this.app.engine.showGrid = !this.app.engine.showGrid;
      this.app.engine.markDirty();
      return;
    }
    if (ctrl && e.key === "0") {
      e.preventDefault();
      this.app.engine.fitToContent();
      return;
    }
    if (ctrl && e.key === "1") {
      e.preventDefault();
      this.app.engine.setZoom(1);
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const ids = [...this.app.state.selectedIds];
      if (ids.length) this.app.state.remove(ids);
      return;
    }

    if (e.key === "Escape") {
      this.app.state.deselect();
      this.app.tools.set("select");
      return;
    }

    // Nudge
    const NUDGE = e.shiftKey ? 10 : 1;
    const nudgeMap = {
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
    };
    if (nudgeMap[e.key]) {
      e.preventDefault();
      const [ndx, ndy] = nudgeMap[e.key];
      this.app.state.getSelected().forEach((el) => {
        this.app.state.updateSilent(el.id, {
          x: el.x + ndx,
          y: el.y + ndy,
          ...(el.type === "line" ? { x2: el.x2 + ndx, y2: el.y2 + ndy } : {}),
        });
      });
      this.app.state.commit();
    }
  }

  _onKeyUp(e) {
    if (e.code === "Space") {
      this._spaceHeld = false;
      this.app.canvas.style.cursor = this.app.tools.current.cursor;
    }
  }

  _onResize() {
    const container = this.app.canvas.parentElement;
    this.app.engine.resize(container.clientWidth, container.clientHeight);
  }

  _onDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const { sx, sy, wp } = this._coords(e);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const el = ElementFactory.create("image", {
        x: wp.x - 100,
        y: wp.y - 75,
        width: 200,
        height: 150,
        src: ev.target.result,
      });
      this.app.state.add(el);
      this.app.state.select(el.id);
    };
    reader.readAsDataURL(file);
  }

  _duplicate() {
    this.app.state.copy();
    this.app.state.paste();
  }
}

// =============================================================================
// SECTION 8: UIManager — panels, toolbar, text editor
// =============================================================================
class UIManager extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this._textEditorEl = null;
    this._editingId = null;
    this._debouncedPropUpdate = Utils.debounce(
      () => this._syncProperties(),
      50,
    );
  }

  init() {
    this._buildToolbar();
    this._buildLayersPanel();
    this._buildPropertiesPanel();
    this._buildTextEditorOverlay();

    // React to state changes
    this.app.state.on("change", () => {
      this.refreshLayers();
      this._syncProperties();
      this.app.engine.markDirty();
    });
    this.app.state.on("selection", () => {
      this.refreshLayers();
      this._syncProperties();
      this.app.engine.markDirty();
    });
    this.app.state.on("history", () => this._updateHistoryButtons());
    this.app.engine.on("viewport", () => this._updateZoomDisplay());
    this.app.tools.on("change", (t) => this._updateToolButtons(t));
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────
  _buildToolbar() {
    const tb = document.getElementById("toolbar");

    // Tool buttons
    const toolDefs = [
      { id: "select", icon: "↖", key: "V", label: "Select" },
      { id: "rect", icon: "▭", key: "R", label: "Rectangle" },
      { id: "circle", icon: "○", key: "E", label: "Ellipse" },
      { id: "line", icon: "╱", key: "L", label: "Line" },
      { id: "text", icon: "T", key: "T", label: "Text" },
      { id: "image", icon: "⊡", key: "I", label: "Image" },
    ];

    const toolBar = document.getElementById("tool-buttons");
    toolDefs.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "tool-btn";
      btn.id = `tool-${t.id}`;
      btn.title = `${t.label} (${t.key})`;
      btn.innerHTML = `<span class="tool-icon">${t.icon}</span>`;
      btn.addEventListener("click", () => this.app.tools.set(t.id));
      toolBar.appendChild(btn);
    });

    // File ops
    document
      .getElementById("btn-save")
      .addEventListener("click", () => this.saveJSON());
    document
      .getElementById("btn-load")
      .addEventListener("click", () => this.loadJSON());
    document
      .getElementById("btn-export")
      .addEventListener("click", () => this.exportPNG());
    document
      .getElementById("btn-fit")
      .addEventListener("click", () => this.app.engine.fitToContent());
    document
      .getElementById("btn-undo")
      .addEventListener("click", () => this.app.state.undo());
    document
      .getElementById("btn-redo")
      .addEventListener("click", () => this.app.state.redo());
    document.getElementById("btn-clear").addEventListener("click", () => {
      if (confirm("Clear canvas? This cannot be undone.")) {
        this.app.state.commit();
        this.app.state.elements = [];
        this.app.state.selectedIds.clear();
        this.app.state.emit("change");
        this.app.state.emit("selection");
      }
    });

    // Zoom controls
    document
      .getElementById("btn-zoom-in")
      .addEventListener("click", () =>
        this.app.engine.setZoom(this.app.engine.viewport.zoom * 1.2),
      );
    document
      .getElementById("btn-zoom-out")
      .addEventListener("click", () =>
        this.app.engine.setZoom(this.app.engine.viewport.zoom / 1.2),
      );
    document
      .getElementById("zoom-display")
      .addEventListener("click", () => this.app.engine.setZoom(1));

    this._updateToolButtons("select");
    this._updateHistoryButtons();
    this._updateZoomDisplay();
  }

  _updateToolButtons(active) {
    document.querySelectorAll(".tool-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.id === `tool-${active}`);
    });
  }

  _updateHistoryButtons() {
    const undo = document.getElementById("btn-undo");
    const redo = document.getElementById("btn-redo");
    if (undo) undo.disabled = !this.app.state.canUndo();
    if (redo) redo.disabled = !this.app.state.canRedo();
  }

  _updateZoomDisplay() {
    const el = document.getElementById("zoom-display");
    if (el)
      el.textContent = Math.round(this.app.engine.viewport.zoom * 100) + "%";
  }

  // ── Layer panel ───────────────────────────────────────────────────────────
  _buildLayersPanel() {
    // Built in HTML, we just need to handle interactions
  }

  refreshLayers() {
    const list = document.getElementById("layers-list");
    if (!list) return;

    const elements = [...this.app.state.getAll()].reverse(); // top first
    list.innerHTML = "";

    elements.forEach((el) => {
      const item = document.createElement("div");
      item.className =
        "layer-item" + (this.app.state.isSelected(el.id) ? " selected" : "");
      item.dataset.id = el.id;

      const icon =
        { rect: "▭", circle: "○", line: "╱", text: "T", image: "⊡" }[el.type] ||
        "?";

      item.innerHTML = `
        <span class="layer-icon">${icon}</span>
        <span class="layer-name">${el.name}</span>
        <div class="layer-actions">
          <button class="layer-vis" title="Toggle visibility">${el.visible ? "👁" : "◌"}</button>
          <button class="layer-lock" title="Toggle lock">${el.locked ? "🔒" : "🔓"}</button>
        </div>`;

      item.querySelector(".layer-vis").addEventListener("click", (e) => {
        e.stopPropagation();
        this.app.state.updateSilent(el.id, { visible: !el.visible });
        this.app.state.emit("change");
      });

      item.querySelector(".layer-lock").addEventListener("click", (e) => {
        e.stopPropagation();
        this.app.state.updateSilent(el.id, { locked: !el.locked });
        this.app.state.emit("change");
      });

      item.addEventListener("click", (e) => {
        this.app.state.select(el.id, e.shiftKey);
      });

      item.addEventListener("dblclick", () => {
        const name = prompt("Rename element:", el.name);
        if (name) this.app.state.update(el.id, { name });
      });

      list.appendChild(item);
    });
  }

  // ── Properties panel ─────────────────────────────────────────────────────
  _buildPropertiesPanel() {
    const panel = document.getElementById("props-content");
    if (!panel) return;
    panel.innerHTML = `
      <div class="props-empty" id="props-empty">
        <p>Select an element to edit its properties.</p>
      </div>

      <div class="props-sections" id="props-sections" style="display:none">
        <!-- Transform -->
        <div class="prop-section">
          <div class="prop-section-title">Transform</div>
          <div class="prop-row two-col">
            <label>X <input type="number" id="prop-x" step="1"></label>
            <label>Y <input type="number" id="prop-y" step="1"></label>
          </div>
          <div class="prop-row two-col">
            <label>W <input type="number" id="prop-w" step="1" min="1"></label>
            <label>H <input type="number" id="prop-h" step="1" min="1"></label>
          </div>
          <div class="prop-row">
            <label>Rotation <input type="number" id="prop-rotation" step="1" min="-360" max="360"> °</label>
          </div>
        </div>

        <!-- Fill & Stroke -->
        <div class="prop-section">
          <div class="prop-section-title">Appearance</div>
          <div class="prop-row">
            <label>Fill
              <div class="color-row">
                <input type="color" id="prop-fill-picker">
                <input type="text"  id="prop-fill-text" maxlength="20">
                <button id="prop-fill-none" title="No fill" class="no-color-btn">⊘</button>
              </div>
            </label>
          </div>
          <div class="prop-row">
            <label>Stroke
              <div class="color-row">
                <input type="color" id="prop-stroke-picker">
                <input type="text"  id="prop-stroke-text" maxlength="20">
                <button id="prop-stroke-none" title="No stroke" class="no-color-btn">⊘</button>
              </div>
            </label>
          </div>
          <div class="prop-row two-col">
            <label>Stroke W <input type="number" id="prop-stroke-w" step="0.5" min="0" max="50"></label>
            <label>Opacity <input type="number" id="prop-opacity" step="0.05" min="0" max="1"></label>
          </div>
          <div class="prop-row">
            <label><input type="checkbox" id="prop-shadow"> Drop Shadow</label>
          </div>
        </div>

        <!-- Text (shown for text elements) -->
        <div class="prop-section" id="text-section" style="display:none">
          <div class="prop-section-title">Text</div>
          <div class="prop-row">
            <label>Font Size <input type="number" id="prop-font-size" step="1" min="6" max="200"></label>
          </div>
          <div class="prop-row">
            <label>Font Family
              <select id="prop-font-family">
                <option>Syne</option><option>Space Mono</option>
                <option>Georgia</option><option>Arial</option>
                <option>Helvetica</option><option>Times New Roman</option>
                <option>Courier New</option><option>Verdana</option>
              </select>
            </label>
          </div>
          <div class="prop-row">
            <label>Align
              <select id="prop-text-align">
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
          </div>
          <div class="prop-row">
            <label>Text
              <textarea id="prop-text-content" rows="3"></textarea>
            </label>
          </div>
        </div>

        <!-- Rect specific -->
        <div class="prop-section" id="rect-section" style="display:none">
          <div class="prop-section-title">Rectangle</div>
          <div class="prop-row">
            <label>Corner Radius <input type="number" id="prop-corner-radius" step="1" min="0" max="999"></label>
          </div>
        </div>

        <!-- Order -->
        <div class="prop-section">
          <div class="prop-section-title">Arrange</div>
          <div class="prop-row arrange-buttons">
            <button id="btn-bring-front" title="Bring to Front">⬆↑</button>
            <button id="btn-bring-fwd"   title="Bring Forward">⬆</button>
            <button id="btn-send-bwd"    title="Send Backward">⬇</button>
            <button id="btn-send-back"   title="Send to Back">⬇↓</button>
          </div>
        </div>
      </div>`;

    this._bindPropInputs();
  }

  _bindPropInputs() {
    const bind = (id, prop, transform = (v) => v) => {
      const el = document.getElementById(id);
      if (!el) return;
      const eventType =
        el.tagName === "SELECT" || el.type === "checkbox" || el.type === "color"
          ? "change"
          : "input";
      el.addEventListener(eventType, () => {
        const selected = this.app.state.getSelected();
        if (!selected.length) return;
        let val =
          el.type === "checkbox"
            ? el.checked
            : el.type === "number"
              ? parseFloat(el.value)
              : el.value;
        val = transform(val);
        selected.forEach((s) =>
          this.app.state.updateSilent(s.id, { [prop]: val }),
        );
        this.app.state.commit();
        this.app.engine.markDirty();
      });
    };

    bind("prop-x", "x", (v) => +v);
    bind("prop-y", "y", (v) => +v);
    bind("prop-w", "width", (v) => Math.max(1, +v));
    bind("prop-h", "height", (v) => Math.max(1, +v));
    bind("prop-rotation", "rotation", (v) => Utils.degToRad(+v));
    bind("prop-fill-picker", "fill");
    bind("prop-fill-text", "fill");
    bind("prop-stroke-picker", "stroke");
    bind("prop-stroke-text", "stroke");
    bind("prop-stroke-w", "strokeWidth", (v) => +v);
    bind("prop-opacity", "opacity", (v) => Utils.clamp(+v, 0, 1));
    bind("prop-shadow", "shadow");
    bind("prop-font-size", "fontSize", (v) => +v);
    bind("prop-font-family", "fontFamily");
    bind("prop-text-align", "textAlign");
    bind("prop-corner-radius", "cornerRadius", (v) => +v);

    const textArea = document.getElementById("prop-text-content");
    if (textArea) {
      textArea.addEventListener("input", () => {
        const selected = this.app.state.getSelected();
        selected.forEach((s) =>
          this.app.state.updateSilent(s.id, { text: textArea.value }),
        );
        this.app.engine.markDirty();
      });
      textArea.addEventListener("change", () => this.app.state.commit());
    }

    // No-fill / no-stroke buttons
    document.getElementById("prop-fill-none")?.addEventListener("click", () => {
      this.app.state
        .getSelected()
        .forEach((s) =>
          this.app.state.updateSilent(s.id, { fill: "transparent" }),
        );
      this.app.state.commit();
      this._syncProperties();
      this.app.engine.markDirty();
    });
    document
      .getElementById("prop-stroke-none")
      ?.addEventListener("click", () => {
        this.app.state
          .getSelected()
          .forEach((s) =>
            this.app.state.updateSilent(s.id, {
              stroke: "transparent",
              strokeWidth: 0,
            }),
          );
        this.app.state.commit();
        this._syncProperties();
        this.app.engine.markDirty();
      });

    // Arrange buttons
    document
      .getElementById("btn-bring-front")
      ?.addEventListener("click", () => {
        this.app.state
          .getSelected()
          .forEach((s) => this.app.state.bringToFront(s.id));
      });
    document.getElementById("btn-bring-fwd")?.addEventListener("click", () => {
      this.app.state
        .getSelected()
        .forEach((s) => this.app.state.bringForward(s.id));
    });
    document.getElementById("btn-send-bwd")?.addEventListener("click", () => {
      this.app.state
        .getSelected()
        .forEach((s) => this.app.state.sendBackward(s.id));
    });
    document.getElementById("btn-send-back")?.addEventListener("click", () => {
      this.app.state
        .getSelected()
        .forEach((s) => this.app.state.sendToBack(s.id));
    });
  }

  _syncProperties() {
    const selected = this.app.state.getSelected();
    const empty = document.getElementById("props-empty");
    const sections = document.getElementById("props-sections");
    if (!sections) return;

    if (!selected.length) {
      empty.style.display = "";
      sections.style.display = "none";
      return;
    }

    empty.style.display = "none";
    sections.style.display = "";

    const el = selected[0]; // primary element
    const set = (id, val) => {
      const inp = document.getElementById(id);
      if (!inp) return;
      if (inp.type === "checkbox") inp.checked = !!val;
      else if (document.activeElement !== inp) inp.value = val ?? "";
    };

    set("prop-x", Utils.round(el.x));
    set("prop-y", Utils.round(el.y));
    set("prop-w", Utils.round(el.width));
    set("prop-h", Utils.round(el.height));
    set("prop-rotation", Utils.round(Utils.radToDeg(el.rotation)));
    set("prop-fill-text", el.fill || "");
    set("prop-stroke-text", el.stroke || "");
    set("prop-stroke-w", el.strokeWidth ?? 0);
    set("prop-opacity", el.opacity ?? 1);
    set("prop-shadow", el.shadow ?? false);

    // Color pickers (only accept hex)
    const toHex = (c) => {
      if (!c || c === "transparent") return "#000000";
      if (c.startsWith("#"))
        return c.length === 4
          ? "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
          : c.slice(0, 7);
      return "#000000";
    };
    set("prop-fill-picker", toHex(el.fill));
    set("prop-stroke-picker", toHex(el.stroke));

    // Type-specific panels
    document.getElementById("text-section").style.display =
      el.type === "text" ? "" : "none";
    document.getElementById("rect-section").style.display =
      el.type === "rect" ? "" : "none";

    if (el.type === "text") {
      set("prop-font-size", el.fontSize ?? 16);
      set("prop-font-family", el.fontFamily || "Syne");
      set("prop-text-align", el.textAlign || "left");
      set("prop-text-content", el.text || "");
    }
    if (el.type === "rect") {
      set("prop-corner-radius", el.cornerRadius ?? 0);
    }
  }

  // ── Text editor overlay ───────────────────────────────────────────────────
  _buildTextEditorOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "text-editor-overlay";
    overlay.className = "text-editor-overlay hidden";
    overlay.innerHTML = `<textarea id="text-editor-input"></textarea>`;
    document.getElementById("canvas-container").appendChild(overlay);
    this._textEditorEl = overlay;

    document
      .getElementById("text-editor-input")
      .addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeTextEditor();
        }
      });

    document
      .getElementById("text-editor-input")
      .addEventListener("input", (e) => {
        if (this._editingId) {
          this.app.state.updateSilent(this._editingId, {
            text: e.target.value,
          });
          this.app.engine.markDirty();
        }
      });

    document
      .getElementById("text-editor-input")
      .addEventListener("blur", () => {
        this.closeTextEditor();
      });
  }

  openTextEditor(id) {
    const el = this.app.state.byId(id);
    if (!el || el.type !== "text") return;
    this._editingId = id;

    const { engine } = this.app;
    const sp = engine.worldToScreen(el.x, el.y);
    const overlay = this._textEditorEl;
    const input = document.getElementById("text-editor-input");

    overlay.style.left = sp.x + "px";
    overlay.style.top = sp.y + "px";
    overlay.style.width = el.width * engine.viewport.zoom + "px";
    overlay.style.minHeight = el.height * engine.viewport.zoom + "px";
    overlay.style.transform = `rotate(${el.rotation}rad)`;
    overlay.classList.remove("hidden");

    input.style.fontSize = (el.fontSize || 16) * engine.viewport.zoom + "px";
    input.style.fontFamily = el.fontFamily || "Syne, sans-serif";
    input.style.color = el.fill || "#e6e6f0";
    input.value = el.text || "";
    input.focus();
    input.select();
  }

  closeTextEditor() {
    if (this._editingId) {
      this.app.state.commit();
    }
    this._editingId = null;
    this._textEditorEl?.classList.add("hidden");
  }

  // ── File ops ──────────────────────────────────────────────────────────────
  saveJSON() {
    const json = this.app.state.serialize();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "design.vfg";
    a.click();
    URL.revokeObjectURL(url);
  }

  loadJSON() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".vfg,.json";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const ok = this.app.state.deserialize(ev.target.result);
        if (!ok) alert("Invalid design file.");
        else this.app.engine.fitToContent();
      };
      reader.readAsText(file);
    };
    input.click();
  }

  exportPNG() {
    const url = this.app.engine.exportPNG();
    if (!url) {
      alert("Nothing to export.");
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = "design.png";
    a.click();
  }
}

// =============================================================================
// SECTION 9: AppController — orchestrates all subsystems
// =============================================================================
class AppController {
  constructor() {
    this.state = new StateManager();
    this.canvas = document.getElementById("main-canvas");
    this.engine = new CanvasEngine(this.canvas, this.state);
    this.tools = new ToolManager(this);
    this.events = new EventManager(this);
    this.ui = new UIManager(this);
  }

  init() {
    // Size canvas to its container
    const container = this.canvas.parentElement;
    this.engine.resize(container.clientWidth, container.clientHeight);

    // Center viewport
    this.engine.viewport.panX = container.clientWidth / 2;
    this.engine.viewport.panY = container.clientHeight / 2;

    // Bind events
    this.events.bind();

    // Init UI
    this.ui.init();

    // Hook tool overlay drawing into render loop
    const origRender = this.engine._render.bind(this.engine);
    this.engine._render = () => {
      origRender();
      this.tools.drawOverlay();
    };

    // Start render loop
    this.engine.startLoop();

    // Load demo content
    this._loadDemo();

    console.log(
      "[VectorForge] Initialized. Keyboard shortcuts: V/R/E/L/T/I for tools, Ctrl+Z/Y undo/redo, Del to delete, Space+drag to pan, scroll to pan, Ctrl+scroll to zoom.",
    );
  }

  _loadDemo() {
    const els = [
      ElementFactory.create("rect", {
        x: -200,
        y: -150,
        width: 200,
        height: 130,
        fill: "#7c6ffa",
        cornerRadius: 12,
        name: "Card BG",
      }),
      ElementFactory.create("rect", {
        x: -190,
        y: -140,
        width: 80,
        height: 80,
        fill: "#fa6f8f",
        cornerRadius: 8,
        name: "Thumb",
      }),
      ElementFactory.create("text", {
        x: -200,
        y: -10,
        width: 200,
        height: 28,
        text: "VectorForge",
        fontSize: 22,
        fill: "#e6e6f0",
        name: "Headline",
      }),
      ElementFactory.create("circle", {
        x: 80,
        y: -150,
        width: 120,
        height: 120,
        fill: "#6ffad5",
        name: "Dot",
      }),
      ElementFactory.create("line", {
        x: -40,
        y: 60,
        x2: 200,
        y2: 60,
        stroke: "#7c6ffa",
        strokeWidth: 3,
        name: "Divider",
      }),
      ElementFactory.create("text", {
        x: -40,
        y: 80,
        width: 280,
        height: 24,
        text: "Design editor — HTML5 Canvas",
        fontSize: 13,
        fill: "#9494aa",
        name: "Subtitle",
      }),
    ];
    els.forEach((el) => this.state.elements.push(el));
    this.state.emit("change");
    this.ui.refreshLayers();
    this.engine.fitToContent();
  }
}

// =============================================================================
// SECTION 10: Bootstrap
// =============================================================================
document.addEventListener("DOMContentLoaded", () => {
  window.app = new AppController();
  window.app.init();
});
