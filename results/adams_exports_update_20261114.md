# Fixed-network exports update — 14 November 2026

The selected export update is complete. The live graph, 100-crash reference sample, CUDA outputs and browser bundle use the installed fixed Adams network. The update did not run a new full 2,483-crash ArcGIS solve.

## Scope and source

The user selected live/browser data and 100-crash validation only. A temporary copy of the installed `mraadmlwin` network produced fresh ArcGIS reference exports. The copy preserved the installed network and used the existing solve script with sample 100 and seed 7.

- Installed source: `C:\Users\mraad\service-area\work\Adams.gdb`.
- Export staging network: `work\Adams_exports_20261114T130702Z.gdb`.
- Fresh sample: `work\Adams_exports_20261114T130702Z_s100`.
- Located facilities: 100, with the same facility names as the previous sample.
- Street edges: 5,036. Graph nodes: 4,358. Crash sites: 2,483.
- ArcGIS line pieces: 84,686. Native polygons: 300.
- ArcGIS solve time: 68.178927 seconds. This is one measurement, not a performance comparison.

The edge table hash is:

`a267e7351820f1942db4844b0bc001e01b40d574d466eb43e3fb1794fb040b87`

The fresh edge, crash, facility, line and polygon hashes match the successful split experiment. The timing record retains its actual staging network name, `Adams_exports_20261114T130702Z`.

Pro37 received verified copies of the matching exports. It did not repeat the 100-crash ArcGIS solve. Its installed network had already matched the fixed network's geometry/cost fingerprint and passed the native crash 1800 check.

## Isolated generation and checks

On `gc5`, a separate project staging directory contained copies of the current CUDA, parity and client-build scripts. It used the new Windows input files. The old active datasets remained in place during generation and validation.

The CUDA batch used eight polygon workers. Both location modes ran the complete unchanged parity gate:

| Mode | Cost mismatches | Maximum cost difference, min | Interval mismatches | Shared-builder polygons passing | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Esri locations | 0 | 1.776e-15 | 0 | 300 / 300 | PASS |
| Own locations | 0 | 5.241e-11 | 0 | 300 / 300 | PASS |

The browser builder produced a graph/mesh bundle and 100-crash fixtures from the same graph. It produced 300 polygon reference cases. The browser header's `edgesSha256` matches the edge Parquet hash.

| Browser bundle property | Value |
| --- | ---: |
| adams.bin size, bytes | 23,903,376 |
| Nodes | 4,358 |
| Edges | 5,036 |
| Faces | 700 |
| Mesh vertices | 664,374 |
| Mesh triangles | 277,158 |

The Mac tested the staged data through a separate Node project. It used the repository's actual browser modules and existing tests. All six checks passed:

- App initialization and superseded-request regression tests.
- Greedy planner reference tests: 512 comparisons.
- Client engine against CUDA: 100 crashes over seven warmed passes; maximum node-cost difference 0 minutes; maximum snap-position difference 5.67e-7.
- Direct ArcPy client line gate: 0 cost mismatches and 0 interval mismatches.
- Planner candidate-cost, coverage and polygon tests.
- Browser GEOS polygon tests: 300/300 comparisons pass; minimum IoU 0.998863; maximum Hausdorff distance 12.920 feet. All reached-piece positions match exactly.

After local activation, the client and direct ArcPy tests also passed from their normal repository paths. Full browser/WebGPU rendering and the browser pixel test were not run during this export update.

## Activation

A ZIP bundle held the generated datasets, reports and file-hash manifest. Its SHA-256 is:

`33757bdc65a754cfe72f9f2c7510db6f66edb0d5ecf1a20979d87085803ea75e`

A receipt records all six passing Node test exit statuses and the archive hash. Each remote installer required that receipt before activation. Every installed file was checked against the bundle manifest. The local installation also checked all installed file hashes.

| Target | Live graph and all crash sites | 100-crash validation data | Browser assets |
| --- | --- | --- | --- |
| mraadmlwin | `C:\Users\mraad\service-area\work\Adams` | `C:\Users\mraad\service-area\work\Adams_s100` | `C:\Users\mraad\service-area\web\data` |
| Pro37 | `C:\Ohio\exports\Adams` | `C:\Ohio\exports\Adams_s100` | `C:\Ohio\exports\web\data` |
| gc5 | `/home/ubuntu/service-area/work/Adams` | `/home/ubuntu/service-area/work/Adams_s100` | `/home/ubuntu/service-area/web/data` |
| Mac | Repository `work/Adams` | Repository `work/Adams_s100` | Repository `web/data` |

The active `Adams` live folder contains `edges.parquet` and `crashes.parquet`. It does not contain old full-run reference lines or polygons. The sample folder contains the matching ArcGIS reference files, CUDA reached/polygon files and timing/hash records for both location modes.

The current full sample reports are [Esri locations](parity_adams_s100_esri.md) and [own locations](parity_adams_s100_own.md). Native ArcGIS polygons remain a separate reference comparison; the shared-builder gate pass does not establish native polygon equality.

## Backups and rollback

Previous data directories were moved to verified backup locations before replacement. Old report files were preserved where present. File hashes verify the archived content.

| Target | Backup root |
| --- | --- |
| mraadmlwin | `C:\Users\mraad\service-area\work\keep\exports_activation_20261114T130702Z` |
| Pro37 | `C:\Ohio\backups\exports_activation_20261114T130702Z` |
| gc5 | `/home/ubuntu/service-area/work/keep/exports_activation_20261114T130702Z` |
| Mac | Repository `work/keep/exports_activation_20261114T130702Z` |

The old `Adams` and `Adams_s100` directories and browser data are under `previous/` with their relative paths. On mraadmlwin and gc5, this preserves the earlier full-run ArcGIS files that were present in `work/Adams`. Pro37 had no previous export set at the selected paths. Its statewide geodatabases were not modified by this export operation.

To restore a previous export set:

1. Stop each process that serves the affected exports.
2. Move the current export directory to a retained path.
3. Restore the matching directory from `previous/`.
4. Restore the matching browser bundle from the same backup.
5. Restore the matching parity reports from the same backup, where present.
6. Check the graph and browser header hashes.

Do not combine an archived graph with the new browser bundle. The installer retains activation manifests and supports rollback if a directory promotion or final hash check fails.

## Records and remaining limits

The structured summary is [adams_exports_update_20261114.json](adams_exports_update_20261114.json). Full manifests, receipts, scripts and logs remain in ignored local `work/export_update_20261114/`, in the GPU stage `work/export_update_20261114T130702Z`, and in the activation backup folders. Remote activation pointers are `exports_activation_20261114.json` at each remote export root. The local activation record is in its backup folder.

Pro37 used a temporary limited task in the signed-in user session. The task completed with status 0 and was removed. No server or SSH tunnel was started.

The old full-run reference outputs are archived. They remain evidence for the original network. This update establishes the 100-crash sample results only. The remaining full-county unsplit crossings were not reassessed. Franklin was not changed. The raw source and preparation script were not changed; a new `prep/01_prepare.py Adams` run would recreate the unsplit prepared network.
