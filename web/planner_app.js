// Station planner page. WebGPU (web/client/gpu.js) solves every crash site as a candidate station in batches;
// a greedy pick chooses k stations; ServiceArea (Float64) recomputes the reported coverage; GEOS (WebAssembly,
// web/client/geom.js) builds the coverage polygon. URL: ?auto=1 runs once on load, ?compare=1 also ranks on the CPU.
import { ServiceArea } from "./client/sa.js";
import { GpuSssp } from "./client/gpu.js";
import { prepare, rings } from "./client/geom.js";
import { candidateCosts, coverage, cpuSolveMany, crashSites, evaluate, gpuSolveMany, greedy } from "./client/planner.js";

const [Graphic, GraphicsLayer, Polygon, Polyline, projectOperator, webMercatorUtils] = await $arcgis.import([
  "@arcgis/core/Graphic.js",
  "@arcgis/core/layers/GraphicsLayer.js",
  "@arcgis/core/geometry/Polygon.js",
  "@arcgis/core/geometry/Polyline.js",
  "@arcgis/core/geometry/operators/projectOperator.js",
  "@arcgis/core/geometry/support/webMercatorUtils.js",
]);

const CUTOFF = 10; // candidate costs cover the largest break
const params = new URLSearchParams(location.search);
const view = document.querySelector("arcgis-map");
const logEl = document.getElementById("log");
const runBtn = document.getElementById("run");
const exportBtn = document.getElementById("export");
const table = document.getElementById("table");
const kInput = document.getElementById("k");
const lines = [];
const log = (s) => { lines.push(s); logEl.textContent = lines.join("\n"); };
const ms = (t) => (performance.now() - t).toFixed(0);
const result = (window.plannerResult = {});

const geosReady = import("geos-wasm").then((m) => m.default()); // ~2.5 MB, loads while the candidates solve
await view.viewOnReady();
const coverLayer = new GraphicsLayer({ title: "Coverage" });
const crashLayer = new GraphicsLayer({ title: "Crashes" });
const stationLayer = new GraphicsLayer({ title: "Stations" });
view.map.addMany([coverLayer, crashLayer, stationLayer]);

const dot = (color, size) => ({ type: "simple-marker", color, size, outline: { color: [255, 255, 255, 0.6], width: 0.5 } });
const GREY = dot([110, 110, 110, 0.7], 4), IN = dot([0, 90, 200, 0.9], 5), OUT = dot([210, 50, 40, 0.9], 5);

let sa, sites, costs, last = null;
try {
  let t = performance.now();
  const json = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); });
  const [engine, fc, config] = await Promise.all([ServiceArea.load("data/adams"), json("crashes"), json("config")]);
  // as web/app.js: the client data must be built from the streets the server uses
  if (config.edgesSha256 !== engine.header.edgesSha256) log("Warning: client data is from other streets than the server: run client/build_client_data.py");
  sa = engine;
  geosReady.then((g) => prepare(sa, g)); // nearest-street cells (about 2.5 s once) while the candidates solve
  sites = crashSites(sa, fc.features.map((f) => {
    const [mx, my] = webMercatorUtils.lngLatToXY(...f.geometry.coordinates);
    return { cid: f.properties.CID, mx, my };
  }));
  log(`${sites.length} of ${fc.features.length} crashes located (${ms(t)} ms)`);
  crashLayer.addMany(sites.map((s) => new Graphic({
    geometry: { type: "point", x: s.mx, y: s.my, spatialReference: { wkid: 3857 } }, symbol: GREY })));

  let solveMany, engineName = "WebGPU";
  try {
    const gpu = await GpuSssp.create(sa, 512);
    solveMany = gpuSolveMany(sa, gpu);
    engineName += ` (${gpu.info.vendor ?? "?"} ${gpu.info.architecture ?? ""})`.replace(" )", ")");
  } catch (err) {
    solveMany = Object.assign(cpuSolveMany(sa), { cpu: true });
    engineName = `CPU, no WebGPU: ${err.message}`;
  }
  t = performance.now();
  try {
    costs = await candidateCosts(sa, sites, CUTOFF, solveMany);
  } catch (err) { // e.g. device lost during the solve: rank on the CPU
    if (solveMany.cpu) throw err;
    engineName = `CPU, WebGPU failed: ${err.message}`;
    t = performance.now();
    costs = await candidateCosts(sa, sites, CUTOFF, cpuSolveMany(sa));
  }
  result.candidateMs = Number(ms(t));
  result.engine = engineName;
  log(`${sites.length} candidate stations solved: ${result.candidateMs} ms, ${engineName}`);

  if (params.get("compare")) { // does fp32 GPU ranking pick the same stations as the CPU?
    t = performance.now();
    const cpu = await candidateCosts(sa, sites, CUTOFF, cpuSolveMany(sa));
    result.cpuCandidateMs = Number(ms(t));
    let same = 0, n = 0;
    for (const B of [1, 5, 10]) for (let k = 1; k <= 20; k++, n++) {
      const a = greedy(costs, sites.length, B, k).picked, b = greedy(cpu, sites.length, B, k).picked;
      same += a.length === b.length && a.every((x, i) => x === b[i]);
    }
    result.sameRanking = `${same} / ${n}`;
    log(`CPU candidates: ${result.cpuCandidateMs} ms; same picks as the CPU for ${same} of ${n} (k, break) cases`);
  }
  runBtn.disabled = false;
} catch (err) {
  log(`Error: ${err.message}`);
  console.error(err);
}

kInput.addEventListener("input", () => { document.getElementById("kOut").value = kInput.value; });
runBtn.addEventListener("click", () => run().catch((err) => { log(`Error: ${err.message}`); console.error(err); }));
exportBtn.addEventListener("click", exportGeoJSON);

async function run() {
  const k = Number(kInput.value), B = Number(document.querySelector("input[name=min]:checked").value);
  let t = performance.now();
  const { picked } = greedy(costs, sites.length, B, k);
  const greedyMs = ms(t);
  t = performance.now();
  const ev = evaluate(sa, sites, picked); // Float64: the numbers shown
  const exactMs = ms(t);
  t = performance.now();
  const geos = await geosReady;
  const g = coverage(sa, geos, sites, picked, B);
  const polys = rings(geos, g); // EPSG:3735, Esri ring order
  geos.GEOSGeom_destroy(g);
  const polyMs = ms(t);

  await projectOperator.projectLoad();
  // Project the rings as polyline paths (one per ring, see exportGeoJSON), then rebuild the polygon.
  const paths = projectOperator.projectExecute(new Polyline({ paths: polys.flat(), spatialReference: { wkid: 3735 } }), view.spatialReference).paths;
  const area = new Polygon({ rings: paths, spatialReference: view.spatialReference });
  coverLayer.removeAll();
  coverLayer.add(new Graphic({ geometry: area, symbol: { type: "simple-fill", color: [0, 110, 200, 0.2],
    outline: { color: [0, 80, 160, 0.9], width: 1.2 } } }));
  crashLayer.graphics.forEach((gr, i) => { gr.symbol = ev.best[i] <= B ? IN : OUT; });
  stationLayer.removeAll();
  stationLayer.addMany(picked.map((s, i) => new Graphic({
    geometry: { type: "point", x: sites[s].mx, y: sites[s].my, spatialReference: { wkid: 3857 } },
    symbol: { type: "simple-marker", style: "diamond", color: [255, 200, 0, 1], size: 13, outline: { color: [60, 40, 0], width: 1 } },
    attributes: { rank: i + 1, cid: sites[s].cid } })));

  for (const row of [...table.querySelectorAll("tr")].slice(1)) row.remove();
  for (const b of [1, 5, 10]) {
    const tr = table.insertRow();
    tr.innerHTML = `<td>${b} min</td><td>${ev.reached[b]}</td><td>${(100 * ev.reached[b] / ev.total).toFixed(1)} %</td>`;
    if (b === B) tr.style.fontWeight = "600";
  }
  table.hidden = false;
  last = { k, B, picked, polys, reached: ev.reached, total: ev.total };
  Object.assign(result, { k, B, stations: picked.map((s) => sites[s].cid), reached: ev.reached, total: ev.total,
    greedyMs: Number(greedyMs), exactMs: Number(exactMs), polygonMs: Number(polyMs), polygons: polys.length });
  log(`${picked.length} stations, ${B} min: pick ${greedyMs} ms, exact coverage ${exactMs} ms, GEOS polygon ${polyMs} ms`);
  exportBtn.disabled = false;
}

// Coverage polygon (WGS84, GeoJSON ring order) and stations, as a file download.
async function exportGeoJSON() {
  if (!last) return;
  await projectOperator.projectLoad();
  // Projected as polyline paths: a polygon projection may merge or drop rings, paths stay one per ring.
  const wgs = projectOperator.projectExecute(new Polyline({ paths: last.polys.flat(), spatialReference: { wkid: 3735 } }), { wkid: 4326 });
  // Esri rings are exterior clockwise; GeoJSON (RFC 7946) wants counter-clockwise: reverse every ring.
  let r = 0;
  const coordinates = last.polys.map((poly) => poly.map(() => [...wgs.paths[r++]].reverse()));
  const features = [{ type: "Feature", properties: { minutes: last.B, stations: last.picked.length,
    reached: last.reached[last.B], crashes: last.total }, geometry: { type: "MultiPolygon", coordinates } }];
  last.picked.forEach((s, i) => features.push({ type: "Feature", properties: { rank: i + 1, CID: sites[s].cid },
    geometry: { type: "Point", coordinates: webMercatorUtils.xyToLngLat(sites[s].mx, sites[s].my) } }));
  const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })], { type: "application/geo+json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob),
    download: `stations_${last.picked.length}_${last.B}min.geojson` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000); // revoking at once can cancel the download
}

if (params.get("auto") && !runBtn.disabled) await run().catch((err) => log(`Error: ${err.message}`));
result.done = true;
