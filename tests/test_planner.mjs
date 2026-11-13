// Station planner (web/client/planner.js): greedy picks, exact coverage, coverage polygon.
// Uses the 100 fixture crashes as sites and the CPU solver (no GPU in Node).
// run: node tests/test_planner.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import initGeos from "geos-wasm";
import { ServiceArea } from "../web/client/sa.js";
import { candidateCosts, coverage, cpuSolveMany, crashSites, evaluate, greedy } from "../web/client/planner.js";
import { polygon, rings } from "../web/client/geom.js";

const dir = new URL("../web/data/", import.meta.url);
const header = JSON.parse(readFileSync(new URL("adams.json", dir)));
const bin = readFileSync(new URL("adams.bin", dir));
const sa = new ServiceArea(header, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const fixture = JSON.parse(readFileSync(new URL("fixture.json", dir)));

const sites = crashSites(sa, fixture.map((c) => ({ cid: c.cid, mx: c.mx, my: c.my })));
assert.equal(sites.length, fixture.length, "every fixture crash is located");
const S = sites.length;
let t = performance.now();
const costs = await candidateCosts(sa, sites, 10, cpuSolveMany(sa), 32);
const costMs = performance.now() - t;

// A station reaches its own site at cost 0; costs match an exact solve (fp32 storage only).
for (let s = 0; s < S; s++) assert.equal(costs[s * S + s], 0, `site ${s} reaches itself`);
const one = evaluate(sa, sites, [7], [10]);
for (let i = 0; i < S; i++) {
  const a = costs[7 * S + i], b = one.best[i];
  assert.ok(a === Infinity ? b > 10 || b === Infinity : Math.abs(a - b) <= 1e-5 * Math.max(1, b), `site ${i}: ${a} vs ${b}`);
}

// Greedy: every step takes the station with the largest marginal gain (brute force over all stations).
for (const B of [1, 5, 10]) {
  const { picked, gains } = greedy(costs, S, B, 5);
  const covered = new Set();
  picked.forEach((p, step) => {
    let best = 0;
    for (let s = 0; s < S; s++) {
      let g = 0;
      for (let i = 0; i < S; i++) if (costs[s * S + i] <= B && !covered.has(i)) g++;
      best = Math.max(best, g);
    }
    assert.equal(gains[step], best, `B=${B} step ${step}: gain is the maximum`);
    for (let i = 0; i < S; i++) if (costs[p * S + i] <= B) covered.add(i);
  });
  // exact Float64 coverage of the picks equals the greedy count (fp32 rounding did not cross a break here)
  assert.equal(evaluate(sa, sites, picked, [B]).reached[B], covered.size, `B=${B}: exact coverage`);
}

// Coverage polygon: one station equals its own service-area polygon; more stations never shrink the area.
const geos = await initGeos();
const M = geos.Module;
const area = (g) => { const p = M._malloc(8); geos.GEOSArea(g, p); const a = M.HEAPF64[p / 8]; M._free(p); return a; };
const { picked } = greedy(costs, S, 5, 3);
t = performance.now();
const cov = coverage(sa, geos, sites, picked, 5);
const polyMs = performance.now() - t;
const single = coverage(sa, geos, sites, picked.slice(0, 1), 5);
sa.solve(sites[picked[0]].edge, sites[picked[0]].frac, 5); sa.flags(5);
const own = polygon(sa, geos);
assert.ok(Math.abs(area(single) - area(own)) <= 1e-6 * area(own), "one station: union equals its polygon");
assert.ok(area(cov) >= area(single), "three stations cover at least one station's area");
// rings(): Esri order, exterior clockwise (negative shoelace area) and holes counter-clockwise
const signed = (r) => r.reduce((a, [x, y], i) => { const [u, v] = r[(i + 1) % r.length]; return a + x * v - u * y; }, 0) / 2;
const polys = rings(geos, cov);
assert.ok(polys.length > 0, "coverage has polygons");
for (const [ext, ...holes] of polys) {
  assert.ok(signed(ext) < 0, "exterior ring is clockwise");
  for (const h of holes) assert.ok(signed(h) > 0, "hole ring is counter-clockwise");
}
const ringArea = polys.reduce((a, [ext, ...holes]) => a - signed(ext) - holes.reduce((b, h) => b + signed(h), 0), 0);
assert.ok(Math.abs(ringArea - area(cov)) <= 1e-6 * area(cov), "ring areas sum to the GEOS area");
for (const g of [cov, single, own]) geos.GEOSGeom_destroy(g);
const r = evaluate(sa, sites, picked);
console.log(`OK planner: ${S} sites, candidate costs ${costMs.toFixed(0)} ms (CPU), 3 stations reach ` +
  `${r.reached[1]} / ${r.reached[5]} / ${r.reached[10]} of ${S} in 1 / 5 / 10 min, coverage polygon ${polyMs.toFixed(0)} ms`);
