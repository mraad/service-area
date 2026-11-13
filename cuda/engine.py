"""CUDA service-area engine: CSR graph, batched bounded SSSP (one block per facility), reached intervals.

Graph and costs come from edges.parquet (the same noded Streets the ArcGIS ND is built on), or from
arrays with node ids and one cost per direction (Graph.from_arrays).
Costs are fp64 so cumulative minutes match Network Analyst to ~1e-12.
"""
import cupy as cp
import numpy as np
import pyarrow.parquet as pq
import shapely

MAX_SNAP_FT = 5000 / 0.3048006096012192  # ArcGIS search tolerance (5000 m); farther points are unlocated

_SRC = r"""
extern "C" __global__
void sssp(const int* __restrict__ rowptr, const int* __restrict__ col, const double* __restrict__ w,
          int N, const int* __restrict__ seed_u, const int* __restrict__ seed_v,
          const double* __restrict__ seed_cu, const double* __restrict__ seed_cv, double cutoff,
          double* dist, int* qa, int* qb, int* inq)
{
    // Worklist Bellman-Ford for facility blockIdx.x. Exact shortest paths for nodes <= cutoff.
    const size_t off = (size_t)blockIdx.x * N;
    volatile double* d = dist + off;
    int* cur = qa + off; int* nxt = qb + off; int* in = inq + off;
    __shared__ int ncur, nnext;
    for (int i = threadIdx.x; i < N; i += blockDim.x) { d[i] = __longlong_as_double(0x7ff0000000000000LL); in[i] = 0; }
    __syncthreads();
    if (threadIdx.x == 0) {
        int u = seed_u[blockIdx.x], v = seed_v[blockIdx.x];
        double cu = seed_cu[blockIdx.x], cv = seed_cv[blockIdx.x];
        ncur = 0;
        if (cu <= cutoff) { d[u] = cu; cur[ncur++] = u; }
        if (cv <= cutoff) { if (v == u) { if (cv < d[u]) d[u] = cv; if (ncur == 0) cur[ncur++] = u; }
                            else { d[v] = cv; cur[ncur++] = v; } }
        nnext = 0;
    }
    __syncthreads();
    while (ncur > 0) {
        for (int k = threadIdx.x; k < ncur; k += blockDim.x) {
            int i = cur[k];
            double di = d[i];
            for (int a = rowptr[i]; a < rowptr[i + 1]; ++a) {
                double nd = di + w[a];
                if (nd > cutoff) continue;
                int j = col[a];
                unsigned long long* p = (unsigned long long*)(dist + off + j);
                unsigned long long nb = (unsigned long long)__double_as_longlong(nd);
                // non-negative doubles order like their bit patterns
                if (atomicMin(p, nb) > nb) {
                    if (atomicExch(in + j, 1) == 0) nxt[atomicAdd(&nnext, 1)] = j;
                }
            }
        }
        __syncthreads();
        for (int k = threadIdx.x; k < nnext; k += blockDim.x) in[nxt[k]] = 0;
        __syncthreads();
        if (threadIdx.x == 0) { ncur = nnext; nnext = 0; }
        int* t = cur; cur = nxt; nxt = t;
        __syncthreads();
    }
}
"""
_kernel = cp.RawKernel(_SRC, "sssp")


class Graph:
    """Street graph. Edge e runs from node eu[e] to node ev[e] (its digitized direction).

    wf[e] is the cost of travel eu -> ev, wb[e] of travel ev -> eu; inf where that travel is not allowed.
    w is wf (the two are equal for a network with one cost per street).
    """

    def __init__(self, edges_parquet):
        t = pq.read_table(edges_parquet)
        w = t["Minutes"].to_numpy().astype(np.float64)
        geom = shapely.from_wkb(np.array(t["wkb"].to_pylist(), dtype=object))
        geom = shapely.force_2d(shapely.line_merge(geom))
        a = shapely.get_coordinates(shapely.get_point(geom, 0))
        b = shapely.get_coordinates(shapely.get_point(geom, -1))
        # prep/01 runs Integrate at the ND XY tolerance, so connected ends are bit-identical.
        _, node = np.unique(np.vstack([a, b]), axis=0, return_inverse=True)
        node = node.ravel()
        self._build(t["EID"].to_numpy(), node[:len(w)], node[len(w):], w, w, geom)

    @classmethod
    def from_arrays(cls, eid, node_u, node_v, wf, wb, geom=None):
        """Graph from node ids and one cost per direction. Without geom: no snapping and no polygons."""
        g = cls.__new__(cls)
        g.node_id, node = np.unique(np.concatenate([node_u, node_v]), return_inverse=True)
        g._build(eid, node[:len(node_u)], node[len(node_u):], wf, wb, geom)
        return g

    def _build(self, eid, eu, ev, wf, wb, geom):
        self.eid = np.asarray(eid).astype(np.int64)
        self.wf, self.wb = np.asarray(wf, np.float64), np.asarray(wb, np.float64)
        self.w = self.wf
        self.geom = geom
        self.eid_to_idx = {int(e): i for i, e in enumerate(self.eid)}
        self.eu, self.ev = eu.astype(np.int32), ev.astype(np.int32)
        self.N = int(max(eu.max(), ev.max())) + 1
        fwd, back = np.isfinite(self.wf), np.isfinite(self.wb)  # only allowed travel becomes an arc
        src = np.concatenate([self.eu[fwd], self.ev[back]])
        dst = np.concatenate([self.ev[fwd], self.eu[back]])
        wt = np.concatenate([self.wf[fwd], self.wb[back]])
        order = np.argsort(src, kind="stable")
        rowptr = np.zeros(self.N + 1, np.int32)
        np.add.at(rowptr, src + 1, 1)
        self.rowptr = np.cumsum(rowptr).astype(np.int32)
        self.col = dst[order].astype(np.int32)
        self.warc = wt[order]
        self.tree = shapely.STRtree(geom) if geom is not None else None
        self._dev = None  # device arrays, uploaded on first GPU use (CPU-only workers never touch CUDA)

    def dev(self):
        if self._dev is None:
            self._dev = tuple(cp.asarray(x) for x in (self.rowptr, self.col, self.warc, self.eu, self.ev, self.wf, self.wb))
        return self._dev

    def locate(self, x, y):
        """Nearest edge, normalized position along it (Esri PosAlong), and snap distance (ft).

        Callers drop points with snap distance > MAX_SNAP_FT, as ArcGIS leaves them unlocated.
        """
        pts = shapely.points(np.asarray(x, float), np.asarray(y, float))
        idx = self.tree.nearest(pts)
        frac = shapely.line_locate_point(self.geom[idx], pts, normalized=True)
        snap = shapely.distance(self.geom[idx], pts)
        return np.asarray(idx, np.int64), np.asarray(frac, np.float64), np.asarray(snap, np.float64)

    def sssp(self, edge_idx, frac, cutoff, threads=256):
        """Node costs (F x N, device fp64, inf beyond cutoff) from facilities at (edge, frac)."""
        F = len(edge_idx)
        edge_idx = np.asarray(edge_idx)
        frac = np.asarray(frac, np.float64)
        su = cp.asarray(self.eu[edge_idx])
        sv = cp.asarray(self.ev[edge_idx])
        wf, wb = self.wf[edge_idx], self.wb[edge_idx]
        # To the start node against the edge direction, to the end node along it; inf (no seed) where that
        # travel is not allowed. A facility at frac 0 or 1 stands on the node: it costs 0 in every case.
        cu = cp.asarray(np.where(np.isfinite(wb), frac * np.where(np.isfinite(wb), wb, 0.0), np.where(frac == 0.0, 0.0, np.inf)))
        cv = cp.asarray(np.where(np.isfinite(wf), (1.0 - frac) * np.where(np.isfinite(wf), wf, 0.0), np.where(frac == 1.0, 0.0, np.inf)))
        dist = cp.empty((F, self.N), cp.float64)
        qa = cp.empty((F, self.N), cp.int32)
        qb = cp.empty((F, self.N), cp.int32)
        inq = cp.empty((F, self.N), cp.int32)
        d_rowptr, d_col, d_w = self.dev()[:3]
        _kernel((F,), (threads,), (d_rowptr, d_col, d_w, np.int32(self.N),
                                    su, sv, cu, cv, np.float64(cutoff), dist, qa, qb, inq))
        return dist

    def reached(self, dist, edge_idx, frac, breaks):
        """Reached edge intervals per facility and break.

        Returns dict of host arrays: fac, brk, edge, a1, b0, c0, c1, s0, s1 where
        [0,a1] is reached from the edge's start node (cost c0 there; a1 = -1 if not reached),
        [b0,1] from its end node (cost c1; b0 = 2 if not reached), and on the facility's own edge
        [s0,s1] from the facility itself (s0 > s1 if not the own edge).
        Positions are normalized along the digitized direction.
        [0,a1] is travel along the edge (cost wf), [b0,1] against it (cost wb); a direction that is not
        allowed (inf) gives no interval, and the own interval does not grow on that side.
        """
        out = {k: [] for k in ("fac", "brk", "edge", "a1", "b0", "c0", "c1", "s0", "s1")}
        cutoff = max(breaks)
        _, _, _, d_eu, d_ev, d_wf, d_wb = self.dev()
        cu = dist[:, d_eu]  # F x E
        cv = dist[:, d_ev]
        hit = (cu < cutoff) | (cv < cutoff)
        own_f = cp.arange(len(edge_idx))
        own_e = cp.asarray(np.asarray(edge_idx))
        hit[own_f, own_e] = True
        f_idx, e_idx = cp.nonzero(hit)
        c0, c1, wf, wb = cu[f_idx, e_idx], cv[f_idx, e_idx], d_wf[e_idx], d_wb[e_idx]
        fr = cp.asarray(np.asarray(frac, np.float64))[f_idx]
        own = e_idx == own_e[f_idx]
        for B in breaks:
            a1 = cp.clip((B - c0) / wf, 0.0, 1.0)
            b0 = cp.clip(1.0 - (B - c1) / wb, 0.0, 1.0)
            a1 = cp.where(cp.isfinite(c0) & (c0 < B) & cp.isfinite(wf), a1, -1.0)  # -1: start side not reached
            b0 = cp.where(cp.isfinite(c1) & (c1 < B) & cp.isfinite(wb), b0, 2.0)   # 2: end side not reached
            s0 = cp.where(own, cp.clip(fr - B / wb, 0.0, 1.0), 2.0)  # own-edge interval [s0,s1]; B / inf = 0
            s1 = cp.where(own, cp.clip(fr + B / wf, 0.0, 1.0), -1.0)
            keep = (a1 >= 0) | (b0 <= 1) | (s0 <= s1)
            out["fac"].append(cp.asnumpy(f_idx[keep]))
            out["brk"].append(np.full(out["fac"][-1].size, B, np.float64))
            out["edge"].append(cp.asnumpy(e_idx[keep]))
            for k, v in (("a1", a1), ("b0", b0), ("c0", c0), ("c1", c1), ("s0", s0), ("s1", s1)):
                out[k].append(cp.asnumpy(v[keep]))
        return {k: np.concatenate(v) for k, v in out.items()}


def intervals(a1, b0, s0, s1):
    """Merge one reached record (see Graph.reached) into disjoint [lo, hi] intervals along the edge."""
    iv = []
    if a1 >= 0:
        iv.append([0.0, float(a1)])
    if b0 <= 1:
        iv.append([float(b0), 1.0])
    if s0 <= s1:
        iv.append([float(s0), float(s1)])
    iv.sort()
    merged = []
    for lo, hi in iv:
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return merged
