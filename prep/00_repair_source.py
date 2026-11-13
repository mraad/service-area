"""Repair the geometry of every feature class in data/OhioTGN.gdb, in place, with the OGC method.

usage: python prep/00_repair_source.py [--workers 1]

One job per county (its Streets, Crashes and other layers).
Keep one process: with 8 processes, 28 of 267 layers failed to open (ERROR 000229 / 000732), because a file
geodatabase does not take that many writers. A second run with one process repaired them.
The first run copies the geodatabase to data/OhioTGN_pre_repair.gdb; nothing is repaired without that copy.
Features with null geometry are kept (KEEP_NULL), so no record is deleted.
Writes work/repair_source.csv: problems found by CheckGeometry (OGC) before and after the repair.
Prep (01, 02, 03) must be run again for a county before its results use the repaired source.
"""
import csv
import multiprocessing as mp
import os
import re
import shutil
import sys
import time
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "OhioTGN.gdb")
BACKUP = os.path.join(ROOT, "data", "OhioTGN_pre_repair.gdb")


def problems(arcpy, fc):
    table = arcpy.management.CheckGeometry(fc, "memory/chk", "OGC").getOutput(0)
    n = int(arcpy.management.GetCount(table)[0])
    arcpy.management.Delete(table)
    return n


def repair(job):
    county, names = job
    import arcpy  # one licence check-out per process
    rows = []
    for name in names:
        fc = os.path.join(SRC, name)
        t = time.perf_counter()
        try:
            before = problems(arcpy, fc)
            if before:
                arcpy.management.RepairGeometry(fc, "KEEP_NULL", "OGC")
            after = problems(arcpy, fc) if before else 0
            rows.append([county, name, int(arcpy.management.GetCount(fc)[0]), before, after,
                         round(time.perf_counter() - t, 1), ""])
        except Exception as exc:  # one bad layer must not stop the other counties
            rows.append([county, name, "", "", "", round(time.perf_counter() - t, 1), str(exc).replace("\n", " ")[:300]])
    return rows


if __name__ == "__main__":
    a = sys.argv[1:]
    workers = int(a[a.index("--workers") + 1]) if "--workers" in a else 1
    if not os.path.exists(BACKUP):
        # A copy that stopped half-way must not count as the safety copy. The name is per run: two runs
        # started together do not write into each other's copy; delete a leftover `.part<pid>` folder by hand.
        part = f"{BACKUP}.part{os.getpid()}"
        shutil.copytree(SRC, part)
        os.rename(part, BACKUP)
        print(f"copy made: {BACKUP}", flush=True)
    import arcpy
    arcpy.env.workspace = SRC
    jobs = defaultdict(list)
    for name in sorted(arcpy.ListFeatureClasses()):
        m = re.match(r"(.+?)_(Streets|Crashes)", name)  # Van_Wert_Streets -> Van_Wert; Crashes_OH is its own job
        jobs[m.group(1) if m else name].append(name)
    print(f"{len(jobs)} jobs, {sum(map(len, jobs.values()))} feature classes, {workers} processes", flush=True)
    out = os.path.join(ROOT, "work", "repair_source.csv")
    with mp.get_context("spawn").Pool(workers) as pool, open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["county", "feature_class", "features", "problems_before", "problems_after", "seconds", "error"])
        for rows in pool.imap_unordered(repair, sorted(jobs.items())):
            w.writerows(rows)
            f.flush()
            print(rows[0][0], [(r[1], r[3], r[4], r[6]) for r in rows if r[3] or r[6]], flush=True)
    print("done:", out)
