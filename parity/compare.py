"""Parity: CUDA vs ArcGIS Network Analyst service areas.

usage: python parity/compare.py Adams [--locations esri|own]

Lines (exact gate): every Esri line piece's From/ToCumul_Minutes equals the CUDA cost at that
position (|d| <= 1e-6 min), and per (crash, edge, break) the reached position intervals are equal
(|d| <= 1e-6).
Polygons (gate): the shared builder (cuda/polygons.py) applied to the Esri reached intervals vs the
CUDA polygons, IoU >= 0.99 and Hausdorff <= 50 ft per (crash, break).
Polygons (reference only): native ArcGIS "High" polygons vs CUDA polygons.
Writes results/parity_<county>_<locations>.md.
"""
import multiprocessing as mp
import json
import hashlib
import os
import sys
from collections import defaultdict

import numpy as np
import pyarrow.parquet as pq
import shapely

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "cuda"))
import batch  # noqa: E402  (pool workers: batch._init_worker makes batch._builder, CPU only)
from batch import BREAKS, located_esri  # noqa: E402
from engine import intervals  # noqa: E402

COST_TOL = POS_TOL = 1e-6
IOU_MIN, HAUS_MAX = 0.99, 50.0


def merge(iv):
    iv = sorted([lo, hi] for lo, hi in iv if hi - lo > POS_TOL)
    out = []
    for lo, hi in iv:
        if out and lo <= out[-1][1] + POS_TOL:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def same(a, b):
    return len(a) == len(b) and all(abs(x[0] - y[0]) <= POS_TOL and abs(x[1] - y[1]) <= POS_TOL
                                    for x, y in zip(a, b))


def cost_at(r, w, p):
    c = np.inf
    if np.isfinite(r["c0"]):
        c = min(c, r["c0"] + p * w)
    if np.isfinite(r["c1"]):
        c = min(c, r["c1"] + (1 - p) * w)
    if r["own"]:
        c = min(c, abs(p - r["frac"]) * w)
    return c


def _directed(a, b):
    """Max distance from a's boundary vertices to b's boundary, via an STRtree of b's segments."""
    xy = shapely.get_coordinates(shapely.boundary(b))
    rings = shapely.get_parts(shapely.boundary(b))
    segs = np.concatenate([np.stack([c[:-1], c[1:]], 1) for c in map(shapely.get_coordinates, rings)])
    lines = shapely.linestrings(segs)
    pts = shapely.points(shapely.get_coordinates(shapely.boundary(a)))
    _, dist = shapely.STRtree(lines).query_nearest(pts, return_distance=True, all_matches=False)
    return dist.max() if len(xy) and len(pts) else 0.0


def hausdorff(a, b):
    """Discrete Hausdorff distance between polygon boundaries (vertices to the other's boundary).

    Matches shapely.hausdorff_distance to float noise but runs in n log m instead of n*m.
    """
    if a.is_empty or b.is_empty:
        return 0.0 if a.is_empty and b.is_empty else np.inf
    return max(_directed(a, b), _directed(b, a))


def _shared(task):
    key, edges, ivs = task
    return key, batch._builder.polygon(edges, ivs)


def _metrics(pair):
    """(IoU, Hausdorff ft) of two polygons; exactly equal geometry skips the work."""
    a, b = pair
    if shapely.equals_exact(a, b, 1e-9):
        return 1.0, 0.0
    union = shapely.area(shapely.union(a, b))
    return (shapely.area(shapely.intersection(a, b)) / union if union else 1.0), hausdorff(a, b)


def poly_section(title, ref, cuda_poly, gate, pool):
    ks = sorted(set(ref) & set(cuda_poly))
    res = pool.map(_metrics, [(ref[k], cuda_poly[k]) for k in ks], chunksize=4)
    iou = np.array([r[0] for r in res])
    haus = np.array([r[1] for r in res])
    ok = (iou >= IOU_MIN) & (haus <= HAUS_MAX)
    out = [f"## {title}", "",
           f"- Pairs compared: {len(ks)} (reference only: {len(set(ref) - set(cuda_poly))}, "
           f"CUDA only: {len(set(cuda_poly) - set(ref))})",
           f"- Within IoU ≥ {IOU_MIN} and Hausdorff ≤ {HAUS_MAX:g} ft: **{int(ok.sum())} / {len(ks)}**"]
    if gate:
        out.append(f"- Gate: **{'PASS' if ok.all() and len(ks) and len(ks) == len(set(ref) | set(cuda_poly)) else 'FAIL'}**")
    out += ["", "| break | n | IoU min | IoU p1 | IoU p10 | IoU p50 | Haus p50 ft | Haus p99 ft | Haus max ft |",
            "|---|---|---|---|---|---|---|---|---|"]
    brk = np.array([k[1] for k in ks])
    for b in BREAKS:
        m = brk == b
        if m.any():
            out.append(f"| {b:g} | {m.sum()} | {iou[m].min():.4f} | {np.percentile(iou[m], 1):.4f} | "
                       f"{np.percentile(iou[m], 10):.4f} | {np.median(iou[m]):.4f} | {np.median(haus[m]):.1f} | "
                       f"{np.percentile(haus[m], 99):.1f} | {haus[m].max():.1f} |")
    out += ["", "Worst 10 by IoU:", ""]
    for i in np.argsort(iou, kind="stable")[:10]:  # stable: same tie order on every machine
        out.append(f"- crash {ks[i][0]} break {ks[i][1]:g}: IoU {iou[i]:.4f}, Hausdorff {haus[i]:.1f} ft")
    return out + [""]


def main():
    county = sys.argv[1]
    a = sys.argv[2:]
    mode = a[a.index("--locations") + 1] if "--locations" in a else "esri"
    d = os.path.join(ROOT, "work", county)
    rpt = [f"# Parity — {county} (CUDA locations: {mode})", ""]
    timing_path = os.path.join(d, f"cuda_timing_{mode}.json")
    try:
        with open(timing_path) as f:
            timing = json.load(f)
        required = ["edges.parquet", "esri_facilities.parquet", "esri_lines.parquet", f"cuda_reached_{mode}.parquet"]
        if mode == "own":
            required.append("crashes.parquet")
        if "--lines-only" not in a:
            required += ["esri_polygons.parquet", f"cuda_polygons_{mode}.parquet"]
        for name in required:
            with open(os.path.join(d, name), "rb") as f:
                if hashlib.file_digest(f, "sha256").hexdigest() != timing.get("sha256", {}).get(name):
                    raise ValueError(f"stale or unverified artifact: {name}")
    except (OSError, ValueError) as exc:
        print(f"Parity gate FAIL: {exc}; rerun CUDA batch with required polygons.")
        return 1
    for label, name in (("Windows ArcPy", "esri_timing.json"), ("CUDA", f"cuda_timing_{mode}.json")):
        path = os.path.join(d, name)
        if os.path.exists(path):
            with open(path) as f:
                metrics = json.load(f)
            rpt += [f"- {label} timings (seconds): " + ", ".join(f"{k}={v:.6f}" for k, v in metrics.items() if k.endswith("_s")), ""]

    fac = located_esri(d).to_pylist()
    rpt += [f"- Located Esri facilities (Status 0): {len(fac)}", ""]
    oid_to_cid = {f["OID"]: int(f["Name"]) for f in fac}
    edges = pq.read_table(os.path.join(d, "edges.parquet"), columns=["EID", "Minutes"])
    w_of = dict(zip(edges["EID"].to_pylist(), edges["Minutes"].to_pylist()))

    # ---- lines
    cuda = pq.read_table(os.path.join(d, f"cuda_reached_{mode}.parquet")).to_pylist()
    ours = defaultdict(list)  # (cid, eid, brk) -> intervals
    rec10 = {}
    for r in cuda:
        iv = merge(intervals(r["a1"], r["b0"], r["s0"], r["s1"]))
        if iv:
            ours[(r["CID"], r["EID"], r["brk"])] = iv
        if r["brk"] == 10.0:
            rec10[(r["CID"], r["EID"])] = r
    esri_iv = defaultdict(list)
    lines = pq.read_table(os.path.join(d, "esri_lines.parquet"),
                          columns=["FacilityID", "SourceOID", "FromPosition", "ToPosition",
                                   "FromCumul_Minutes", "ToCumul_Minutes"]).to_pylist()
    cost_bad, cost_max = [], 0.0
    unsplit = set()  # Esri left a piece unsplit across this break (it moved the whole piece up a band)
    for ln in lines:
        cid, eid = oid_to_cid[ln["FacilityID"]], ln["SourceOID"]
        lo, hi = sorted((ln["FromPosition"], ln["ToPosition"]))
        for b in BREAKS:
            if ln["ToCumul_Minutes"] <= b + COST_TOL:
                esri_iv[(cid, eid, b)].append([lo, hi])
            elif ln["FromCumul_Minutes"] < b - COST_TOL:
                unsplit.add((cid, eid, b))
        r = rec10.get((cid, eid))
        if r is None:
            cost_bad.append((cid, eid, "edge not reached by CUDA"))
            continue
        for p, c in ((ln["FromPosition"], ln["FromCumul_Minutes"]), (ln["ToPosition"], ln["ToCumul_Minutes"])):
            err = abs(cost_at(r, w_of[eid], p) - c)
            cost_max = max(cost_max, err)
            if err > COST_TOL:
                cost_bad.append((cid, eid, f"pos {p:.6f} esri {c:.9f} cuda {cost_at(r, w_of[eid], p):.9f}"))
    esri_m = {k: merge(v) for k, v in esri_iv.items()}
    esri_m = {k: v for k, v in esri_m.items() if v}
    keys = set(esri_m) | set(ours)
    iv_bad = [(k, esri_m.get(k), ours.get(k)) for k in sorted(keys) if not same(esri_m.get(k, []), ours.get(k, []))]
    rpt += ["## Lines (exact gate)", "",
            f"- Esri line pieces: {len(lines)}; (crash, edge, break) interval sets: Esri {len(esri_m)}, CUDA {len(ours)}",
            f"- Cumulative-minutes mismatches (> {COST_TOL}): **{len(cost_bad)}** (max abs diff {cost_max:.3e} min)",
            f"- Reached-interval mismatches (> {POS_TOL}): **{len(iv_bad)}**"
            f" (of which Esri left the line unsplit at the break: {sum(k in unsplit for k, _, _ in iv_bad)};"
            f" Esri unsplit break crossings in total: {len(unsplit)})",
            f"- Gate: **{'PASS' if not cost_bad and not iv_bad else 'FAIL'}**", ""]
    for x in cost_bad[:10]:
        rpt.append(f"  - cost: crash {x[0]} edge {x[1]}: {x[2]}")
    for k, e, o in iv_bad[:10]:
        tag = " [Esri unsplit crossing]" if k in unsplit else ""
        rpt.append(f"  - interval: crash {k[0]} edge {k[1]} break {k[2]}: esri {e} cuda {o}{tag}")

    # ---- polygons
    pp = os.path.join(d, f"cuda_polygons_{mode}.parquet")
    if "--lines-only" not in a:
        cuda_poly = {(p["CID"], p["ToBreak"]): shapely.from_wkb(p["wkb"]) for p in pq.read_table(pp).to_pylist()}
        edges_parquet = os.path.join(d, "edges.parquet")
        idx = {e: i for i, e in enumerate(pq.read_table(edges_parquet, columns=["EID"])["EID"].to_pylist())}
        by_poly = defaultdict(lambda: ([], []))
        for (cid, eid, b), iv in esri_m.items():
            by_poly[(cid, b)][0].append(idx[eid])
            by_poly[(cid, b)][1].append(iv)
        ep = pq.read_table(os.path.join(d, "esri_polygons.parquet"), columns=["FacilityID", "ToBreak", "wkb"]).to_pylist()
        native = {(oid_to_cid[p["FacilityID"]], p["ToBreak"]): shapely.from_wkb(p["wkb"]) for p in ep}
        with mp.get_context("spawn").Pool(os.cpu_count(), batch._init_worker, (edges_parquet,)) as pool:
            shared = dict(pool.map(_shared, [(k, *v) for k, v in by_poly.items()], chunksize=4))
            rpt += poly_section("Polygons — gate: shared builder on Esri lines vs CUDA (IoU ≥ 0.99, Hausdorff ≤ 50 ft)",
                                shared, cuda_poly, gate=True, pool=pool)
            rpt += poly_section("Polygons — reference only: native ArcGIS High vs CUDA", native, cuda_poly,
                                gate=False, pool=pool)
    os.makedirs(os.path.join(ROOT, "results"), exist_ok=True)
    out = os.path.join(ROOT, "results", f"parity_{county.lower()}_{mode}.md")
    with open(out, "w") as f:
        f.write("\n".join(rpt) + "\n")
    print("\n".join(r for r in rpt if not r.startswith("- crash")))
    return int(any("Gate: **FAIL**" in line for line in rpt))


if __name__ == "__main__":
    sys.exit(main())
