# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Goal and priority

Network service areas (drive-time zones, breaks 1 / 5 / 10 min) on a street network, computed three ways. Priority order: **fidelity with ArcGIS Network Analyst first, speed second.** `README.md` is the full reference (rules, measured results, procedures in section 11); `tasks/todo.md` holds findings and status, `tasks/lessons.md` holds corrections.

Scope: Adams County, Ohio is the gate county (source layers `Adams_Streets` and `Adams_Crashes` in `OhioTGN.gdb`). Franklin County is the dense-network check: a pilot of 20 crashes is compared, the run of 2,000 crashes (`Franklin_s2000`) is not compared yet. Use the named source dataset, not a derived copy.

## Three machines

Nothing but the Node test and static file edits runs on the Mac. Code is edited here and copied to the remotes (`scp`/`rsync`); the remotes are not git clones.

| Where | Path | Runs |
| --- | --- | --- |
| Mac (this repo) | `~/service-area` | editing, `node tests/test_client.mjs`, browser |
| `gpu-x86` (Linux, 2× RTX, CUDA 13) | `~/service-area`, venv `.venv` | `cuda/`, `parity/`, `client/`, `docs/`, Python tests |
| `gpu-arm` (Linux aarch64, NVIDIA GB10, CUDA 13.0) | `~/service-area`, venv `.venv` (uv, same pins as gpu-x86) | alternative to gpu-x86 for `cuda/`, `parity/`, Python tests, server (`client/` not run yet); outputs equal gpu-x86 bit for bit (`results/gpu-arm.md`) |
| `arcgis-win` (Windows, ArcGIS Pro 3.7, NA licence) | `%USERPROFILE%\service-area` | `prep/` (ArcPy) with `"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe"` |

`work/`, `data/`, `web/data/` are git-ignored and live on the remotes (`web/data/` is also copied to the Mac for the Node test). Stop the gpu-x86 tmux session and the tunnel when a task ends.

## Commands

```bash
# gpu-x86: Python tests (all / one by name filter)
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m unittest discover -s tests -k test_name -v

# gpu-x86: CUDA batch + parity gate against ArcGIS output (--locations esri | own)
.venv/bin/python cuda/batch.py Adams_s100 --locations esri
.venv/bin/python parity/compare.py Adams_s100 --locations esri   # report: results/parity_adams_s100_esri.md

# gpu-x86: client data (web/data/adams.bin, adams.json, fixture.json); then copy web/data/ to the Mac
.venv/bin/python client/build_client_data.py Adams

# Mac: browser engine vs CUDA fixture
node tests/test_client.mjs

# live server (binds 127.0.0.1:8765 on gpu-x86) + tunnel
ssh gpu-x86 "cd ~/service-area && tmux new -d -s sa \"ARCGIS_PORTAL_URL=$ARCGIS_PORTAL_URL ARCGIS_CLIENT_ID=$ARCGIS_CLIENT_ID .venv/bin/python cuda/server.py Adams\""
ssh -N -L 8765:localhost:8765 gpu-x86        # then http://localhost:8765/ and /client/check.html
ssh gpu-x86 'tmux kill-session -t sa'

# arcgis-win: prep\01_prepare.py Adams, prep\02_build_nd.py Adams, prep\03_solve_arcpy.py Adams --sample 100 --seed 7
```

`ARCGIS_PORTAL_URL` and `ARCGIS_CLIENT_ID` come from the environment of the Mac at run time: the local shell expands them into the `ssh` command, so set them on the Mac, not on the remote (dark basemap after OAuth sign-in; OSM is the fallback). Never write their values into files.

## Architecture

Pipeline: `prep/` (ArcPy) → Parquet in `work/<County>[_s<N>]` → `cuda/` → `parity/` and `web/`.

- **`prep/`** makes the street network both engines share: filter by MTFCC, planarize, `Integrate` at the network XY tolerance, drop duplicate streets, `Minutes` from the speed table in `speeds.py` (single source of the cost model). `03_solve_arcpy.py` solves with the Network Analyst *layer* API (the `arcpy.nax` API fails: no travel modes) and writes the reference lines, polygons and facility locations. All geometry is EPSG:3735 (US survey feet).
- **`cuda/engine.py`** `Graph`: directed CSR graph with one cost per direction (`wf`, `wb`; `inf` = not allowed). `Graph(edges_parquet)` is the Ohio form (nodes joined on exact coordinates, `wf = wb`); `Graph.from_arrays` takes node ids and per-direction costs (one-way streets). CuPy `RawKernel` shortest paths (one thread block per crash, fp64, cutoff pruning), `locate()` snapping, `reached()` → per-edge reached intervals `[0,a1]`, `[b0,1]`, own-edge `[s0,s1]`, merged by `intervals()`.
- **`cuda/polygons.py`** `Builder`: the one polygon builder. `classify()` splits reached edges into full edges, partial pieces, node disks and filled faces; `polygon()` unions flat-cap buffers of them, then keeps only the ground whose nearest street piece is reached (Voronoi cells of 50 ft pieces, `TERR_FT`; a piece reached in part counts as reached). `POS_EPS` and `MIN_HOLE_FT2` exist to remove slivers and zero-area holes; do not loosen them.
- **`cuda/batch.py`** (offline, all crashes) and **`cuda/server.py`** (FastAPI `/sa`, `/config`, `/crashes`, static `web/`) both use `Graph` + `Builder`.
- **`parity/compare.py`** is the gate. Lines are the exact check against native Network Analyst (cost ≤ 1e-6 min, interval ≤ 1e-6). Polygons are compared with the *same* `Builder` on both sides (IoU ≥ 0.99, Hausdorff ≤ 50 ft); native Esri polygons are reported as reference only, because Esri's polygon generalization is not reproducible. One known residual class, Esri "unsplit break crossing" lines, is labelled but still fails the gate — it is not a tolerance problem, do not widen tolerances to hide it.
- **Browser engine** (`web/client/`), an alternative to the server, not a replacement: `client/build_client_data.py` bakes the graph, snap geometry and a static mesh (offset by the trim distance in EPSG:3735, then projected to Web Mercator). `sa.js` (`ServiceArea`, no SDK imports, also runs in Node) does snapping and a Float64 Dijkstra and reproduces `Builder.classify` as flags. `layer.js` is a `BaseLayerViewGL2D` WebGL2 layer: a mask pass where rasterization is the union and the fragment shader applies the cutoff per pixel, a depth-tested pass that keeps only pixels whose nearest street piece is reached, then a composite pass. `geom.js` builds the real polygon with GEOS-wasm (same rules, Voronoi cells from `cellXY`). It produces a picture, not geometry. `web/app.js` switches Server | Client | Both and warns when `edgesSha256` in `web/data/adams.json` differs from the server's `/config`.

Coupling to respect:
- A rule change in `Builder.classify` / `polygon` must be mirrored in `sa.js` `flags()`, `geom.js` `polygon()` and the shaders in `layer.js`; `tests/test_client.mjs` and `web/client/check.html` (pixel comparison with `/sa`) catch drift.
- After any change to `edges.parquet` or the mesh rules, rebuild the client data and recopy `web/data/`.
- Changing prep changes the network for all engines: re-run prep, the ArcGIS solve, batch and compare.
