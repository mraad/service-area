// Direct ArcPy line gate; known unsplit crossings still fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ServiceArea } from "../web/client/sa.js";
const dir = new URL("../web/data/", import.meta.url);
const header = JSON.parse(readFileSync(new URL("adams.json", dir)));
const bin = readFileSync(new URL("adams.bin", dir));
const sa = new ServiceArea(header, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const cases = JSON.parse(readFileSync(new URL("fixture.json", dir)));
const tol = 1e-6;
function merge(iv) {
  const out = [];
  for (const [lo, hi] of iv.filter(([a, b]) => b - a > tol).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out.at(-1);
    if (last && lo <= last[1] + tol) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
let costBad = 0, intervalBad = 0;
assert.ok(cases.length);
for (const c of cases) {
  assert.ok(c.esriLines?.length, "Rebuild fixtures with ArcPy lines");
  const dist = sa.solve(c.edge, c.frac, 10);
  for (const [e, p0, p1, c0, c1] of c.esriLines) {
    for (const [p, want] of [[p0, c0], [p1, c1]]) {
      const got = Math.min(dist[sa.eu[e]] + p * sa.w[e], dist[sa.ev[e]] + (1 - p) * sa.w[e],
        e === c.edge ? Math.abs(p - c.frac) * sa.w[e] : Infinity);
      if (!Number.isFinite(got) || Math.abs(got - want) > tol) costBad++;
    }
  }
  for (const B of [1, 5, 10]) {
    const expected = new Map();
    for (const [e, p0, p1, , c1] of c.esriLines) {
      if (c1 > B + tol) continue;
      if (!expected.has(e)) expected.set(e, []);
      expected.get(e).push([Math.min(p0, p1), Math.max(p0, p1)]);
    }
    for (let e = 0; e < sa.E; e++) {
      const iv = [], w = sa.w[e], cu = dist[sa.eu[e]], cv = dist[sa.ev[e]];
      if (cu < B) iv.push([0, Math.min(1, (B - cu) / w)]);
      if (cv < B) iv.push([Math.max(0, 1 - (B - cv) / w), 1]);
      if (e === c.edge) iv.push([Math.max(0, c.frac - B / w), Math.min(1, c.frac + B / w)]);
      const got = merge(iv), want = merge(expected.get(e) ?? []);
      if (got.length !== want.length || got.some((v, i) => v.some((x, j) => Math.abs(x - want[i][j]) > tol))) {
        intervalBad++;
        if (intervalBad <= 10) console.error(`interval mismatch: crash ${c.cid}, edge ${e}, break ${B}`);
      }
    }
  }
}
console.log(`ArcPy client gate: ${cases.length} crashes, ${costBad} cost mismatches, ${intervalBad} interval mismatches`);
process.exitCode = costBad || intervalBad ? 1 : 0;
