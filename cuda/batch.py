"""Batch CUDA service areas for a county.

usage: python cuda/batch.py Adams [--locations esri|own] [--chunk 2048] [--workers N] [--no-polygons]

Reads work/<County>/edges.parquet and esri_facilities.parquet (facility set + Esri locations) or
crashes.parquet (own snapping). Writes cuda_reached_<mode>.parquet, cuda_polygons_<mode>.parquet,
cuda_timing_<mode>.json. Shortest paths run on the GPU; polygons on a CPU process pool.
"""
import json
import hashlib
import multiprocessing as mp
import os
import sys
import time

import cupy as cp
import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import shapely

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import MAX_SNAP_FT, Graph, intervals  # noqa: E402
from polygons import Builder  # noqa: E402

BREAKS = [1.0, 5.0, 10.0]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def located_esri(d):
    """Esri facilities that the solver located (Status 0); others have SourceOID -1."""
    t = pq.read_table(os.path.join(d, "esri_facilities.parquet"))
    return t.filter(pc.equal(t["Status"], 0))


def facilities(g, d, mode):
    """CID, edge index, frac for each facility."""
    fac = os.path.join(d, "esri_facilities.parquet")
    if mode == "esri":
        t = located_esri(d)
        cid = np.array([int(n) for n in t["Name"].to_pylist()])
        edge = np.array([g.eid_to_idx[int(s)] for s in t["SourceOID"].to_pylist()])
        return cid, edge, t["PosAlong"].to_numpy().astype(np.float64)
    t = pq.read_table(os.path.join(d, "crashes.parquet"))
    cid = t["CID"].to_numpy()
    if os.path.exists(fac):  # same facility set as the ArcGIS run
        keep = np.isin(cid, [int(n) for n in located_esri(d)["Name"].to_pylist()])
        t, cid = t.filter(pa.array(keep)), cid[keep]
    edge, frac, snap = g.locate(t["x"].to_numpy(), t["y"].to_numpy())
    ok = snap <= MAX_SNAP_FT
    return cid[ok], edge[ok], frac[ok]


_builder = None


def _init_worker(edges_parquet):
    global _builder
    _builder = Builder(Graph(edges_parquet))  # CPU only: Graph uploads to the GPU lazily


def _polygon(task):
    c, b, e, a1, b0, s0, s1 = task
    poly = _builder.polygon(e, [intervals(*v) for v in zip(a1, b0, s0, s1)])
    return int(c), float(b), shapely.to_wkb(poly)


def tasks(cols):
    """One task per (CID, break): that group's edges and interval columns."""
    order = np.lexsort((cols["brk"], cols["CID"]))
    c, b = cols["CID"][order], cols["brk"][order]
    cut = np.flatnonzero((np.diff(c) != 0) | (np.diff(b) != 0)) + 1
    for g in np.split(order, cut):
        yield (cols["CID"][g[0]], cols["brk"][g[0]], cols["edge"][g],
               cols["a1"][g], cols["b0"][g], cols["s0"][g], cols["s1"][g])


def main():
    county = sys.argv[1]
    a = sys.argv[2:]
    mode = a[a.index("--locations") + 1] if "--locations" in a else "esri"
    chunk = int(a[a.index("--chunk") + 1]) if "--chunk" in a else 2048
    workers = int(a[a.index("--workers") + 1]) if "--workers" in a else os.cpu_count()
    d = os.path.join(ROOT, "work", county)
    edges_parquet = os.path.join(d, "edges.parquet")
    # Invalidate the previous run before writing any new output.
    old = os.path.join(d, f"cuda_timing_{mode}.json")
    if os.path.exists(old):
        os.rename(old, f"{old}.{time.time_ns()}")
    old = os.path.join(d, f"cuda_polygons_{mode}.parquet")
    if os.path.exists(old):
        os.remove(old)
    t0 = time.perf_counter()
    g = Graph(edges_parquet)
    cid, edge, frac = facilities(g, d, mode)
    assert len(cid), "No located facilities"
    t_load = time.perf_counter() - t0

    t_sssp = t_reach = 0.0
    parts = []
    for s in range(0, len(cid), chunk):
        sl = slice(s, s + chunk)
        cp.cuda.Device().synchronize()
        t1 = time.perf_counter()
        dist = g.sssp(edge[sl], frac[sl], max(BREAKS))
        cp.cuda.Device().synchronize()
        t2 = time.perf_counter()
        r = g.reached(dist, edge[sl], frac[sl], BREAKS)
        del dist
        t3 = time.perf_counter()
        r["CID"] = cid[sl][r["fac"]]
        r["frac"] = frac[sl][r["fac"]]
        r["own"] = edge[sl][r["fac"]] == r["edge"]
        r["EID"] = g.eid[r["edge"]]
        parts.append(r)
        t_sssp += t2 - t1
        t_reach += t3 - t2
    cols = {k: np.concatenate([p[k] for p in parts]) for k in parts[0] if k != "fac"}
    pq.write_table(pa.table(cols), os.path.join(d, f"cuda_reached_{mode}.parquet"))

    t_poly = 0.0
    if "--no-polygons" not in a:
        t4 = time.perf_counter()
        with mp.get_context("spawn").Pool(workers, _init_worker, (edges_parquet,)) as pool:
            res = pool.map(_polygon, tasks(cols), chunksize=8)
        t_poly = time.perf_counter() - t4
        pq.write_table(pa.table({"CID": [r[0] for r in res], "ToBreak": [r[1] for r in res],
                                 "wkb": [r[2] for r in res]}),
                       os.path.join(d, f"cuda_polygons_{mode}.parquet"))
    timing = {"county": county, "mode": mode, "facilities": int(len(cid)), "edges": int(len(g.w)),
              "nodes": g.N, "load_s": t_load, "sssp_s": t_sssp, "reached_s": t_reach,
              "polygons_s": t_poly, "polygon_workers": workers,
              "gpu": cp.cuda.runtime.getDeviceProperties(0)["name"].decode()}
    names = ["edges.parquet", f"cuda_reached_{mode}.parquet"]
    names += [name for name in ("esri_facilities.parquet", "esri_lines.parquet", "esri_polygons.parquet")
              if os.path.exists(os.path.join(d, name))]
    if mode == "own":
        names.append("crashes.parquet")
    if "--no-polygons" not in a:
        names.append(f"cuda_polygons_{mode}.parquet")
    timing["sha256"] = {}
    for name in names:
        with open(os.path.join(d, name), "rb") as f:
            timing["sha256"][name] = hashlib.file_digest(f, "sha256").hexdigest()
    with open(os.path.join(d, f"cuda_timing_{mode}.json"), "w") as f:
        json.dump(timing, f, indent=1)
    print(json.dumps(timing))


if __name__ == "__main__":
    main()
