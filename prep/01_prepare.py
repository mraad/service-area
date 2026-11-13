"""Prepare a noded street network and crash points for one county (ArcPy).

usage: python prep/01_prepare.py Adams

Output: work/<County>.gdb with Net/Streets (planarized, EID, MPH, Minutes) and Crashes (CID).
Both the ArcGIS ND and the CUDA engine read Net/Streets, so connectivity is identical.
"""
import os
import sys
from collections import Counter

import arcpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from speeds import ENDPOINT_ONLY, EXCLUDED, MPH, DEFAULT_MPH, minutes  # noqa: E402

county = sys.argv[1]
src = os.path.join(ROOT, "data", "OhioTGN.gdb")
work_dir = os.path.join(ROOT, "work")
gdb = os.path.join(work_dir, f"{county}.gdb")

arcpy.env.overwriteOutput = True
arcpy.env.outputZFlag = "Disabled"
arcpy.env.outputMFlag = "Disabled"
os.makedirs(work_dir, exist_ok=True)
if not arcpy.Exists(gdb):
    arcpy.management.CreateFileGDB(work_dir, f"{county}.gdb")
sr = arcpy.Describe(os.path.join(src, f"{county}_Streets")).spatialReference
fd = os.path.join(gdb, "Net")
if not arcpy.Exists(fd):
    arcpy.management.CreateFeatureDataset(gdb, "Net", sr)


def quoted(codes):
    return ",".join(f"'{c}'" for c in codes)


def components(fc):
    """Union-find over exactly equal endpoints (the CUDA graph rule). Returns (n_components, largest_share)."""
    parent = {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for (shp,) in arcpy.da.SearchCursor(fc, ["SHAPE@"]):
        a = (shp.firstPoint.X, shp.firstPoint.Y)
        b = (shp.lastPoint.X, shp.lastPoint.Y)
        parent[find(a)] = find(b)
    sizes = Counter(find(k) for k in list(parent))
    return len(sizes), max(sizes.values()) / len(parent)


raw = os.path.join(gdb, "raw_streets")
arcpy.conversion.ExportFeatures(
    os.path.join(src, f"{county}_Streets"), raw, f"MTFCC NOT IN ({quoted(EXCLUDED)})")
local = os.path.join(gdb, "raw_local")
fwy = os.path.join(gdb, "raw_fwy")
arcpy.conversion.ExportFeatures(raw, local, f"MTFCC NOT IN ({quoted(ENDPOINT_ONLY)})")
arcpy.conversion.ExportFeatures(raw, fwy, f"MTFCC IN ({quoted(ENDPOINT_ONLY)})")

# Local roads: split at every crossing and T-junction among themselves.
planar = os.path.join(gdb, "planar_local")
arcpy.management.FeatureToLine(local, planar, attributes="ATTRIBUTES")
# Every line (incl. freeways/ramps) is split where any road ends on its interior (T-junction).
ends = os.path.join(gdb, "raw_ends")
arcpy.management.FeatureVerticesToPoints(raw, ends, "BOTH_ENDS")
parts = [os.path.join(gdb, "split_local")]
arcpy.management.SplitLineAtPoint(planar, ends, parts[0], "0.01 Feet")
if int(arcpy.management.GetCount(fwy)[0]):
    parts.append(os.path.join(gdb, "split_fwy"))
    arcpy.management.SplitLineAtPoint(fwy, ends, parts[1], "0.01 Feet")

streets = os.path.join(fd, "Streets")
if arcpy.Exists(os.path.join(fd, "Streets_ND")):  # the ND locks Streets; 02_build_nd.py rebuilds it
    arcpy.management.Delete(os.path.join(fd, "Streets_ND"))
fms = arcpy.FieldMappings()
for p in parts:
    fms.addTable(p)
keep = {"NAME", "MTFCC", "TGN_SID"}
for i in reversed(range(fms.fieldCount)):
    if fms.getFieldMap(i).outputField.name not in keep:
        fms.removeFieldMap(i)
arcpy.management.Merge(parts, streets, fms)
# Make ends that the ND would connect (within its XY tolerance) bit-identical, so the CUDA graph,
# which joins only exactly equal coordinates, gets the same connectivity.
xy_tol = arcpy.Describe(streets).spatialReference.XYTolerance
arcpy.management.Integrate([[streets, 1]], f"{xy_tol} Feet")

arcpy.management.AddField(streets, "EID", "LONG")
arcpy.management.AddField(streets, "MPH", "DOUBLE")
arcpy.management.AddField(streets, "Minutes", "DOUBLE")
dropped = dups = 0
seen = set()
with arcpy.da.UpdateCursor(streets, ["OID@", "SHAPE@", "MTFCC", "EID", "MPH", "Minutes"]) as cur:
    for oid, shp, mtfcc, *_ in cur:
        if shp is None or shp.length <= 0:
            cur.deleteRow()
            dropped += 1
            continue
        # The source has duplicate street features (456 pairs + 11 triples in Adams); keep the first.
        xy = tuple((round(p.X, 3), round(p.Y, 3)) for part in shp for p in part)
        key = min(xy, xy[::-1])
        if key in seen:
            cur.deleteRow()
            dups += 1
            continue
        seen.add(key)
        cur.updateRow([oid, shp, mtfcc, oid, MPH.get(mtfcc, DEFAULT_MPH), minutes(shp.length, mtfcc)])

crashes = os.path.join(gdb, "Crashes")
arcpy.conversion.ExportFeatures(os.path.join(src, f"{county}_Crashes"), crashes)
arcpy.management.AddField(crashes, "CID", "LONG")
arcpy.management.CalculateField(crashes, "CID", "!OBJECTID!", "PYTHON3")

for name in ("raw_local", "raw_fwy", "planar_local", "raw_ends", "split_local", "split_fwy"):
    if arcpy.Exists(os.path.join(gdb, name)):
        arcpy.management.Delete(os.path.join(gdb, name))

n_raw = int(arcpy.management.GetCount(raw)[0])
n_out = int(arcpy.management.GetCount(streets)[0])
print(f"streets raw={n_raw} noded={n_out} zero_length_dropped={dropped} duplicates_dropped={dups}")
print("components raw=%d (largest %.3f)" % components(raw))
print("components noded=%d (largest %.3f)" % components(streets))
print(f"crashes={arcpy.management.GetCount(crashes)[0]}")
