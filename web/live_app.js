// Live service area: click (or hover) on the map. WebGPU (web/client/gpu.js) solves the shortest paths in fp32,
// GEOS (WebAssembly, web/client/geom.js) builds the real polygon with the Builder rules. The panel shows the time
// of the calculation only. The fp32 against Float64 check is in web/client/bench_gpu.html.
import { ServiceArea } from "./client/sa.js";
import { GpuSssp } from "./client/gpu.js";
import { polygon, prepare, rings } from "./client/geom.js";
import { gpuSolveMany } from "./client/planner.js";

const [Graphic, GraphicsLayer, Polygon, Polyline, projectOperator] = await $arcgis.import([
  "@arcgis/core/Graphic.js",
  "@arcgis/core/layers/GraphicsLayer.js",
  "@arcgis/core/geometry/Polygon.js",
  "@arcgis/core/geometry/Polyline.js",
  "@arcgis/core/geometry/operators/projectOperator.js",
]);

const view = document.querySelector("arcgis-map");
const hud = document.getElementById("hud");
const minutes = () => Number(document.querySelector("input[name=min]:checked").value);
const mode = () => document.querySelector("input[name=mode]:checked").value;
const result = (window.liveResult = { solves: 0 });

await view.viewOnReady();
const layer = new GraphicsLayer({ title: "Service area" });
view.map.add(layer);
const area = new Graphic({ symbol: { type: "simple-fill", color: [0, 110, 200, 0.25], outline: { color: [0, 80, 160, 0.9], width: 1.5 } } });
const pin = new Graphic({ symbol: { type: "simple-marker", color: [255, 200, 0], size: 9, outline: { color: [60, 40, 0], width: 1 } } });
layer.addMany([area, pin]);

let sa, gpu = null, geos, engine;
try {
  hud.textContent = "Loading street data, GEOS and WebGPU…";
  [sa, geos] = await Promise.all([ServiceArea.load("data/adams"), import("geos-wasm").then((m) => m.default()), projectOperator.projectLoad()]);
  prepare(sa, geos); // nearest-street cells: about 2.5 s once, here and not at the first click
  try {
    gpu = await GpuSssp.create(sa, 1);
    engine = `WebGPU (${gpu.info.vendor ?? "?"} ${gpu.info.architecture ?? ""})`.replace(" )", ")");
  } catch (err) {
    engine = `CPU, no WebGPU: ${err.message}`;
  }
  result.engine = engine;
  hud.textContent = `${engine}\nClick on the map.`;
} catch (err) {
  hud.textContent = `Error: ${err.message}`;
  throw err;
}

async function solve(pt) {
  const B = minutes(), t0 = performance.now();
  pin.geometry = pt;
  const s = sa.snap(pt.x, pt.y); // the view is Web Mercator
  if (!s) { area.geometry = null; hud.textContent = `${engine}\nNot located: more than 5 km from a street.`; return; }
  let t = performance.now();
  if (gpu) {
    let d;
    try {
      d = await gpuSolveMany(sa, gpu)([s], B);
    } catch (err) { // e.g. device lost after start: stay usable on the CPU
      gpu = null;
      engine = `CPU, WebGPU failed: ${err.message}`;
      result.engine = engine;
    }
    if (d) sa.setDist(d, 0, s.edge, s.frac); else sa.solve(s.edge, s.frac, B);
  } else sa.solve(s.edge, s.frac, B);
  sa.flags(B);
  const solveMs = performance.now() - t;

  t = performance.now();
  const g = polygon(sa, geos);
  const polys = rings(geos, g); // EPSG:3735, Esri ring order
  geos.GEOSGeom_destroy(g);
  const geosMs = performance.now() - t;
  // rings as polyline paths keep one path per ring through the projection; then rebuild the polygon
  const paths = projectOperator.projectExecute(new Polyline({ paths: polys.flat(), spatialReference: { wkid: 3735 } }), view.spatialReference).paths;
  area.geometry = polys.length ? new Polygon({ rings: paths, spatialReference: view.spatialReference }) : null;
  const totalMs = performance.now() - t0;
  Object.assign(result, { solves: result.solves + 1, B, solveMs, geosMs, totalMs });
  hud.textContent = `${engine}\nsolve ${solveMs.toFixed(1)} ms · polygon ${geosMs.toFixed(1)} ms · total ${totalMs.toFixed(1)} ms`;
}

// One solve at a time; while one runs, only the newest point waits (latest wins).
let busy = false, pending = null, last = null;
async function request(pt) {
  last = pt;
  if (busy) { pending = pt; return; }
  busy = true;
  try { await solve(pt); } catch (err) { hud.textContent = `Error: ${err.message}`; console.error(err); }
  busy = false;
  if (pending) { const next = pending; pending = null; request(next); }
}

view.addEventListener("arcgisViewClick", (e) => { if (mode() === "click") request(e.detail.mapPoint); });
let hoverXY = null;
view.addEventListener("arcgisViewPointerMove", (e) => {
  if (mode() !== "hover") return;
  if (hoverXY === null) requestAnimationFrame(() => { const pt = view.toMap(hoverXY); hoverXY = null; if (pt) request(pt); });
  hoverXY = { x: e.detail.x, y: e.detail.y };
});
document.getElementById("minutes").addEventListener("change", () => { if (last) request(last); });
// Screen readers announce click results and errors, not every hover update.
const live = () => hud.setAttribute("aria-live", mode() === "hover" ? "off" : "polite");
document.getElementById("mode").addEventListener("change", live);
live();
