// Scale bench: the browser engine on k disjoint, translated copies of the Adams network.
// Measures the per-call cost that grows with network size (not with the cutoff area).
// Limit: copies are not connected, so this tests per-call O(N)/O(E) work, not cross-tile routing.
// run: node tests/bench_scale.mjs [k ...]   (default 1 10 30 100)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ServiceArea, TEX_W } from "../web/client/sa.js";


const dir = new URL("../web/data/", import.meta.url);
const header = JSON.parse(readFileSync(new URL("adams.json", dir)));
const bin = readFileSync(new URL("adams.bin", dir));
const base = new ServiceArea(header, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const cases = JSON.parse(readFileSync(new URL("fixture.json", dir)));
const KS = process.argv.slice(2).map(Number);

// How each array changes from one copy to the next.
const { N, E, F } = base;
const OFFSET = { col: N, eu: N, ev: N, incEdges: E, faceEdges: E };  // index arrays
const PREFIX = ["rowptr", "vertOff", "faceOff", "incOff"];           // CSR offsets: drop the leading 0 of later copies
const NEEDED = ["rowptr", "col", "warc", "eu", "ev", "w", "vertOff", "vertXY", "vertP", "faceOff", "faceEdges", "incOff", "incEdges", "pieceN"];
let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
for (let i = 0; i < base.vertXY.length; i += 2) {
  x0 = Math.min(x0, base.vertXY[i]); x1 = Math.max(x1, base.vertXY[i]);
  y0 = Math.min(y0, base.vertXY[i + 1]); y1 = Math.max(y1, base.vertXY[i + 1]);
}
const PAD = 20000; // metres between copies: more than maxSnapM, so a point snaps only in its own copy

function tiled(k) {
  const cols = Math.ceil(Math.sqrt(k));
  const shift = (t) => [(t % cols) * (x1 - x0 + PAD), Math.floor(t / cols) * (y1 - y0 + PAD)];
  const arrays = {}, parts = [];
  let offset = 0;
  for (const name of NEEDED) {
    const src = base[name], a = header.arrays[name];
    const lead = PREFIX.includes(name) ? 1 : 0;
    const length = src.length + (k - 1) * (src.length - lead);
    const out = new src.constructor(length);
    for (let t = 0, at = 0; t < k; t++) {
      const from = t === 0 ? 0 : lead;
      const piece = src.subarray(from);
      if (name === "vertXY") {
        const [dx, dy] = shift(t);
        for (let i = 0; i < piece.length; i += 2) { out[at + i] = piece[i] + dx; out[at + i + 1] = piece[i + 1] + dy; }
      } else if (PREFIX.includes(name)) {
        const add = t * src[src.length - 1];
        for (let i = 0; i < piece.length; i++) out[at + i] = piece[i] + add;
      } else if (name in OFFSET) {
        const add = t * OFFSET[name];
        for (let i = 0; i < piece.length; i++) out[at + i] = piece[i] + add;
      } else out.set(piece, at);
      at += piece.length;
    }
    offset = Math.ceil(offset / 8) * 8;
    arrays[name] = { dtype: a.dtype, offset, length };
    parts.push([offset, out]);
    offset += out.byteLength;
  }
  const buf = new ArrayBuffer(offset);
  for (const [o, a] of parts) new Uint8Array(buf, o, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  const h = { ...header, nodes: k * N, edges: k * E, faces: k * F, arrays };
  return { sa: new ServiceArea(h, buf), shift };
}

// The client data size per copy, from the real header (bin = graph + snap geometry + mesh).
const meshBytes = ["mesh", "streetIdx", "diskIdx", "faceIdx"].reduce((s, n) => s + header.arrays[n].length * 4, 0);
const binBytes = bin.byteLength;

// What layer.js uploads after one solve: the marked rows (or every row, for an engine without marks).
function uploadBytes(sa) {
  if (!sa.dirty) return sa.edgeTex.byteLength + sa.nodeFlags.byteLength + sa.faceFlags.byteLength;
  let b = 0;
  for (const [name, bytes] of [["edge", 16 * TEX_W], ["node", TEX_W], ["face", TEX_W]]) {
    const d = sa.dirty[name];
    for (let r = 0; r < d.length; r++) if (d[r]) { b += bytes; d[r] = 0; }
  }
  return b;
}

const ms = (t) => (performance.now() - t);
const rows = [];
for (const k of KS.length ? KS : [1, 10, 30, 100]) {
  let t = performance.now();
  const { sa, shift } = tiled(k);
  const buildMs = ms(t);
  // each case runs in a pseudo-random copy, so caches see the whole network
  const runs = cases.map((c, i) => ({ c, tile: (i * 7919) % k }));
  const once = ({ c, tile }) => {
    const [dx, dy] = shift(tile);
    const s = sa.snap(c.mx + dx, c.my + dy);
    assert.equal(s.edge, c.ownEdge + tile * E, `k=${k} crash ${c.cid}: snapped edge`);
    sa.solve(c.edge + tile * E, c.frac, 10);
    for (const B of [1, 5, 10]) sa.flags(B);
  };
  runs.forEach(once); // warm
  uploadBytes(sa);
  let solveMs = 0, flagMs = 0, snapMs = 0, upBytes = 0;
  const PASSES = 3;
  for (let p = 0; p < PASSES; p++) for (const { c, tile } of runs) {
    const [dx, dy] = shift(tile);
    t = performance.now(); sa.snap(c.mx + dx, c.my + dy); snapMs += ms(t);
    t = performance.now(); sa.solve(c.edge + tile * E, c.frac, 10); solveMs += ms(t);
    t = performance.now(); sa.flags(10); flagMs += ms(t);
    upBytes += uploadBytes(sa);
    // costs must equal copy 0 (the fixture): the copies are independent
    const d = sa.dist;
    for (let n = 0; n < N; n++) {
      const want = c.dist[n] === null ? Infinity : c.dist[n];
      if (Math.abs(d[tile * N + n] - want) > 1e-9 && !(want === Infinity && d[tile * N + n] === Infinity)) {
        throw new Error(`k=${k} crash ${c.cid} node ${n}: ${d[tile * N + n]} != ${want}`);
      }
    }
  }
  const n = runs.length * PASSES;
  rows.push({ k, nodes: k * N, edges: k * E, buildMs, solve: solveMs / n, flags: flagMs / n, snap: snapMs / n,
    uploadMB: upBytes / n / 1e6, fullMB: (sa.edgeTex.byteLength + sa.nodeFlags.byteLength + sa.faceFlags.byteLength) / 1e6, binMB: (k * binBytes) / 1e6, meshMB: (k * meshBytes) / 1e6 });
}
const f = (x, d = 3) => x.toFixed(d).padStart(9);
console.log("    k    nodes    edges  solve10ms  flags10ms   snap ms  upload MB/solve (full)  bin MB  mesh MB  build ms");
for (const r of rows) {
  console.log(`${String(r.k).padStart(5)} ${String(r.nodes).padStart(8)} ${String(r.edges).padStart(8)} ${f(r.solve)}  ${f(r.flags)} ${f(r.snap)} ${f(r.uploadMB, 3)} ${f(r.fullMB, 2)}    ${f(r.binMB, 0)} ${f(r.meshMB, 0)} ${f(r.buildMs, 0)}`);
}
