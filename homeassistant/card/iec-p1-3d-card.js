/*
 * IEC P1 3D card — a three-dimensional live view of a three-phase meter
 * for Home Assistant. Each phase is a glass tube sized to the breaker; the
 * fill is the live current, so you see at a glance how close each phase is
 * to tripping. Drag the scene to rotate it.
 *
 * MIT License, part of iec-p1-esphome-3phase.
 */

const CARD_VERSION = "1.0.0";
const TAG = "iec-p1-3d-card";

const STRINGS = {
  he: {
    title: "חשמל בבית",
    perHour: "לשעה",
    now: "צריכה עכשיו",
    exporting: "מחזיר לרשת",
    peak: (kw, time) => `שיא היום ${kw} kW${time ? ` בשעה ${time}` : ""}`,
    phase: (n) => `פאזה ${n}`,
    today: "היום",
    month: "החודש",
    forecast: "צפי לחודש",
    vsYesterday: "מול אתמול",
    sameAsYesterday: "כמו אתמול",
    needDay: "צריך יממה מלאה של נתונים",
    noData: "אין נתונים מהמונה",
    noDataHint: "בדוק שהקורא מחובר ושהמכשיר זמין ב-Home Assistant",
    sceneLabel: (a) => `עומס לפי פאזה: ${a}. גרור או השתמש בחצים כדי לסובב, לחיצה כפולה מאפסת`,
    ofBreaker: (pct) => `${pct}% מהמפסק`,
  },
  en: {
    title: "Home power",
    perHour: "per hour",
    now: "Using now",
    exporting: "Exporting",
    peak: (kw, time) => `Today's peak ${kw} kW${time ? ` at ${time}` : ""}`,
    phase: (n) => `Phase ${n}`,
    today: "Today",
    month: "This month",
    forecast: "Month forecast",
    vsYesterday: "vs yesterday",
    sameAsYesterday: "Same as yesterday",
    needDay: "Needs a full day of data",
    noData: "No data from the meter",
    noDataHint: "Check that the reader is connected and available in Home Assistant",
    sceneLabel: (a) => `Load per phase: ${a}. Drag or use the arrow keys to rotate, double-click to reset`,
    ofBreaker: (pct) => `${pct}% of breaker`,
  },
};

const ENTITY_KEYS = [
  "power", "power_export",
  "power_l1", "power_l2", "power_l3",
  "current_l1", "current_l2", "current_l3",
  "voltage_l1", "voltage_l2", "voltage_l3",
  "cost_now", "cost_today", "cost_month", "forecast",
  "vs_yesterday", "peak", "peak_time", "energy_today", "energy_month",
  "breaker",
];

function defaultEntities(meterPrefix) {
  const m = meterPrefix || "sensor.electricity_meter";
  return {
    power: `${m}_power`,
    power_export: `${m}_power_export`,
    power_l1: `${m}_power_l1`,
    power_l2: `${m}_power_l2`,
    power_l3: `${m}_power_l3`,
    current_l1: `${m}_current_l1`,
    current_l2: `${m}_current_l2`,
    current_l3: `${m}_current_l3`,
    voltage_l1: `${m}_voltage_l1`,
    voltage_l2: `${m}_voltage_l2`,
    voltage_l3: `${m}_voltage_l3`,
    // Cost and statistics are computed on the reader itself.
    cost_now: `${m}_cost_now`,
    cost_today: `${m}_cost_today`,
    cost_month: `${m}_cost_month`,
    forecast: `${m}_forecast_month`,
    vs_yesterday: `${m}_compared_to_yesterday`,
    peak: `${m}_peak_today`,
    peak_time: `${m}_peak_time`,
    energy_today: `${m}_energy_today`,
    energy_month: `${m}_energy_month`,
    // Breaker size is a setting on the reader (number entity)
    breaker: `number.${m.replace(/^sensor\./, "")}_breaker_size`,
  };
}

// Phase colours. "gold" matches the reader's own web interface (gold, copper,
// silver like busbar metals); "classic" is the original cyan/violet/amber.
const PALETTES = {
  gold: ["#f0c95c", "#c58468", "#cdd3da"],
  classic: ["#2ec5f0", "#9b7cff", "#ffb23e"],
};
let PHASE_COLORS = PALETTES.gold;
const WARN = "#ff8a3d";
const CRIT = "#ff4d5a";
const EXPORT = "#3ddc97";

/* ---------- world geometry (CSS px in the 3D world) ---------- */
const FLOOR_W = 320;
const FLOOR_D = 196;
const SLAB = 10;
const TUBE = 46;          // tube footprint
const TUBE_H = 124;       // tube height = 100% of the breaker
const TUBE_Y = 98;
const TUBE_X = [84, 170, 256];
const METER = { x: 16, y: 104, w: 42, d: 30, h: 70 };
const DEFAULT_VIEW = { rx: 56, rz: 18 };

/* ---------- seven-segment digits, like the meter's own display ---------- */
//  segments: a top, b upper-right, c lower-right, d bottom, e lower-left, f upper-left, g middle
const SEGMENTS = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
  "-": "g", " ": "",
};
const DW = 26, DH = 46, ST = 5.4, GAP = 1.2, SLOT = 34;

function segPolys(x0) {
  const t = ST, h2 = DH / 2, g = GAP;
  const hz = (x, y, w) =>
    `${x + g + t / 2},${y} ${x + g + t},${y - t / 2} ${x + w - g - t},${y - t / 2} ${x + w - g - t / 2},${y} ${x + w - g - t},${y + t / 2} ${x + g + t},${y + t / 2}`;
  const vt = (x, y, hh) =>
    `${x},${y + g + t / 2} ${x + t / 2},${y + g + t} ${x + t / 2},${y + hh - g - t} ${x},${y + hh - g - t / 2} ${x - t / 2},${y + hh - g - t} ${x - t / 2},${y + g + t}`;
  const L = x0 + t / 2, R = x0 + DW - t / 2;
  return {
    a: hz(x0, t / 2, DW),
    g: hz(x0, h2, DW),
    d: hz(x0, DH - t / 2, DW),
    f: vt(L, t / 2, h2 - t / 2),
    b: vt(R, t / 2, h2 - t / 2),
    e: vt(L, h2, h2 - t / 2),
    c: vt(R, h2, h2 - t / 2),
  };
}

/** text like "-12.34" → SVG markup with lit and ghost segments over fixed slots */
function sevenSeg(text, slots) {
  const chars = [];
  let dpAfter = -1;
  for (const ch of text) {
    if (ch === ".") dpAfter = chars.length - 1;
    else chars.push(ch);
  }
  while (chars.length < slots) { chars.unshift(" "); if (dpAfter >= 0) dpAfter++; }
  const width = slots * SLOT;
  let out = `<svg viewBox="-4 -1 ${width + 6} ${DH + 2}" width="${(width + 6) * 0.86}" height="${(DH + 2) * 0.86}" aria-hidden="true"><defs><linearGradient id="lcdgold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset=".45" stop-color="#e8bf55"/><stop offset=".55" stop-color="#c8972f"/><stop offset="1" stop-color="#f2d27a"/></linearGradient></defs><g transform="skewX(-7)">`;
  chars.forEach((ch, i) => {
    const polys = segPolys(i * SLOT + 6);
    const lit = SEGMENTS[ch] ?? "";
    for (const s of "abcdefg") {
      out += `<polygon class="${lit.includes(s) ? "on" : "off"}" points="${polys[s]}"/>`;
    }
    const dpOn = i === dpAfter;
    out += `<rect class="${dpOn ? "on" : "off"}" x="${i * SLOT + 6 + DW + 1.5}" y="${DH - ST}" width="${ST}" height="${ST}" rx="1"/>`;
  });
  return out + "</g></svg>";
}

/* ---------- small helpers ---------- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function boxHTML(cls, w, d, h, extra = {}) {
  const f = (name, style, inner = "") =>
    `<div class="f f-${name}" style="${style}">${inner}</div>`;
  return `<div class="box ${cls}" style="width:${w}px;height:${d}px">
    ${f("n", `width:${w}px;height:${h}px;transform:rotateX(90deg)`, extra.n || "")}
    ${f("w", `width:${d}px;height:${h}px;transform:rotateZ(90deg) rotateX(90deg)`, extra.w || "")}
    ${f("e", `width:${d}px;height:${h}px;transform:translateX(${w}px) rotateZ(90deg) rotateX(90deg)`, extra.e || "")}
    ${f("s", `width:${w}px;height:${h}px;transform:translateY(${d}px) rotateX(90deg)`, extra.s || "")}
    ${f("top", `width:${w}px;height:${d}px;transform:translateZ(${h}px)`, extra.top || "")}
  </div>`;
}

const STYLE = `
:host {
  --l1: ${PHASE_COLORS[0]};
  --l2: ${PHASE_COLORS[1]};
  --l3: ${PHASE_COLORS[2]};
  --warn: ${WARN};
  --crit: ${CRIT};
  --export: ${EXPORT};
  --scene-a: #1d2836;
  --scene-b: #10161f;
  --ink: #eef4fa;
  --ink-2: #9fb0c2;
  --ink-3: #6f8296;
  --rule: rgba(255, 255, 255, 0.08);
  --floor: #1a2430;
  --floor-edge: #2f3d4d;
  --slab-s: #141c26;
  --slab-e: #0f161e;
  --grid: rgba(160, 190, 220, 0.07);
  --glass: rgba(255, 255, 255, 0.035);
  --glass-hi: rgba(255, 255, 255, 0.09);
  --glass-edge: rgba(200, 225, 255, 0.22);
  --meter-top: #e9edf1;
  --meter-s: #cfd5dc;
  --meter-e: #aeb6bf;
  --meter-n: #c3cad2;
  --lcd-bg: #1c2a22;
  --lcd-on: #eaf7ff;
  --lcd-off: rgba(255, 255, 255, 0.055);
  --lcd-glow: rgba(140, 220, 255, 0.45);
  --tag-bg: rgba(12, 18, 26, 0.78);
  --tag-ink: #ffffff;
  --focus: #7cc8ff;
  display: block;
}
:host([theme="light"]) {
  --scene-a: #f3f6f9;
  --scene-b: #dfe6ed;
  --ink: #17212c;
  --ink-2: #4d5f72;
  --ink-3: #7a8a9b;
  --rule: rgba(20, 40, 60, 0.1);
  --floor: #f9fbfd;
  --floor-edge: #c4cfdb;
  --slab-s: #d3dbe4;
  --slab-e: #bfc9d4;
  --grid: rgba(30, 60, 90, 0.07);
  --glass: rgba(30, 60, 90, 0.035);
  --glass-hi: rgba(30, 60, 90, 0.07);
  --glass-edge: rgba(30, 60, 90, 0.28);
  --meter-top: #ffffff;
  --meter-s: #e6eaee;
  --meter-e: #cdd3d9;
  --meter-n: #dde2e7;
  --lcd-on: #142030;
  --lcd-off: rgba(10, 30, 50, 0.07);
  --lcd-glow: transparent;
  --tag-bg: rgba(255, 255, 255, 0.92);
  --tag-ink: #17212c;
  --focus: #0a6fd6;
}
/* gold look (default) */
:host([look="gold"]) {
  --scene-a: #201d17;
  --scene-b: #12110f;
  --ink: #f4eee0;
  --ink-2: #c3b79c;
  --ink-3: #8a7f67;
  --rule: rgba(232, 191, 85, 0.14);
  --floor: #1d1b16;
  --floor-edge: #3a3326;
  --slab-s: #16140f;
  --slab-e: #110f0b;
  --grid: rgba(232, 191, 85, 0.06);
  --glass: rgba(255, 236, 190, 0.03);
  --glass-hi: rgba(255, 236, 190, 0.08);
  --glass-edge: rgba(232, 191, 85, 0.3);
  --lcd-off: rgba(232, 191, 85, 0.07);
  --lcd-glow: rgba(232, 191, 85, 0.4);
  --tag-bg: rgba(18, 17, 15, 0.82);
  --focus: #fff3c4;
}
:host([look="gold"][theme="light"]) {
  --scene-a: #fbf7ee;
  --scene-b: #efe6d2;
  --ink: #2a2214;
  --ink-2: #6b5a3a;
  --ink-3: #93825f;
  --rule: rgba(150, 110, 30, 0.16);
  --floor: #fffdf8;
  --floor-edge: #d9c9a3;
  --slab-s: #e6d8b8;
  --slab-e: #d6c49c;
  --grid: rgba(150, 110, 30, 0.08);
  --glass: rgba(150, 110, 30, 0.04);
  --glass-hi: rgba(150, 110, 30, 0.08);
  --glass-edge: rgba(150, 110, 30, 0.32);
  --lcd-off: rgba(150, 110, 30, 0.08);
  --lcd-glow: transparent;
  --tag-bg: rgba(255, 253, 248, 0.94);
  --tag-ink: #2a2214;
  --focus: #8a6418;
}
:host([look="gold"]) .lcd svg .on { fill: url(#lcdgold); }
:host([look="gold"][theme="light"]) .lcd svg .on { fill: #8a6418; }
:host([look="gold"]) .rate-val {
  background: linear-gradient(135deg, #fff1b8 0%, #e8bf55 38%, #b8862b 62%, #f2d27a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
:host([look="gold"][theme="light"]) .rate-val { background: none; color: #8a6418; }
ha-card {
  overflow: hidden;
  background: linear-gradient(170deg, var(--scene-a), var(--scene-b));
  color: var(--ink);
  border: none;
}
.card {
  container-type: inline-size;
  font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif));
  font-variant-numeric: tabular-nums;
}
button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  cursor: pointer;
  text-align: inherit;
}
button:focus-visible, .viewport:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: 10px;
}

/* ---------- head ---------- */
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 0;
  position: relative;
  z-index: 2;
}
.title {
  font-size: 15px;
  font-weight: 500;
  color: var(--ink-2);
  margin: 0 0 6px;
}
.lcd {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  direction: ltr;
  justify-content: flex-start;
}
:host([dir="rtl"]) .lcd { justify-content: flex-end; }
.lcd svg .on { fill: var(--lcd-on); filter: drop-shadow(0 0 3px var(--lcd-glow)); }
.lcd svg .off { fill: var(--lcd-off); }
.lcd.export svg .on { fill: var(--export); filter: drop-shadow(0 0 3px rgba(61, 220, 151, .5)); }
.lcd .unit {
  font-size: 15px;
  font-weight: 500;
  color: var(--ink-2);
  padding-bottom: 4px;
}
.sub {
  font-size: 12.5px;
  color: var(--ink-3);
  margin-top: 6px;
  min-height: 1.2em;
}
.sub.export { color: var(--export); }
.rate {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding: 2px 4px;
  border-radius: 10px;
  flex: none;
}
:host([dir="rtl"]) .rate { align-items: flex-start; }
.rate-val {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  direction: ltr;
}
.rate-unit { font-size: 12.5px; color: var(--ink-3); }

/* ---------- 3D scene ---------- */
.viewport {
  position: relative;
  height: var(--scene-h, 248px);
  perspective: 1100px;
  perspective-origin: 50% 20%;
  overflow: hidden;
  direction: ltr; /* 3D layout is positional, keep it out of RTL */
  cursor: grab;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
}
.viewport.dragging { cursor: grabbing; }
.world {
  position: absolute;
  left: 50%;
  top: 56%;
  width: ${FLOOR_W}px;
  height: ${FLOOR_D}px;
  margin: -${FLOOR_D / 2}px 0 0 -${FLOOR_W / 2}px;
  transform-style: preserve-3d;
  transform: scale(var(--s, 1)) rotateX(var(--rx)) rotateZ(var(--rz));
  transition: transform 500ms cubic-bezier(.2, .8, .2, 1);
}
.viewport.dragging .world { transition: none; }
.world * { transform-style: preserve-3d; }
.floor { position: absolute; inset: 0; }
.floor svg { position: absolute; inset: 0; transform: translateZ(0.5px); }
.slab {
  position: absolute;
  left: 0;
  top: 0;
  background: var(--slab-s);
}
.slab.s { width: ${FLOOR_W}px; height: ${SLAB}px; transform-origin: 0 0; transform: translateY(${FLOOR_D}px) rotateX(-90deg); }
.slab.n { width: ${FLOOR_W}px; height: ${SLAB}px; transform-origin: 0 0; transform: rotateX(-90deg); }
.slab.e { width: ${FLOOR_D}px; height: ${SLAB}px; transform-origin: 0 0; transform: translateX(${FLOOR_W}px) rotateZ(90deg) rotateX(-90deg); background: var(--slab-e); }
.slab.w { width: ${FLOOR_D}px; height: ${SLAB}px; transform-origin: 0 0; transform: rotateZ(90deg) rotateX(-90deg); background: var(--slab-e); }

.box { position: absolute; left: 0; top: 0; }
.f { position: absolute; left: 0; top: 0; transform-origin: 0 0; box-sizing: border-box; }

/* glass tube = 100% of the breaker */
.glass .f {
  background: linear-gradient(to bottom, var(--glass), var(--glass-hi));
  border: 1px solid var(--glass-edge);
}
.glass .f-top { background: var(--glass); }
.glass .f-n::after, .glass .f-s::after, .glass .f-e::after, .glass .f-w::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 80%;
  border-top: 1px dashed var(--warn);
  opacity: 0.55;
}

/* live current fill */
.fill {
  left: 4px;
  top: 4px;
  transform: scaleZ(0.001);
  transform-origin: 0 0 0;
  transition: transform 900ms cubic-bezier(.2, .8, .2, 1);
}
.tower { position: absolute; top: ${TUBE_Y}px; width: ${TUBE}px; height: ${TUBE}px; cursor: pointer; }
.fill .f-s, .fill .f-n {
  background: linear-gradient(to bottom, color-mix(in srgb, var(--c) 45%, #000), var(--c));
}
.fill .f-e, .fill .f-w {
  background: linear-gradient(to bottom, color-mix(in srgb, var(--c) 30%, #000), color-mix(in srgb, var(--c) 75%, #000));
}
.fill .f-top {
  background: color-mix(in srgb, var(--c) 72%, #fff);
  box-shadow: 0 0 22px 2px var(--c);
}
.tower.crit .fill .f-top { animation: pulse 1.1s ease-in-out infinite; }
.tower.empty .glass .f { border-style: dashed; }

.tag {
  position: absolute;
  left: ${TUBE / 2}px;
  top: ${TUBE / 2}px;
  transform: translateZ(${TUBE_H + 10}px) rotateZ(calc(var(--rz) * -1)) rotateX(calc(var(--rx) * -1)) translate(-50%, -100%);
  transition: transform 500ms cubic-bezier(.2, .8, .2, 1);
  white-space: nowrap;
  pointer-events: none;
}
.viewport.dragging .tag { transition: none; }
.tag span {
  display: block;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--tag-bg);
  color: var(--tag-ink);
  border: 1px solid var(--c);
  font-size: 12px;
  font-weight: 600;
  direction: ltr;
  transform-style: flat;
}

/* the meter itself, pale plastic like the real Kaifa */
.meter { left: ${METER.x}px; top: ${METER.y}px; }
.meter .f-top { background: var(--meter-top); }
.meter .f-s { background: var(--meter-s); }
.meter .f-n { background: var(--meter-n); }
.meter .f-e, .meter .f-w { background: var(--meter-e); }
.meter .lcd-win {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 20px;
  height: 18px;
  border-radius: 2px;
  background: var(--lcd-bg);
  overflow: hidden;
}
.meter .lcd-win::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 6px;
  height: 6px;
  width: var(--lcd-fill, 30%);
  background: #9fe8c4;
  opacity: 0.85;
  border-radius: 1px;
  transition: width 600ms ease;
}
.meter .led {
  position: absolute;
  right: 9px;
  bottom: 50px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5a1a1a;
}
.meter .led.on { animation: impulse var(--blink, 4s) linear infinite; }
.meter .terminal {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 14px;
  background: rgba(0, 0, 0, 0.14);
}
.meter .brand {
  position: absolute;
  left: 8px;
  bottom: 52px;
  width: 18px;
  height: 3px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 1px;
}

/* floor drawing */
.floor .plate { fill: var(--floor); stroke: var(--floor-edge); stroke-width: 1; }
.floor .gridline { stroke: var(--grid); stroke-width: 1; }
.floor .duct { fill: none; stroke: var(--floor-edge); stroke-width: 4.5; stroke-linecap: round; stroke-linejoin: round; opacity: .8; }
.floor .flow {
  fill: none;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 3 11;
  animation: flow var(--flow, 3s) linear infinite;
}
.floor .flow.idle { animation: none; opacity: .25; }
.floor .flow.reverse { animation-direction: reverse; }

@keyframes flow { to { stroke-dashoffset: -28; } }
@keyframes impulse {
  0%, 9% { background: #ff3b3b; box-shadow: 0 0 8px 2px rgba(255, 59, 59, .8); }
  10%, 100% { background: #5a1a1a; box-shadow: none; }
}
@keyframes pulse { 50% { box-shadow: 0 0 34px 8px var(--c); } }

/* offline */
.stage.offline .viewport { opacity: 0.35; }
.notice {
  display: none;
  padding: 0 18px 4px;
  font-size: 13px;
  color: var(--ink-2);
}
.notice b { display: block; color: var(--ink); font-weight: 600; }
.stage.offline .notice { display: block; }

/* ---------- phase legend ---------- */
.phases {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 2px 14px 12px;
}
.ph {
  display: grid;
  grid-template-columns: 3px 1fr;
  column-gap: 9px;
  padding: 6px 6px;
  border-radius: 10px;
}
.ph .bar { grid-row: 1 / span 3; border-radius: 2px; background: var(--c); }
.ph .name { font-size: 12px; color: var(--ink-3); }
.ph .amps { font-size: 18px; font-weight: 600; direction: ltr; text-align: start; }
:host([dir="rtl"]) .ph .amps { text-align: right; }
.ph .amps small { font-size: 12px; font-weight: 500; color: var(--ink-3); }
.ph .amps.warn { color: var(--warn); }
.ph .amps.crit { color: var(--crit); }
.ph .volts { font-size: 12px; color: var(--ink-2); direction: ltr; }
:host([dir="rtl"]) .ph .volts { text-align: right; }

/* ---------- money ---------- */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid var(--rule);
}
.stat {
  padding: 12px 8px 14px;
  text-align: center;
  border-radius: 0;
}
.stat + .stat { border-inline-start: 1px solid var(--rule); }
.stat .v { display: block; font-size: 17px; font-weight: 600; direction: ltr; }
.stat .k { display: block; font-size: 12px; color: var(--ink-3); margin-top: 2px; }
.stat .v.up { color: var(--crit); }
.stat .v.down { color: var(--export); }
.stat .v.na { color: var(--ink-3); font-weight: 500; }

.ph .amps { white-space: nowrap; }
@container (max-width: 360px) {
  .ph .amps { font-size: 16px; }
  .ph .amps small { display: none; }
  .head { padding: 14px 14px 0; }
  .phases { padding: 2px 8px 10px; gap: 4px; }
}
@container (max-width: 300px) {
  .stats { grid-template-columns: repeat(2, 1fr); }
  .stat:nth-child(3) { border-inline-start: 0; }
  .stat:nth-child(n + 3) { border-top: 1px solid var(--rule); }
}
@media (prefers-reduced-motion: reduce) {
  .world, .tag, .fill, .meter .lcd-win::after { transition: none !important; }
  .floor .flow, .meter .led.on, .tower.crit .fill .f-top { animation: none !important; }
}
`;

class IecP13dCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = { ...DEFAULT_VIEW };
    this._built = false;
    this._risen = false;
  }

  static getStubConfig() {
    return {};
  }

  static getConfigForm() {
    const ent = (name) => ({ name, selector: { entity: { domain: name === "breaker" ? ["number", "input_number", "sensor"] : "sensor" } } });
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        {
          name: "breaker_amps",
          selector: { number: { min: 6, max: 125, step: 1, mode: "box", unit_of_measurement: "A" } },
        },
        {
          name: "language",
          selector: { select: { mode: "dropdown", options: [{ value: "he", label: "עברית" }, { value: "en", label: "English" }] } },
        },
        {
          name: "style",
          selector: { select: { mode: "dropdown", options: [{ value: "gold", label: "Gold" }, { value: "classic", label: "Classic" }] } },
        },
        { name: "meter_prefix", selector: { text: {} } },
        {
          type: "expandable",
          name: "entities",
          title: "Entities",
          schema: ENTITY_KEYS.map(ent),
        },
      ],
      computeLabel: (s) =>
        ({
          title: "Title",
          breaker_amps: "Breaker per phase (empty = read from the reader)",
          language: "Language",
          style: "Style",
          meter_prefix: "Meter entity prefix (default sensor.electricity_meter)",
        })[s.name] ?? s.name,
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    if (config.breaker_amps !== undefined && !(Number(config.breaker_amps) > 0)) {
      throw new Error("breaker_amps must be a positive number");
    }
    this._config = { ...config };
    this._lang = config.language === "en" ? "en" : config.language === "he" ? "he" : null;
    this._entities = { ...defaultEntities(config.meter_prefix), ...(config.entities || {}) };
    this._built = false;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._render();
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: 12, rows: 8, min_columns: 6, min_rows: 7 };
  }

  connectedCallback() {
    if (this._ro) this._ro.observe(this);
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
  }

  /* ---------- state helpers ---------- */
  _t() {
    // Hebrew by default; set `language: en` for English.
    return STRINGS[this._lang || "he"];
  }

  _num(key) {
    const id = this._entities[key];
    const st = id && this._hass?.states?.[id];
    if (!st) return NaN;
    let v = parseFloat(st.state);
    if (!Number.isFinite(v)) return NaN;
    const unit = st.attributes?.unit_of_measurement;
    if (unit === "W" && /power/.test(key)) v /= 1000;
    return v;
  }

  _attr(key, attr) {
    const id = this._entities[key];
    return id && this._hass?.states?.[id]?.attributes?.[attr];
  }

  _money(v, digits) {
    if (!isNum(v)) return "—";
    const n = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return `${v < 0 ? "−" : ""}₪${n}`;
  }

  _fixed(v, d) {
    return isNum(v) ? v.toFixed(d) : "—";
  }

  _more(key) {
    const entityId = this._entities[key];
    if (!entityId || !this._hass?.states?.[entityId]) return;
    const ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId };
    this.dispatchEvent(ev);
  }

  /* ---------- build once ---------- */
  _build() {
    const look = this._config.style === "classic" ? "classic" : "gold";
    this.setAttribute("look", look);
    PHASE_COLORS = PALETTES[look];
    this._colors = PHASE_COLORS;
    const t = this._t();
    const rtl = t === STRINGS.he;
    this.setAttribute("dir", rtl ? "rtl" : "ltr");

    // In RTL, phase 1 sits on the right, matching the legend order below.
    this._order = rtl ? [2, 1, 0] : [0, 1, 2];

    const towers = [0, 1, 2]
      .map((i) => {
        const x = TUBE_X[this._order.indexOf(i)];
        return `<div class="tower" data-i="${i}" style="left:${x}px;--c:${PHASE_COLORS[i]}">
          ${boxHTML("glass", TUBE, TUBE, TUBE_H)}
          ${boxHTML("fill", TUBE - 8, TUBE - 8, TUBE_H)}
          <div class="tag"><span>—</span></div>
        </div>`;
      })
      .join("");

    const grid = [];
    for (let x = 20; x < FLOOR_W; x += 20) grid.push(`<line class="gridline" x1="${x}" y1="6" x2="${x}" y2="${FLOOR_D - 6}"/>`);
    for (let y = 20; y < FLOOR_D; y += 20) grid.push(`<line class="gridline" x1="6" y1="${y}" x2="${FLOOR_W - 6}" y2="${y}"/>`);

    // Three conductors leave the meter as a small bus and branch to each phase.
    const ducts = [0, 1, 2].map((i) => {
      const slot = this._order.indexOf(i);
      const cx = TUBE_X[slot] + TUBE / 2;
      const sx = METER.x + 12 + slot * 9;
      const lane = TUBE_Y + TUBE + 14 + slot * 8;
      return `M${sx} ${METER.y + METER.d + 2} V ${lane} H ${cx} V ${TUBE_Y + TUBE + 2}`;
    });

    const glows = [0, 1, 2]
      .map((i) => {
        const cx = TUBE_X[this._order.indexOf(i)] + TUBE / 2;
        return `<ellipse class="glow" data-i="${i}" cx="${cx}" cy="${TUBE_Y + TUBE / 2}" rx="44" ry="40" fill="url(#g${i})" opacity="0"/>`;
      })
      .join("");

    const defs = PHASE_COLORS.map(
      (c, i) => `<radialGradient id="g${i}"><stop offset="0" stop-color="${c}" stop-opacity=".55"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`
    ).join("");

    const meterFront = `<div class="terminal"></div><div class="brand"></div><div class="led"></div><div class="lcd-win"></div>`;

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="card">
          <div class="stage">
            <div class="head">
              <div class="readout">
                <div class="title"></div>
                <button class="lcd" data-k="power" type="button"></button>
                <div class="sub"></div>
              </div>
              <button class="rate" data-k="cost_now" type="button">
                <span class="rate-val">—</span>
                <span class="rate-unit">${t.perHour}</span>
              </button>
            </div>
            <div class="notice"><b>${t.noData}</b>${t.noDataHint}</div>
            <div class="viewport" tabindex="0" role="img">
              <div class="world">
                <div class="slab n"></div><div class="slab w"></div>
                <div class="slab s"></div><div class="slab e"></div>
                <div class="floor">
                  <svg viewBox="0 0 ${FLOOR_W} ${FLOOR_D}" width="${FLOOR_W}" height="${FLOOR_D}">
                    <defs>${defs}</defs>
                    <rect class="plate" x="0.5" y="0.5" width="${FLOOR_W - 1}" height="${FLOOR_D - 1}" rx="6"/>
                    ${grid.join("")}
                    ${glows}
                    ${ducts.map((d) => `<path class="duct" d="${d}"/>`).join("")}
                    ${ducts.map((d, i) => `<path class="flow idle" data-i="${i}" d="${d}" stroke="${PHASE_COLORS[i]}"/>`).join("")}
                  </svg>
                </div>
                ${boxHTML("meter", METER.w, METER.d, METER.h, { s: meterFront })}
                ${towers}
              </div>
            </div>
          </div>
          <div class="phases">
            ${[0, 1, 2]
              .map(
                (i) => `<button class="ph" data-i="${i}" data-k="current_l${i + 1}" type="button" style="--c:${PHASE_COLORS[i]}">
                  <span class="bar"></span>
                  <span class="name">${t.phase(i + 1)}</span>
                  <span class="amps">—</span>
                  <span class="volts">—</span>
                </button>`
              )
              .join("")}
          </div>
          <div class="stats">
            <button class="stat" data-k="cost_today" type="button"><span class="v">—</span><span class="k">${t.today}</span></button>
            <button class="stat" data-k="cost_month" type="button"><span class="v">—</span><span class="k">${t.month}</span></button>
            <button class="stat" data-k="forecast" type="button"><span class="v">—</span><span class="k">${t.forecast}</span></button>
            <button class="stat" data-k="vs_yesterday" type="button"><span class="v">—</span><span class="k">${t.vsYesterday}</span></button>
          </div>
        </div>
      </ha-card>`;

    const root = this.shadowRoot;
    this._el = {
      stage: root.querySelector(".stage"),
      title: root.querySelector(".title"),
      lcd: root.querySelector(".lcd"),
      sub: root.querySelector(".sub"),
      rate: root.querySelector(".rate-val"),
      viewport: root.querySelector(".viewport"),
      world: root.querySelector(".world"),
      towers: [...root.querySelectorAll(".tower")].sort((a, b) => a.dataset.i - b.dataset.i),
      flows: [...root.querySelectorAll(".flow")],
      glows: [...root.querySelectorAll(".glow")].sort((a, b) => a.dataset.i - b.dataset.i),
      led: root.querySelector(".meter .led"),
      lcdWin: root.querySelector(".meter .lcd-win"),
      phases: [...root.querySelectorAll(".ph")],
      stats: Object.fromEntries([...root.querySelectorAll(".stat")].map((b) => [b.dataset.k, b.querySelector(".v")])),
    };

    root.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => this._more(b.dataset.k)));
    this._el.towers.forEach((tw) => tw.addEventListener("click", (e) => {
      if (this._dragMoved) return;
      e.stopPropagation();
      this._more(`current_l${+tw.dataset.i + 1}`);
    }));

    this._bindRotate();
    this._applyView();

    if (!this._ro) {
      this._ro = new ResizeObserver(() => this._fit());
      this._ro.observe(this);
    }
    this._fit();
    this._built = true;
  }

  _fit() {
    if (!this._el) return;
    const w = this._el.viewport.clientWidth || 400;
    const s = clamp(w / 470, 0.62, 1.1);
    this._el.viewport.style.setProperty("--s", s.toFixed(3));
    this._el.viewport.style.setProperty("--scene-h", `${Math.round(248 * clamp(s / 0.94, 0.8, 1.15))}px`);
  }

  _applyView() {
    const v = this._el.viewport;
    v.style.setProperty("--rx", `${this._view.rx}deg`);
    v.style.setProperty("--rz", `${this._view.rz}deg`);
  }

  _bindRotate() {
    const vp = this._el.viewport;
    let start = null;
    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, rx: this._view.rx, rz: this._view.rz };
      this._dragMoved = false;
    });
    vp.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!this._dragMoved && Math.hypot(dx, dy) < 4) return;
      if (!this._dragMoved) {
        this._dragMoved = true;
        vp.setPointerCapture(e.pointerId);
        vp.classList.add("dragging");
      }
      this._view.rz = clamp(start.rz + dx * 0.4, -120, 60);
      this._view.rx = clamp(start.rx - dy * 0.25, 30, 74);
      this._applyView();
    });
    const end = () => {
      start = null;
      vp.classList.remove("dragging");
      setTimeout(() => (this._dragMoved = false), 0);
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("dblclick", () => {
      this._view = { ...DEFAULT_VIEW };
      this._applyView();
    });
    vp.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 15 : 5;
      if (e.key === "ArrowLeft") this._view.rz = clamp(this._view.rz - step, -120, 60);
      else if (e.key === "ArrowRight") this._view.rz = clamp(this._view.rz + step, -120, 60);
      else if (e.key === "ArrowUp") this._view.rx = clamp(this._view.rx - step, 30, 74);
      else if (e.key === "ArrowDown") this._view.rx = clamp(this._view.rx + step, 30, 74);
      else if (e.key === "Home" || e.key === "Escape") this._view = { ...DEFAULT_VIEW };
      else return;
      e.preventDefault();
      this._applyView();
    });
  }

  /* ---------- update on every state change ---------- */
  _changed() {
    // hass is replaced on every state change in the whole system; only redraw
    // when one of our entities (or the theme) actually changed.
    const objs = ENTITY_KEYS.map((k) => this._hass.states[this._entities[k]]);
    objs.push(this._hass.themes?.darkMode);
    const prev = this._lastObjs;
    this._lastObjs = objs;
    return !prev || objs.some((o, i) => o !== prev[i]);
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (this._built && !this._changed()) return;
    const dark = this._hass.themes?.darkMode;
    this.setAttribute("theme", dark === false ? "light" : "dark");
    if (!this._built) { this._build(); this._changed(); }

    const t = this._t();
    const el = this._el;
    const fromReader = this._num("breaker");
    const amps = Number(this._config.breaker_amps) || (fromReader > 0 ? fromReader : 25);

    el.title.textContent = this._config.title ?? t.title;

    const power = this._num("power");
    const exp = this._num("power_export");
    const exporting = isNum(exp) && exp > 0.005 && (!isNum(power) || power < 0.005);
    const offline = !isNum(power) && !isNum(exp);
    el.stage.classList.toggle("offline", offline);

    // Seven-segment total: imported power, or exported power with a minus sign.
    const shown = exporting ? -exp : power;
    const txt = isNum(shown)
      ? Math.abs(shown) >= 100 ? shown.toFixed(0) : Math.abs(shown) >= 10 ? shown.toFixed(1) : shown.toFixed(2)
      : "----";
    const key = `${txt}|${exporting}`;
    if (key !== this._lcdKey) {
      this._lcdKey = key;
      el.lcd.innerHTML = `${sevenSeg(isNum(shown) ? txt : "    ", 5)}<span class="unit">kW</span>`;
      el.lcd.classList.toggle("export", exporting);
      el.lcd.setAttribute("aria-label", `${exporting ? t.exporting : t.now}: ${isNum(shown) ? Math.abs(shown).toFixed(2) : "—"} kW`);
    }

    // Line under the display: peak today, or that we're exporting.
    el.sub.classList.toggle("export", exporting);
    if (exporting) {
      el.sub.textContent = t.exporting;
    } else {
      const peak = this._num("peak");
      const pt = this._hass.states[this._entities.peak_time]?.state;
      const time = /^\d{1,2}:\d{2}$/.test(pt || "") ? pt : this._attr("peak", "peak_time");
      el.sub.textContent = isNum(peak) ? t.peak(peak.toFixed(2), time) : "";
    }

    el.rate.textContent = this._money(this._num("cost_now"), 2);

    // Towers: fill = live current against the breaker.
    const labels = [];
    for (let i = 0; i < 3; i++) {
      const n = i + 1;
      const cur = this._num(`current_l${n}`);
      const pw = this._num(`power_l${n}`);
      const volt = this._num(`voltage_l${n}`);
      const ratio = isNum(cur) ? cur / amps : NaN;
      const r = isNum(ratio) ? clamp(ratio, 0, 1.04) : 0;
      const level = !isNum(ratio) ? "empty" : ratio >= 0.95 ? "crit" : ratio >= 0.8 ? "warn" : "ok";

      const tw = el.towers[i];
      const color = level === "crit" ? CRIT : level === "warn" ? WARN : this._colors[i];
      tw.style.setProperty("--c", color);
      tw.classList.toggle("crit", level === "crit");
      tw.classList.toggle("empty", level === "empty");
      const fill = tw.querySelector(".fill");
      const z = Math.max(0.001, r).toFixed(3);
      if (!this._risen) {
        // First paint: start at the floor, then rise to the live value.
        requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.transform = `scaleZ(${z})`)));
      } else {
        fill.style.transform = `scaleZ(${z})`;
      }
      tw.querySelector(".tag span").textContent = isNum(pw) ? `${pw.toFixed(2)} kW` : "—";

      el.glows[i].setAttribute("opacity", (isNum(ratio) ? 0.12 + 0.75 * clamp(ratio, 0, 1) : 0).toFixed(2));

      const flow = el.flows[i];
      const live = isNum(pw) ? Math.abs(pw) : 0;
      const dur = clamp(5 / (live + 0.08), 0.5, 14);
      flow.classList.toggle("idle", live < 0.02);
      flow.classList.toggle("reverse", exporting);
      flow.setAttribute("stroke", exporting ? EXPORT : this._colors[i]);
      const durTxt = `${dur.toFixed(1)}s`;
      if (flow.style.getPropertyValue("--flow") !== durTxt) flow.style.setProperty("--flow", durTxt);

      const ph = el.phases[i];
      const ampsEl = ph.querySelector(".amps");
      ampsEl.innerHTML = isNum(cur) ? `${cur.toFixed(1)} A <small>/ ${amps}</small>` : "—";
      ampsEl.classList.toggle("warn", level === "warn");
      ampsEl.classList.toggle("crit", level === "crit");
      ph.querySelector(".volts").textContent = isNum(volt) ? `${volt.toFixed(0)} V` : "—";
      ph.title = isNum(ratio) ? t.ofBreaker(Math.round(ratio * 100)) : "";

      labels.push(`${t.phase(n)} ${isNum(cur) ? cur.toFixed(1) + " A" : "—"}`);
    }
    this._risen = true;
    el.viewport.setAttribute("aria-label", t.sceneLabel(labels.join(", ")));

    // Meter: impulse LED blinks like the real one (1000 imp/kWh).
    const flowKw = exporting ? exp : power;
    if (isNum(flowKw) && flowKw > 0.01) {
      const period = clamp(3.6 / flowKw, 0.25, 20);
      el.led.classList.add("on");
      const p = `${period.toFixed(2)}s`;
      if (el.led.style.getPropertyValue("--blink") !== p) el.led.style.setProperty("--blink", p);
    } else {
      el.led.classList.remove("on");
    }
    const totalCap = (amps * 3 * 230) / 1000;
    el.lcdWin.style.setProperty("--lcd-fill", `${(clamp((flowKw || 0) / totalCap, 0.04, 1) * 82).toFixed(0)}%`);

    // Money row.
    el.stats.cost_today.textContent = this._money(this._num("cost_today"), 1);
    el.stats.cost_month.textContent = this._money(this._num("cost_month"), 0);
    el.stats.forecast.textContent = this._money(this._num("forecast"), 0);

    const vs = this._num("vs_yesterday");
    const vsEl = el.stats.vs_yesterday;
    vsEl.classList.remove("up", "down", "na");
    if (!isNum(vs)) {
      vsEl.textContent = "—";
      vsEl.classList.add("na");
      vsEl.parentElement.title = t.needDay;
    } else {
      const r = Math.round(vs);
      vsEl.textContent = Math.abs(r) <= 5 ? "≈" : `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
      if (r > 5) vsEl.classList.add("up");
      else if (r < -5) vsEl.classList.add("down");
      vsEl.parentElement.title = Math.abs(r) <= 5 ? t.sameAsYesterday : `${r > 0 ? "+" : ""}${r}%`;
    }
  }
}

if (!customElements.get(TAG)) {
  customElements.define(TAG, IecP13dCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: TAG,
    name: "IEC P1 3D",
    description: "Three-phase meter in 3D: load per phase against the breaker, live power and cost.",
    preview: true,
    documentationURL: "https://github.com/mp3llll/iec-p1-esphome-3phase",
  });
  console.info(`%c IEC-P1-3D-CARD %c ${CARD_VERSION} `, "background:#2ec5f0;color:#000;border-radius:3px 0 0 3px;padding:2px 4px", "background:#1d2836;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");
}
