// Browser engine (web/client/sa.js) vs the CUDA engine and Builder.classify.
// Needs web/data/{adams.bin,adams.json,fixture.json} from client/build_client_data.py.
// run: node tests/test_client.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ServiceArea, TEX_W } from "../web/client/sa.js";

const dir = new URL("../web/data/", import.meta.url);
const header = JSON.parse(readFileSync(new URL("adams.json", dir)));
const bin = readFileSync(new URL("adams.bin", dir));
const sa = new ServiceArea(header, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const cases = JSON.parse(readFileSync(new URL("fixture.json", dir)));

const textures = [[sa.edgeTex, sa.dirty.edge, 4 * TEX_W], [sa.nodeFlags, sa.dirty.node, TEX_W], [sa.faceFlags, sa.dirty.face, TEX_W]];
const on = (flags) => [...flags.keys()].filter((i) => flags[i] === 1 || flags[i] === 255);  // nodeFlags 100: reached end, no disk
let maxCost = 0, maxFrac = 0, solveMs = 0, flagMs = 0, snapMs = 0;
// Warm every stage before seven measured passes over identical inputs.
for (const c of cases) {
  sa.snap(c.mx, c.my);
  sa.solve(c.edge, c.frac, 10);
  for (const B of [1, 5, 10]) sa.flags(B);
}
for (const c of Array.from({ length: 7 }, () => cases).flat()) {
  // shortest-path costs equal the CUDA kernel (cutoff 10)
  let t = performance.now();
  const dist = sa.solve(c.edge, c.frac, 10);
  solveMs += performance.now() - t;
  for (let n = 0; n < sa.N; n++) {
    if (c.dist[n] === null) assert.equal(dist[n], Infinity, `crash ${c.cid} node ${n} should be unreached`);
    else maxCost = Math.max(maxCost, Math.abs(dist[n] - c.dist[n]));
  }
  // polygon parts equal Builder.classify for each break
  for (const [B, want] of Object.entries(c.breaks)) {
    sa.solve(c.edge, c.frac, Number(B));
    const before = textures.map(([a]) => a.slice());
    for (const [, d] of textures) d.fill(0);
    t = performance.now();
    sa.flags(Number(B));
    flagMs += performance.now() - t;
    // layer.js uploads only marked rows: every row whose texture data changed must be marked
    textures.forEach(([a, d, perRow], i) => {
      for (let r = 0; r < d.length; r++) {
        if (d[r]) continue;
        for (let k = r * perRow; k < (r + 1) * perRow; k++) {
          if (!Object.is(a[k], before[i][k])) assert.fail(`crash ${c.cid} break ${B}: texture ${i} row ${r} changed but not marked`);
        }
      }
    });
    assert.deepEqual(on(sa.full), want.full, `crash ${c.cid} break ${B}: full edges`);
    assert.deepEqual(on(sa.nodeFlags), want.disk, `crash ${c.cid} break ${B}: disk nodes`);
    assert.deepEqual(on(sa.faceFlags), want.faces, `crash ${c.cid} break ${B}: faces`);
    // setDist (costs from another solver, e.g. WebGPU) leaves the same state as solve()
    const copy = Float64Array.from(sa.dist), parts = [on(sa.full), on(sa.nodeFlags), on(sa.faceFlags)];
    sa.solve(c.edge, c.frac, 0.5);  // other state first
    sa.setDist(copy, 0, c.edge, c.frac);
    sa.flags(Number(B));
    assert.deepEqual([on(sa.full), on(sa.nodeFlags), on(sa.faceFlags)], parts, `crash ${c.cid} break ${B}: setDist`);
  }
  // snapping equals Graph.locate (STRtree in EPSG:3735)
  t = performance.now();
  const s = sa.snap(c.mx, c.my);
  snapMs += performance.now() - t;
  assert.equal(s.edge, c.ownEdge, `crash ${c.cid}: snapped edge`);
  maxFrac = Math.max(maxFrac, Math.abs(s.frac - c.ownFrac));
}
assert.ok(maxCost <= 1e-9, `max cost difference ${maxCost}`);
assert.ok(maxFrac <= 1e-6, `max snap position difference ${maxFrac}`);
assert.equal(sa.snap(header.origin[0] + 5e6, header.origin[1]), null, "far point is not located");
const n = cases.length * 7;
console.log(`OK ${cases.length} crashes, 7 warmed passes: max cost diff ${maxCost.toExponential(2)} min, max snap position diff ${maxFrac.toExponential(2)}`);
console.log(`mean per call: solve(10 min) ${(solveMs / n).toFixed(3)} ms, flags ${(flagMs / n / 3).toFixed(3)} ms, snap ${(snapMs / n).toFixed(3)} ms`);
