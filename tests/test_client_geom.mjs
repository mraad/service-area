// Browser polygons (web/client/geom.js + geos-wasm) against Builder.polygon (web/data/fixture_poly.json).
// Part 1 needs no GEOS: the reached pieces of sa.flags() equal Builder.classify segs.
// Part 2 (needs `npm ci` for geos-wasm; fails without it): the parity gate of parity/compare.py, IoU >= 0.99, Hausdorff <= 50 ft.
// run: node tests/test_client_geom.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ServiceArea } from "../web/client/sa.js";

const dir = new URL("../web/data/", import.meta.url);
const header = JSON.parse(readFileSync(new URL("adams.json", dir)));
const bin = readFileSync(new URL("adams.bin", dir));
const sa = new ServiceArea(header, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const byCid = new Map(JSON.parse(readFileSync(new URL("fixture.json", dir))).map((c) => [c.cid, c]));
const polys = JSON.parse(readFileSync(new URL("fixture_poly.json", dir)));
const run = (p) => { const c = byCid.get(p.cid); sa.solve(c.edge, c.frac, p.minutes); sa.flags(p.minutes); };

let maxPos = 0;
for (const p of polys) {
  run(p);
  const got = [...sa.pieces].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.equal(got.length, p.pieces.length, `crash ${p.cid} ${p.minutes} min: piece count`);
  got.forEach(([e, lo, hi], i) => {
    assert.equal(e, p.pieces[i][0], `crash ${p.cid} ${p.minutes} min: piece edge`);
    maxPos = Math.max(maxPos, Math.abs(lo - p.pieces[i][1]), Math.abs(hi - p.pieces[i][2]));
  });
}
assert.ok(maxPos <= 1e-9, `max piece position difference ${maxPos}`);
console.log(`OK pieces: ${polys.length} crash-breaks, max position diff ${maxPos.toExponential(2)}`);

const { default: initGeos } = await import("geos-wasm"); // pinned in package.json: npm ci; a missing package fails the test
const { polygon } = await import("../web/client/geom.js");
const geos = await initGeos();
console.log(`GEOS ${geos.GEOSversion()} (gpu-x86 Shapely uses GEOS 3.14.1)`);
const M = geos.Module;
const num = (fn, ...g) => { const ptr = M._malloc(8); fn(...g, ptr); const v = M.HEAPF64[ptr / 8]; M._free(ptr); return v; };
const fromHex = (hex) => {
  const bytes = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  const ptr = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  const g = geos.GEOSGeomFromWKB_buf(ptr, bytes.length);
  M._free(ptr);
  return g;
};
const ms = {}, res = [];
for (const p of polys) {
  run(p);
  const t = performance.now();
  const g = polygon(sa, geos);
  (ms[p.minutes] ??= []).push(performance.now() - t);
  const ref = fromHex(p.wkb);
  const inter = geos.GEOSIntersection(g, ref), uni = geos.GEOSUnion(g, ref);
  const u = num(geos.GEOSArea, uni);
  const iou = u ? num(geos.GEOSArea, inter) / u : 1;
  const haus = num(geos.GEOSHausdorffDistance, g, ref);
  res.push({ cid: p.cid, minutes: p.minutes, iou, haus });
  for (const x of [g, ref, inter, uni]) geos.GEOSGeom_destroy(x);
}
const bad = res.filter((r) => !(r.iou >= 0.99 && r.haus <= 50));
const minIou = Math.min(...res.map((r) => r.iou)), maxHaus = Math.max(...res.map((r) => r.haus));
const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`polygons: ${res.length - bad.length} / ${res.length} within IoU >= 0.99 and Hausdorff <= 50 ft; min IoU ${minIou.toFixed(6)}, max Hausdorff ${maxHaus.toFixed(3)} ft`);
console.log(`ms per polygon p50: ${Object.entries(ms).map(([B, a]) => `${B} min ${p50(a).toFixed(1)}`).join(", ")} (server p50 3.7 / 18.9 / 67.6)`);
for (const r of bad) console.log(`  FAIL crash ${r.cid} ${r.minutes} min: IoU ${r.iou.toFixed(4)}, Hausdorff ${r.haus.toFixed(1)} ft`);
assert.equal(bad.length, 0, "polygon parity gate");
