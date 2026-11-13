"""Warm repeated CUDA stage timings on the same ArcPy facility sample. Run on gpu-x86."""
import hashlib
import json
import os
import statistics
import sys
import time

import cupy as cp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "cuda"))
from batch import facilities, tasks, BREAKS
from engine import Graph, intervals
from polygons import Builder


def main():
    county = sys.argv[1]
    d = os.path.join(ROOT, "work", county)
    path = os.path.join(d, "edges.parquet")
    g = Graph(path)
    builder = Builder(g)
    cid, edge, frac = facilities(g, d, "esri")
    assert len(cid), "No located facilities"
    samples = []
    for repeat in range(8):
        cp.cuda.Device().synchronize()
        start = time.perf_counter()
        dist = g.sssp(edge, frac, 10)
        cp.cuda.Device().synchronize()
        solved = time.perf_counter()
        r = g.reached(dist, edge, frac, BREAKS)
        reached = time.perf_counter()
        r["CID"] = cid[r["fac"]]
        for _, _, e, a1, b0, s0, s1 in tasks(r):  # one group per (crash, break), grouped once
            builder.polygon(e, [intervals(*v) for v in zip(a1, b0, s0, s1)])
        end = time.perf_counter()
        if repeat:
            samples.append({"sssp_s": solved - start, "reached_s": reached - solved,
                            "polygons_serial_s": end - reached})
    with open(path, "rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    with open(os.path.join(d, "esri_timing.json")) as f:
        arc = json.load(f)
    result = {"county": county, "facilities": len(cid), "edgesSha256": digest,
              "breaks": BREAKS, "warmup_runs": 1, "samples": samples,
              "median": {k: statistics.median(s[k] for s in samples) for k in samples[0]},
              "windows_arcpy": arc}
    out = os.path.join(ROOT, "results", f"benchmark_{county}_{time.time_ns()}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
