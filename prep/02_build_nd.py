"""Build Net/Streets_ND (end-point connectivity, Minutes cost from field) for one county.

usage: python prep/02_build_nd.py Adams

Uses prep/streets_nd_template.xml. To regenerate that template, run with --make-template:
it builds a default ND, exports its template, and prints it for patching.
"""
import os
import sys

import arcpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
county = sys.argv[1]
gdb = os.path.join(ROOT, "work", f"{county}.gdb")
fd = os.path.join(gdb, "Net")
nd = os.path.join(fd, "Streets_ND")
template = os.path.join(ROOT, "prep", "streets_nd_template.xml")
arcpy.env.overwriteOutput = True
arcpy.CheckOutExtension("Network")

if arcpy.Exists(nd):
    arcpy.management.Delete(nd)

if "--make-template" in sys.argv:
    arcpy.na.CreateNetworkDataset(fd, "Streets_ND", ["Streets"], "NO_ELEVATION")
    raw = os.path.join(ROOT, "work", "default_template.xml")
    arcpy.na.CreateTemplateFromNetworkDataset(nd, raw)
    print(open(raw, encoding="utf-8").read())
    sys.exit(0)

arcpy.na.CreateNetworkDatasetFromTemplate(template, fd)
arcpy.na.BuildNetwork(nd)
desc = arcpy.Describe(nd)
print("attributes:", [(a.name, a.usageType) for a in desc.attributes])
print("built:", nd)
