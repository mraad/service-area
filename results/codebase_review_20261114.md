# Codebase review and optimization — 2026-11-14

Branch: `optimize/simplify-service-area`.

Static review covered the main prep/export, CUDA graph/batch/server, polygon builder,
parity gate, browser solver/geometry/rendering and planner flows, with emphasis on
correctness and repeated work. Assumed load: the documented local server and one
interactive browser, using Adams and the Franklin pilot. This was not an exhaustive
security audit or a fresh ArcGIS fidelity assessment.

## Findings addressed

1. **Map request race** (`web/app.js`, `solveServer`). After a minutes or engine
   change cancels a request, its completion could still replace the current polygon
   or error message. Its `finally` block could also drain the replacement request's
   pending point and queue an older point behind it. Only the current controller may
   now update results or advance the queue. Removed the unused request timer.
2. **Repeated planner scans** (`web/client/planner.js`, `greedy`). Every selection
   recomputed every station's marginal coverage even when it could not win. A
   station's previous gain bounds its next gain because coverage only grows. Skip
   that station when the bound cannot beat the current winner. Ascending scan order
   preserves the lowest-index tie rule. Extra storage: one Uint32 per candidate
   (9,932 bytes for 2,483 sites). No new dependencies or interface changes.

## Validation

- `node tests/test_app.mjs`: passes deep-link initialization and superseded success,
  abort and error responses, including preservation of the newest queued point.
  The stale-success regression failed on the original implementation.
- `node tests/test_greedy.mjs`: passes 512 comparisons against an independent
  set-based reference, covering empty inputs, zero selections, exhausted coverage,
  sparse/dense costs, and bitset word boundaries; also checks lowest-index ties.
- `node --check` for both changed production modules and the new test: passes.
- `git diff --check`: passes.
- Final review: manual. CodeRabbit 0.7.6 failed to start its authentication callback
  (`Failed to start server. Is port 0 in use?`); no CodeRabbit review completed.

Synthetic benchmark on this Mac: 2,483 candidates, break 5, at most 20 stations;
two warm-ups followed by nine measured runs, alternating before/after order.
Baseline is `main`'s greedy implementation. All three inputs produced identical
picked indices and gains before and after.

| Synthetic costs | Before median ms | After median ms | Speedup |
| --- | ---: | ---: | ---: |
| Local: circular index distance / 20 | 10.10 | 6.25 | 1.62x |
| Overlapping: 15% reached | 21.59 | 19.13 | 1.13x |
| Dense: 80% reached | 22.83 | 22.95 | 0.99x |

Random matrices use an LCG seeded with 7 (1664525, 1013904223, modulus 2^32);
reached entries cost 5 and other entries Infinity. These are algorithm measurements,
not a real county or end-to-end browser performance claim. Cost-matrix construction
and initial bitset construction remain quadratic in the site count.

## Limits and retained decisions

- No changes to network preparation, costs, shortest-path arithmetic, polygon rules,
  tolerances, mesh data, or fixtures. Larger numerical/geometry optimizations need
  the documented remote fidelity gates before adoption.
- `gpu-x86` did not resolve, including outside the sandbox. `web/data/` is absent
  locally. CUDA/Python tests, fixture-based Node tests, real browser/WebGPU checks,
  and ArcGIS parity were not run. No remote files or services were changed or started.
- Existing ArcGIS unsplit break crossings and the unassessed Franklin_s2000 run
  remain as documented in `tasks/todo.md`; this review does not establish a parity pass.

## Follow-up before shipping

The user identified `gc5` as the available GPU host. Browser data and fixtures were
copied from its existing project into ignored `web/data/`, and `npm ci --ignore-scripts`
installed the pinned GEOS test dependency. No tracked dependency files changed.

- App regression and greedy reference checks pass.
- `tests/test_client.mjs` passes all 100 crashes over seven warmed passes: maximum
  node-cost difference 0, maximum snap-position difference 5.67e-7.
- `tests/test_planner.mjs` passes candidate-cost, greedy, exact-coverage and polygon checks.
- `tests/test_client_geom.mjs` passes all 300 piece and polygon comparisons:
  minimum IoU 0.998863, maximum Hausdorff 12.920 ft.
- `tests/test_client_arcpy.mjs` fails with 0 cost mismatches and 1 interval mismatch:
  crash 1800, edge index 2304, break 5. This is the documented unsplit crossing.
  This test imports only the unchanged `ServiceArea` module, so neither changed
  production module participates in the failure.
- The user explicitly authorized deferring this known interval mismatch and shipping
  this branch. The failure remains visible; no tolerances or gate logic were changed.
  Follow-up: fresh Windows ArcPy solve and inspection of crash 1800's line-band assignment.
