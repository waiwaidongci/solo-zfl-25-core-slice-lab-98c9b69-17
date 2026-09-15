// Browser-level retest without a browser binary: extract the REAL inline <script>
// from the micro workbench page and run it in a minimal DOM/Canvas/Image sandbox
// whose fetch is forwarded to the live server. Replays the native event sequence
// a browser produces when closing an area with a double-click:
//   click v1, click v2, click v3, click(v3 again), dblclick
// (a dblclick dispatches a trailing click that used to duplicate the endpoint).
import vm from "node:vm";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let base = process.env.BASE || `http://127.0.0.1:${3000 + Math.floor(Math.random() * 500)}`;
let server = null;
let dataDir = null;

async function ensureServer() {
  // Reuse an externally provided server (BASE env); otherwise spawn an isolated one.
  try {
    const r = await fetch(base + "/api/samples");
    if (r.ok) return;
  } catch { /* spawn */ }
  dataDir = await mkdtemp(join(os.tmpdir(), "corelab-browser-"));
  const port = Number(new URL(base).port);
  server = spawn(process.execPath, [join(root, "server.js")], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + "/api/samples")).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("harness server failed to start");
}

async function setupSlice() {
  const id = "S-BROWSER";
  await fetch(base + "/api/samples", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "browser", borehole: "b", coreBox: "c", depth: "d", owner: "o", sliceId: id, method: "m" })
  });
  await fetch(base + `/api/slices/${id}/calibration`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ magnification: 100, scaleLengthUm: 100, scalePixels: 200, rows: 2, cols: 2, overlap: 25 })
  });
  for (const rc of ["0-0", "0-1", "1-0", "1-1"]) {
    const buf = await readFile(join(__dirname, "..", "data", "fixtures", "good", `${rc}.png`));
    const r = await fetch(base + `/api/slices/${id}/tiles/${rc}`, { method: "PUT", body: buf });
    if (r.status !== 201) throw new Error("upload " + rc + " " + r.status);
  }
  await fetch(base + `/api/slices/${id}/stitch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  });
  return id;
}

function makeCtx() {
  const noop = () => {};
  return {
    drawImage: noop, beginPath: noop, arc: noop, fill: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fillRect: noop, fillText: noop,
    set lineWidth(_) {}, set strokeStyle(_) {}, set fillStyle(_) {}, set font(_) {}
  };
}

function makeEl(id) {
  const listeners = {};
  const el = {
    id, value: "", innerHTML: "", textContent: "", dataset: {}, style: {},
    options: [], files: [],
    classList: { toggle: noop2, add: noop2, remove: noop2 },
    onclick: null, onchange: null, onsubmit: null,
    appendChild() {}, remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(t, cb) { (listeners[t] ||= []).push(cb); },
    dispatch(t, evt) { return (listeners[t] || []).map(cb => cb(evt)); },
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: el.width || 560, height: el.height || 560 }),
    width: 560, height: 560
  };
  return el;
}
function noop2() {}

async function main() {
  await ensureServer();
  try {
    await run();
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await new Promise(r => server.on("exit", r));
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });

async function run() {
  const sliceId = await setupSlice();
  const pageMod = await import("../lib/micro-page.js");
  const html = pageMod.microPage;
  const script = html.split("<script>")[1].split("</script>")[0];

  const ids = ["sliceSelect", "reload", "magnification", "scaleLengthUm", "scalePixels",
    "rows", "cols", "overlap", "umPerPx", "saveCalib", "fieldGrid", "alerts",
    "stitchBtn", "clearMosaic", "mosaicCanvas", "mosaicMeta", "measureHint",
    "cancelTool", "measureRows", "form", "samples", "stats", "sliceInfo", "viewer"];
  const byId = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
  byId["sliceSelect"].value = sliceId; // come in via ?slice=<id> equivalent
  const toolButtons = ["point", "line", "area"].map(t => {
    const b = makeEl("tool-" + t); b.dataset.tool = t; return b;
  });

  const captured = { area: null };
  const realFetch = fetch;
  const sandboxFetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === "POST" && u.endsWith("/measurements")) {
      captured.area = JSON.parse(opts.body);
    }
    return realFetch(u.startsWith("http") ? u : base + u, opts);
  };

  function FakeImage() {
    return {
      set src(v) { setTimeout(() => this.onload && this.onload(), 0); },
      get src() { return ""; },
      onload: null, width: 560, height: 560 // real 2x2 mosaic dimensions
    };
  }

  const sandbox = {
    console, setTimeout, clearTimeout, Math, JSON, Date, Promise, fetch: sandboxFetch,
    URLSearchParams, encodeURIComponent,
    location: { search: "" },
    window: { innerWidth: 1200, innerHeight: 800 },
    Image: FakeImage,
    document: {
      querySelector: sel => sel.startsWith("#") ? byId[sel.slice(1)] : null,
      querySelectorAll: sel => sel === "[data-tool]" ? toolButtons : [],
      createElement: () => makeEl("dyn")
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: "micro-page-inline.js" });

  await sleep(300); // let init() load samples/micro/mosaic

  const canvas = byId["mosaicCanvas"];
  // pick the area tool like a user clicking its button
  toolButtons.find(b => b.dataset.tool === "area").onclick();

  const click = (x, y) => canvas.dispatch("click", { clientX: x, clientY: y });
  // three distinct vertices, then the trailing click a dblclick emits, then dblclick
  click(10, 10); click(100, 10); click(10, 100);
  click(10, 100); // duplicate of the last vertex — must be ignored
  await sleep(20);
  canvas.dispatch("dblclick", { clientX: 10, clientY: 100 });
  await sleep(300);

  check("页面提交的面积顶点数为 3（终点未重复）",
    captured.area && captured.area.type === "area" && captured.area.points.length === 3,
    JSON.stringify(captured.area));
  check("三个顶点坐标正确且互不相同", !!captured.area && (() => {
    const p = captured.area.points;
    return p.length === 3 &&
      JSON.stringify(p) === JSON.stringify([{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 10, y: 100 }]);
  })(), JSON.stringify(captured.area?.points));

  const res = await (await fetch(base + `/api/slices/${sliceId}/measurements`)).json();
  const area = res.find(m => m.type === "area");
  check("服务端落库面积仅 3 个像素顶点", area && area.pixels.length === 3, JSON.stringify(area?.pixels));
  check("面积值正确 (4050 px²: base 90 × height 90 / 2)", area && area.pixelArea === 4050, String(area?.pixelArea));

  // point tool still works after area flow
  toolButtons.find(b => b.dataset.tool === "point").onclick();
  click(50, 60);
  await sleep(200);
  const res2 = await (await fetch(base + `/api/slices/${sliceId}/measurements`)).json();
  check("点工具流程不受影响", res2.some(m => m.type === "point" && m.pixels.x === 50 && m.pixels.y === 60));

  console.log(`\n浏览器事件复测: ${passed} 通过, ${failed} 失败`);
  if (failed) throw new Error("browser harness checks failed");
}
