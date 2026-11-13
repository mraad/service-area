// Station planner: where should k response stations go to reach the most crashes within B minutes?
// Candidates are the crash sites themselves. Ranking may use fp32 node costs (WebGPU); the reported
// coverage is recomputed in Float64 with ServiceArea.solve (fidelity first). No SDK imports: runs in Node.

import { polygon, union } from "./geom.js";

// Crash points (Web Mercator) snapped to the network; points beyond the snap limit are dropped.
export function crashSites(sa, points) {
  const sites = [];
  for (const p of points) {
    const s = sa.snap(p.mx, p.my);
    if (s) sites.push({ cid: p.cid, mx: p.mx, my: p.my, edge: s.edge, frac: s.frac });
  }
  return sites;
}

// Cost from one source to each site: the cheaper end of the site's edge, or along the source's own edge.
function costRow(sa, dist, off, src, sites, out, outOff) {
  const { eu, ev, w } = sa;
  for (let i = 0; i < sites.length; i++) {
    const { edge: e, frac: f } = sites[i];
    let c = Math.min(dist[off + eu[e]] + f * w[e], dist[off + ev[e]] + (1 - f) * w[e]);
    if (e === src.edge) c = Math.min(c, Math.abs(f - src.frac) * w[e]);
    out[outOff + i] = c;
  }
}

// solveMany(sources, cutoff) -> node costs, sources.length * N values (Infinity beyond cutoff).
export function cpuSolveMany(sa) {
  return async (sources, cutoff) => {
    const out = new Float32Array(sources.length * sa.N);
    sources.forEach((s, i) => out.set(sa.solve(s.edge, s.frac, cutoff), i * sa.N));
    return out;
  };
}

export function gpuSolveMany(sa, gpu) {
  return (sources, cutoff) => gpu.run(sources.map((s) => ({
    u: sa.eu[s.edge], v: sa.ev[s.edge], cu: s.frac * sa.w[s.edge], cv: (1 - s.frac) * sa.w[s.edge],
  })), cutoff);
}

// Station-to-site costs for every candidate (candidates = sites): Float32Array(S * S), row = station.
export async function candidateCosts(sa, sites, cutoff, solveMany, chunk = 512) {
  const S = sites.length, costs = new Float32Array(S * S);
  for (let a = 0; a < S; a += chunk) {
    const src = sites.slice(a, a + chunk);
    const dist = await solveMany(src, cutoff);
    src.forEach((s, i) => costRow(sa, dist, i * sa.N, s, sites, costs, (a + i) * S));
  }
  return costs;
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

// Greedy max coverage: each step adds the station that reaches the most sites not yet reached (cost <= B).
// Ties go to the lower index. Stops early when no station adds a site.
export function greedy(costs, S, B, k) {
  const words = Math.ceil(S / 32), bits = new Uint32Array(S * words), covered = new Uint32Array(words);
  for (let s = 0; s < S; s++) {
    for (let i = 0; i < S; i++) if (costs[s * S + i] <= B) bits[s * words + (i >>> 5)] |= 1 << (i & 31);
  }
  const picked = [], gains = [];
  for (let step = 0; step < k; step++) {
    let best = -1, bestGain = 0;
    for (let s = 0; s < S; s++) {
      let g = 0;
      for (let j = 0; j < words; j++) g += popcount(bits[s * words + j] & ~covered[j]);
      if (g > bestGain) { bestGain = g; best = s; }
    }
    if (best < 0) break;
    for (let j = 0; j < words; j++) covered[j] |= bits[best * words + j];
    picked.push(best); gains.push(bestGain);
  }
  return { picked, gains };
}

// Exact (Float64) best cost from the chosen stations to every site, and the share reached per break.
export function evaluate(sa, sites, stations, breaks = [1, 5, 10]) {
  const cutoff = Math.max(...breaks), best = new Float64Array(sites.length).fill(Infinity), row = new Float64Array(sites.length);
  for (const s of stations) {
    const src = sites[s];
    costRow(sa, sa.solve(src.edge, src.frac, cutoff), 0, src, sites, row, 0);
    for (let i = 0; i < row.length; i++) if (row[i] < best[i]) best[i] = row[i];
  }
  const reached = Object.fromEntries(breaks.map((B) => [B, best.reduce((n, c) => n + (c <= B), 0)]));
  return { best, reached, total: sites.length };
}

// Coverage polygon of the chosen stations at break B (EPSG:3735): Builder rules per station, then a GEOS union.
export function coverage(sa, geos, sites, stations, B) {
  return union(geos, stations.map((s) => {
    sa.solve(sites[s].edge, sites[s].frac, B);
    sa.flags(B);
    return polygon(sa, geos);
  }));
}
