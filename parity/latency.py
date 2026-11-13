"""Latency of the live /sa endpoint at random crash locations (jittered up to 500 ft).

usage: python parity/latency.py [--base http://localhost:8765] [--n 1000] [--out results/latency.md]
"""
import json
import random
import sys
import time
import urllib.request

import numpy as np

a = sys.argv[1:]
base = a[a.index("--base") + 1] if "--base" in a else "http://localhost:8765"
n = int(a[a.index("--n") + 1]) if "--n" in a else 1000
out = a[a.index("--out") + 1] if "--out" in a else None

pts = [f["geometry"]["coordinates"] for f in json.load(urllib.request.urlopen(base + "/crashes"))["features"]]
rng = random.Random(11)
rows = ["| minutes | n | server p50 ms | server p95 ms | round trip p50 ms | round trip p95 ms |", "|---|---|---|---|---|---|"]
for m in (1, 5, 10):
    srv, rtt = [], []
    for _ in range(n):
        lon, lat = rng.choice(pts)
        lon += rng.uniform(-0.0018, 0.0018)  # ~500 ft
        lat += rng.uniform(-0.0014, 0.0014)
        t0 = time.perf_counter()
        f = json.load(urllib.request.urlopen(f"{base}/sa?lon={lon:.6f}&lat={lat:.6f}&minutes={m}"))
        rtt.append((time.perf_counter() - t0) * 1000)
        srv.append(f["properties"]["solve_ms"])
    rows.append(f"| {m} | {n} | {np.median(srv):.1f} | {np.percentile(srv, 95):.1f} | "
                f"{np.median(rtt):.1f} | {np.percentile(rtt, 95):.1f} |")
print("\n".join(rows))
if out:
    open(out, "w").write(f"# /sa latency ({base}, sequential, {n} points per row)\n\n" + "\n".join(rows) + "\n")
