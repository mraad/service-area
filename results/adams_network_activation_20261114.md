# Fixed Adams network activation — 14 November 2026

The verified cutoff-split Adams network is installed on both Windows targets. The change affects the prepared geodatabase only. The source geodatabase and the earlier exported baseline files were not edited.

## Installed networks

| Host | Active network dataset | Result |
| --- | --- | --- |
| mraadmlwin | `C:\Users\mraad\service-area\work\Adams.gdb\Net\Streets_ND` | Replaced the original prepared Adams network after backup |
| Pro37 | `C:\Ohio\Adams.gdb\Net\Streets_ND` | Added a separate Adams network, as the user selected |

Pro37 is the running Parallels VM whose Windows hostname is `MANSOURRAAD5524`. It did not have an existing Adams geodatabase at the selected destination. The statewide `C:\Ohio\OhioNetwork-01.gdb` and `OhioNetwork-02.gdb` remain in place. Both statewide geodatabases also have verified backups.

## Backups

| Host | Original | Verified backup |
| --- | --- | --- |
| mraadmlwin | `C:\Users\mraad\service-area\work\Adams.gdb` | `C:\Users\mraad\service-area\work\keep\network_promotion_20261114T130021Z\Adams.gdb` |
| Pro37 | `C:\Ohio\OhioNetwork-01.gdb` | `C:\Ohio\backups\network_promotion_20261114T130046Z\OhioNetwork-01.gdb` |
| Pro37 | `C:\Ohio\OhioNetwork-02.gdb` | `C:\Ohio\backups\network_promotion_20261114T130046Z\OhioNetwork-02.gdb` |

Every backup data file was checked with SHA-256. Source files were checked again after copying. Lock files were excluded. The verified file counts are 117 for the original Adams backup, 61 for OhioNetwork-01, and 106 for OhioNetwork-02.

On mraadmlwin, the original geodatabase was also retained by rename as `Adams_original_retained.gdb` inside the same backup folder. Neither retained original was deleted. Each machine's backup folder contains `activation.json`, `activation.log`, `staged_check.json`, and `installed_check.json`. The full activation manifest records the per-file backup hashes. A status pointer is beside the active geodatabase: `Adams_activation.json`.

## Source and transfer

The source is the already tested `work\Adams_split_20261114T121005Z.gdb` on mraadmlwin. It contains the long child edge 3249 and the short tail edge 7337. The previous 100-crash Esri-location gate passed with zero cost mismatches, zero interval mismatches and 300/300 shared-builder polygons passing. See [the experiment record](adams_split_cutoff_20261114.md).

A ZIP package preserved the source geodatabase and a manifest of its data-file hashes. The package transferred to Pro37 through the Mac's shared project folder. SHA-256 was checked on the Mac and again inside Pro37 before extraction:

`a0ba536bc16cb2dacdd31b2ea22ab8760a8090f28905ad7333b94838449cd4fc`

Each extracted data file was checked against the package manifest. The stage rebuilt its network dataset before the native solve. Activation did not overwrite an unidentified Pro37 Adams geodatabase.

## Validation

The procedure validated the stage before activation. It then repeated validation at the final installed path. Both stages used ArcGIS Pro 3.7.3, build 1901, with Network Analyst.

| Check | mraadmlwin | Pro37 |
| --- | --- | --- |
| Installed street edges | 5,036 | 5,036 |
| Installed crashes | 2,483 | 2,483 |
| Source OID equals EID for every street | PASS | PASS |
| Street geometry and cost fingerprint equals the fixed source | PASS | PASS |
| Crash geometry fingerprint equals the fixed source | PASS | PASS |
| Native ArcGIS solve for crash 1800, breaks 1/5/10 | PASS | PASS |
| Long child edge ends at or below 5 minutes | PASS | PASS |
| Tail is separate and extends above 5 minutes | PASS | PASS |
| Installed crossing lines equal staged crossing lines | PASS | PASS |

The installed geometry/cost fingerprints match across both machines:

- Street rows: `856f413145387ded41e363d3da879ebd7be9bb2750256fc102f1dca1984070c1`.
- Crash rows: `2665ca346a70a4c60988fea6b61ee0695757670f0947133001e33d5595cfa9c4`.

The street fingerprint covers sorted EID, geometry WKB, Minutes and MTFCC values. The validator also requires each OID to equal its EID. The crash fingerprint covers sorted CID and geometry WKB values. These fingerprints describe logical rows; they are not hashes of the complete geodatabase.

Both installed networks produce these ArcGIS line records for crash 1800:

| Edge | From position | To position | From cumulative minutes | To cumulative minutes |
| --- | ---: | ---: | ---: | ---: |
| 3249 | 0 | 1 | 3.5492812118132644 | 4.999999999999991 |
| 7337 | 0 | 1 | 4.999999999999991 | 5.000032509772196 |

The complete installed 100-crash gate was not rerun. The source had already passed that gate. This activation checked matching geometry/cost fingerprints and a native solve at each final path. The checks do not establish a full-county pass.

## File-lock handling

The first mraadmlwin attempt passed its staged solve but ArcGIS retained a lock on the staged network. The directory move failed. The procedure restored the original network automatically. The first attempt's backup and failure manifest remain under `work\keep\network_promotion_20261114T125827Z`.

The successful procedure ran native validation in separate child processes. Each process exited before activation. This released its network file handles before the directory move. The installed-path validation also used a separate child process.

Pro37's SYSTEM account could not initialize the ArcGIS user license. A temporary limited scheduled task ran the operation in the already signed-in `mraad` session. The task completed with exit status 0. The license probe task and activation task were removed after verification. No password or license token was read or copied.

## Rollback

Rollback is available. No rollback was requested after successful activation.

To restore the original mraadmlwin network:

1. Close each ArcGIS session that uses the active Adams network.
2. Move the active fixed `Adams.gdb` to a separate retained path.
3. Copy the verified original `Adams.gdb` backup to `C:\Users\mraad\service-area\work\Adams.gdb`.
4. Check the restored street count against 5,035.
5. Check the restored data against the saved backup hashes.

Pro37's original statewide networks require no rollback because they were not modified. To withdraw the added Adams network:

1. Close each ArcGIS session that uses `C:\Ohio\Adams.gdb`.
2. Move `C:\Ohio\Adams.gdb` to a separate retained path.

Keep the statewide backups until they are no longer required.

## Version limits

The operation did not replace the original source streets in `OhioTGN.gdb`. Running `prep/01_prepare.py Adams` again will recreate the unsplit prepared network from that source. The manual split is not a general preparation rule.

Existing exported `work/Adams`, `work/Adams_s100`, GPU work folders and browser data remain separate, earlier versions. No Parquet or browser data was promoted by this operation. Do not describe those older exports as derived from the installed fixed network. A later export must use the active network and retain matching inputs for all engines. Client data must be rebuilt if its exported edges change.

No server or SSH tunnel was started. Host activation records are summarized in [adams_network_activation_20261114.json](adams_network_activation_20261114.json). Full per-file manifests remain with the backups and in ignored local `work/network_promotion_20261114/`.
