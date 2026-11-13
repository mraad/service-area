# Browser compute: WebAssembly and WebGPU (investigation, 2026-11-11)

Question: what does it take to run the service area in WebAssembly, and to use the browser GPU for the calculation?
Goals chosen: (1) bigger networks, (2) real polygon geometry in the browser. Fidelity first, speed second.

Machine: Mac (Apple silicon, Metal), Node v26.13.0, Chrome headless. Network: Adams (4,357 nodes, 5,035 edges).

## 1. Where the time goes on a bigger network

`tests/bench_scale.mjs` runs the browser engine on k disjoint, translated copies of Adams.
Limit: the copies are not connected, so this measures per-call work that grows with network size, not cross-tile routing.
Every run checks that costs equal the CUDA fixture (the WASM spike was also checked bit for bit against the JS engine).

Before (whole-array work per call):

| k | edges | solve 10 min (ms) | flags (ms) | texture upload per solve (MB) | client data (MB) |
|---|---|---|---|---|---|
| 1 | 5,035 | 0.041 | 0.174 | 0.09 | 19 |
| 10 | 50,350 | 0.064 | 0.730 | 0.87 | 186 |
| 30 | 151,050 | 0.083 | 1.915 | 2.58 | 558 |
| 100 | 503,500 | 0.192 | 5.957 | 8.57 | 1,859 |

After the JS change (reset only the nodes the last solve reached; `flags()` visits only edges at reached nodes;
`layer.js` uploads only changed texture rows):

| k | solve (ms) | flags (ms) | upload per solve (MB) | WASM solve (ms) | WASM flags (ms) |
|---|---|---|---|---|---|
| 1 | 0.032 | 0.089 | 0.075 | 0.028 | 0.025 |
| 10 | 0.035 | 0.095 | 0.116 | 0.030 | 0.027 |
| 30 | 0.037 | 0.095 | 0.114 | 0.031 | 0.028 |
| 100 | 0.036 | 0.100 | 0.117 | 0.031 | 0.029 |

Results:
- The per-call cost was O(N + E), not Dijkstra. The JS change makes it flat: flags 5.96 → 0.10 ms, upload 8.57 → 0.12 MB at 100×.
  `tests/test_client.mjs` still gives cost difference 0 and equal flags. `client/check.html` against `/sa`: worst IoU 0.9953 (gate 0.99).
- WASM (Rust spike, 31 KB): solve 1.2× and flags 3.4× faster than the new JS; together 2.3×.
  The saving is 0.07 ms per click, far below one 16 ms frame. The spike was deleted after the audit: it was a
  fourth copy of the interval rules (CUDA, Builder, sa.js) with no test after the bench. The numbers above are its record.
- **The real limit is data size.** The client data is ~19 MB per Adams-sized area, mostly the static mesh (17 MB).
  At 100× that is ~1.9 GB, which a browser cannot download or hold. Bigger networks need tiled data (section 4),
  not faster compute.

## 2. WebGPU shortest paths (plain fp32)

`web/client/gpu.js` ports the CUDA kernel (`cuda/engine.py`: worklist Bellman-Ford, one workgroup per source,
`atomicMin` on the bits of non-negative floats) to WGSL. `web/client/bench_gpu.html` compares it with the CUDA fixture.

| Measure | Result |
|---|---|
| Max cost error vs CUDA fp64 | 3.14e-6 min |
| Reached nodes over the 1e-6 min line gate | 3,493 of 54,949 (6.36 %) — **gate FAIL** |
| Nodes reached in one engine but not the other | 0 |
| Polygon parts (full edges, disks, faces) different from `Builder.classify` | 0 of 300 crash-breaks |
| 1 source per dispatch, with readback | p50 0.40 ms, p95 0.90 ms (JS: 0.04 ms) |
| 100 sources in one dispatch, with readback | p50 0.50 ms (JS: 4.27 ms for 100) |

Results:
- fp32 fails the line-cost gate but gives the same polygon parts on this sample. The error is fp32 rounding of costs up to 10 min.
- For one click WebGPU is ~10× slower than JS: dispatch and `mapAsync` readback dominate.
- For batches WebGPU is ~8.5× faster than JS (100 sources in 0.5 ms).
- WebGPU results must come back through the CPU: the map SDK 5.2 draws with WebGL2, which cannot read WebGPU buffers.
- Not measured: WebGPU on the 100× network (each workgroup initializes N costs, so one source gets slower as N grows).

Use WebGPU only for many sources at once (for example all crashes in view), not for the interactive click.

## 3. Emulated fp64 (design only, not built)

To pass the 1e-6 gate on the GPU without f64:
- Store each cost as a double-float: hi + lo, two f32 values (~48-bit mantissa, error ~1e-13 min at 10 min).
  Add with the two-sum algorithm (Knuth/Dekker): about 6–10 f32 operations per add instead of 1.
- WGSL has no 64-bit atomics. Options: (a) pack hi/lo in two u32 and update with an `atomicCompareExchangeWeak`
  loop on a 32-bit lock or key (`hi` bits for the coarse min, then a second pass for `lo`); (b) keep the fp32 kernel to find
  the reached set and the order, then recompute exact costs on the CPU in Float64 with one Dijkstra restricted to the reached
  nodes (cheap: the reached set is small).
- Expected cost: (a) 3–5× slower kernel and more complex code; (b) adds about one JS solve (~0.04 ms) and is exact.
  (b) is the simpler route if fp64 parity on the GPU is needed.

## 4. Mesh size and tiling (notes, not built)

- Adams: `mesh` 13.3 MB (float32, stride 5) + index lists 3.3 MB, of 19 MB total client data (adams.bin now 20.9 MB with the
  EPSG:3735 geometry for polygons).
- Option: cut the network into tiles (e.g. 10 km). Each tile has its own `.bin` (graph part + mesh). Load tiles by view extent
  plus a margin of `cutoff × max speed`. Edge and node ids become (tile, local id), or a global id table maps them.
- A shortest path can leave the loaded tiles. Load the tiles the search frontier reaches on demand (one extra round trip)
  or keep a small global graph without the mesh (graph alone is ~0.2 MB per Adams).
- The mesh can be built in the browser from the vertices (the offsets are simple), which removes ~70 % of the download.

## 5. Polygons in the browser (GEOS through WebAssembly)

`web/client/geom.js` applies `Builder.polygon` with GEOS (`geos-wasm` 3.1.1): substring of reached pieces in EPSG:3735,
flat-cap buffer (quad segs 16), round disks at flagged nodes, flagged blocks, unary union, micro holes dropped.
`client/build_client_data.py` now adds `vert3735`, `nodeXY`, `faceWkb` to the client data and writes `fixture_poly.json`
(Builder pieces and polygon WKB for 100 crashes × 3 breaks).

- Reached pieces from `sa.flags()` equal `Builder.classify`: 300 of 300 crash-breaks, max position difference 0.
- Polygon gate (`node tests/test_client_geom.mjs`): **300 / 300 pass** (IoU ≥ 0.99, Hausdorff ≤ 50 ft).
  Min IoU 0.998819, max Hausdorff 12.92 ft. Not identical to the server: `geos-wasm` 3.1.1 bundles GEOS 3.13.0,
  gpu-x86 Shapely uses GEOS 3.14.1. The cause of the residual is not isolated yet.
- Time per polygon (Node, p50): 1 min 0.7 ms, 5 min 14.0 ms, 10 min 61.8 ms with cached edge and disk buffers (before: 0.8 / 16.4 / 74.3 ms). Server p50: 2.8 / 10.4 / 34.2 ms.
