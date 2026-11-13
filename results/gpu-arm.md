# gpu-arm as an alternative to gpu-x86 (2026-11-11, speed tables measured again 2026-11-12 after the nearest-street polygon step)

gpu-x86 stays the default host. gpu-arm runs the same code with the same inputs.

| | gpu-x86 | gpu-arm |
|---|---|---|
| GPU | 2 × NVIDIA RTX PRO 6000 Blackwell | NVIDIA GB10 |
| CPU / memory | x86_64 | aarch64, 20 cores, 121 GB unified |
| OS / CUDA | Linux, CUDA 13 | Ubuntu 24.04, CUDA 13.0, driver 580.178.04 |
| Python packages | cupy-cuda13x 14.2.0, numpy 2.5.4, shapely 2.2.0 (GEOS 3.14.1), pyarrow 26.0.1, pyproj 3.8.0, fastapi 0.162.3, uvicorn 0.54.0 | same versions (aarch64 wheels) |

## Fidelity (Adams_s100, `--locations esri`)

- Python tests: 5 / 5 pass.
- `cuda/batch.py` output equals gpu-x86 bit for bit: `cuda_reached_esri.parquet` 97,363 rows, every column identical;
  `cuda_polygons_esri.parquet` 300 / 300 polygons with identical WKB.
- `parity/compare.py`: same gates as gpu-x86. Lines: 0 cost mismatches (max 1.776e-15 min), 1 interval mismatch
  (the known Esri unsplit crossing). Shared-builder polygons 299 / 300.
- The report text differs from gpu-x86 only in the order of tied entries (IoU 1.0000) in "Worst 10 by IoU":
  `np.argsort` with the default (unstable) sort orders ties differently on the two machines.

## Speed

`parity/benchmark.py Adams_s100` (1 warm-up, 7 measured runs, median):

| Stage | gpu-x86 | gpu-arm |
|---|---|---|
| Shortest paths (GPU) | 0.4 ms | 0.4 ms |
| Reached intervals | 5.4 ms | 2.6 ms |
| Polygons, serial (1 CPU process) | 14.69 s | 8.26 s |
| Polygons, batch pool | 4.35 s (48 processes) | 2.54 s (20 processes) |

`parity/latency.py --n 200`, server and client on the same machine, same points (seed 11):

| Break | gpu-x86 server p50 / p95 ms | gpu-arm server p50 / p95 ms | gpu-x86 round trip p50 ms | gpu-arm round trip p50 ms |
|---|---|---|---|---|
| 1 min | 3.7 / 8.9 | 2.0 / 7.1 | 4.7 | 2.6 |
| 5 min | 21.4 / 41.7 | 16.4 / 29.6 | 231.9 | 19.9 |
| 10 min | 67.6 / 107.5 | 50.1 / 74.7 | 283.4 | 58.1 |

The GPU step is the same. gpu-arm is faster on the CPU steps (polygon building, JSON encoding), which dominate.
The server runs the polygon union on 8 threads. 10 min p50 history: one thread gpu-x86 99.2 ms, gpu-arm 49.9 ms; 8 threads 33.9 ms, 23.8 ms; with the nearest-street step the values in the table.
The gpu-x86 round trip stays far above its server time: 232 ms against 21 ms at 5 minutes, 283 ms against 68 ms at 10 minutes. The cause is not isolated. The server time stops before the response body is made (projection to WGS84 and GeoJSON text in `cuda/server.py`), so that step, the transfer and the client are all inside the gap. gpu-arm runs the same code with a gap of 3.5 ms and 8 ms.

## Web pages through gpu-arm

Server on gpu-arm, tunnel to local port 8766 (`ssh -N -L 127.0.0.1:8766:127.0.0.1:8765 gpu-arm`), headless Chrome:
`live.html` 44 / 44 solves with the same polygon parts as Float64; `planner.html` same picks as the CPU in 60 / 60
cases and the same coverage (1,228 / 2,483 at 5 min); `index.html` Both mode solves on the server and in the client.

## Not checked

- `cuda/batch.py` on the full Adams run (2,483 crashes) on gpu-arm.
- The `--locations own` mode on gpu-arm.
- `client/build_client_data.py` on gpu-arm (`web/data/` was copied from the Mac, which holds gpu-x86's build).
