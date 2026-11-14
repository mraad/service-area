# Adams cutoff-edge split experiment — 2026-11-14

**Splitting the affected edge at the calculated cutoff removes the mismatch on an isolated network copy.** The unchanged Esri-location gates now pass: zero cost mismatches, zero reached-interval mismatches, and 300/300 shared-builder polygon pairs passing across the same 100 crashes and 1/5/10-minute breaks. The original network and baseline exports were not modified.

## Controlled change

Windows host `mraadmlwin`, ArcGIS Pro 3.7.3. Copied the prepared `work\Adams.gdb` to `work\Adams_split_20261114T121005Z.gdb`; removed the copy's network dataset before editing. This intentionally modified copy was authorized as a diagnostic experiment; the named source `data\OhioTGN.gdb` was not changed.

For crash 1800, original edge 3249 has endpoint costs 3.5492812118132644 and 5.000032509772196 minutes. The calculated 5-minute position is:

`(5 - 3.5492812118132644) / (5.000032509772196 - 3.5492812118132644) = 0.9999775910783317`

Used ArcPy `segmentAlongLine` at that normalized position. Kept the first child at OID/EID 3249 and inserted the tail as OID/EID 7337. Preserved all other attributes and used the existing speed-table function to compute Minutes from each child's length. Checked the stored child geometries and cost values.

| Measure | Value |
| --- | ---: |
| Original length, ft | 3,829.9834266115795 |
| Long child length, ft | 3,829.8974456544256 |
| Tail length, ft | 0.0859809918316327 |
| Long child cost, min | 1.4507187881867265 |
| Tail cost, min | 0.0000325097722052645 |
| Change in total edge cost, min | 2.220446049250313e-16 |
| Arrival cost at new junction, min | 4.999999999999991 |
| Network XY tolerance, ft | 0.00328083333333333 |
| Network XY resolution, ft | 0.00032808333333333355 |

The tail is about 26 times the XY tolerance. Assertions verified positive child lengths, the exact shared junction, preservation of the original outer endpoints, identical geometry/costs for every other edge, OID/EID agreement and zero OGC geometry problems. Edges/nodes changed from 5,035/4,357 to 5,036/4,358.

Rebuilt with the existing `prep/02_build_nd.py` and solved with the existing `prep/03_solve_arcpy.py`, using the experiment county name and `--sample 100 --seed 7`. Asserted the facility names match the baseline. The original prepared-network geometry/cost snapshot and all five original sample Parquet hashes were unchanged after completion.

ArcGIS now exports the two children separately for crash 1800:

| Edge | From position | To position | From cost, min | To cost, min |
| --- | ---: | ---: | ---: | ---: |
| 3249 | 0 | 1 | 3.5492812118132644 | 4.999999999999991 |
| 7337 | 0 | 1 | 4.999999999999991 | 5.000032509772196 |

## GPU verification

Copied the complete experiment exports through the Mac to the separate `gc5` directory `work/Adams_split_20261114T121005Z_s100`. Verified the hashes recorded by the CUDA batch against the locally transferred Windows Parquet files. Ran the existing CUDA batch (`--locations esri --workers 8`) and unchanged parity gate on the **same modified network** used by ArcGIS.

| Measure | Original/repaired baseline | Cutoff split |
| --- | ---: | ---: |
| Located facilities | 100 | 100 |
| ArcPy line pieces | 84,676 | 84,686 |
| Cumulative-cost mismatches | 0 | 0 |
| Maximum cost difference, min | 1.776e-15 | 1.776e-15 |
| Reached-interval mismatches | 1 | 0 |
| Esri unsplit break crossings | 1 | 0 |
| Line gate | FAIL | PASS |
| Shared-builder polygon pairs passing | 299 / 300 | 300 / 300 |
| Shared-builder polygon gate | FAIL | PASS |
| ArcPy solve seconds | 69.454876 | 67.750360 |

The split report shows shared-builder IoU 1.0000 and Hausdorff 0.0 ft at each break (rounded report values). Full report: [parity_adams_split_cutoff_20261114_esri.md](parity_adams_split_cutoff_20261114_esri.md). The parity command exited 0. Timing is a single solve per case and does not establish a performance improvement.

## Interpretation and retained limits

The native ArcGIS polygon Parquet file is byte-identical to the baseline (SHA-256 `fe8ae839116a71d01fb0c62bff1f472137f365ef4c8f54d193b4977f9ff38f42`), as are crashes and facility locations. The network and exported line files changed. This supports a line-output splitting/band-assignment explanation rather than an incorrect accumulated travel cost. It does not identify the internal ArcGIS implementation cause.

This is a cutoff-specific diagnostic workaround on a copy, not a general preparation change. The original network's known failure remains deferred. Splitting also introduces a junction and floating-point arithmetic changes, so this experiment alone cannot isolate every internal factor. No tolerances, gate logic, source data or production/client data were changed. Midpoint and other split positions, own-location parity, full Adams and Franklin were not tested.

Artifacts remain on Windows:

- Experiment script: `C:\Users\mraad\service-area\work\split_edge_20261114.py`.
- GDB: `work\Adams_split_20261114T121005Z.gdb`.
- Logs, geometry check and manifest: `work\keep\Adams_split_20261114T121005Z`.
- Exports and manifest: `work\Adams_split_20261114T121005Z_s100`.

GPU artifacts remain under the same experiment sample name on `gc5`. No server or tunnel was started.
