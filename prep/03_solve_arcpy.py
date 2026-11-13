"""ArcGIS Network Analyst service areas (reference engine) + Parquet export for the CUDA side.

usage: python prep/03_solve_arcpy.py Adams [--sample N] [--seed 7] [--batch B]

--batch B solves the sample in groups of B crashes (one solve per group; service areas are per facility,
so results are the same) and sums the stage times. Facility OIDs are offset so they stay unique.

Writes work/<County>/ : edges.parquet, crashes.parquet, esri_facilities.parquet,
esri_lines.parquet, esri_polygons.parquet, esri_timing.json
"""
import json
import os
import random
import sys
import time

import arcpy
import pyarrow as pa
import pyarrow.compute  # noqa: F401  (pa.compute)
import pyarrow.parquet as pq

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
county = sys.argv[1]
args = sys.argv[2:]
sample = int(args[args.index("--sample") + 1]) if "--sample" in args else 0
seed = int(args[args.index("--seed") + 1]) if "--seed" in args else 7
batch = int(args[args.index("--batch") + 1]) if "--batch" in args else 0
BREAKS = [1, 5, 10]
TRIM_M = 100

gdb = os.path.join(ROOT, "work", f"{county}.gdb")
streets = os.path.join(gdb, "Net", "Streets")
nd = os.path.join(gdb, "Net", "Streets_ND")
crashes = os.path.join(gdb, "Crashes")
out = os.path.join(ROOT, "work", f"{county}_s{sample}" if sample else county)  # samples never overwrite a full run
os.makedirs(out, exist_ok=True)
arcpy.env.overwriteOutput = True
arcpy.CheckOutExtension("Network")


def dump(rows_iter, names, path):
    cols = {n: [] for n in names}
    for row in rows_iter:
        for n, v in zip(names, row):
            cols[n].append(v)
    pq.write_table(pa.table(cols), path)
    return len(next(iter(cols.values()))) if cols else 0


def fc_rows(fc, fields, where=None):
    """Rows with geometry as 2D WKB in the last column."""
    with arcpy.da.SearchCursor(fc, fields + ["SHAPE@WKB"], where) as cur:
        for r in cur:
            yield list(r[:-1]) + [bytes(r[-1]) if r[-1] is not None else None]


# Inputs shared with CUDA.
n_e = dump(fc_rows(streets, ["EID", "MTFCC", "Minutes", "SHAPE@LENGTH"]),
           ["EID", "MTFCC", "Minutes", "length_ft", "wkb"], os.path.join(out, "edges.parquet"))
dump(fc_rows(crashes, ["CID", "SHAPE@X", "SHAPE@Y"]),
     ["CID", "x", "y", "wkb"], os.path.join(out, "crashes.parquet"))

cids = [r[0] for r in arcpy.da.SearchCursor(crashes, ["CID"])]
chosen = None  # None: all crashes
if sample and sample < len(cids):
    random.Random(seed).shuffle(cids)
    chosen = sorted(cids[:sample])
groups = [chosen]
if batch:  # also when the sample is all crashes
    every = chosen if chosen is not None else sorted(cids)
    groups = [every[i:i + batch] for i in range(0, len(every), batch)]

# The template ND has no stored travel modes, so arcpy.nax refuses it; the layer API takes JSON.
TRAVEL_MODE = json.dumps({
    "name": "Drive", "id": "1", "description": "", "type": "AUTOMOBILE",
    "impedanceAttributeName": "Minutes", "timeAttributeName": "Minutes", "distanceAttributeName": "Length",
    "restrictionAttributeNames": [], "attributeParameterValues": [],
    "uturnAtJunctions": "esriNFSBAllowBacktrack", "useHierarchy": False,
    "simplificationTolerance": None, "simplificationToleranceUnits": "esriFeet"})

NAMES = [("Facilities", "esri_facilities"), ("SALines", "esri_lines"), ("SAPolygons", "esri_polygons")]
stage = {"load_s": 0.0, "solve_s": 0.0, "export_s": 0.0}
messages = []
for k, group in enumerate(groups):
    where = None if group is None else f"CID IN ({','.join(map(str, group))})"
    t0 = time.perf_counter()
    layer = arcpy.na.MakeServiceAreaAnalysisLayer(
        nd, "SA", TRAVEL_MODE, "FROM_FACILITIES", BREAKS, None, "LOCAL_TIME_AT_LOCATIONS",
        "POLYGONS_AND_LINES", "HIGH", "OVERLAP", "DISKS", f"{TRIM_M} Meters").getOutput(0)
    sub = arcpy.na.GetNAClassNames(layer)
    crash_lyr = arcpy.management.MakeFeatureLayer(crashes, "crash_lyr", where)
    arcpy.na.AddLocations(layer, sub["Facilities"], crash_lyr, "Name CID #", "5000 Meters")
    t1 = time.perf_counter()
    # A group where no crash is located has no valid facility: Solve stops with an error and the groups
    # solved before it would not be merged. Such a group is exported without a solve.
    fac_lyr = layer.listLayers(sub["Facilities"])[0]
    if any(True for _ in arcpy.da.SearchCursor(fac_lyr, ["Status"], "Status = 0")):
        result = arcpy.na.Solve(layer, "SKIP", "TERMINATE")
        messages += [result.getMessage(i) for i in range(result.messageCount)]
    else:
        messages.append(f"group {k + 1}: no located facility, not solved")
    t2 = time.perf_counter()
    for cls, name in NAMES:
        sl = layer.listLayers(sub[cls])[0]
        fields = [f.name for f in arcpy.ListFields(sl) if f.type not in ("OID", "Geometry")]
        dump(fc_rows(sl, ["OID@"] + fields), ["OID"] + fields + ["wkb"], os.path.join(out, f"{name}.part{k}.parquet"))
    t3 = time.perf_counter()
    for key, dt in (("load_s", t1 - t0), ("solve_s", t2 - t1), ("export_s", t3 - t2)):
        stage[key] += dt
    print(f"group {k + 1}/{len(groups)}: solve {t2 - t1:.1f} s", flush=True)
    arcpy.management.Delete(crash_lyr)
    arcpy.management.Delete(layer)

t2 = time.perf_counter()
counts = {}
offsets = [0]  # facility OIDs of later groups move past the earlier ones, so FacilityID stays unique
for k in range(len(groups) - 1):
    offsets.append(offsets[-1] + max(pq.read_table(os.path.join(out, f"esri_facilities.part{k}.parquet"),
                                                   columns=["OID"])["OID"].to_pylist(), default=0))
for _, name in NAMES:
    parts = [os.path.join(out, f"{name}.part{k}.parquet") for k in range(len(groups))]
    path = os.path.join(out, f"{name}.parquet")
    if len(parts) == 1:
        os.replace(parts[0], path)  # one solve: the file is written exactly as before
    else:
        key = "OID" if name == "esri_facilities" else "FacilityID"
        tables = []
        for off, part in zip(offsets, parts):
            t = pq.read_table(part)
            if t.num_rows:  # a part with no rows has null-typed columns: its schema differs from the others
                tables.append(t.set_column(t.schema.get_field_index(key), key, pa.compute.add(t[key], off)))
        pq.write_table(pa.concat_tables(tables) if tables else pq.read_table(parts[0]), path)
        for part in parts:
            os.remove(part)
    counts[name] = pq.read_metadata(path).num_rows
stage["export_s"] += time.perf_counter() - t2
fac_t = pq.read_table(os.path.join(out, "esri_facilities.parquet"), columns=["Status"])
unlocated = int(sum(s != 0 for s in fac_t["Status"].to_pylist()))
print(f"unlocated facilities (Status != 0, skipped by the CUDA side): {unlocated}")

timing = {"county": county, "edges": n_e, "facilities": counts["esri_facilities"],
          **stage, "batch": batch, "groups": len(groups), "breaks": BREAKS,
          "trim_m": TRIM_M, "detail": "High", "sample": sample, "seed": seed, "unlocated": unlocated,
          "messages": messages}
timing_path = os.path.join(out, "esri_timing.json")
if os.path.exists(timing_path):
    os.rename(timing_path, timing_path + f".{time.time_ns()}")
with open(timing_path, "w") as f:
    json.dump(timing, f, indent=1)
print(json.dumps({k: v for k, v in timing.items() if k != "messages"}), counts)
