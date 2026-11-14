import { ServiceArea } from "./client/sa.js";
import { createServiceAreaLayer } from "./client/layer.js";

const [esriConfig, OAuthInfo, esriId, Graphic, GraphicsLayer, Polygon, Layer, BaseLayerViewGL2D, Point, webMercatorUtils] = await $arcgis.import([
  "@arcgis/core/config.js",
  "@arcgis/core/identity/OAuthInfo.js",
  "@arcgis/core/identity/IdentityManager.js",
  "@arcgis/core/Graphic.js",
  "@arcgis/core/layers/GraphicsLayer.js",
  "@arcgis/core/geometry/Polygon.js",
  "@arcgis/core/layers/Layer.js",
  "@arcgis/core/views/2d/layers/BaseLayerViewGL2D.js",
  "@arcgis/core/geometry/Point.js",
  "@arcgis/core/geometry/support/webMercatorUtils.js",
]);

const viewElement = document.querySelector("arcgis-map");
const hud = document.getElementById("hud");
await viewElement.viewOnReady();

// Dark basemap after ArcGIS sign-in (server env ARCGIS_PORTAL_URL / ARCGIS_CLIENT_ID); OSM until then.
const signin = document.getElementById("signin");
try {
  const { portalUrl, clientId } = await (await fetch("config")).json();
  if (portalUrl && clientId) {
    esriConfig.portalUrl = portalUrl;
    esriId.registerOAuthInfos([new OAuthInfo({ appId: clientId, portalUrl, popup: false })]);
    const sharing = `${portalUrl.replace(/\/$/, "")}/sharing`;
    const useDark = () => { viewElement.basemap = "dark-gray-vector"; signin.hidden = true; };
    esriId.checkSignInStatus(sharing).then(useDark).catch(() => {
      signin.hidden = false;
      signin.onclick = () => esriId.getCredential(sharing).then(useDark);  // redirects to the portal, returns here
    });
  }
} catch (err) {
  console.warn("No ArcGIS sign-in config; staying on OSM", err);
}

const areaLayer = new GraphicsLayer();
const FILLED = { type: "simple-fill", color: [0, 110, 200, 0.25], outline: { color: [0, 80, 160, 0.9], width: 1.5 } };
// "Both" engine: the server polygon is an outline over the client raster (visual fidelity check)
const OUTLINE = { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: [235, 104, 52, 1], width: 1.5 } };
const area = new Graphic({ symbol: FILLED });
areaLayer.add(area);
viewElement.map.add(areaLayer);

const minutes = () => document.querySelector("input[name=min]:checked").value;
const mode = () => document.querySelector("input[name=mode]:checked").value;
const engine = () => document.querySelector("input[name=engine]:checked").value;
const hudText = { warn: "", client: "", server: "" };
const showHud = () => { hud.textContent = [hudText.warn, hudText.client, hudText.server].filter(Boolean).join(" | "); };

// Browser engine: data and WebGL layer are loaded the first time Client or Both is selected.
let sa = null;
let saLayer = null;
let clientLoad = null;  // one load, also when the engine control changes again before it ends
// Resolves to true when the browser engine is ready. On failure it selects the Server engine.
function loadClient() {
  clientLoad ??= (async () => {
    hud.textContent = "Loading client data…";
    try {
      const [engineData, config] = await Promise.all([ServiceArea.load("data/adams"), fetch("config").then((r) => r.json())]);
      sa = engineData;
      saLayer = createServiceAreaLayer({ Layer, BaseLayerViewGL2D }, sa);
      viewElement.map.add(saLayer, 0);
      hudText.client = "";  // a retry after a failed load removes the old error text
      hudText.warn = config.edgesSha256 === sa.header.edgesSha256 ? ""
        : "Client data is from other streets than the server: run client/build_client_data.py";
      return true;
    } catch (err) {
      console.error(err);
      clientLoad = null;
      document.querySelector("input[name=engine][value=server]").checked = true;
      hudText.client = "Client data not loaded: run client/build_client_data.py";
      return false;
    }
  })();
  return clientLoad;
}

function solveClient(point) {
  if (!sa) return;
  const t0 = performance.now();
  const B = Number(minutes());
  const s = sa.snap(point.x, point.y);  // the view is Web Mercator
  if (!s) {
    saLayer.clear();
    hudText.client = "client: not located";
  } else {
    sa.solve(s.edge, s.frac, B);
    sa.flags(B);
    saLayer.show(B);
    hudText.client = `client ${(performance.now() - t0).toFixed(2)} ms`;
  }
  showHud();
}

function solve(point) {
  lastPoint = point;
  if (engine() !== "server") solveClient(point);
  if (engine() !== "client") solveServer(point);
}

// One request in flight; the newest pending point is sent as soon as it returns (latest wins).
let inFlight = null;
let pending = null;
let lastPoint = null;

function toPolygon(geojson) {
  const rings = geojson.type === "Polygon" ? geojson.coordinates
    : geojson.type === "MultiPolygon" ? geojson.coordinates.flat() : [];
  return new Polygon({ rings, spatialReference: { wkid: 4326 } });
}

async function solveServer(point) {
  if (inFlight) {
    pending = point;
    return;
  }
  const ctrl = new AbortController();
  inFlight = ctrl;
  try {
    const url = `sa?lon=${point.longitude.toFixed(6)}&lat=${point.latitude.toFixed(6)}&minutes=${minutes()}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const f = await res.json();
    if (inFlight !== ctrl) return;
    area.geometry = toPolygon(f.geometry);
    hudText.server = `server ${f.properties.solve_ms.toFixed(1)} ms`;
  } catch (err) {
    if (inFlight === ctrl && err.name !== "AbortError") { area.geometry = null; hudText.server = `Error: ${err.message}`; }  // no stale polygon
  } finally {
    if (inFlight === ctrl) {
      inFlight = null;
      showHud();
      if (pending) {
        const next = pending;
        pending = null;
        solveServer(next);
      }
    }
  }
}

let rafPoint = null;
viewElement.addEventListener("arcgisViewPointerMove", (event) => {
  if (mode() !== "hover") return;
  const { x, y } = event.detail;
  if (rafPoint === null) {
    requestAnimationFrame(() => {
      const mp = viewElement.toMap(rafPoint);
      rafPoint = null;
      if (mp) solve(mp);
    });
  }
  rafPoint = { x, y };
});

viewElement.addEventListener("arcgisViewClick", (event) => {
  if (mode() === "click") solve(event.detail.mapPoint);
});

// A minutes change re-solves the last point at once instead of waiting for a stale answer.
document.getElementById("minutes").addEventListener("change", () => {
  inFlight?.abort();
  inFlight = null;
  pending = null;
  if (lastPoint) solve(lastPoint);
});

// Engine change: load the browser engine when needed, hide what the other engine drew, solve again.
document.getElementById("engine").addEventListener("change", async () => {
  const loaded = engine() === "server" || await loadClient();
  const e = engine();  // Server again when the load failed
  if (e === "server") { saLayer?.clear(); if (loaded) hudText.client = ""; }
  if (e === "client") { inFlight?.abort(); inFlight = null; pending = null; area.geometry = null; hudText.server = ""; }
  area.symbol = e === "both" ? OUTLINE : FILLED;
  showHud();
  if (lastPoint) solve(lastPoint);
});

// Deep link: ?engine=both&minutes=10&at=-83.54,38.79 selects the options and solves at that point.
// Optional: zoom=12, rotation=30.
const params = new URLSearchParams(location.search);
for (const name of ["engine", "min", "mode"]) {
  const value = params.get(name === "min" ? "minutes" : name);
  const input = value && document.querySelector(`input[name=${name}][value="${CSS.escape(value)}"]`);
  if (input) input.checked = true;
}
const [longitude, latitude] = (params.get("at") ?? "").split(",").map((v) => parseFloat(v));  // "" -> NaN, not 0
if (engine() !== "server") await loadClient();
area.symbol = engine() === "both" ? OUTLINE : FILLED;
if (Number.isFinite(longitude) && Math.abs(longitude) <= 180 && Number.isFinite(latitude) && Math.abs(latitude) <= 90) {
  await viewElement.goTo({ center: [longitude, latitude], zoom: Number(params.get("zoom")) || 12,
    rotation: Number(params.get("rotation")) || 0 }, { animate: false });
  solve(webMercatorUtils.geographicToWebMercator(new Point({ longitude, latitude })));
}
