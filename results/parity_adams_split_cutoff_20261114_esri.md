# Parity — Adams_split_20261114T121005Z_s100 (CUDA locations: esri)

- Windows ArcPy timings (seconds): load_s=4.131993, solve_s=67.750360, export_s=1.150595

- CUDA timings (seconds): load_s=0.038153, sssp_s=0.084481, reached_s=0.104762, polygons_s=4.103306

- Located Esri facilities (Status 0): 100

## Lines (exact gate)

- Esri line pieces: 84686; (crash, edge, break) interval sets: Esri 97374, CUDA 97374
- Cumulative-minutes mismatches (> 1e-06): **0** (max abs diff 1.776e-15 min)
- Reached-interval mismatches (> 1e-06): **0** (of which Esri left the line unsplit at the break: 0; Esri unsplit break crossings in total: 0)
- Gate: **PASS**

## Polygons — gate: shared builder on Esri lines vs CUDA (IoU ≥ 0.99, Hausdorff ≤ 50 ft)

- Pairs compared: 300 (reference only: 0, CUDA only: 0)
- Within IoU ≥ 0.99 and Hausdorff ≤ 50 ft: **300 / 300**
- Gate: **PASS**

| break | n | IoU min | IoU p1 | IoU p10 | IoU p50 | Haus p50 ft | Haus p99 ft | Haus max ft |
|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.0 | 0.0 | 0.0 |
| 5 | 100 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.0 | 0.0 | 0.0 |
| 10 | 100 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.0 | 0.0 | 0.0 |

Worst 10 by IoU:

- crash 82 break 10: IoU 1.0000, Hausdorff 0.0 ft
- crash 57 break 5: IoU 1.0000, Hausdorff 0.0 ft
- crash 1238 break 5: IoU 1.0000, Hausdorff 0.0 ft
- crash 29 break 1: IoU 1.0000, Hausdorff 0.0 ft
- crash 29 break 5: IoU 1.0000, Hausdorff 0.0 ft
- crash 29 break 10: IoU 1.0000, Hausdorff 0.0 ft
- crash 55 break 1: IoU 1.0000, Hausdorff 0.0 ft
- crash 55 break 5: IoU 1.0000, Hausdorff 0.0 ft
- crash 55 break 10: IoU 1.0000, Hausdorff 0.0 ft
- crash 57 break 1: IoU 1.0000, Hausdorff 0.0 ft

## Polygons — reference only: native ArcGIS High vs CUDA

- Pairs compared: 300 (reference only: 0, CUDA only: 0)
- Within IoU ≥ 0.99 and Hausdorff ≤ 50 ft: **0 / 300**

| break | n | IoU min | IoU p1 | IoU p10 | IoU p50 | Haus p50 ft | Haus p99 ft | Haus max ft |
|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 0.8928 | 0.9005 | 0.9421 | 0.9615 | 309.7 | 755.8 | 833.5 |
| 5 | 100 | 0.7655 | 0.8719 | 0.9665 | 0.9751 | 748.0 | 3090.4 | 3146.5 |
| 10 | 100 | 0.8895 | 0.9158 | 0.9640 | 0.9856 | 1066.1 | 7086.8 | 8204.1 |

Worst 10 by IoU:

- crash 132 break 5: IoU 0.7655, Hausdorff 3146.5 ft
- crash 2075 break 5: IoU 0.8730, Hausdorff 3089.8 ft
- crash 1350 break 5: IoU 0.8865, Hausdorff 2107.5 ft
- crash 403 break 10: IoU 0.8895, Hausdorff 5756.2 ft
- crash 611 break 1: IoU 0.8928, Hausdorff 264.3 ft
- crash 196 break 1: IoU 0.9005, Hausdorff 484.6 ft
- crash 1238 break 10: IoU 0.9161, Hausdorff 8204.1 ft
- crash 322 break 10: IoU 0.9241, Hausdorff 6002.4 ft
- crash 1640 break 10: IoU 0.9258, Hausdorff 5426.5 ft
- crash 55 break 1: IoU 0.9282, Hausdorff 343.4 ft

