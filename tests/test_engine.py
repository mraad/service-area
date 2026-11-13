"""GPU SSSP vs CPU heapq Dijkstra on a random planar grid; reached-interval math."""
import heapq
import os
import sys
import tempfile
import unittest

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import shapely

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cuda"))
import engine  # noqa: E402


def grid_edges(n, seed=3):
    rng = np.random.default_rng(seed)
    lines, w = [], []
    for i in range(n):
        for j in range(n):
            for di, dj in ((1, 0), (0, 1)):
                if i + di < n and j + dj < n and rng.random() < 0.85:
                    lines.append(shapely.LineString([(i * 100, j * 100), ((i + di) * 100, (j + dj) * 100)]))
                    w.append(rng.uniform(0.05, 0.6))
    return lines, np.array(w)


def write(lines, w, path):
    pq.write_table(pa.table({"EID": np.arange(1, len(w) + 1), "MTFCC": ["S1400"] * len(w),
                             "Minutes": w, "length_ft": [g.length for g in lines],
                             "wkb": shapely.to_wkb(np.array(lines, dtype=object))}), path)


def dijkstra(g, e, frac, cutoff):
    d = np.full(g.N, np.inf)
    pq_ = []
    for node, c in ((g.eu[e], frac * g.wb[e] if np.isfinite(g.wb[e]) else (0.0 if frac == 0 else np.inf)),
                    (g.ev[e], (1 - frac) * g.wf[e] if np.isfinite(g.wf[e]) else (0.0 if frac == 1 else np.inf))):
        if c <= cutoff and c < d[node]:
            d[node] = c
            heapq.heappush(pq_, (c, node))
    while pq_:
        c, i = heapq.heappop(pq_)
        if c > d[i]:
            continue
        for a in range(g.rowptr[i], g.rowptr[i + 1]):
            nd = c + g.warc[a]
            j = g.col[a]
            if nd <= cutoff and nd < d[j]:
                d[j] = nd
                heapq.heappush(pq_, (nd, j))
    return d


class EngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = os.path.join(cls.tmp.name, "edges.parquet")
        write(*grid_edges(40), path)
        cls.g = engine.Graph(path)

    def test_sssp_matches_dijkstra(self):
        rng = np.random.default_rng(1)
        F = 64
        e = rng.integers(0, len(self.g.w), F)
        frac = rng.random(F)
        for cutoff in (1.0, 5.0, 1e9):
            dist = self.g.sssp(e, frac, cutoff).get()
            for f in range(F):
                ref = dijkstra(self.g, e[f], frac[f], cutoff)
                np.testing.assert_array_equal(np.isinf(dist[f]), np.isinf(ref))
                fin = np.isfinite(ref)
                np.testing.assert_allclose(dist[f][fin], ref[fin], rtol=0, atol=1e-12)

    def test_reached_intervals(self):
        # single edge 0..1000 ft, 1 minute; facility at 0.3; breaks 0.2 and 1.0
        tmp = os.path.join(self.tmp.name, "one.parquet")
        write([shapely.LineString([(0, 0), (1000, 0)])], np.array([1.0]), tmp)
        g = engine.Graph(tmp)
        dist = g.sssp([0], [0.3], 1.0)
        r = g.reached(dist, [0], [0.3], [0.2, 1.0])
        rows = [dict(zip(r, vals)) for vals in zip(*r.values())]
        by_b = {row["brk"]: engine.intervals(row["a1"], row["b0"], row["s0"], row["s1"]) for row in rows}
        np.testing.assert_allclose(by_b[0.2], [[0.1, 0.5]])
        np.testing.assert_allclose(by_b[1.0], [[0.0, 1.0]])
        # Own edges must survive selection even when neither endpoint is reached.
        dist = g.sssp([0, 0], [0.3, 0.7], 0.1)
        r = g.reached(dist, [0, 0], [0.3, 0.7], [0.1])
        np.testing.assert_array_equal(r["fac"], [0, 1])
        np.testing.assert_array_equal(r["edge"], [0, 0])
        np.testing.assert_allclose(r["s0"], [0.2, 0.6])
        np.testing.assert_allclose(r["s1"], [0.4, 0.8])


class DirectedTest(unittest.TestCase):
    """Graph.from_arrays: node ids, one cost per direction, one-way streets (inf)."""

    def test_sssp_matches_dijkstra(self):
        rng = np.random.default_rng(5)
        n = 30
        u, v = [], []
        for i in range(n):
            for j in range(n):
                for di, dj in ((1, 0), (0, 1)):
                    if i + di < n and j + dj < n and rng.random() < 0.9:
                        u.append(1000 + i * n + j)          # node ids need not start at 0
                        v.append(1000 + (i + di) * n + j + dj)
        E = len(u)
        wf, wb = rng.uniform(0.05, 0.6, E), rng.uniform(0.05, 0.6, E)  # a different cost per direction
        wf[rng.random(E) < 0.15] = np.inf                                # one-way against the edge
        wb[rng.random(E) < 0.15] = np.inf                                # one-way along the edge (some closed both ways)
        g = engine.Graph.from_arrays(np.arange(E), np.array(u), np.array(v), wf, wb)
        F = 64
        e, frac = rng.integers(0, E, F), rng.random(F)
        frac[:8] = [0.0, 1.0] * 4  # facilities that stand on a node
        for cutoff in (1.0, 5.0, 1e9):
            dist = g.sssp(e, frac, cutoff).get()
            for f in range(F):
                ref = dijkstra(g, e[f], frac[f], cutoff)
                np.testing.assert_array_equal(np.isinf(dist[f]), np.isinf(ref))
                fin = np.isfinite(ref)
                np.testing.assert_allclose(dist[f][fin], ref[fin], rtol=0, atol=1e-12)

    def test_one_way_intervals(self):
        # nodes 1 - 2 - 3. Edge 0: 1 <-> 2, 2 min along, 4 min against. Edge 1: 2 -> 3 only, 4 min.
        g = engine.Graph.from_arrays([10, 20], np.array([1, 2]), np.array([2, 3]), [2.0, 4.0], [4.0, np.inf])
        r = g.reached(g.sssp([0], [0.5], 10.0), [0], [0.5], [1.0, 5.0])
        rows = {(b, e): dict(zip(r, vals)) for vals, b, e in zip(zip(*r.values()), r["brk"], r["edge"])}
        np.testing.assert_allclose([rows[(1.0, 0)]["s0"], rows[(1.0, 0)]["s1"]], [0.25, 1.0])  # 1 min: 0.25 back, 0.5 on
        self.assertNotIn((1.0, 1), rows)                       # node 2 costs exactly 1 min
        np.testing.assert_allclose(rows[(5.0, 1)]["a1"], 1.0)  # 1 + 4 = 5 min: all of edge 1
        self.assertEqual(rows[(5.0, 1)]["b0"], 2.0)            # never against the one-way
        # start on the one-way edge: forward only, nothing behind it
        r = g.reached(g.sssp([1], [0.5], 10.0), [1], [0.5], [1.0, 10.0])
        np.testing.assert_array_equal(r["edge"], [1, 1])
        np.testing.assert_allclose(r["s0"], [0.5, 0.5])
        np.testing.assert_allclose(r["s1"], [0.75, 1.0])
        # start at frac 0 of the one-way edge: it stands on node 2, so edge 0 is reached against its direction (4 min)
        r = g.reached(g.sssp([1], [0.0], 10.0), [1], [0.0], [1.0])
        rows = {e: dict(zip(r, vals)) for vals, e in zip(zip(*r.values()), r["edge"])}
        np.testing.assert_allclose(rows[0]["b0"], 0.75)
        np.testing.assert_allclose([rows[1]["s0"], rows[1]["s1"]], [0.0, 0.25])


if __name__ == "__main__":
    unittest.main()
