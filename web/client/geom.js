// Service-area polygon in the browser: the rules of cuda/polygons.py Builder.polygon, run by GEOS (geos-wasm).
// Input: a ServiceArea after solve() + flags(B). Output: a GEOS geometry in EPSG:3735 (US survey feet).
// No SDK imports: runs in Node too. The caller passes the initialized geos object and destroys the result.

import { POS_EPS } from "./sa.js";

const TRIM_FT = 100.0 / 0.3048006096012192; // same as cuda/polygons.py
const MIN_HOLE_FT2 = 1e-6;
const QUAD_SEGS = 16; // Shapely 2 buffer default
const CAP_FLAT = 2, POLYGON = 3, MULTIPOINT = 4, MULTIPOLYGON = 6, COLLECTION = 7;
const VORONOI_PRESERVE_ORDER = 2;

// Coordinates of edge e between normalized positions lo and hi (shapely.ops.substring, normalized=True):
// the start point, the vertices strictly inside, the end point. A full edge keeps all its vertices.
function substring(sa, e, lo, hi) {
  const { vert3735: xy, vertP: p, vertOff } = sa;
  const v0 = vertOff[e], v1 = vertOff[e + 1];
  if (lo <= POS_EPS && hi >= 1 - POS_EPS) return xy.subarray(2 * v0, 2 * v1);
  const at = (t) => {
    let k = v0;
    while (k < v1 - 2 && p[k + 1] < t) k++;
    const f = p[k + 1] > p[k] ? (t - p[k]) / (p[k + 1] - p[k]) : 0;
    return [xy[2 * k] + f * (xy[2 * k + 2] - xy[2 * k]), xy[2 * k + 1] + f * (xy[2 * k + 3] - xy[2 * k + 1])];
  };
  const out = [...at(lo)];
  for (let k = v0; k < v1; k++) if (p[k] > lo && p[k] < hi) out.push(xy[2 * k], xy[2 * k + 1]);
  out.push(...at(hi));
  return Float64Array.from(out);
}

function lineString(geos, coords) {
  const M = geos.Module, ptr = M._malloc(coords.byteLength);
  M.HEAPF64.set(coords, ptr / 8);
  const seq = geos.GEOSCoordSeq_copyFromBuffer(ptr, coords.length / 2, 0, 0);
  M._free(ptr);
  return geos.GEOSGeom_createLineString(seq);
}

function collection(geos, type, geoms) { // takes ownership of geoms
  const M = geos.Module, ptr = M._malloc(4 * Math.max(1, geoms.length));
  M.HEAPU32.set(geoms, ptr / 4);
  const g = geos.GEOSGeom_createCollection(type, ptr, geoms.length);
  M._free(ptr);
  return g;
}

export function area(geos, g) {
  const M = geos.Module, ptr = M._malloc(8);
  geos.GEOSArea(g, ptr);
  const a = M.HEAPF64[ptr / 8];
  M._free(ptr);
  return a;
}

// Buffers of whole edges and node disks never change: kept per ServiceArea (one geos instance per page), cloned per use.
const cache = new WeakMap();

// Builder territory: Voronoi cells of the street-piece points (cellXY), made once per ServiceArea. Cell i belongs
// to point i. The frame is the bounding box of the points grown by 4 trim distances, as in cuda/polygons.py.
function cells(sa, geos, kept) {
  if (kept.cells) return kept.cells;  // the first call takes about 2.5 s for Adams (150,033 cells)
  const xy = sa.cellXY, pts = new Array(xy.length / 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = xy[2 * i], y = xy[2 * i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    pts[i] = geos.GEOSGeom_createPointFromXY(x, y);
  }
  const mp = collection(geos, MULTIPOINT, pts), d = 4 * TRIM_FT;
  const env = geos.GEOSGeom_createRectangle(x0 - d, y0 - d, x1 + d, y1 + d);
  kept.cells = geos.GEOSVoronoiDiagram(mp, env, 0, VORONOI_PRESERVE_ORDER);
  geos.GEOSGeom_destroy(mp); geos.GEOSGeom_destroy(env);
  return kept.cells;
}

const keptOf = (sa) => cache.get(sa) ?? cache.set(sa, { edge: new Map(), disk: new Map() }).get(sa);

// Makes the cells before the first polygon, so a page can do it while it loads.
export function prepare(sa, geos) { cells(sa, geos, keptOf(sa)); }

// Builder.polygon: flat-cap buffers of the reached pieces, round disks at flagged nodes, flagged blocks, union;
// then only the ground whose nearest street piece is reached (the cells of the reached pieces).
export function polygon(sa, geos) {
  if (!sa.pieces.length) return geos.GEOSGeom_createEmptyPolygon();
  const M = geos.Module, parts = [];
  const params = geos.GEOSBufferParams_create();
  geos.GEOSBufferParams_setEndCapStyle(params, CAP_FLAT);
  geos.GEOSBufferParams_setQuadrantSegments(params, QUAD_SEGS);
  const kept = keptOf(sa);
  const clone = (map, key, make) => {
    let g = map.get(key);
    if (!g) map.set(key, (g = make()));
    return geos.GEOSGeom_clone(g);
  };
  const buffer = (e, lo, hi) => {
    const line = lineString(geos, substring(sa, e, lo, hi));
    const b = geos.GEOSBufferWithParams(line, params, TRIM_FT);
    geos.GEOSGeom_destroy(line);
    return b;
  };
  for (const [e, lo, hi] of sa.pieces) {
    parts.push(lo <= POS_EPS && hi >= 1 - POS_EPS ? clone(kept.edge, e, () => buffer(e, 0, 1)) : buffer(e, lo, hi));
  }
  for (let k = 0; k < sa.nOn; k++) {
    const n = sa.onNodes[k];
    parts.push(clone(kept.disk, n, () => {
      const pt = geos.GEOSGeom_createPointFromXY(sa.nodeXY[2 * n], sa.nodeXY[2 * n + 1]);
      const b = geos.GEOSBuffer(pt, TRIM_FT, QUAD_SEGS);
      geos.GEOSGeom_destroy(pt);
      return b;
    }));
  }
  geos.GEOSBufferParams_destroy(params);
  for (let k = 0; k < sa.nOnF; k++) {
    const f = sa.onFaces[k], a = sa.faceWkbOff[f], b = sa.faceWkbOff[f + 1];
    const ptr = M._malloc(b - a);
    M.HEAPU8.set(sa.faceWkb.subarray(a, b), ptr);
    parts.push(geos.GEOSGeomFromWKB_buf(ptr, b - a));
    M._free(ptr);
  }
  const u = union(geos, parts);
  // A piece that is reached in part counts as reached (the same shortcut as Builder.polygon).
  const all = cells(sa, geos, kept), ids = new Set();
  for (const [e, lo, hi] of sa.pieces) {
    const n = sa.pieceN[e], off = sa.pieceOff[e];
    for (let k = Math.floor(lo * n), end = Math.min(n, Math.ceil(hi * n)); k < end; k++) ids.add(sa.pieceCell[off + k]);
  }
  const reached = collection(geos, COLLECTION, [...ids].sort((a, b) => a - b).map((i) => geos.GEOSGeom_clone(geos.GEOSGetGeometryN(all, i))));
  const territory = geos.GEOSCoverageUnion(reached);
  const cut = geos.GEOSIntersection(u, territory);
  const out = dropMicroHoles(geos, cut);  // always a new geometry
  for (const g of [u, reached, territory, cut]) geos.GEOSGeom_destroy(g);
  return out;
}

// Union of geometries (shapely.union_all); takes ownership of geoms, the caller destroys the result.
export function union(geos, geoms) {
  const all = collection(geos, COLLECTION, geoms);
  const u = geos.GEOSUnaryUnion(all);
  geos.GEOSGeom_destroy(all);
  return u;
}

// _drop_micro_holes: flat caps that nearly touch leave zero-area holes (~1e-20 ft2) in the union.
function dropMicroHoles(geos, g) {
  const polys = [];
  for (let i = 0; i < geos.GEOSGetNumGeometries(g); i++) {
    const p = geos.GEOSGetGeometryN(g, i);
    if (geos.GEOSGeomTypeId(p) !== POLYGON) continue;
    const holes = [];
    for (let h = 0; h < geos.GEOSGetNumInteriorRings(p); h++) {
      const ring = geos.GEOSGeom_clone(geos.GEOSGetInteriorRingN(p, h));
      const asPoly = geos.GEOSGeom_createPolygon(geos.GEOSGeom_clone(ring), 0, 0);
      if (area(geos, asPoly) >= MIN_HOLE_FT2) holes.push(ring); else geos.GEOSGeom_destroy(ring);
      geos.GEOSGeom_destroy(asPoly);
    }
    const M = geos.Module, ptr = M._malloc(4 * Math.max(1, holes.length));
    M.HEAPU32.set(holes, ptr / 4);
    polys.push(geos.GEOSGeom_createPolygon(geos.GEOSGeom_clone(geos.GEOSGetExteriorRing(p)), ptr, holes.length));
    M._free(ptr);
  }
  return polys.length === 1 ? polys[0] : collection(geos, MULTIPOLYGON, polys);
}

// Polygons as [[exterior, ...holes], ...] of [x, y] rings (EPSG:3735), in Esri order: exterior clockwise,
// holes counter-clockwise (GEOSOrientPolygons changes g in place). GeoJSON needs the reverse order.
export function rings(geos, g) {
  const M = geos.Module, out = [];
  geos.GEOSOrientPolygons(g, 1);
  const ring = (r) => {
    const seq = geos.GEOSGeom_getCoordSeq(r), sz = M._malloc(4);
    geos.GEOSCoordSeq_getSize(seq, sz);
    const n = M.HEAPU32[sz / 4];
    M._free(sz);
    const buf = M._malloc(16 * n);
    geos.GEOSCoordSeq_copyToBuffer(seq, buf, 0, 0);
    const c = M.HEAPF64.slice(buf / 8, buf / 8 + 2 * n);
    M._free(buf);
    return Array.from({ length: n }, (_, i) => [c[2 * i], c[2 * i + 1]]);
  };
  for (let i = 0; i < geos.GEOSGetNumGeometries(g); i++) {
    const p = geos.GEOSGetGeometryN(g, i);
    if (geos.GEOSisEmpty(p)) continue;
    const poly = [ring(geos.GEOSGetExteriorRing(p))];
    for (let h = 0; h < geos.GEOSGetNumInteriorRings(p); h++) poly.push(ring(geos.GEOSGetInteriorRingN(p, h)));
    out.push(poly);
  }
  return out;
}
