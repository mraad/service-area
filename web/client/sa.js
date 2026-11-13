// Browser service-area engine: snap, shortest paths (Float64, same arithmetic as cuda/engine.py)
// and the polygon-part flags of cuda/polygons.py (Builder.classify). No SDK imports: runs in Node too.

const TYPES = { uint8: Uint8Array, int32: Int32Array, uint32: Uint32Array, float32: Float32Array, float64: Float64Array };
export const POS_EPS = 1e-9; // same as cuda/polygons.py
const CELL_M = 500; // snap grid cell (Web Mercator metres)
export const TEX_W = 1024; // per-edge / per-node / per-face data go to the GPU as TEX_W-wide textures
const R_EARTH = 6378137;
const E2 = 0.00669438002290; // GRS80 first eccentricity squared

export class ServiceArea {
  constructor(header, buffer) {
    this.header = header;
    for (const [name, a] of Object.entries(header.arrays)) {
      this[name] = new TYPES[a.dtype](buffer, a.offset, a.length);
    }
    this.N = header.nodes;
    this.E = header.edges;
    this.F = header.faces;
    this.dist = new Float64Array(this.N).fill(Infinity); // solve() resets only the nodes it reached
    this.heapNode = new Int32Array(this.col.length + 2); // at most one push per arc relaxation + two seeds
    this.heapCost = new Float64Array(this.col.length + 2);
    this.full = new Uint8Array(this.E);
    this.nodeHit = new Uint8Array(this.N);
    const texels = (n) => Math.ceil(n / TEX_W) * TEX_W; // whole texture rows
    this.nodeFlags = new Uint8Array(texels(this.N));
    this.faceFlags = new Uint8Array(texels(this.F));
    this.edgeTex = new Float32Array(texels(this.E) * 4); // cu, cv, w, pieces (pieceN): one texel per edge
    for (let e = 0; e < this.E; e++) {
      this.edgeTex[4 * e] = this.edgeTex[4 * e + 1] = 1e30; this.edgeTex[4 * e + 2] = this.w[e]; this.edgeTex[4 * e + 3] = this.pieceN[e];
    }
    // Per-call work is kept to the reached area: lists of what the last solve()/flags() touched are reset
    // instead of whole arrays, and changed texture rows are marked for layer.js (uploads only those rows).
    this.touched = new Int32Array(this.N); this.nTouched = 0;      // nodes with a finite dist
    this.texEdges = new Int32Array(this.E); this.nTex = 0;         // edges written to edgeTex
    this.inTex = new Uint8Array(this.E);
    this.hitNodes = new Int32Array(this.N); this.nHit = 0;
    this.onNodes = new Int32Array(this.N); this.nOn = 0;           // nodeFlags set
    this.onFaces = new Int32Array(this.F); this.nOnF = 0;          // faceFlags set
    this.faceSeen = new Uint8Array(this.F);
    this.nearNodes = [];
    this.pieces = []; // [edge, lo, hi] of every reached piece after flags(): Builder.classify segs, for geom.js
    this.dirty = { edge: new Uint8Array(texels(this.E) / TEX_W), node: new Uint8Array(texels(this.N) / TEX_W),
      face: new Uint8Array(texels(this.F) / TEX_W) };
    this.dirty.edge.fill(1); this.dirty.node.fill(1); this.dirty.face.fill(1); // first upload: everything
    this.pieceOff = new Int32Array(this.E + 1); // street pieces of the nearest-street cells: edge e has pieceN[e]
    for (let e = 0; e < this.E; e++) this.pieceOff[e + 1] = this.pieceOff[e] + this.pieceN[e];
    this.#buildEdgeFaces();
    this.#buildGrid();
  }

  static async load(baseUrl) {
    const get = async (url, kind) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r[kind]();
    };
    const [header, buffer] = await Promise.all([get(`${baseUrl}.json`, "json"), get(`${baseUrl}.bin`, "arrayBuffer")]);
    return new ServiceArea(header, buffer);
  }

  #buildEdgeFaces() { // edge -> faces whose boundary or inside holds it (inverse of faceOff/faceEdges)
    const { faceOff, faceEdges, E, F } = this;
    const off = new Int32Array(E + 1);
    for (let k = 0; k < faceEdges.length; k++) off[faceEdges[k] + 1]++;
    for (let e = 0; e < E; e++) off[e + 1] += off[e];
    const fill = off.slice(0, -1), items = new Int32Array(faceEdges.length);
    for (let f = 0; f < F; f++) for (let k = faceOff[f]; k < faceOff[f + 1]; k++) items[fill[faceEdges[k]]++] = f;
    this.efOff = off; this.efFaces = items;
  }

  #buildGrid() {
    const { vertOff, vertXY, E } = this;
    const nSeg = vertXY.length / 2 - E;
    this.segEdge = new Int32Array(nSeg);
    this.segVert = new Int32Array(nSeg); // index of the segment's first vertex
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, s = 0;
    for (let e = 0; e < E; e++) {
      for (let v = vertOff[e]; v < vertOff[e + 1]; v++) {
        const x = vertXY[2 * v], y = vertXY[2 * v + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (v + 1 < vertOff[e + 1]) { this.segEdge[s] = e; this.segVert[s++] = v; }
      }
    }
    this.gx0 = x0; this.gy0 = y0;
    this.gw = Math.floor((x1 - x0) / CELL_M) + 1;
    this.gh = Math.floor((y1 - y0) / CELL_M) + 1;
    const cells = (seg, fn) => {
      const v = this.segVert[seg];
      const ax = vertXY[2 * v], ay = vertXY[2 * v + 1], bx = vertXY[2 * v + 2], by = vertXY[2 * v + 3];
      const cx0 = Math.floor((Math.min(ax, bx) - x0) / CELL_M), cx1 = Math.floor((Math.max(ax, bx) - x0) / CELL_M);
      const cy0 = Math.floor((Math.min(ay, by) - y0) / CELL_M), cy1 = Math.floor((Math.max(ay, by) - y0) / CELL_M);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * this.gw + cx);
    };
    const off = new Int32Array(this.gw * this.gh + 1);
    for (let seg = 0; seg < nSeg; seg++) cells(seg, (c) => off[c + 1]++);
    for (let c = 0; c < off.length - 1; c++) off[c + 1] += off[c];
    const fill = off.slice(0, -1);
    const items = new Int32Array(off[off.length - 1]);
    for (let seg = 0; seg < nSeg; seg++) cells(seg, (c) => { items[fill[c]++] = seg; });
    this.cellOff = off; this.cellSeg = items;
  }

  // Nearest edge to a Web Mercator point. Returns {edge, frac, snapM} or null beyond maxSnapM (ground metres).
  snap(mx, my) {
    const { vertXY, vertP, gw, gh } = this;
    // Web Mercator is not conformal on the ellipsoid: its north-south scale is N/M times its east-west
    // scale (0.4% here). ky makes distances isotropic on the ground, so the nearest point matches EPSG:3735.
    const sin2 = Math.tanh(my / R_EARTH) ** 2; // sin^2(latitude)
    const ky = (1 - E2) / (1 - E2 * sin2);
    const scale = Math.cosh(my / R_EARTH) * Math.sqrt(1 - E2 * sin2); // east-west Mercator metres per ground metre
    const maxD = this.header.maxSnapM * scale;
    const pcx = Math.floor((mx - this.gx0) / CELL_M), pcy = Math.floor((my - this.gy0) / CELL_M);
    let best = Infinity, bestSeg = -1, bestT = 0;
    const scan = (cx, cy) => {
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) return;
      const c = cy * gw + cx;
      for (let k = this.cellOff[c]; k < this.cellOff[c + 1]; k++) {
        const seg = this.cellSeg[k], v = this.segVert[seg];
        const ax = vertXY[2 * v], ay = vertXY[2 * v + 1];
        const dx = vertXY[2 * v + 2] - ax, dy = (vertXY[2 * v + 3] - ay) * ky;
        const qy = (my - ay) * ky;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((mx - ax) * dx + qy * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - mx, ey = t * dy - qy;
        const d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; bestSeg = seg; bestT = t; }
      }
    };
    const maxRing = Math.ceil(maxD / CELL_M) + 1;
    for (let r = 0; r <= maxRing; r++) {
      if (r === 0) scan(pcx, pcy);
      else {
        for (let i = -r; i <= r; i++) { scan(pcx + i, pcy - r); scan(pcx + i, pcy + r); }
        for (let i = -r + 1; i < r; i++) { scan(pcx - r, pcy + i); scan(pcx + r, pcy + i); }
      }
      // every segment nearer than r cells (in the ky-scaled metric) was in a scanned ring
      if (best <= (r * CELL_M * ky) ** 2) break;
    }
    if (bestSeg < 0 || best > maxD * maxD) return null;
    const v = this.segVert[bestSeg];
    // Ground length along a Mercator segment is proportional to the latitude change (integral of
    // sech(y/R) dy), not to t: Mercator scale grows with latitude. Without this, long north-south
    // segments put the position off by ~1e-4 of the edge against EPSG:3735.
    const lat = (y) => Math.atan(Math.sinh(y / R_EARTH));
    const ya = vertXY[2 * v + 1], yb = vertXY[2 * v + 3];
    const la = lat(ya), lb = lat(yb);
    const t = Math.abs(lb - la) > 1e-12 ? (lat(ya + bestT * (yb - ya)) - la) / (lb - la) : bestT;
    return { edge: this.segEdge[bestSeg], frac: vertP[v] + t * (vertP[v + 1] - vertP[v]), snapM: Math.sqrt(best) / scale };
  }

  // Node costs (minutes) from a point at (edge, frac), Infinity beyond cutoff. Same seeds and pruning as Graph.sssp.
  solve(edge, frac, cutoff) {
    const { dist, rowptr, col, warc, heapNode, heapCost, touched } = this;
    for (let i = 0; i < this.nTouched; i++) dist[touched[i]] = Infinity;
    let n = 0, nt = 0;
    const reach = (node, cost) => { if (dist[node] === Infinity) touched[nt++] = node; dist[node] = cost; };
    const push = (node, cost) => {
      let i = n++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapCost[p] <= cost) break;
        heapCost[i] = heapCost[p]; heapNode[i] = heapNode[p]; i = p;
      }
      heapCost[i] = cost; heapNode[i] = node;
    };
    const w = this.w[edge];
    for (const [node, c] of [[this.eu[edge], frac * w], [this.ev[edge], (1 - frac) * w]]) {
      if (c <= cutoff && c < dist[node]) { reach(node, c); push(node, c); }
    }
    while (n > 0) {
      const node = heapNode[0], cost = heapCost[0];
      const lastC = heapCost[--n], lastN = heapNode[n];
      let i = 0;
      for (;;) { // sift the last item down from the root
        let k = 2 * i + 1;
        if (k >= n) break;
        if (k + 1 < n && heapCost[k + 1] < heapCost[k]) k++;
        if (heapCost[k] >= lastC) break;
        heapCost[i] = heapCost[k]; heapNode[i] = heapNode[k]; i = k;
      }
      heapCost[i] = lastC; heapNode[i] = lastN;
      if (cost > dist[node]) continue; // stale entry
      for (let a = rowptr[node]; a < rowptr[node + 1]; a++) {
        const nd = cost + warc[a], j = col[a];
        if (nd <= cutoff && nd < dist[j]) { reach(j, nd); push(j, nd); }
      }
    }
    this.nTouched = nt;
    this.edge = edge; this.frac = frac;
    return dist;
  }

  // Node costs from another solver (WebGPU: Float32Array, values at d[off..off+N)): leaves the same state
  // as solve(), so flags() can run on them.
  setDist(d, off, edge, frac) {
    const { dist, touched } = this;
    for (let i = 0; i < this.nTouched; i++) dist[touched[i]] = Infinity;
    let nt = 0;
    for (let n = 0; n < this.N; n++) if (d[off + n] !== Infinity) { dist[n] = d[off + n]; touched[nt++] = n; }
    this.nTouched = nt; this.edge = edge; this.frac = frac;
  }

  // After solve(): fills edgeTex (cu, cv per edge), nodeFlags (255 disk, 100 node of a reached end piece without a disk)
  // and faceFlags (255 filled block) for break B.
  // Interval rules are those of Graph.reached + intervals + Builder.classify. Only edges incident to reached
  // nodes (and the own edge) can hold an interval; every other edge keeps cu = cv = 1e30 and no flags.
  flags(B) {
    const { dist, eu, ev, w, full, nodeHit, nodeFlags, faceFlags, edgeTex, incOff, incEdges, faceOff, faceEdges, pieceN,
      texEdges, inTex, hitNodes, onNodes, onFaces, faceSeen, efOff, efFaces, dirty } = this;
    const row = (i) => (i / TEX_W) | 0;
    for (let k = 0; k < this.nTex; k++) {
      const e = texEdges[k];
      edgeTex[4 * e] = edgeTex[4 * e + 1] = 1e30; full[e] = 0; inTex[e] = 0; dirty.edge[row(e)] = 1;
    }
    for (let k = 0; k < this.nHit; k++) nodeHit[hitNodes[k]] = 0;
    for (const n of this.nearNodes) { nodeFlags[n] = 0; dirty.node[row(n)] = 1; }
    const nearNodes = (this.nearNodes = []); // nodes whose end piece (first or last 50 ft piece of an edge) is reached
    for (let k = 0; k < this.nOnF; k++) { faceFlags[onFaces[k]] = 0; dirty.face[row(onFaces[k])] = 1; }
    let nTex = 0, nHit = 0, nOn = 0, nOnF = 0;
    const pieces = (this.pieces = []);
    const add = (e) => { if (!inTex[e]) { inTex[e] = 1; texEdges[nTex++] = e; } };
    if (this.edge !== undefined) add(this.edge);
    for (let i = 0; i < this.nTouched; i++) {
      const n = this.touched[i];
      for (let k = incOff[n]; k < incOff[n + 1]; k++) add(incEdges[k]);
    }
    const hit = (n) => { if (!nodeHit[n]) { nodeHit[n] = 1; hitNodes[nHit++] = n; } };
    const clip = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
    const fullEdges = [];
    for (let t = 0; t < nTex; t++) {
      const e = texEdges[t];
      const c0 = dist[eu[e]], c1 = dist[ev[e]], we = w[e];
      edgeTex[4 * e] = c0 === Infinity ? 1e30 : c0;
      edgeTex[4 * e + 1] = c1 === Infinity ? 1e30 : c1;
      dirty.edge[row(e)] = 1;
      if (c0 >= B && c1 >= B && e !== this.edge) continue;
      // up to three intervals: [0,a1] from the start node, [b0,1] from the end node, [s0,s1] on the own edge
      const iv = [];
      if (c0 < B) iv.push([0, clip((B - c0) / we)]);
      if (c1 < B) iv.push([clip(1 - (B - c1) / we), 1]);
      if (e === this.edge) iv.push([clip(this.frac - B / we), clip(this.frac + B / we)]);
      if (!iv.length) continue;
      iv.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      let lo = iv[0][0], hi = iv[0][1];
      const close = () => {
        if (hi - lo <= POS_EPS) return;
        pieces.push([e, lo, hi]);
        if (lo <= POS_EPS && hi >= 1 - POS_EPS && !full[e]) { full[e] = 1; fullEdges.push(e); }
        if (lo <= POS_EPS) hit(eu[e]);
        if (hi >= 1 - POS_EPS) hit(ev[e]);
        // Builder keeps the whole cell of a piece reached in part, also the ground behind the node
        if (lo * pieceN[e] < 1) nearNodes.push(eu[e]);
        if (hi * pieceN[e] > pieceN[e] - 1) nearNodes.push(ev[e]);
      };
      for (let k = 1; k < iv.length; k++) {
        if (iv[k][0] <= hi) { if (iv[k][1] > hi) hi = iv[k][1]; } else { close(); lo = iv[k][0]; hi = iv[k][1]; }
      }
      close();
    }
    for (let h = 0; h < nHit; h++) {
      const n = hitNodes[h];
      let ok = 1;
      if (incOff[n + 1] - incOff[n] !== 1) { // not a dead end: every incident edge must be full
        for (let k = incOff[n]; k < incOff[n + 1]; k++) if (!full[incEdges[k]]) { ok = 0; break; }
      }
      if (ok) { nodeFlags[n] = 255; onNodes[nOn++] = n; }
    }
    for (const n of nearNodes) { if (!nodeFlags[n]) nodeFlags[n] = 100; dirty.node[row(n)] = 1; }
    const seen = [];
    for (const e of fullEdges) { // only blocks touching a full edge can be filled
      for (let j = efOff[e]; j < efOff[e + 1]; j++) {
        const f = efFaces[j];
        if (faceSeen[f]) continue;
        faceSeen[f] = 1; seen.push(f);
        let ok = 1;
        for (let k = faceOff[f]; ok && k < faceOff[f + 1]; k++) if (!full[faceEdges[k]]) ok = 0;
        if (ok) { faceFlags[f] = 255; onFaces[nOnF++] = f; dirty.face[row(f)] = 1; }
      }
    }
    for (const f of seen) faceSeen[f] = 0;
    this.nTex = nTex; this.nHit = nHit; this.nOn = nOn; this.nOnF = nOnF;
  }
}
