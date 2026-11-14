# Adams geometry repair and network rebuild — 2026-11-14

**Result: no improvement.** A fresh ArcGIS solve after source and prepared-geometry repair and a complete network rebuild reproduces the existing crash 1800 / 5-minute mismatch. Every exported input and ArcGIS result Parquet file is byte-identical to the baseline. Fidelity tolerances and gate logic were not changed.

## Procedure and preservation

- Windows host: `mraadmlwin`, project `C:\Users\mraad\service-area`, ArcGIS Pro 3.7.3 (build 1901), ArcGIS Python environment.
- Input: the named `data\OhioTGN.gdb\Adams_Streets` and `Adams_Crashes`, not a derived replacement.
- Before modifying data, copied the complete source geodatabase, prepared `work\Adams.gdb`, and previous `work\Adams_s100` outputs into `work\keep\repair_rebuild_20261114T120055Z` on Windows. The same directory holds `experiment.json`, CheckGeometry tables and preparation/build/solve logs.
- Ran CheckGeometry with both ESRI and OGC validation, then RepairGeometry with both methods and `KEEP_NULL`, on the two source layers. Re-ran `prep/01_prepare.py Adams`, repaired and checked prepared Streets and Crashes, and kept Minutes consistent with geometry length and the existing speed table.
- Rebuilt `Net\Streets_ND` with `prep/02_build_nd.py Adams`, then ran `prep/03_solve_arcpy.py Adams --sample 100 --seed 7`. Asserted the same facility names, including crash 1800.
- For GPU validation, verified the existing `gc5` baseline files against all fresh Windows export hashes before copying them to the isolated `work/Adams_repair_20261114T120055Z` directory. Used the fresh Windows timing JSON, ran a new CUDA batch with Esri locations and 8 polygon workers, then the unchanged parity gate. Baseline GPU outputs were preserved.
- Reproduction scripts remain on Windows at `work\repair_rebuild_20261114.py` and on `gc5` at `work/Adams_repair_20261114T120055Z/check.py`. GPU code matched repository behavior; `engine.py` differed only in its module docstring.

## Geometry and network

| Layer | Features before / after | ESRI problems before / after | OGC problems before / after |
| --- | ---: | ---: | ---: |
| Source Adams_Streets | 3,063 / 3,063 | 0 / 0 | 0 / 0 |
| Source Adams_Crashes | 2,483 / 2,483 | 0 / 0 | 0 / 0 |
| Prepared Streets | 5,035 / 5,035 | 0 / 0 | 0 / 0 |
| Prepared Crashes | 2,483 / 2,483 | 0 / 0 | 0 / 0 |

Source street repair reported `WARNING 003598: Updated feature class extent`; no geometry defects were reported. Preparation again removed 2,301 duplicates, dropped zero zero-length streets and produced 22 connected components (largest share 0.987). The rebuilt graph has 4,357 nodes. All feature-count assertions passed.

## Before and after results

All five Parquet exports have identical SHA-256 hashes before and after:

| File | SHA-256 |
| --- | --- |
| edges.parquet | bb2cf3f190bfe49a2f53877c84fefb55a61ec881f0f934478088f1da3dfebf65 |
| crashes.parquet | 8a398118449146764e1bf0edd7be5dcdcc800a603bee9d0b7ce39bf738995ca5 |
| esri_facilities.parquet | 77980a58956581226d1fda3438296f31dd16ce18a40f82e619ce8ce8b419213a |
| esri_lines.parquet | c3de3b54bed7393115266cbcac8fa855b8fe21247c3dccf1835c312dba180477 |
| esri_polygons.parquet | fe8ae839116a71d01fb0c62bff1f472137f365ef4c8f54d193b4977f9ff38f42 |

| Measure | Before | After |
| --- | ---: | ---: |
| ArcPy solve seconds | 69.274490 | 69.454876 |
| Located facilities | 100 | 100 |
| ArcPy line pieces | 84,676 | 84,676 |
| Cumulative-cost mismatches | 0 | 0 |
| Maximum cost error, minutes | 1.776e-15 | 1.776e-15 |
| Reached-interval mismatches | 1 | 1 |
| Shared-builder polygon pairs passing | 299 / 300 | 299 / 300 |
| Crash 1800, 5 min: shared-builder IoU | 0.9396 | 0.9396 |
| Crash 1800, 5 min: Hausdorff, feet | 2,131.2 | 2,131.2 |

The current Builder's polygon metrics above match the current baseline; older investigation notes predate the nearest-street rule and list different polygon metrics. Native ArcGIS polygon comparisons also remain unchanged. Full fresh gate report: [parity_adams_repair_20261114_esri.md](parity_adams_repair_20261114_esri.md). The parity command exits 1 because the known gates still fail.

The fresh CUDA reached and polygon files also match their baseline SHA-256 hashes:
`d21f892a828c4eb32e7fdf2a0185aab4f051782e12ccf2885fc0e17bafadabac`
and `d3cf6ecd230a2caa9ca58d93d66619443c3570e46f0ccec59dfafb65444a3682`, respectively.

## Exact remaining crossing

For facility OID 72 (crash 1800), source edge 3249, ArcGIS still exports one whole-edge line:

- FromPosition `0.0`, ToPosition `1.0`.
- FromCumul_Minutes `3.5492812118132644`.
- ToCumul_Minutes `5.000032509772196`.
- At break 5, CUDA reaches `[0.0, 0.9999775910783317]`; ArcGIS has no interval for this edge in that cumulative break, so the gate labels an Esri unsplit crossing.

This experiment rules out repair/rebuild as a remedy for this reproducible case; it does not establish the internal ArcGIS cause. The mismatch remains visible and deferred.

Scope: Adams_s100 only. Franklin and a full Adams re-solve were not run. Client data did not require rebuilding because exported edges and mesh rules did not change. No server or tunnel was started.
