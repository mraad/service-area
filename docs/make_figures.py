"""Make the README figures from the Adams data (run on gpu-x86).

usage: python docs/make_figures.py [--sample Adams_s100] [--raw work/adams_raw.geojson]

Writes docs/images/{noding,lines,polygons,iou,latency,timing}.png.
"""
import json
import os
import re
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker  # noqa: E402,F401
import numpy as np  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
import shapely  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "cuda"))
from engine import Graph  # noqa: E402

a = sys.argv[1:]
SAMPLE = a[a.index("--sample") + 1] if "--sample" in a else "Adams_s100"
RAW = a[a.index("--raw") + 1] if "--raw" in a else os.path.join(ROOT, "work", "adams_raw.geojson")
D = os.path.join(ROOT, "work", SAMPLE)
OUT = os.path.join(ROOT, "docs", "images")
os.makedirs(OUT, exist_ok=True)

# Validated categorical palette (dataviz reference instance): CUDA = blue, Esri = orange.
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
BLUE_LIGHT = "#86b6ef"  # same blue ramp, lighter step: second measure of one series
INK, INK2, GRID, SURF = "#0b0b0b", "#52514e", "#d9d8d4", "#fcfcfb"
plt.rcParams.update({"figure.facecolor": SURF, "axes.facecolor": SURF, "axes.edgecolor": GRID,
                     "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
                     "text.color": INK, "font.size": 10, "axes.titlesize": 11,
                     "axes.spines.top": False, "axes.spines.right": False})
BAND = {1.0: AQUA, 5.0: BLUE, 10.0: ORANGE}


def plot_lines(ax, geoms, **kw):
    for g in geoms:
        for part in shapely.get_parts(g):
            xy = shapely.get_coordinates(part)
            ax.plot(xy[:, 0], xy[:, 1], solid_capstyle="round", **kw)


def outline(ax, poly, **kw):
    for p in shapely.get_parts(poly):
        for r in [p.exterior, *p.interiors]:
            xy = np.asarray(r.coords)
            ax.plot(xy[:, 0], xy[:, 1], **kw)


def map_axes(ax, title):
    ax.set_title(title, loc="left")
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)


def save(fig, name):
    fig.savefig(os.path.join(OUT, name), dpi=110, bbox_inches="tight")
    plt.close(fig)
    print("wrote", name)


g = Graph(os.path.join(D, "edges.parquet"))
fac = pq.read_table(os.path.join(D, "esri_facilities.parquet")).to_pylist()
oid_to_cid = {f["OID"]: int(f["Name"]) for f in fac}
cid_to_fac = {int(f["Name"]): f for f in fac}

# 1. noding: raw dangles vs noded dangles, zoomed on West Union.
raw = json.load(open(RAW))["features"]
raw_g = np.array([shapely.geometry.shape(f["geometry"]) for f in raw], dtype=object)
raw_g = np.array([shapely.get_parts(x)[0] if x.geom_type == "MultiLineString" else x for x in raw_g], dtype=object)


def dangles(geoms):
    ends = np.vstack([shapely.get_coordinates(shapely.get_point(geoms, 0)),
                      shapely.get_coordinates(shapely.get_point(geoms, -1))])
    u, c = np.unique(np.round(ends, 3), axis=0, return_counts=True)
    return u[c == 1]


box = shapely.box(1664500, 288500, 1675500, 296500)
fig, axs = plt.subplots(1, 2, figsize=(11, 4.6))
for ax, geoms, title in ((axs[0], raw_g, "Source streets (OhioTGN.gdb)"), (axs[1], g.geom, "Noded streets (prep/01_prepare.py)")):
    sel = geoms[shapely.intersects(geoms, box)]
    plot_lines(ax, sel, color=INK2, lw=0.8)
    dg = dangles(geoms)
    m = shapely.contains_xy(box, dg[:, 0], dg[:, 1])
    ax.scatter(dg[m, 0], dg[m, 1], s=14, color=ORANGE, zorder=3, label="dead end (one edge)")
    map_axes(ax, f"{title}: {m.sum()} dead ends in view")
    ax.set_xlim(box.bounds[0], box.bounds[2])
    ax.set_ylim(box.bounds[1], box.bounds[3])
axs[1].legend(loc="upper left", frameon=True, facecolor=SURF, edgecolor=GRID, markerscale=1.5)
save(fig, "noding.png")

# Pick the sample crash with the most reached 5-minute edges for the line and polygon figures.
L = pq.read_table(os.path.join(D, "esri_lines.parquet")).to_pylist()
count = {}
for l in L:
    if l["ToCumul_Minutes"] <= 5:
        count[l["FacilityID"]] = count.get(l["FacilityID"], 0) + 1
fo = max(count, key=count.get)
CID = oid_to_cid[fo]
f0 = cid_to_fac[CID]
print("figure crash", CID)

# 2. lines: Esri lines vs CUDA reached pieces, colored by band.
R = [r for r in pq.read_table(os.path.join(D, "cuda_reached_esri.parquet")).to_pylist() if r["CID"] == CID]
from engine import intervals  # noqa: E402
from shapely.ops import substring  # noqa: E402

fig, axs = plt.subplots(1, 2, figsize=(11, 5.2))
for B in (10.0, 5.0, 1.0):
    # cumulative per break, drawn 10 -> 5 -> 1 so inner bands sit on top (same as the CUDA panel)
    esri = [shapely.from_wkb(l["wkb"]) for l in L if l["FacilityID"] == fo and l["ToCumul_Minutes"] <= B + 1e-9]
    plot_lines(axs[0], esri, color=BAND[B], lw=1.6)
    pieces = []
    for r in R:
        if r["brk"] != B:
            continue
        for lo, hi in intervals(r["a1"], r["b0"], r["s0"], r["s1"]):
            if hi - lo > 1e-9:
                pieces.append(substring(g.geom[g.eid_to_idx[r["EID"]]], lo, hi, normalized=True))
    plot_lines(axs[1], pieces, color=BAND[B], lw=1.6)
for ax, title in ((axs[0], "ArcGIS Network Analyst: SA lines"), (axs[1], "CUDA engine: reached edge intervals")):
    ax.scatter([f0["SnapX"]], [f0["SnapY"]], s=60, marker="*", color=INK, zorder=4, label="crash")
    map_axes(ax, title)
for B, lab in ((1.0, "0–1 min"), (5.0, "1–5 min"), (10.0, "5–10 min")):
    axs[1].plot([], [], color=BAND[B], lw=3, label=lab)
axs[1].legend(loc="lower right", frameon=False)
xl, yl = axs[0].get_xlim(), axs[0].get_ylim()
axs[1].set_xlim(xl)
axs[1].set_ylim(yl)
save(fig, "lines.png")

# 3. polygons: shared builder (CUDA) vs native ArcGIS High, per break.
CP = {(p["CID"], p["ToBreak"]): shapely.from_wkb(p["wkb"]) for p in pq.read_table(os.path.join(D, "cuda_polygons_esri.parquet")).to_pylist()}
EP = {(oid_to_cid[p["FacilityID"]], p["ToBreak"]): shapely.from_wkb(p["wkb"]) for p in pq.read_table(os.path.join(D, "esri_polygons.parquet")).to_pylist()}
fig, axs = plt.subplots(1, 3, figsize=(13, 4.8))
for ax, B in zip(axs, (1.0, 5.0, 10.0)):
    c, e = CP[(CID, B)], EP[(CID, B)]
    iou = c.intersection(e).area / c.union(e).area
    x0, y0, x1, y1 = c.union(e).bounds
    sel = g.geom[shapely.intersects(g.geom, shapely.box(x0, y0, x1, y1))]
    plot_lines(ax, sel, color=GRID, lw=0.6)
    for p in shapely.get_parts(c):
        ax.fill(*p.exterior.xy, color=BLUE, alpha=0.18, lw=0)
    outline(ax, c, color=BLUE, lw=1.4)
    outline(ax, e, color=ORANGE, lw=1.1)
    ax.scatter([f0["SnapX"]], [f0["SnapY"]], s=50, marker="*", color=INK, zorder=4)
    map_axes(ax, f"{B:g} min  (IoU {iou:.3f})")
    ax.set_xlim(x0 - 300, x1 + 300)
    ax.set_ylim(y0 - 300, y1 + 300)
axs[2].plot([], [], color=BLUE, lw=3, label="CUDA (shared builder)")
axs[2].plot([], [], color=ORANGE, lw=3, label="ArcGIS High polygon")
axs[2].legend(loc="lower right", frameon=False)
save(fig, "polygons.png")

# 4. IoU distribution vs native ArcGIS polygons, small multiples per break.
fig, axs = plt.subplots(1, 3, figsize=(12, 3.4), sharey=True)
for ax, B in zip(axs, (1.0, 5.0, 10.0)):
    ks = [k for k in CP if k[1] == B and k in EP]
    iou = np.array([CP[k].intersection(EP[k]).area / CP[k].union(EP[k]).area for k in ks])
    ax.hist(iou, bins=np.linspace(0.5, 1.0, 26), color=BLUE, edgecolor=SURF, linewidth=2)
    ax.axvline(np.median(iou), color=INK, lw=1, ls="--")
    ax.text(np.median(iou) - 0.012, ax.get_ylim()[1] * 0.92, f"median {np.median(iou):.3f}", color=INK, ha="right", fontsize=9)
    ax.set_title(f"{B:g} min, n = {len(iou)}", loc="left")
    ax.set_xlabel("IoU, CUDA vs ArcGIS High polygon")
    ax.grid(axis="y", color=GRID, lw=0.6)
    ax.set_axisbelow(True)
axs[0].set_ylabel("crashes")
save(fig, "iou.png")

# 5. latency of the live /sa endpoint (results/latency.md).
rows = [r for r in open(os.path.join(ROOT, "results", "latency.md")) if re.match(r"\| \d+ \|", r)]
mins, p50, p95 = [], [], []
for r in rows:
    c = [x.strip() for x in r.strip("|\n").split("|")]
    mins.append(c[0]); p50.append(float(c[2])); p95.append(float(c[3]))
fig, ax = plt.subplots(figsize=(6.4, 3.2))
y = np.arange(len(mins))
ax.barh(y + 0.19, p50, height=0.34, color=BLUE, label="p50")
ax.barh(y - 0.19, p95, height=0.34, color=BLUE_LIGHT, label="p95")
for i in range(len(mins)):
    ax.text(p50[i] + 2, y[i] + 0.19, f"{p50[i]:g} ms", va="center", fontsize=9, color=INK2)
    ax.text(p95[i] + 2, y[i] - 0.19, f"{p95[i]:g} ms", va="center", fontsize=9, color=INK2)
ax.set_yticks(y, [f"{m} min" for m in mins])
ax.set_xlabel("server time per request (ms), gpu-x86")
ax.grid(axis="x", color=GRID, lw=0.6)
ax.set_axisbelow(True)
ax.legend(frameon=False, loc="lower right")
save(fig, "latency.png")

# 6. batch time for the 100-crash sample: ArcGIS solve vs CUDA stages.
et = json.load(open(os.path.join(D, "esri_timing.json")))
ct = json.load(open(os.path.join(D, "cuda_timing_esri.json")))
labels = ["ArcGIS solve (arcgis-win)", "CUDA shortest paths", "CUDA reached intervals", "CUDA polygons (48 CPU workers)"]
vals = [et["solve_s"], ct["sssp_s"], ct["reached_s"], ct["polygons_s"]]
fig, ax = plt.subplots(figsize=(6.4, 2.8))
yy = np.arange(len(labels))[::-1]
ax.barh(yy, vals, height=0.5, color=[ORANGE, BLUE, BLUE, BLUE])
for yi, v in zip(yy, vals):
    ax.text(v * 1.15, yi, f"{v:.2f} s", va="center", fontsize=9, color=INK2)
ax.set_xscale("log")
ax.xaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:g}"))
ax.set_yticks(yy, labels)
ax.set_xlabel("seconds for 100 crashes × 3 breaks (log scale)")
ax.grid(axis="x", color=GRID, lw=0.6)
ax.set_axisbelow(True)
save(fig, "timing.png")
