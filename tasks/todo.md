# CUDA service areas — todo

## Review and optimization — 2026-11-14

- Branch `optimize/simplify-service-area`: fixed superseded server-request results/queue handling; planner greedy skips candidates whose previous gain cannot beat the current winner; removed the unused request timer.
- Node checks pass: `tests/test_app.mjs` and fixture-free `tests/test_greedy.mjs` (512 reference comparisons). Synthetic planner benchmark: 1.62x local coverage, 1.13x overlapping, no material change for dense coverage; picks and gains unchanged.
- Remote/fixture validation unavailable (`gpu-x86` does not resolve; local `web/data/` absent). Manual final review; CodeRabbit authentication callback failed. Scope, evidence and limits: `results/codebase_review_20261114.md`.
- Shipping follow-up: retrieved fixtures from `gc5`; client engine (100 crashes), geometry (300/300 polygons), planner, app and greedy tests pass. Direct ArcPy gate retains the known crash 1800 / 5-minute interval mismatch (0 cost mismatches, 1 interval mismatch). User explicitly authorized deferring that residual and shipping; tolerances and gates remain unchanged. Revisit with a fresh Windows ArcPy solve and line-band inspection.

## Deferred investigation (user request)

- Finding 2026-11-12: the unsplit crossings come from the ArcGIS line output, not from CUDA (costs equal within 1e-6 min at both line ends; source geometry has 0 OGC problems; Franklin pilot shows 2 more). Why ArcGIS does not split is still unknown. README 8.4 has the note.
- [ ] Crash 1800, 5-minute break: defer investigation for now. Edge 3249 is reached by CUDA over [0, 0.9999775910783317], but ArcPy leaves the crossing unsplit and assigns the piece to the next break band. Shared-builder polygon IoU is 0.939716; Hausdorff distance is 2,143.624 ft. Revisit with a fresh Windows ArcPy solve and inspect the line-band assignment. Comparison image: `results/crash1800_failure.png`. Keep this known residual visible in parity reports; deferral does not change tolerances or establish a full parity pass.
- [x] 2026-11-14 repair/rebuild experiment on `mraadmlwin`: backed up the full named source GDB, prepared Adams GDB and sample; repaired source and prepared geometry using ESRI + OGC with KEEP_NULL (0 problems before/after, counts unchanged); reran prep, rebuilt ND and solved the identical 100-crash seed-7 sample. All five exported Parquet files byte-identical to baseline. Fresh CUDA batch + parity on `gc5`: still 0 cost mismatches, 1 interval mismatch, 299/300 shared-builder polygons passing. No improvement; retain the deferral. Current Builder metrics: IoU 0.9396 / Hausdorff 2,131.2 ft (the older figures above predate the nearest-street rule). Evidence and backups: `results/adams_repair_rebuild_20261114.md`; gate: `results/parity_adams_repair_20261114_esri.md`.
- [x] 2026-11-14 cutoff-split experiment: on an isolated prepared-network copy, split edge 3249 at fraction 0.9999775910783317 (new tail EID 7337, length 0.085981 ft). Rebuilt and reran the same 100 crashes/seed 7; fresh CUDA Esri-location gate now has 0 cost mismatches, 0 interval mismatches and 300/300 shared-builder polygons passing. All other edges and original network preserved; native ArcGIS polygons byte-identical to baseline. Supports an exported-line splitting/band issue; this is not a general fix, and the original network's residual remains deferred. Evidence: `results/adams_split_cutoff_20261114.md`; gate: `results/parity_adams_split_cutoff_20261114_esri.md`.

Plan: `~/.claude/plans/you-re-an-expert-network-declarative-comet.md`

## Phase 1 — Data + ArcPy baseline (arcgis-win)
- [x] Copy Adams+Franklin subset (`data/OhioSub.gdb`, 25 MB) to arcgis-win
- [x] `speeds.py` (MTFCC → mph)
- [x] `prep/01_prepare.py` Adams: filter, planarize, `Minutes`, crashes
- [x] Connectivity check: components before/after planarize
- [x] `prep/02_build_nd.py` + `prep/streets_nd_template.xml`, ND built
- [x] `prep/03_solve_arcpy.py`: SA 1/5/10, High, Lines+Polygons, timing
- [ ] Export edges, facilities, Esri lines/polygons to Parquet

## Phase 2 — CUDA SSSP + lines (gpu-x86)
- [x] uv venv: cupy-cuda13x shapely pyproj pyarrow fastapi uvicorn
- [x] `cuda/graph.py` CSR + snapper
- [x] `cuda/sssp.cu` + `cuda/sssp.py` batch kernel (fp64)
- [x] `cuda/lines.py` partial edges
- [x] Unit tests: GPU vs heapq Dijkstra, clip math
- [ ] Line parity exact with Esri locations (20-crash sample PASS, max 1.8e-15 min; full run pending)
- [ ] Line parity exact with own snapper

## Phase 3 — Polygons + calibration
- [x] `cuda/polygons.py` buffer-union
- [x] `parity/compare.py` → `results/parity_adams.md`
- [ ] Gate: IoU ≥ 0.99, Hausdorff ≤ 50 ft (else GPU cost-field raster; thresholds fixed)

## Phase 4 — Performance (Franklin) — DEFERRED: Adams only for now (user, 2026-11-10)
- [ ] Prep + ND Franklin (freeway/ramp endpoint-only)
- [ ] ArcPy on 5,000 seeded crashes; extrapolate
- [ ] CUDA on all 114,712; `results/bench.md`
- [ ] Parity spot-check 500 Franklin crashes

## Phase 5 — Live service + web app
- [ ] `cuda/server.py` FastAPI `/sa`
- [ ] `web/index.html` + `web/app.js` (SDK 5.2, hover/click, abort stale)
- [ ] `results/latency.md` p50/p95, 1,000 points × 1/5/10
- [ ] Screenshot; stop tmux

## Findings / status (2026-11-10)
- Source: original OhioTGN.gdb on arcgis-win (data/OhioTGN.gdb). Dedupe drops 2,301 duplicate edges (same MTFCC, alternate names); Integrate at ND XY tolerance; 5,035 edges, 22 components.
- No travel modes in template ND -> 03 uses layer API (MakeServiceAreaAnalysisLayer + JSON travel mode).
- Fidelity sample (100 crashes, seed 7), both Esri locations and own snapping:
  lines 0 cost mismatches / 84,676 pieces; 1 interval mismatch = Esri unsplit break crossing (crash 1800, edge 3249, 5 min).
  Shared-builder polygons 299/300 (same case). Native Esri High reference: IoU p50 0.94 / 0.97 / 0.98 (1/5/10 min).
- Esri unsplit crossings are not a tolerance: full Adams has 17 vs 244,266 splits, ranges overlap in ft/min/fraction,
  and one edge is split for one crash and unsplit for another. Left as labelled residual (gate stays FAIL on them).
- Full Adams ArcGIS solve: 2,483 crashes, 1,873 s. CUDA 100 crashes: SSSP 0.08 s, reached 0.17 s, polygons 2.3 s (48 workers).
- Live /sa server p50: 1 min 3.2 ms, 5 min 20 ms, 10 min 98 ms (results/latency.md). Server stopped.
- Not run yet: Franklin branch of prep (freeway/ramp), dark basemap in a browser.

## Phase 6 — Client-side engine (WebGL alternative, plan 2026-11-10)
- [x] `Builder.classify` refactor; parity report identical
- [x] `client/build_client_data.py` → `web/data/adams.bin|json`, `fixture.json` (18.6 MB)
- [x] `web/client/sa.js` + `tests/test_client.mjs`: cost diff 0, flags equal, snap diff 5.7e-7
- [x] `web/client/layer.js` (BaseLayerViewGL2D, mask + composite)
- [x] Engine toggle Server | Client | Both + deep link in `web/app.js`
- [x] Headless Chrome: `client/check.html` IoU 0.9955–0.9997 vs server; real map screenshot in Both mode
- [x] README section 14 + procedure 11.8
- [ ] Not done: frame rate in a real browser; hover feel checked by a person
- Finding: GEOS flat-cap buffer (server) drops area on short end pieces after a bend (0.34% worst); client draws the full union.

## Audit 2 fixes (2026-11-10)
- [x] 1+4 one client load promise, errors caught, falls back to Server with a message (headless: 404 case shows it)
- [x] 2 `edgesSha256` in `adams.json` and `/config`; page warns on mismatch (headless: tampered hash shows it)
- [x] 3 rotation: `check.html` 30° cases IoU 0.995–0.997; real map at `rotation=30` coincides with the server outline
- [x] 5 `/sa` rejects nan / inf / out-of-range with 422
- [x] 6 README 11.7/11.8 order; 7 `client_ms` column removed; 8 `trimFt` removed
- [ ] 9 not changed: per-frame `gl.getParameter(gl.VIEWPORT)` stays; the SDK viewport origin is not guaranteed to be 0,0

## Phase 7 — WASM / WebGPU investigation (plan 2026-11-11, branch `investigate/wasm-webgpu`)
Goals: bigger networks; real polygon geometry in the browser. WebGPU in plain fp32; emulated fp64 documented only.
- [x] A1 `tests/bench_scale.mjs`: k = 1/10/30/100 disjoint Adams copies; solve/flags/snap ms, upload bytes, data size
- [x] A2 `sa.js` sparse reset + touched-only flags; `layer.js` dirty-row upload; `test_client.mjs` still exact
- [x] A3 `wasm/sa-core` (Rust) solve+flags: 2.3× but 0.07 ms/click; deleted after audit (4th copy of interval rules)
- [x] A4 `web/client/gpu.js` + `bench_gpu.html`: WGSL port of CUDA kernel, fp32 error vs 1e-6 gate, timings
- [x] A5 mesh size + tiling notes (no build)
- [x] A6 emulated fp64 design (report only)
- [x] B1 `geos-wasm` 3.1.1 = GEOS 3.13.0 (Shapely 3.14.1)
- [x] B2 `build_client_data.py`: `vert3735`, node/face 3735 geometry, `fixture_poly.json`
- [x] B3 `sa.js` `flags()` keeps merged pieces
- [x] B4 `web/client/geom.js` GEOS polygon (EPSG:3735) 
- [x] B5 `tests/test_client_geom.mjs` + `package.json`: IoU ≥ 0.99, Hausdorff ≤ 50 ft, ms per polygon
- [ ] B6 `app.js` Polygon toggle; `check.html` GEOS IoU vs `/sa`
- [x] C `results/browser_compute.md` + README section
- Findings: per-call O(N+E) was the scale limit (flags 5.96 → 0.10 ms, upload 8.57 → 0.12 MB at 100×); data size (~19 MB per
  Adams) is the real limit. WASM 2.3× but saves 0.07 ms/click. WebGPU fp32: 6.36 % nodes over 1e-6 gate, 0 polygon-part
  differences; 1 source 0.40 ms (10× slower than JS), 100 sources 0.50 ms (8.5× faster). Pieces = Builder 300/300.
- gpu-x86 `web/data.bak-20261111` holds the client data before the rebuild; gpu-x86 `web/` synced from the branch.
- B5: 300/300 pass, min IoU 0.998819, max Hausdorff 12.92 ft; p50 0.8 / 16.4 / 74.3 ms (1/5/10 min). Residual cause not isolated.
- Benchmark 2026-11-11 (gpu-x86, Adams_s100, 7 warm repeats, median): sssp 0.4 ms, reached 5.3 ms, polygons serial 12.57 s; ArcPy solve 69.3 s (same 100).
- gpu-x86 `work/Adams` had stale esri_* (7,336-edge, 20-crash run) beside current edges; replaced with the Windows 2,483-crash run (edges sha matches); old files in `work/keep/stale-20261111/`.

## Phase 8 — Station planner (WebAssembly + WebGPU app, plan 2026-11-11, branch `feat/station-planner`)
Question it answers: where should k response stations go to reach the most crashes within B minutes?
- [x] P1 `web/client/planner.js` (no SDK): crash positions (snap), station→crash cost rows from node costs, greedy max coverage, exact Float64 evaluation of chosen stations
- [x] P2 candidate solve: WebGPU `GpuSssp` in chunks of 512 sources (fp32, ranking only); CPU `sa.solve` fallback when WebGPU is missing
- [x] P3 `tests/test_planner.mjs`: greedy vs brute force on a small set; exact evaluation vs `sa.solve`; GPU-free path
- [x] P4 polygons: chosen stations solved in Float64, `geom.polygon` per station, GEOS union, projected 3735 → map with SDK `projectOperator`
- [x] P5 `web/planner.html` + `web/planner.js`: crashes from `/crashes`, k (1–20) and break (1/5/10), Run, table % reached at 1/5/10 min, timings, GeoJSON export (WGS84)
- [x] P6 headless run against the live server: timings, GPU vs CPU ranking agreement; README section
Rules: reported numbers and polygons come from Float64 (fidelity first); fp32 GPU only ranks candidates.
- Results (Chrome headless, Metal): 2,483 candidates WebGPU 37–41 ms warm (79 ms cold) vs CPU 110 ms; same picks 60/60;
  5 stations at 5 min reach 1,228 / 2,483 (49.5 %); GEOS coverage 213–217 ms. Export: MultiPolygon, RFC 7946 ring order.
- Found while testing: SDK polygon projection does not keep one ring per input ring (export crashed); rings are projected as
  polyline paths. `projectOperator.load/execute` are deprecated in SDK 5.2: use `projectLoad/projectExecute`.

## Phase 9 — Live service area page (WebGPU + WebAssembly, 2026-11-11)
- [x] `sa.setDist` (costs from another solver; used by `bench_gpu.html` and `live_app.js`), test in `test_client.mjs`
- [x] `web/live.html` + `web/live_app.js`: click/hover, WebGPU solve, GEOS polygon + area, Float64 parts check, latest-wins
- [x] Headless (Metal): 44/44 solves same parts; 5 min solve 0.8–2 ms, GEOS 21–34 ms; 10 min GEOS 91 ms
- [ ] Not done: hover feel checked by a person in a visible browser
- [x] README: hover animation `docs/images/live_hover.gif` (28 frames, 640×410, 164 KB; edge 2206 near West Union, 5 min), `docs/make_hover_gif.mjs`; layout rows for the new files
- [ ] Skipped for now (CodeRabbit PR #5, unverified): keyboard way to pick a solve point on `live.html` (and `index.html`), e.g. a "Solve at map center" button

## Phase 10 — gpu-arm as an alternative to gpu-x86 (plan 2026-11-11, branch `investigate/gpu-arm`)
gpu-arm: NVIDIA GB10 (aarch64, 20 cores, 121 GB unified memory), Ubuntu 24.04, CUDA 13.0, driver 580, uv in ~/.local/bin. gpu-x86 stays the default; nothing that uses gpu-x86 is removed.
- [x] S1 `~/service-area` on gpu-arm: copy code, `work/Adams_s100`, `work/Adams`, `web/data` (from gpu-x86, same files and hashes)
- [x] S2 venv with uv, same versions as gpu-x86 (cupy-cuda13x 14.2.0 on aarch64, numpy 2.5.4, shapely 2.2.0 / GEOS 3.14.1, pyarrow 26.0.1, pyproj 3.8.0, fastapi, uvicorn)
- [x] S3 Python tests on gpu-arm
- [x] S4 fidelity: `cuda/batch.py Adams_s100` + `parity/compare.py`: same gate results as gpu-x86; reached and polygon outputs compared with gpu-x86's
- [x] S5 speed: `parity/benchmark.py Adams_s100` and `parity/latency.py` on gpu-arm vs gpu-x86
- [x] S6 live server on gpu-arm + tunnel: `live.html`, `planner.html`, `index.html` load and solve
- [x] S7 docs: README + CLAUDE.md name gpu-arm as an alternative host (gpu-x86 unchanged); `results/gpu-arm.md` with the comparison
- Results: outputs bit-identical to gpu-x86 (97,363 reached rows, 300/300 polygon WKB); gates same; polygons serial 6.23 s vs 12.57 s; server p50 1.4/13.5/49.9 vs 2.9/26.4/99.2 ms; pages work through gpu-arm (tunnel :8766). Details `results/gpu-arm.md`.
- Finding: compare.py "Worst 10" tie order differs across machines (unstable `np.argsort`); report gates and numbers equal.

## Phase 11 — Review, simplify, optimize (plan 2026-11-12, branch `refactor/simplify-optimize`)
Plan: `~/.claude/plans/review-simplify-and-optimize-wise-newt.md`. Host gpu-x86, gpu-arm cross-check. `prep/` review only.
- [x] 0 baseline on gpu-x86 (`work/keep/baseline-20261112/`, hashes), baseline timings, polygon profile
- [x] 1 simplify: `located_esri` / `BREAKS` / worker init reused; batch invalidation; stable "Worst 10"; JS `POS_EPS`, `area()`, `gpuSolveMany`
- [x] 2a full-edge + disk buffer cache in `Builder` (byte-identical)
- [x] 2b skipped: `Builder.__init__` 0.23 s, not worth it
- [x] 2c `/sa` response without JSON round trip; plus optional 8-thread union (`Builder.polygon(pool=)`), used by the server only
- [x] 2d buffer cache in `geom.js`
- [x] 3 MultiLineString buffer experiment: rejected (slower; IoU 0.9972, Hausdorff 332 ft vs today)
- [x] verify: Python tests, batch + compare hashes, client data hashes, Node tests, gpu-arm
- [x] `/sa` latency after the change (gpu-x86, n 100): p50 2.8 / 10.4 / 34.2 ms (before 3.2 / 20.1 / 97.8); gpu-arm (n 200) 1.7 / 8.6 / 23.8 ms. Figures `latency.png`, `timing.png` regenerated.
- [ ] not done: `check.html` in a browser; gpu-x86 round trip 255 ms vs server 34 ms at 10 min (client/loopback side, not isolated)
- Profile (gpu-x86, Adams_s100, ms per polygon at 1/5/10 min): total 3.1 / 27.4 / 95.3; union 1.7 / 21.2 / 75.4 (79 %), piece buffers 0.6 / 3.8 / 13.7, classify 0.4 / 1.1 / 2.6. SSSP + reached under 6 ms for 100 crashes.
- Exact (byte-identical `cuda_reached_*`, `cuda_polygons_*`, `adams.bin`, fixtures on gpu-x86 and gpu-arm): benchmark polygons serial gpu-x86 12.57 → 10.65 s, gpu-arm 6.23 → 5.24 s.
- Union strategies vs serial `union_all` (Adams_s100, 10 min): 8 threads 76.0 → 29.4 ms; absorb covered edges into face buffers 62.4 ms; `buffer(0)` 357.6 ms. Threads on full Adams (7,449 polygons): 81.6 → 33.7 ms at 10 min, min IoU 0.999999999999, max Hausdorff 1.8e-5 ft. Batch keeps the serial union (48 processes already), so its outputs stay byte-identical.
- Browser GEOS (Node, Mac): 10 min p50 73.2 → 62 ms with the buffer cache; parity 300/300, min IoU 0.998819 unchanged.
- Reviewed, not changed: CUDA and WGSL kernels (under 1 ms), `prep/` (review only), hand-rolled argv parsing, the two latest-wins request loops.
- gpu-x86 baseline before this phase: `work/keep/baseline-20261112/` (SHA256SUMS).

## Phase 12 — Franklin County check, 2,000-crash sample (plan 2026-11-12)
Source: `data/OhioTGN.gdb` on arcgis-win: `Franklin_Streets` 22,573, `Franklin_Crashes` 114,712. Seed 7, breaks 1/5/10, same settings as Adams.
- [ ] F1 `prep/01_prepare.py Franklin` (first run of the freeway/ramp endpoint-only branch); check components before/after, duplicates
- [ ] F2 `prep/02_build_nd.py Franklin`
- [ ] F3 pilot: `03_solve_arcpy.py Franklin --sample 20` to measure s/crash and line pieces/crash; extrapolate time and size for 2,000
- [ ] F4 `03_solve_arcpy.py Franklin --sample 2000 --seed 7` → `work/Franklin_s2000` (ArcGIS timing kept); split into batches only if F3 shows one solve is not feasible
- [ ] F5 save the sample: CID list in `results/franklin_s2000_seed7_cids.csv` (tracked) and the parquet folder kept on arcgis-win + CUDA host
- [ ] F6 parity first: `cuda/batch.py Franklin_s2000 --locations esri|own`, `parity/compare.py` → `results/parity_franklin_s2000_{esri,own}.md`
- [ ] F7 speed: batch ×3 (median sssp / reached / polygons), `/sa` latency on Franklin (n 200), ArcGIS solve_s; speedup per crash and per polygon
- Finding F1: 54,639 edges (from 22,566 after the walkway filter), 3,214 duplicates dropped, components 14,272 → 19 (largest 0.999); ND built.
- Finding F3 pilot (20 crashes, seed 7): ArcGIS solve 54.7 s (2.7 s/crash), 304,903 line pieces (15,245/crash, 24 MB). 2,000 projected ~91 min, ~30 M pieces → `--batch 200` (10 groups); `prep/03_solve_arcpy.py --batch` added (one group writes the same files as before).
- Bug fixed: `polygonize` made 2 self-intersecting faces of 13,606 where freeway/ramp cross streets with no node; `union_all` raised TopologyException. `Builder.__init__` repairs only invalid faces with `make_valid`; Adams_s100 outputs unchanged (4 hashes on gpu-arm).
- Pilot parity (gpu-arm = gpu-x86 bit for bit): lines 0 cost mismatches; 2 interval mismatches, both Esri unsplit crossings; shared builder 58/60 (same 2). Native Esri vs CUDA median IoU 0.86 / 0.93 / 0.95, Haus median 471 / 4,097 / 13,543 ft (Adams 0.94 / 0.97 / 0.98).
- Cause (tested on the 3 worst pilot cases): Esri keeps a point only if its NEAREST street is reached there; unreached parallel streets beside freeways cut its polygon. Nearest-street rule vs Esri IoU 0.86 / 0.94 (1 / 5 min) against buffer-union 0.33 / 0.67; at 10 min it is too small (0.86 vs 0.93): Esri also fills blocks. Proposal (not done, needs a decision): a builder that combines nearest-street with block fill; gate stays the shared builder.
- [ ] F8 comparison: `results/franklin_s2000.md` (accuracy, timing, speedup, Adams vs Franklin), README section, published page section

## Phase 13 — Polygon rule for dense networks (plan 2026-11-12, `~/.claude/plans/review-simplify-and-optimize-wise-newt.md`)
Franklin pilot: native-ArcGIS median IoU 0.86 / 0.93 / 0.95 against Adams 0.94 / 0.97 / 0.98. Buffer union covers unreached streets beside freeways.
- [x] A1 raster evaluation of 10 candidate rules (Franklin_s20 + Adams_s100), native IoU per rule and break
- [x] A2 not needed: A1 rejects untrimmed inner breaks (nearest street with no trim: Franklin 0.85 / 0.84 / 0.88, Adams 0.38 / 0.36 / 0.48)
- [x] A3 Gate A passed by "buffer union, cut to the ground whose nearest street is reached" (same result as nearest + trim + strict blocks). Relaxed block fill is worse at 10 min (Adams 0.94).
- [x] B rule in `Builder`: point-Voronoi cells of 50 ft street pieces (`TERR_FT`), coverage union of the reached cells, intersection with the buffer union. `tests/test_polygons.py` (4 tests). No cache file: start-up 1.4 s Adams, 7.7 s Franklin per process.
- Native ArcGIS median IoU, before → after: Franklin_s20 0.860 / 0.927 / 0.953 → 0.967 / 0.972 / 0.969 (p10 0.459 / 0.886 / 0.939 → 0.919 / 0.948 / 0.958); Adams_s100 0.941 / 0.970 / 0.985 → 0.962 / 0.975 / 0.986.
- Gates unchanged: lines 0 cost mismatches; interval mismatches only the ArcGIS unsplit crossings (Adams 1, Franklin 2); shared builder 299/300 and 58/60. gpu-x86 and gpu-arm reports and polygon hashes identical; `cuda_reached_*` hashes unchanged.
- Cost: polygon time +15–25 % (Adams 10 min 82 → 115 ms; Franklin 10 min 1.33 s, of which the buffer union 1.06 s). Batch Adams_s100 polygons 2.4 → 4.3 s on gpu-x86 (worker start-up).
- Bugs found on the way: one Voronoi cell with a float-noise spike broke the coverage (fixed: midpoints rounded to 0.001 ft); street data itself is valid, no data repair needed.
- [x] C browser mirror (user go-ahead 2026-11-12):
  - `layer.js`: second mask pass with the depth buffer (depth = distance from the street, mesh attribute b); the nearest street or node writes "reached" into the green channel; composite = union AND nearest reached. Piece rule in the shader (`pieceN` in the 4th channel of the edge texture).
  - `geom.js`: Voronoi cells from `cellXY` with GEOS-wasm (`GEOSVoronoiDiagram`, once, about 2.5 s for Adams; `prepare()` runs it at page load), `GEOSCoverageUnion` of the reached cells, `GEOSIntersection`.
  - `sa.js`: `nodeFlags` 255 disk / 100 reached end without disk; `pieceOff`. `build_client_data.py`: `pieceN`, `pieceCell`, `cellXY`, street-vertex offset b. `adams.bin` 20.9 → 23.9 MB.
  - Headless Chrome through gpu-arm: `check.html` PASS, 18 cases IoU 0.9969–0.9997 against `/sa`; `live.html` 15/15 solves with the same parts as Float64 (GEOS 57–118 ms at 10 min); planner same result (1,228 / 2,483 at 5 min, polygon 295 ms, was 213–217); `index.html` Both mode draws.
- Tried and removed: cutting the cell of a partly reached piece at the break position (half-plane, then strip). It made thin slits that move with float noise in the positions: Adams own-location gate 299 → 291/300 with IoU 1.0000 and Hausdorff up to 94 ft. Kept rule: a piece reached in part counts as reached, in all engines (`shortcut:` comment in `Builder.polygon`).
- Source repair (user request 2026-11-12): `prep/00_repair_source.py`, OGC method, in place on `data/OhioTGN.gdb` (copy first: `data/OhioTGN_pre_repair.gdb`). 88 counties + statewide, 267 layers, 3,027,360 features. 7 street layers had problems, 136 features in total (Lake 120, Champaign 5, Columbiana 5, Brown 3, Huron 1, Monroe 1, Muskingum 1); 0 after. Adams and Franklin: 0 problems. No layer lost, no feature count changed. 8 parallel processes: 28 layers failed to open; a serial rerun covered them. Log: `results/repair_source_20261112.csv`.
- Lesson for me: a shell check chained with `&&` before an edit hid that the edit did not run; one parity run measured old code.
