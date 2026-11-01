// Minimal stand-in for the ESPHome web_server, for previewing esphome/ui/app.js.
// node tests/ui/mock_device.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = +process.argv[2] || 8790;
const APP = path.join(__dirname, "../../esphome/ui/app.js");
const PORTAL = path.join(__dirname, "../../esphome/ui/portal.html");

// Same shell ESPHome builds for version 3 with js_include and js_url: ""
const INDEX = "<!DOCTYPE html><html><head><meta charset=UTF-8><link rel=icon href=data:></head><body><script type=module src=/0.js></script><esp-app></esp-app></body></html>";

const S = (id, value, extra = {}) => ({ id, value, state: typeof value === "number" ? String(value) : value, ...extra });
const plans = [
  "ללא הנחה", "מותאם אישית",
  "סלקום – 7% קבוע", "סלקום – לילה", "פרטנר – 6% קבוע", "פרטנר – יום",
  "בזק – לילה", "פזגז – 7% קבוע", "פזגז – ערב", "אלקטרה פאוור – יום",
];
const state = {};
for (const s of [
  S("sensor/Power", 4.39), S("sensor/Power Export", 0),
  S("sensor/Power L1", 0.34), S("sensor/Power L2", 2.94), S("sensor/Power L3", 1.11),
  S("sensor/Current L1", 1.8), S("sensor/Current L2", 21.4), S("sensor/Current L3", 5.0),
  S("sensor/Voltage L1", 226.4), S("sensor/Voltage L2", 225.1), S("sensor/Voltage L3", 225.3),
  S("sensor/Cost Now", 2.65), S("sensor/Cost Today", 14.62), S("sensor/Cost Month", 17.8),
  S("sensor/Forecast Month", 512.4), S("sensor/Energy Today", 23.4), S("sensor/Compared To Yesterday", 12),
  S("sensor/Peak Today", 6.21), S("text_sensor/Peak Time", "19:42"),
  S("sensor/Baseload", 0.18), S("sensor/Baseload Cost", 79),
  S("sensor/Price", 0.6034), S("sensor/Discount", 7), S("text_sensor/Discount Window", ""),
  S("select/Supplier Plan", "פזגז – 7% קבוע", { option: plans }),
  S("number/Base Price", "0.6488", { min_value: "0", max_value: "5", step: "0.0001" }),
  S("number/Fixed Charge", "33.69", { min_value: "0", max_value: "500", step: "0.01" }),
  S("number/Breaker Size", "25", { min_value: "6", max_value: "125", step: "1" }),
  S("number/Custom Discount", "0"), S("number/Custom Window Discount", "20"),
  S("number/Custom Window Start", "23"), S("number/Custom Window End", "7"),
  S("switch/Custom Window Sun-Thu Only", false, { state: "OFF" }),
  S("binary_sensor/P1 Data", true, { state: "ON" }), S("sensor/P1 CRC Errors", 0),
  S("sensor/WiFi Signal", -58), S("text_sensor/IP Address", "10.0.0.87"), S("sensor/Uptime", 273600),
  S("update/Firmware", "2.1.0", { state: "UPDATE AVAILABLE", current_version: "2.0.0", title: "IEC P1 3-phase", summary: "תמיכה במסלולי ערב, תיקון השוואה לאתמול." }),
]) state[s.id] = s;

const clients = new Set();
function send(res, ev, data) { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); }

setInterval(() => {
  // jiggle live values so the page looks alive
  const j = (id, base, amp) => { state[id].value = +(base + (Math.random() - 0.5) * amp).toFixed(2); state[id].state = String(state[id].value); };
  j("sensor/Power L2", 2.94, 0.2); j("sensor/Current L2", 21.4, 0.8);
  for (const c of clients) { send(c, "state", state["sensor/Power L2"]); send(c, "state", state["sensor/Current L2"]); send(c, "ping", { title: "Electricity meter" }); }
}, 3000);

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" && req.method === "GET") { res.writeHead(200, { "content-type": "text/html" }); return res.end(INDEX); }
  if (url.pathname === "/0.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(fs.readFileSync(APP)); }
  if (url.pathname === "/portal") { res.writeHead(200, { "content-type": "text/html" }); return res.end(fs.readFileSync(PORTAL)); }
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ mac: "A0:B7:65:12:34:56", name: "electricity-meter-123456", aps: [{}, { ssid: "Peer-Home", rssi: -48, lock: 1 }, { ssid: "Peer-Home-Ext", rssi: -66, lock: 1 }, { ssid: "Guests", rssi: -71, lock: 0 }, { ssid: "Neighbor 5G", rssi: -84, lock: 1 }] }));
  }
  if (url.pathname === "/wifisave") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("Saved. Connecting..."); }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    send(res, "ping", { title: "Electricity meter", ota: true, lang: "en" });
    for (const s of Object.values(state)) send(res, "state", s);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "POST") {
    if (url.pathname === "/update") { req.resume(); req.on("end", () => { res.writeHead(200); res.end("Update Successful!"); }); return; }
    const [, domain, name, action] = url.pathname.split("/").map(decodeURIComponent);
    const id = `${domain}/${name}`;
    const s = state[id];
    if (!s) { res.writeHead(404); return res.end(); }
    if (action === "set" && url.searchParams.has("value")) { s.value = url.searchParams.get("value"); s.state = s.value; }
    if (action === "set" && url.searchParams.has("option")) { s.value = s.state = url.searchParams.get("option"); }
    if (action === "turn_on" || action === "turn_off") { s.value = action === "turn_on"; s.state = s.value ? "ON" : "OFF"; }
    for (const c of clients) send(c, "state", s);
    res.writeHead(200); return res.end();
  }
  res.writeHead(404); res.end();
}).listen(port, () => console.log(`mock device on http://localhost:${port}`));
