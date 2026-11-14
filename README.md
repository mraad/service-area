<h1>CUDA Service Areas with ArcGIS Parity</h1>

<p>
This repository calculates drive-time service areas on a street network.
The <b>ArcGIS engine</b> uses ArcGIS Network Analyst through ArcPy.
The <b>CUDA engine</b> uses a GPU shortest-path kernel.
A parity check compares the two engines.
A live server and a web map show one service area at the mouse position.
The <b>browser engines</b> calculate the service area in the browser: JavaScript and WebGL (section 14),
and WebGPU with GEOS in WebAssembly (sections 15 to 17).
</p>

<p align="center">
  <img src="docs/images/live_hover.gif" width="640" alt="Animation: the mouse moves along a street near West Union and the 5-minute service area changes with it.">
  <br><em>The live page (section 17): the mouse moves along one street near West Union. WebGPU and GEOS update the 5-minute service area at each position.</em>
</p>

<p>
The study area is Adams County, Ohio.
The start points are the crash points in <code>Adams_Crashes</code>.
The breaks are 1, 5, and 10 minutes.
</p>

<p align="center">
  <img src="docs/images/architecture.svg" width="600" alt="System diagram: arcgis-win runs ArcPy, gpu-x86 runs the CUDA engine, the Mac runs the browser.">
  <br><em>Figure 1. Three machines. Both engines read the same noded edge table.</em>
</p>

<h2>Contents</h2>
<ol>
  <li><a href="#terms">Terms</a></li>
  <li><a href="#results">Results</a></li>
  <li><a href="#data">Data</a></li>
  <li><a href="#travel-time">Travel time</a></li>
  <li><a href="#arcgis-engine">ArcGIS engine</a></li>
  <li><a href="#cuda-engine">CUDA engine</a></li>
  <li><a href="#polygon-builder">Polygon builder</a></li>
  <li><a href="#parity">Parity</a></li>
  <li><a href="#performance">Performance</a></li>
  <li><a href="#live-server-and-web-map">Live server and web map</a></li>
  <li><a href="#procedures">Procedures</a></li>
  <li><a href="#repository-layout">Repository layout</a></li>
  <li><a href="#known-limits">Known limits</a></li>
  <li><a href="#client-engine">Client engine (WebGL)</a></li>
  <li><a href="#browser-compute">Browser compute: WASM and WebGPU</a></li>
  <li><a href="#station-planner">Station planner (WebGPU and WebAssembly)</a></li>
  <li><a href="#live-page">Live service area (WebGPU and WebAssembly)</a></li>
  <li><a href="#gpu-arm">Alternative host: gpu-arm</a></li>
  <li><a href="#cutoff-investigation">Cutoff investigation: crash 1800</a></li>
</ol>

<h2 id="terms">1. Terms</h2>
<p>This document uses each term with one meaning only.</p>
<table>
  <tr><th>Term</th><th>Meaning</th></tr>
  <tr><td>crash</td><td>One point in <code>Adams_Crashes</code>. Each crash is one start point (facility).</td></tr>
  <tr><td>break</td><td>A travel-time limit: 1, 5, or 10 minutes.</td></tr>
  <tr><td>edge</td><td>One street line between two nodes, after noding.</td></tr>
  <tr><td>node</td><td>An edge end. Edges connect only at nodes.</td></tr>
  <tr><td>position</td><td>A location along an edge, from 0 (start of the line) to 1 (end of the line).</td></tr>
  <tr><td>reached interval</td><td>The part of an edge, from position <i>lo</i> to position <i>hi</i>, that a crash reaches within a break.</td></tr>
  <tr><td>line</td><td>One reached interval as a line geometry. ArcGIS calls this output "SA Lines".</td></tr>
  <tr><td>polygon</td><td>The service-area area for one crash and one break.</td></tr>
  <tr><td>trim</td><td>The polygon buffer distance: 100 m (328.083 US survey feet).</td></tr>
  <tr><td>gpu-x86</td><td>The Linux GPU machine. It runs the CUDA engine and the live server.</td></tr>
  <tr><td>gpu-arm</td><td>An alternative Linux GPU machine (NVIDIA GB10, aarch64). It runs the same CUDA engine and live server as gpu-x86 (section 18).</td></tr>
  <tr><td>arcgis-win</td><td>The Windows machine. It runs ArcGIS Pro 3.7.3 with Network Analyst.</td></tr>
</table>

<h2 id="results">2. Results</h2>
<p>
The parity sample is 100 crashes (random seed 7).
The full ArcGIS run uses all 2,483 crashes.
</p>
<table>
  <tr><th>Check</th><th>Result</th></tr>
  <tr><td>Cumulative minutes, CUDA vs ArcGIS lines</td><td>0 mismatches in 84,676 lines. Maximum difference: 1.8e-15 min.</td></tr>
  <tr><td>Reached intervals, CUDA vs ArcGIS lines</td><td>1 mismatch in 97,362 interval sets. ArcGIS did not split that line at the break (see <a href="#esri-unsplit">8.4</a>).</td></tr>
  <tr><td>Own snapping vs ArcGIS locations</td><td>Same result as above. Maximum cost difference: 5.2e-11 min.</td></tr>
  <tr><td>Polygon gate (shared builder)</td><td>299 of 300 pass. The one failure is the same crash as the interval mismatch.</td></tr>
  <tr><td>Native ArcGIS polygons (reference only)</td><td>Median IoU 0.962 (1 min), 0.975 (5 min), 0.986 (10 min).</td></tr>
  <tr><td>Batch time, 100 crashes</td><td>ArcGIS solve 69.3 s. CUDA shortest paths 0.08 s, reached intervals 0.11 s, polygons 4.35 s.</td></tr>
  <tr><td>Live server, p50</td><td>3.7 ms (1 min), 18.9 ms (5 min), 67.6 ms (10 min).</td></tr>
</table>
<p>
These results describe the original Adams network.
On 14 November 2026, a geometry repair and a network rebuild reproduced the same mismatch.
A separate test split the affected edge at the calculated 5-minute position.
That test passed both gates for the same 100 crashes.
The original network remains unchanged by the split test.
See <a href="#cutoff-investigation">section 19</a> for the procedure, evidence, and limits.
</p>

<h2 id="data">3. Data</h2>

<h3>3.1 Source</h3>
<ul>
  <li>File geodatabase: <code>OhioTGN.gdb</code>. It is not in this repository.</li>
  <li>Test data in this repository, Adams County only: <code>work/Adams</code> (prepared streets and crashes) and <code>work/Adams_s100</code> (the same streets, the 100-crash sample and the ArcGIS results: lines, polygons, facility locations, timing). With these files the CUDA batch and the parity gate run with no ArcGIS licence (section 11).</li>
  <li>Streets: <code>Adams_Streets</code>, 3,063 lines. Fields: <code>NAME</code>, <code>MTFCC</code>, <code>TGN_SID</code>, and crash statistics.</li>
  <li>Crashes: <code>Adams_Crashes</code>, 2,483 points.</li>
  <li>Spatial reference: NAD83 / Ohio South, US survey feet (EPSG:3735). XY tolerance: 0.00328083 ft.</li>
  <li>The data has no speed field and no one-way field. All Z values are 0.</li>
</ul>

<h3>3.2 Defects in the source streets</h3>
<p>The source streets are not ready for a network. The prepare step corrects three defects.</p>
<ol>
  <li><b>Streets are not noded.</b> 1,453 street ends touch the inside of another street (T-junctions). 453 street pairs cross with no shared node. The raw network has 1,673 separate components.</li>
  <li><b>Streets are duplicated.</b> 467 groups of lines have the same geometry. They have the same <code>MTFCC</code> and different names (for example "Co Rd 27" and "Steam Furnace Rd").</li>
  <li><b>Connected ends are not always bit-identical.</b> ArcGIS connects ends within the XY tolerance. The CUDA engine connects only equal coordinates.</li>
</ol>

<h3>3.3 Prepare step (<code>prep/01_prepare.py</code>)</h3>
<ol>
  <li>Remove walkways and bike paths (<code>MTFCC</code> S1710 and S1820).</li>
  <li>Split local streets at all crossings and T-junctions (<code>FeatureToLine</code>).</li>
  <li>Split freeways and ramps (S1100, S1630) only where a street ends on them (<code>SplitLineAtPoint</code>). This keeps overpasses unconnected.</li>
  <li>Merge the two sets into <code>Net/Streets</code>.</li>
  <li>Snap ends within the XY tolerance to one coordinate (<code>Integrate</code>).</li>
  <li>Delete duplicate lines (same coordinates in either direction).</li>
  <li>Calculate <code>EID</code>, <code>MPH</code>, and <code>Minutes</code> for each edge.</li>
</ol>
<p>
The result has 5,035 edges, 4,357 nodes, and 22 components.
The largest component holds 98.7% of the nodes.
</p>

<p align="center">
  <img src="docs/images/noding.png" width="600" alt="West Union streets before and after noding, with dead ends marked.">
  <br><em>Figure 2. West Union. Orange points are dead ends. Noding removes the false dead ends at T-junctions.</em>
</p>

<h2 id="travel-time">4. Travel time</h2>
<p>
<code>speeds.py</code> holds the speed table.
Both engines use the same <code>Minutes</code> field.
All streets are two-way.
</p>
<p><code>Minutes = length_ft / 5280 / MPH × 60</code></p>
<table>
  <tr><th>MTFCC</th><th>Street class</th><th>MPH</th></tr>
  <tr><td>S1100</td><td>Primary road (interstate)</td><td>65</td></tr>
  <tr><td>S1200</td><td>Secondary road</td><td>45</td></tr>
  <tr><td>S1400</td><td>Local street</td><td>30</td></tr>
  <tr><td>S1500</td><td>4WD trail</td><td>10</td></tr>
  <tr><td>S1630</td><td>Ramp</td><td>35</td></tr>
  <tr><td>S1640</td><td>Service drive</td><td>25</td></tr>
  <tr><td>S1730</td><td>Alley</td><td>10</td></tr>
  <tr><td>S1740</td><td>Private road</td><td>10</td></tr>
  <tr><td>S1750</td><td>Internal census road</td><td>15</td></tr>
  <tr><td>S1780</td><td>Parking lot road</td><td>5</td></tr>
  <tr><td>other</td><td>Unknown class</td><td>25</td></tr>
</table>

<h2 id="arcgis-engine">5. ArcGIS engine</h2>

<h3>5.1 Network dataset (<code>prep/02_build_nd.py</code>)</h3>
<ul>
  <li>The script builds <code>Net/Streets_ND</code> from <code>prep/streets_nd_template.xml</code>.</li>
  <li>Connectivity is end-point. Edges connect only at their ends.</li>
  <li>The cost attribute <code>Minutes</code> reads the field <code>!Minutes!</code> in both directions.</li>
  <li>The template has no travel modes. <code>arcpy.nax</code> does not accept a network without travel modes. The solve script uses the layer API with a JSON travel mode.</li>
</ul>

<h3>5.2 Solve (<code>prep/03_solve_arcpy.py</code>)</h3>
<table>
  <tr><th>Setting</th><th>Value</th></tr>
  <tr><td>Tool</td><td><code>MakeServiceAreaAnalysisLayer</code>, <code>AddLocations</code>, <code>Solve</code></td></tr>
  <tr><td>Impedance</td><td><code>Minutes</code></td></tr>
  <tr><td>Breaks</td><td>1, 5, 10</td></tr>
  <tr><td>Direction</td><td>From facilities</td></tr>
  <tr><td>Output</td><td>Polygons and lines</td></tr>
  <tr><td>Polygon detail</td><td>High</td></tr>
  <tr><td>Geometry at overlap / cutoff</td><td>Overlap / Disks</td></tr>
  <tr><td>Polygon trim</td><td>100 m</td></tr>
  <tr><td>Search tolerance</td><td>5,000 m</td></tr>
  <tr><td>U-turns</td><td>Allowed</td></tr>
</table>
<p>
The script writes Parquet files to <code>work/&lt;County&gt;</code>, or to <code>work/&lt;County&gt;_s&lt;N&gt;</code> for a sample.
It writes <code>edges</code>, <code>crashes</code>, <code>esri_facilities</code>, <code>esri_lines</code>, <code>esri_polygons</code>, and <code>esri_timing.json</code>.
It also prints the number of crashes that ArcGIS did not locate (<code>Status</code> not 0).
</p>

<h2 id="cuda-engine">6. CUDA engine</h2>

<h3>6.1 Graph (<code>cuda/engine.py</code>, <code>Graph</code>)</h3>
<ul>
  <li>The graph reads <code>edges.parquet</code>.</li>
  <li>Edge ends with equal coordinates become one node.</li>
  <li>The graph stores the edges in CSR format (compressed sparse rows), with both directions of each edge.</li>
  <li>Costs are 64-bit floats. This keeps cumulative minutes equal to ArcGIS within 1e-12.</li>
  <li>The graph copies its arrays to the GPU at the first GPU call. CPU-only processes can load the graph without CUDA.</li>
</ul>

<h3>6.2 Location</h3>
<ul>
  <li>Esri mode: the engine uses the ArcGIS location of each crash (<code>SourceOID</code>, <code>PosAlong</code>).</li>
  <li>Own mode: the engine finds the nearest edge with an STRtree. The position is the normalized distance along that edge.</li>
  <li>A crash farther than 5,000 m from all edges is not located. This is the same rule as ArcGIS.</li>
</ul>

<h3>6.3 Shortest-path kernel</h3>
<ul>
  <li>One CUDA thread block calculates the costs for one crash.</li>
  <li>The kernel starts at the two ends of the crash edge. The start costs are <code>position × w</code> and <code>(1 − position) × w</code>. <i>w</i> is the edge cost in minutes.</li>
  <li>The kernel uses worklist Bellman-Ford. Each round relaxes the edges of the nodes that changed in the last round.</li>
  <li>An atomic minimum on the 64-bit pattern of the cost updates a node. Non-negative doubles sort in the same order as their bit patterns.</li>
  <li>The kernel stops a path when its cost is more than the largest break (10 min). One solve gives the costs for all three breaks.</li>
  <li>The batch tool sends crashes in chunks of 2,048.</li>
</ul>

<h3>6.4 Reached intervals (<code>Graph.reached</code>)</h3>
<p>For each edge (<i>u</i>, <i>v</i>) with cost <i>w</i>, node costs <i>c<sub>u</sub></i> and <i>c<sub>v</sub></i>, and break <i>B</i>:</p>
<ul>
  <li>From the start node: <code>[0, a1]</code> with <code>a1 = clip((B − c_u) / w, 0, 1)</code>.</li>
  <li>From the end node: <code>[b0, 1]</code> with <code>b0 = clip(1 − (B − c_v) / w, 0, 1)</code>.</li>
  <li>On the crash edge only: <code>[s0, s1]</code> with <code>s0 = clip(p − B / w)</code> and <code>s1 = clip(p + B / w)</code>. <i>p</i> is the crash position.</li>
  <li>The union of these parts is the reached interval for that edge and break.</li>
</ul>

<p align="center">
  <img src="docs/images/lines.png" width="600" alt="ArcGIS SA lines and CUDA reached intervals for one crash, colored by break.">
  <br><em>Figure 3. One crash. Left: ArcGIS lines. Right: CUDA reached intervals. The colors show the break bands.</em>
</p>

<h2 id="polygon-builder">7. Polygon builder</h2>
<p>
<code>cuda/polygons.py</code> (<code>Builder</code>) makes one polygon from the reached intervals of one crash and one break.
The parity check applies the same builder to the ArcGIS lines.
The rules come from a comparison with ArcGIS High polygons.
</p>
<ol>
  <li>Buffer each reached interval by the trim distance. Use flat caps. ArcGIS cuts flat at the cutoff point.</li>
  <li>Add a round disk (trim radius) at each reached node where all edges are fully reached.</li>
  <li>Add a round disk at each reached dead end.</li>
  <li>Fill each network face (block) when all edges on its boundary and inside it are fully reached.</li>
  <li>Join all parts into one polygon.</li>
  <li>Keep only the ground whose nearest street is reached there. The builder cuts each street into pieces of at most 50 ft. Each piece owns the ground that is nearer to it than to any other piece (a Voronoi cell). The polygon keeps only the cells of reached pieces. Without this step, a buffer along a freeway also covers the unreached streets beside it. ArcGIS does not include that ground.</li>
  <li>Remove holes smaller than 1e-6 ft². The join makes these holes where two flat caps almost touch.</li>
</ol>
<p>
The builder treats two positions closer than 1e-9 as equal.
Floating-point noise does not create sliver lines or change the "fully reached" test.
</p>

<p align="center">
  <img src="docs/images/polygons.png" width="600" alt="CUDA polygons and ArcGIS High polygons for one crash at 1, 5, and 10 minutes.">
  <br><em>Figure 4. One crash. Blue: CUDA polygon (shared builder). Orange: native ArcGIS High polygon.</em>
</p>

<h2 id="parity">8. Parity</h2>

<h3>8.1 Gates (<code>parity/compare.py</code>)</h3>
<table>
  <tr><th>Gate</th><th>Rule</th></tr>
  <tr><td>Lines: cost</td><td>For each ArcGIS line, the CUDA cost at <code>FromPosition</code> and <code>ToPosition</code> equals <code>FromCumul_Minutes</code> and <code>ToCumul_Minutes</code> within 1e-6 min.</td></tr>
  <tr><td>Lines: intervals</td><td>For each crash, edge, and break, the reached intervals are equal within 1e-6.</td></tr>
  <tr><td>Polygons</td><td>The shared builder on the ArcGIS intervals and the CUDA polygon have IoU ≥ 0.99 and Hausdorff distance ≤ 50 ft.</td></tr>
  <tr><td>Reference (no gate)</td><td>Native ArcGIS High polygons vs CUDA polygons. The report gives the IoU and Hausdorff distribution.</td></tr>
</table>

<h3>8.2 Why polygons use a shared builder</h3>
<p>
The nearest-street step came from a test of 10 candidate rules against native ArcGIS polygons. It raised the median IoU in Franklin (20 crashes) from 0.86 / 0.93 / 0.95 to 0.97 / 0.97 / 0.97 for 1 / 5 / 10 minutes, and in Adams (100 crashes) from 0.94 / 0.97 / 0.98 to 0.96 / 0.98 / 0.99.
The browser engines use the same step. The WebGL layer finds the nearest street of each pixel with the depth buffer. The GEOS polygon (<code>geom.js</code>) makes the same cells in the browser from the piece points in <code>web/data/adams.bin</code>; this takes approximately 2.5 s one time, when the page loads.
A piece that is reached in part counts as reached. Thus the polygon can keep up to 50 ft of ground after a break position, where another reached street covers that ground.
</p>
<p>
The ArcGIS polygon algorithm is not published.
ArcGIS High polygons are smoothed buffers.
Their boundary points are 300 to 345 ft from the reached lines, not exactly 328 ft.
Exact geometric parity with native polygons is not possible.
The lines are exact. A shared builder makes the polygon parity exact for the same lines.
</p>

<p align="center">
  <img src="docs/images/iou.png" width="600" alt="Histograms of IoU between CUDA and native ArcGIS polygons for 1, 5, and 10 minutes.">
  <br><em>Figure 5. IoU of CUDA polygons against native ArcGIS High polygons, 100 crashes per break.</em>
</p>

<h3>8.3 Report</h3>
<p>The comparison exits with status 1 when either gate fails, or required artifacts are missing or their SHA-256 hashes differ from the completed CUDA run. Re-run the batch after changing reference inputs. Use <code>--lines-only</code> explicitly for a partial check; this is not a full parity pass. Batch runs invalidate old polygon output and archive previous timing JSON files with a timestamp suffix.</p>
<p>Reports include Windows ArcPy and CUDA stage timings. <code>python parity/benchmark.py Adams_s100</code> on gpu-x86 records one warm-up and seven measured runs on the same facilities, with serial polygon timings labelled separately from batch pool timings. Results retain the Windows timing record and network hash in timestamped JSON files. These measurements alone do not establish an optimization speedup.</p>
<p>
The report is <code>results/parity_&lt;county&gt;_&lt;mode&gt;.md</code>.
It lists the mismatch counts, the IoU and Hausdorff table per break, and the 10 worst polygons.
The check runs in about 5 s for 100 crashes on gpu-x86.
Equal polygons skip the geometry work.
Other polygons go to a process pool.
</p>

<h3 id="esri-unsplit">8.4 ArcGIS unsplit lines</h3>
<p>
ArcGIS usually splits a line where it crosses a break.
Sometimes ArcGIS does not split the line.
It puts the full line into the next break band.
In the full Adams run, this occurs 17 times in 2,168,587 lines.
ArcGIS splits 244,266 lines at a break.
</p>
<p>
The tested tolerance measurements do not give a general rule for this behavior.
The leftover lengths of split and unsplit lines overlap in feet, in minutes, and in edge fraction.
One edge is split for one crash and not split for another crash.
The CUDA engine always splits.
The report marks each such case as <code>[Esri unsplit crossing]</code>.
The gate counts these cases as failures.
</p>
<p><b>Note (12 November 2026): where the difference comes from.</b></p>
<ul>
  <li>The difference is in the ArcGIS line output. It is not in the CUDA shortest paths.</li>
  <li>For each of these lines, the ArcGIS travel times at the two ends are equal to the CUDA travel times within 1e-6 min. Thus the two engines agree on the position where the travel time is equal to the break. CUDA cuts the line at that position. ArcGIS does not cut it.</li>
  <li>The OGC geometry check found 0 problems in the Adams and Franklin source layers. A later repair and rebuild did not change the Adams result. This test does not identify the internal ArcGIS cause.</li>
  <li>The Franklin pilot (20 crashes) shows the same behavior: 2 unsplit lines (crash 49470 at 5 min, crash 111391 at 1 min) and no other line difference.</li>
  <li>An unsplit output line can change the polygon made by the shared Builder. For crash 1800 at 5 minutes, the ArcGIS line input omits the reached part of edge 3249. The shared-builder polygon IoU is 0.9396. This comparison does not use the native ArcGIS polygon as the gate reference.</li>
  <li>The internal ArcGIS rule remains unknown. The isolated cutoff-split test removed this mismatch. Native ArcGIS polygon files did not change. See <a href="#cutoff-investigation">section 19</a>.</li>
  <li>This note is about lines only. The CUDA polygons are an approximation of the ArcGIS polygons (section 7).</li>
</ul>

<h2 id="performance">9. Performance</h2>
<p align="center">
  <img src="docs/images/timing.png" width="600" alt="Batch time for 100 crashes: ArcGIS solve against CUDA stages, log scale.">
  <br><em>Figure 6. Batch time for 100 crashes and 3 breaks. The scale is logarithmic.</em>
</p>
<ul>
  <li>ArcGIS: 69.3 s for 100 crashes. 1,873 s for all 2,483 crashes.</li>
  <li>CUDA shortest paths: 0.08 s for 100 crashes on one RTX PRO 6000 Blackwell.</li>
  <li>CUDA polygons: 4.35 s on 48 CPU processes. Polygon construction is the largest CUDA-side cost. Before the nearest-street step (section 8.2) this was 2.41 s: the step adds the union of the Voronoi cells and one intersection for each polygon.</li>
  <li>Buffers of whole edges and node disks are made once per <code>Builder</code>. Serial polygon time for 100 crashes is 14.69 s on gpu-x86 and 8.26 s on gpu-arm (before the nearest-street step: 10.65 s and 5.24 s).</li>
  <li>The live server runs the union on 8 threads (<code>Builder.polygon(pool=)</code>). Server p50 at 10 minutes went from 97.8 ms to 34.2 ms with the threads. The nearest-street step then raised it to 67.6 ms. All 7,449 Adams polygons agree with the serial union (Hausdorff below 0.0001 ft). The batch keeps the serial union, so its files stay identical.</li>
</ul>

<p align="center">
  <img src="docs/images/latency.png" width="600" alt="Server time per request at p50 and p95 for 1, 5, and 10 minutes.">
  <br><em>Figure 7. Live server time per request on gpu-x86 (100 random points near crashes).</em>
</p>
<table>
  <tr><th>Break</th><th>Server p50</th><th>Server p95</th><th>Round trip p50 (on gpu-x86)</th><th>Round trip p95 (on gpu-x86)</th></tr>
  <tr><td>1 min</td><td>3.7 ms</td><td>9.4 ms</td><td>4.7 ms</td><td>10.8 ms</td></tr>
  <tr><td>5 min</td><td>18.9 ms</td><td>34.8 ms</td><td>30.9 ms</td><td>248.6 ms</td></tr>
  <tr><td>10 min</td><td>67.6 ms</td><td>111.6 ms</td><td>270.7 ms</td><td>328.2 ms</td></tr>
</table>
<p>The round trip includes JSON encoding and transfer. Large 10-minute polygons make the response large.</p>

<h2 id="live-server-and-web-map">10. Live server and web map</h2>

<h3>10.1 Server (<code>cuda/server.py</code>)</h3>
<table>
  <tr><th>Endpoint</th><th>Result</th></tr>
  <tr><td><code>GET /sa?lon=&amp;lat=&amp;minutes=</code></td><td>One polygon as a GeoJSON Feature in WGS84. <code>minutes</code> is more than 0 and not more than 10. The header <code>X-Solve-ms</code> gives the server time.</td></tr>
  <tr><td><code>GET /crashes</code></td><td>All crashes as GeoJSON points. <code>parity/latency.py</code> uses them as test points.</td></tr>
  <tr><td><code>GET /config</code></td><td>The portal URL and the OAuth client ID from the environment, and the SHA-256 of <code>edges.parquet</code>. The web map shows a warning when the client data is from a different file.</td></tr>
  <tr><td><code>GET /</code></td><td>The web map (<code>web/</code>).</td></tr>
</table>
<p>
The server listens on 127.0.0.1:8765 only.
The Mac connects through an SSH tunnel.
The server keeps the graph on the GPU.
Rings are oriented for the ArcGIS SDK (outer ring clockwise).
</p>

<h3>10.2 Web map (<code>web/</code>)</h3>
<ul>
  <li>The map uses ArcGIS Maps SDK for JavaScript 5.2.2 (pinned) and the <code>&lt;arcgis-map&gt;</code> component.</li>
  <li>The panel selects the break (1, 5, or 10 min) and the mode (Hover or Click).</li>
  <li>Hover mode sends one request at a time. When a response arrives, the map sends the newest mouse position. Old positions are not sent.</li>
  <li>A break change cancels the open request and solves the last point again.</li>
  <li>The status line shows the calculation time only: the server time and, for the browser engine, the client time.</li>
  <li>The default basemap is OpenStreetMap.</li>
  <li>After ArcGIS sign-in, the basemap changes to <code>dark-gray-vector</code>. The sign-in uses OAuth with a redirect to the page.</li>
</ul>

<h2 id="procedures">11. Procedures</h2>
<p>Do the steps in the given order. Each step has one action.</p>

<h3>11.1 Prepare gpu-x86 (one time)</h3>
<ol>
  <li>Connect to gpu-x86: <code>ssh gpu-x86</code>.</li>
  <li>Go to the project folder: <code>cd ~/service-area</code>.</li>
  <li>Make the environment: <code>uv venv -p 3.12 .venv</code>.</li>
  <li>Install the packages: <code>uv pip install -p .venv/bin/python cupy-cuda13x shapely pyproj pyarrow numpy fastapi uvicorn matplotlib scipy</code>.</li>
</ol>

<h3>11.2 Run the ArcGIS engine (arcgis-win)</h3>
<ol>
  <li>Copy <code>OhioTGN.gdb</code> to <code>%USERPROFILE%\service-area\data\</code>.</li>
  <li>Copy <code>speeds.py</code> and <code>prep\</code> to <code>%USERPROFILE%\service-area\</code>.</li>
  <li>Open a command prompt in <code>%USERPROFILE%\service-area</code>.</li>
  <li>Prepare the streets: <code>"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" prep\01_prepare.py Adams</code>.</li>
  <li>Build the network: <code>... prep\02_build_nd.py Adams</code>.</li>
  <li>Solve the 100-crash sample: <code>... prep\03_solve_arcpy.py Adams --sample 100 --seed 7</code>.</li>
  <li>Copy <code>work\Adams_s100\</code> to <code>~/service-area/work/</code> on gpu-x86.</li>
</ol>
<p>Note: the full run (no <code>--sample</code>) takes about 31 minutes.</p>

<h3>11.3 Run the CUDA engine and the parity check (gpu-x86)</h3>
<ol>
  <li>Run the tests: <code>.venv/bin/python -m unittest discover -s tests -v</code>.</li>
  <li>Run the CUDA engine with the ArcGIS locations: <code>.venv/bin/python cuda/batch.py Adams_s100 --locations esri</code>.</li>
  <li>Run the parity check: <code>.venv/bin/python parity/compare.py Adams_s100 --locations esri</code>.</li>
  <li>Read the report: <code>results/parity_adams_s100_esri.md</code>.</li>
  <li>Run the CUDA engine with its own locations: <code>.venv/bin/python cuda/batch.py Adams_s100 --locations own</code>.</li>
  <li>Run the own-location parity check: <code>.venv/bin/python parity/compare.py Adams_s100 --locations own</code>.</li>
  <li>Read the own-location report: <code>results/parity_adams_s100_own.md</code>.</li>
</ol>

<h3>11.4 Start the live server and the web map</h3>
<ol>
  <li>Copy <code>work/Adams_s100/edges.parquet</code> and <code>crashes.parquet</code> to <code>work/Adams/</code> on gpu-x86.</li>
  <li>On the Mac, set <code>ARCGIS_PORTAL_URL</code> and <code>ARCGIS_CLIENT_ID</code>. This step is necessary only for the dark basemap.</li>
  <li>Start the server in tmux on gpu-x86:
<pre><code>ssh gpu-x86 "cd ~/service-area &amp;&amp; tmux new -d -s sa \"ARCGIS_PORTAL_URL=$ARCGIS_PORTAL_URL ARCGIS_CLIENT_ID=$ARCGIS_CLIENT_ID .venv/bin/python cuda/server.py Adams\""</code></pre></li>
  <li>Open the tunnel on the Mac: <code>ssh -N -L 8765:localhost:8765 gpu-x86</code>.</li>
  <li>Open <code>http://localhost:8765/</code> in a browser.</li>
  <li>Select the break.</li>
  <li>Move the mouse on the map.</li>
</ol>
<p>
Note: the OAuth app must list <code>http://localhost:8765/</code> as a redirect URI.
If it does not, the sign-in fails.
</p>

<h3>11.5 Stop the live server</h3>
<ol>
  <li>Stop the server: <code>ssh gpu-x86 'tmux kill-session -t sa'</code>.</li>
  <li>Stop the tunnel: press Ctrl+C in the tunnel terminal.</li>
</ol>

<h3>11.6 Measure the server time</h3>
<ol>
  <li>Start the server (11.4, steps 1 to 3).</li>
  <li>Run the benchmark on gpu-x86: <code>.venv/bin/python parity/latency.py --n 100 --out results/latency.md</code>.</li>
</ol>

<h3>11.7 Make the figures</h3>
<ol>
  <li>Export the raw streets on the Mac: <code>ogr2ogr -f GeoJSON -dim 2 adams_raw.geojson OhioTGN.gdb Adams_Streets -select MTFCC</code>.</li>
  <li>Copy <code>adams_raw.geojson</code> to <code>~/service-area/work/</code> on gpu-x86.</li>
  <li>Make the figures on gpu-x86: <code>.venv/bin/python docs/make_figures.py</code>.</li>
  <li>Copy <code>docs/images/</code> back to the repository.</li>
</ol>

<h3>11.8 Build and test the client engine</h3>
<ol>
  <li>Build the client data on gpu-x86: <code>.venv/bin/python client/build_client_data.py Adams</code>.</li>
  <li>Copy <code>web/data/</code> from gpu-x86 to the Mac repository.</li>
  <li>Run the engine test on the Mac: <code>node tests/test_client.mjs</code>.</li>
  <li>Start the server (11.4, step 3).</li>
  <li>Open the tunnel (11.4, step 4).</li>
  <li>Open <code>http://localhost:8765/client/check.html</code> to compare the client raster with the server polygon.</li>
  <li>Open <code>http://localhost:8765/</code>.</li>
  <li>Select the engine <b>Client</b> or <b>Both</b>.</li>
</ol>

<h2 id="repository-layout">12. Repository layout</h2>
<table>
  <tr><th>Path</th><th>Content</th></tr>
  <tr><td><code>speeds.py</code></td><td>MTFCC speed table. Both engines use it.</td></tr>
  <tr><td><code>prep/01_prepare.py</code></td><td>ArcPy: filter, node, snap, dedupe, calculate <code>Minutes</code>.</td></tr>
  <tr><td><code>prep/02_build_nd.py</code></td><td>ArcPy: build the network dataset from the template.</td></tr>
  <tr><td><code>prep/streets_nd_template.xml</code></td><td>Network dataset template with the <code>Minutes</code> cost.</td></tr>
  <tr><td><code>prep/03_solve_arcpy.py</code></td><td>ArcPy: service areas and Parquet export.</td></tr>
  <tr><td><code>cuda/engine.py</code></td><td>Graph, location, shortest-path kernel, reached intervals.</td></tr>
  <tr><td><code>cuda/polygons.py</code></td><td>Shared polygon builder.</td></tr>
  <tr><td><code>cuda/batch.py</code></td><td>Batch run for all crashes in a folder.</td></tr>
  <tr><td><code>cuda/server.py</code></td><td>Live FastAPI server.</td></tr>
  <tr><td><code>parity/compare.py</code></td><td>Parity gates and report.</td></tr>
  <tr><td><code>parity/latency.py</code></td><td>Server time benchmark.</td></tr>
  <tr><td><code>parity/benchmark.py</code></td><td>Warm repeated CUDA stage timings on the same facilities (8.3).</td></tr>
  <tr><td><code>tests/</code></td><td>GPU shortest path against Dijkstra, interval math, parity checker.</td></tr>
  <tr><td><code>web/</code></td><td>Web map (HTML and JavaScript).</td></tr>
  <tr><td><code>web/client/sa.js</code></td><td>Client engine: snap, shortest path, polygon-part flags. No SDK imports.</td></tr>
  <tr><td><code>web/client/layer.js</code></td><td>Client engine: WebGL2 layer (mask pass and composite pass).</td></tr>
  <tr><td><code>web/client/check.html</code></td><td>Pixel comparison of the client raster and the server polygon.</td></tr>
  <tr><td><code>client/build_client_data.py</code></td><td>Builds <code>web/data/</code> (graph, snap geometry, mesh, test fixture).</td></tr>
  <tr><td><code>tests/test_client.mjs</code></td><td>Node test: client engine against the CUDA engine.</td></tr>
  <tr><td><code>tests/test_client_arcpy.mjs</code></td><td>Node test: client lines against the ArcPy lines (14.4).</td></tr>
  <tr><td><code>tests/test_app.mjs</code></td><td>Node test: URL parameters of the web map (14.6), without the map SDK.</td></tr>
  <tr><td><code>web/client/gpu.js</code>, <code>web/client/geom.js</code></td><td>WebGPU shortest paths (fp32) and GEOS polygons (WebAssembly).</td></tr>
  <tr><td><code>web/client/planner.js</code>, <code>web/planner.html</code></td><td>Station planner (section 16).</td></tr>
  <tr><td><code>web/live.html</code></td><td>Live service area with WebGPU and GEOS (section 17).</td></tr>
  <tr><td><code>tests/test_client_geom.mjs</code>, <code>tests/test_planner.mjs</code>, <code>tests/bench_scale.mjs</code></td><td>Node tests: browser polygons, station planner, scale bench.</td></tr>
  <tr><td><code>docs/make_hover_gif.mjs</code></td><td>Records the hover animation.</td></tr>
  <tr><td><code>docs/make_cutoff_figures.py</code></td><td>Makes the crash 1800 comparison figure from the preserved repair and split experiments.</td></tr>
  <tr><td><code>docs/</code></td><td>Figure script and figures.</td></tr>
  <tr><td><code>tasks/</code></td><td>Task list and lessons.</td></tr>
  <tr><td><code>work/</code>, <code>data/</code></td><td>Data and outputs. Git ignores these folders.</td></tr>
</table>

<h2 id="known-limits">13. Known limits</h2>
<ul>
  <li>The speeds come from the street class only. The data has no posted speeds and no one-way streets.</li>
  <li>Native ArcGIS polygons and CUDA polygons are not equal. Median IoU is 0.96 to 0.99 in Adams (100 crashes) and 0.97 in the Franklin pilot (20 crashes).</li>
  <li>17 ArcGIS lines in the full Adams run are not split at a break. The CUDA engine does not copy this behavior. An isolated split removed the crash 1800 mismatch in the 100-crash sample. A general correction is not established (sections 8.4 and 19).</li>
  <li>Polygon construction runs on the CPU. It is the slowest CUDA-side step.</li>
  <li>The freeway and ramp split rule (3.3, step 3) ran for Franklin County (518 freeway and 1,010 ramp edges). The 20-crash Franklin pilot has no cost mismatches and two interval mismatches. Both interval mismatches are unsplit break crossings. The run of 2,000 crashes is not compared yet.</li>
  <li>Adams County is tested in full. Franklin County has a pilot only.</li>
</ul>

<h2 id="client-engine">14. Client engine (WebGL)</h2>
<p>
The client engine is an alternative to the server engine.
It does not replace the server engine.
The browser does the calculation and the drawing.
The server only supplies static files.
The <b>Engine</b> control in the panel selects Server, Client, or Both.
</p>

<p align="center">
  <img src="docs/images/client_both.png" width="600" alt="Web map in Both mode: client fill and server outline at 5 minutes.">
  <br><em>Figure 8. Both mode at 5 minutes. Blue fill: client engine. Orange outline: server engine.</em>
</p>

<h3>14.1 Design</h3>
<ul>
  <li><b>Shortest path in JavaScript.</b> The graph is small (4,357 nodes). Dijkstra with a typed-array heap uses 64-bit floats. The costs are equal to the CUDA costs.</li>
  <li><b>No shortest path on the GPU.</b> WebGL has 32-bit floats only, and a texture readback is slower than the JavaScript solve.</li>
  <li><b>The rasterizer does the polygon union.</b> The layer draws all parts into an offscreen mask. Then it draws the mask one time with a fill and an outline. The client does not build polygon geometry.</li>
  <li><b>The cutoff is a per-pixel test.</b> Each street vertex holds its position <i>p</i> along the edge. The fragment shader calculates <code>cost = min(cu + p·w, cv + (1 − p)·w)</code> and discards the pixel when the cost is more than the break. The cut is perpendicular to the street. This gives the flat caps of the polygon builder.</li>
  <li><b>The mesh is static.</b> One solve changes three small textures only: the node costs per edge, the node disk flags, and the face flags.</li>
</ul>

<h3>14.2 Data (<code>client/build_client_data.py</code>)</h3>
<ul>
  <li>The script writes <code>web/data/adams.bin</code> (20.9 MB) and <code>web/data/adams.json</code>. Git ignores <code>web/data/</code>.</li>
  <li>Graph arrays: CSR, edge ends, edge minutes (Float64).</li>
  <li>Snap geometry: street vertices in Web Mercator, with the position along the edge from EPSG:3735 lengths.</li>
  <li>Mesh: street quads, round-join wedges, node disks, and face triangles. The script offsets all vertices by the trim distance in EPSG:3735. Then it projects them to Web Mercator.</li>
  <li>The mesh has 664,363 vertices and 277,153 triangles.</li>
</ul>

<h3>14.3 Snap</h3>
<ul>
  <li>The snap uses a 500 m grid of street segments in Web Mercator. It does not use a projection library.</li>
  <li>Web Mercator is not conformal on the ellipsoid. Its north-south scale is 0.4% different from its east-west scale. The snap corrects this difference. Without the correction, the snapped position is wrong by some millimetres.</li>
  <li>A point farther than 5,000 m from all streets is not located.</li>
</ul>

<h3>14.4 Results</h3>
<p>Regenerate client fixtures for the default 100 crashes, then run <code>node tests/test_client.mjs</code> for CUDA agreement and seven warmed timing passes. Run <code>node tests/test_client_arcpy.mjs</code> for an independent ArcPy line gate. The known unsplit crossing remains a failure. The browser pixel check now reports PASS only at IoU ≥ 0.99; an empty selection or lower IoU reports ERROR.</p>
<table>
  <tr><th>Check</th><th>Result</th></tr>
  <tr><td>Node costs, client vs CUDA (20 crashes)</td><td>Maximum difference: 0 min.</td></tr>
  <tr><td>Full edges, node disks, filled faces vs <code>Builder.classify</code> (20 crashes, 3 breaks)</td><td>Equal.</td></tr>
  <tr><td>Snapped position vs <code>Graph.locate</code></td><td>Same edge. Maximum position difference: 5.7e-7.</td></tr>
  <tr><td>Client raster vs server polygon (6 crashes, 3 breaks, 2048 px)</td><td>IoU 0.9955 to 0.9997.</td></tr>
  <tr><td>Time per mouse position (Node, mean)</td><td>Snap 0.003 ms, solve 0.031 ms (10 min), flags 0.040 ms.</td></tr>
</table>
<p>
The largest difference is 0.34% of one polygon area.
There, the GEOS flat-cap buffer on the server drops area at short end pieces after a bend.
The client draws the full union at these locations.
</p>

<h3>14.5 Limits of the client engine</h3>
<ul>
  <li>The client engine gives a picture, not polygon geometry. Use the server engine when geometry is necessary.</li>
  <li>The browser downloads 20.9 MB of data one time (it includes the EPSG:3735 geometry for browser polygons).</li>
  <li>The time values are from Node on the Mac. The frame rate in the browser is not measured.</li>
  <li>The layer does not draw world copies across the date line.</li>
</ul>

<h3>14.6 Deep link</h3>
<p>
The page accepts URL parameters.
Example: <code>http://localhost:8765/?engine=both&amp;minutes=5&amp;at=-83.5456,38.7948&amp;zoom=12</code>.
The page selects the options and solves at the given longitude and latitude.
The parameters <code>zoom</code> and <code>rotation</code> (degrees) are optional.
</p>

<h2 id="browser-compute">15. Browser compute: WASM and WebGPU</h2>
<p>
This section gives the results of an investigation. The full numbers are in <code>results/browser_compute.md</code>.
</p>
<ul>
  <li>The client engine does work only in the reached area. Each solve resets only the nodes that it reached. The layer uploads only the texture rows that changed.</li>
  <li>On 100 copies of Adams (503,500 edges), flags take 0.10 ms. Before the change, flags took 5.96 ms.</li>
  <li>A WebAssembly engine (Rust) gave the same results. It was 2.3 times faster, but it saved only 0.07 ms per mouse position. It was removed, because it was a fourth copy of the interval rules.</li>
  <li>A WebGPU engine (<code>web/client/gpu.js</code>, fp32) finds the same polygon parts for 300 of 300 crash-breaks. Its costs do not pass the 1e-6 min gate: 6.36% of nodes fail.</li>
  <li>WebGPU is slower than JavaScript for one source (0.40 ms). It is faster for 100 sources together (0.50 ms).</li>
  <li>The data size limits the network size: approximately 19 MB for each Adams-sized area. A larger network needs tiled data.</li>
  <li>The browser polygon (<code>web/client/geom.js</code>, GEOS 3.13.0 in WebAssembly) passes the polygon gate for 300 of 300 crash-breaks. The minimum IoU is 0.9988. A 10-minute polygon takes 74 ms in Node.</li>
</ul>
<p>Run the tests:</p>
<ol>
  <li>Run the scale test on the Mac: <code>node tests/bench_scale.mjs</code>.</li>
  <li>Open <code>http://localhost:8765/client/bench_gpu.html</code> in a browser with WebGPU.</li>
  <li>Install the GEOS package: <code>npm ci</code>.</li>
  <li>Run the polygon test: <code>node tests/test_client_geom.mjs</code>.</li>
</ol>

<h2 id="station-planner">16. Station planner (WebGPU and WebAssembly)</h2>
<p>
The station planner answers one question: where must k response stations go to reach the most crashes within B minutes?
Open <code>http://localhost:8765/planner.html</code>.
</p>
<p align="center">
  <img src="docs/images/planner.png" width="600" alt="Map of Adams County with 5 stations, crashes reached in 5 minutes in blue, other crashes in red.">
  <br><em>Figure 9. Five stations, 5 minutes: 1,228 of 2,483 crashes (49.5%) are reached.</em>
</p>
<ol>
  <li>The page snaps all crashes to the streets. Each crash site is a candidate station.</li>
  <li>WebGPU solves all 2,483 candidates in batches of 512 (fp32). If the browser has no WebGPU, the page uses the JavaScript solver.</li>
  <li>A greedy pick adds, one at a time, the station that reaches the most crashes that are not yet reached.</li>
  <li>The JavaScript solver (Float64) solves the chosen stations again. The table shows these exact values.</li>
  <li>GEOS (WebAssembly) builds the service-area polygon of each station and their union.</li>
  <li><b>Export GeoJSON</b> downloads the coverage polygon and the stations in WGS84.</li>
</ol>
<table>
  <tr><th>Measurement (Chrome, Apple M-series GPU)</th><th>Result</th></tr>
  <tr><td>2,483 candidates, WebGPU (warm)</td><td>37 to 41 ms</td></tr>
  <tr><td>2,483 candidates, JavaScript</td><td>110 ms</td></tr>
  <tr><td>Same stations from WebGPU and JavaScript</td><td>60 of 60 cases (k = 1 to 20, breaks 1, 5, 10 min)</td></tr>
  <tr><td>Greedy pick, exact check, GEOS polygon (5 stations, 5 min)</td><td>6 to 11 ms, 1 to 2 ms, 213 to 217 ms</td></tr>
</table>
<ul>
  <li>The fp32 values only rank the candidates. The table and the polygon come from Float64.</li>
  <li>Add <code>?compare=1</code> to the URL to rank on the CPU too and count equal picks. Add <code>?auto=1</code> to run at load.</li>
  <li>Run the test on the Mac: <code>node tests/test_planner.mjs</code>.</li>
  <li>The candidates are crash sites only. The planner does not use other sites, such as existing stations.</li>
</ul>

<h2 id="live-page">17. Live service area (WebGPU and WebAssembly)</h2>
<p>
Open <code>http://localhost:8765/live.html</code>. Click on the map, or select <b>Hover</b> and move the mouse.
The service area follows the point.
</p>
<p align="center">
  <img src="docs/images/live_hover.gif" width="640" alt="Animation: hover along a street near West Union, 5-minute service area.">
  <br><em>Figure 10. Hover along one street segment (2.5 km, near West Union), 5 minutes. 28 positions: each WebGPU solve takes approximately 1 ms and each GEOS polygon approximately 30 ms.</em>
</p>
<ol>
  <li>WebGPU calculates the shortest paths (fp32). If the browser has no WebGPU, the page uses the JavaScript solver.</li>
  <li>GEOS (WebAssembly) builds the polygon with the same rules as the server.</li>
  <li>The panel shows the calculation time only: solve, polygon, and total. The comparison of fp32 with Float64 is in <code>web/client/bench_gpu.html</code>, not on this page.</li>
  <li>During hover, only one solve runs at a time. The newest point is solved next.</li>
</ol>
<table>
  <tr><th>Measurement (Chrome, Apple M-series GPU)</th><th>1 min</th><th>5 min</th><th>10 min</th></tr>
  <tr><td>WebGPU solve with readback (warm)</td><td>1.6 ms</td><td>0.8 to 2 ms</td><td>2.3 ms</td></tr>
  <tr><td>GEOS polygon</td><td>2.5 ms</td><td>21 to 34 ms</td><td>91 ms</td></tr>
  <tr><td>Same polygon parts as Float64</td><td colspan="3">44 of 44 solves (3 clicks, 1 break change, 40 hover moves). Largest cost difference: 1.6e-6 min. Measured on 11 November 2026, when the page still made this check.</td></tr>
</table>
<p>To make the animation again, follow the steps at the top of <code>docs/make_hover_gif.mjs</code>.</p>
<p>The main page (<code>index.html</code>, engine <b>Client</b>) is faster for hover, because it draws with WebGL and makes no geometry. Use this page when you need the polygon geometry.</p>

<h2 id="gpu-arm">18. Alternative host: gpu-arm</h2>
<p>
gpu-x86 is the default host. gpu-arm is an alternative host for the CUDA engine, the parity check and the live server.
gpu-arm has an NVIDIA GB10 GPU, an aarch64 CPU with 20 cores, and 121 GB of unified memory.
The full comparison is in <code>results/gpu-arm.md</code>.
</p>
<table>
  <tr><th>Check</th><th>Result on gpu-arm</th></tr>
  <tr><td>Batch output (Adams_s100)</td><td>Equal to gpu-x86 bit for bit: 97,363 reached rows and 300 polygons.</td></tr>
  <tr><td>Parity gates</td><td>Same as gpu-x86: 0 cost mismatches, 1 known interval mismatch, 299 of 300 polygons.</td></tr>
  <tr><td>Polygons, one CPU process</td><td>8.26 s (gpu-x86: 14.69 s).</td></tr>
  <tr><td>Live server p50</td><td>2.0 ms, 16.4 ms, 50.1 ms for 1, 5, 10 min (gpu-x86, same-session run: 3.7 ms, 21.4 ms, 67.6 ms).</td></tr>
</table>
<p>Set up gpu-arm:</p>
<ol>
  <li>Make the folder: <code>ssh gpu-arm mkdir -p ~/service-area</code>.</li>
  <li>Copy the code from the Mac: <code>rsync -a --exclude .git --exclude work --exclude data --exclude node_modules ./ gpu-arm:service-area/</code>.</li>
  <li>Copy <code>work/Adams_s100</code> and <code>work/Adams</code> from gpu-x86 to gpu-arm through the Mac.</li>
  <li>Make the environment: <code>ssh gpu-arm 'cd ~/service-area &amp;&amp; ~/.local/bin/uv venv --python 3.12 .venv'</code>.</li>
  <li>Install the packages: <code>~/.local/bin/uv pip install --python .venv/bin/python cupy-cuda13x==14.2.0 numpy==2.5.4 shapely==2.2.0 pyarrow==26.0.1 pyproj==3.8.0 fastapi==0.162.3 uvicorn==0.54.0</code>.</li>
</ol>
<p>The commands for gpu-x86 in section 11 also work on gpu-arm. Replace <code>gpu-x86</code> with <code>gpu-arm</code> in the <code>ssh</code> and <code>rsync</code> commands. To use both hosts at one time, tunnel gpu-arm to another local port: <code>ssh -N -L 127.0.0.1:8766:127.0.0.1:8765 gpu-arm</code>.</p>

<h2 id="cutoff-investigation">19. Cutoff investigation: crash 1800</h2>

<p>
This section records two tests from 14 November 2026.
The first test repaired the geometry and rebuilt the Adams network.
The second test split one edge at its calculated 5-minute position.
Both tests used the same 100 crashes and random seed 7.
</p>
<p>
<b>Result:</b> repair and rebuild did not remove the mismatch.
The isolated edge split removed the mismatch.
The original network still has the known mismatch.
The split is a diagnostic result, not a general preparation rule.
</p>

<h3 id="cutoff-terms">19.1 Terms and test conditions</h3>
<table>
  <tr><th>Term</th><th>Meaning in this investigation</th></tr>
  <tr><td>break</td><td>The travel-time limit for a service area.</td></tr>
  <tr><td>cost</td><td>Travel time in minutes. The network stores the edge cost in the <code>Minutes</code> field.</td></tr>
  <tr><td>cutoff position</td><td>The position on an edge where travel time equals the break.</td></tr>
  <tr><td>break band</td><td>A travel-time range in the line output, such as 1–5 minutes or 5–10 minutes.</td></tr>
  <tr><td>cumulative result</td><td>All reached intervals up to one break. The 5-minute result includes intervals from the inner bands.</td></tr>
  <tr><td>child edge</td><td>One of the two edges made by the split.</td></tr>
  <tr><td>tail</td><td>The short child edge after the cutoff position.</td></tr>
  <tr><td>baseline</td><td>The prepared Adams network and its original 100-crash reference outputs.</td></tr>
  <tr><td>shared-builder polygon</td><td>A polygon made by <code>Builder</code> from one engine's reached intervals.</td></tr>
  <tr><td>native polygon</td><td>A polygon exported directly by ArcGIS Network Analyst.</td></tr>
</table>
<p>
A shared-builder polygon and a native polygon are different outputs.
The polygon gate compares two shared-builder polygons.
The native polygon comparison is a separate reference measurement.
</p>
<table>
  <tr><th>Test condition</th><th>Value</th></tr>
  <tr><td>County</td><td>Adams County, Ohio</td></tr>
  <tr><td>Source streets</td><td><code>data/OhioTGN.gdb/Adams_Streets</code></td></tr>
  <tr><td>Source crashes</td><td><code>data/OhioTGN.gdb/Adams_Crashes</code></td></tr>
  <tr><td>Facility sample</td><td>100 crashes; random seed 7; the same facility names in each test</td></tr>
  <tr><td>Breaks</td><td>1, 5, and 10 minutes</td></tr>
  <tr><td>Locations for the gate</td><td>ArcGIS facility locations, with <code>--locations esri</code></td></tr>
  <tr><td>Coordinate system</td><td>EPSG:3735; US survey feet</td></tr>
  <tr><td>ArcGIS software</td><td>ArcGIS Pro 3.7.3, build 1901; Network Analyst</td></tr>
  <tr><td>Windows host</td><td><code>mraadmlwin</code>; this host performs the <code>arcgis-win</code> role</td></tr>
  <tr><td>GPU host</td><td><code>gc5</code>; this host performs the <code>gpu-x86</code> role</td></tr>
  <tr><td>GPU</td><td>NVIDIA RTX PRO 6000 Blackwell Server Edition</td></tr>
  <tr><td>Windows project folder</td><td><code>C:\Users\mraad\service-area</code></td></tr>
  <tr><td>GPU project folder</td><td><code>/home/ubuntu/service-area</code></td></tr>
</table>
<p>
The role names in earlier sections are not guaranteed SSH aliases.
These two tests used <code>mraadmlwin</code> and <code>gc5</code>.
</p>

<h3 id="cutoff-original">19.2 The original mismatch</h3>
<p>
The affected facility is crash 1800.
Its facility OID in this sample is 72.
The affected street has source OID 3249 and exported <code>EID</code> 3249.
A browser fixture uses a separate array index, 2304, for this edge.
The array index is not the source OID.
</p>
<table>
  <tr><th>ArcGIS line field</th><th>Value</th><th>Meaning</th></tr>
  <tr><td><code>FromPosition</code></td><td>0.0</td><td>Start of the digitized edge</td></tr>
  <tr><td><code>ToPosition</code></td><td>1.0</td><td>End of the digitized edge</td></tr>
  <tr><td><code>FromCumul_Minutes</code></td><td>3.5492812118132644</td><td>Travel time from crash 1800 to the edge start</td></tr>
  <tr><td><code>ToCumul_Minutes</code></td><td>5.000032509772196</td><td>Travel time from crash 1800 to the edge end</td></tr>
</table>
<p>
The edge starts inside the 5-minute service area.
The edge ends outside it.
The end exceeds the break by 0.000032509772196 minutes, or approximately 0.0019506 seconds.
Most of the edge is reached.
</p>
<p>
ArcGIS exports one line from position 0 to position 1.
It does not split this line at 5 minutes.
The cumulative 5-minute line result therefore omits this edge.
CUDA includes the reached interval <code>[0.0, 0.9999775910783317]</code>.
The gate records one reached-interval mismatch.
</p>
<p>
The travel-time calculations agree.
The maximum cumulative-cost difference across the sample is 1.776e-15 minutes.
This value is below the 1e-6-minute gate tolerance.
The difference is in the reported interval, not in the measured edge-end costs.
</p>

<p align="center">
  <a href="docs/images/cutoff_split.svg"><img src="docs/images/cutoff_split.svg" width="640" alt="Three line diagrams compare the original ArcGIS line, the CUDA reached interval, and the two child edges after the cutoff split. The short tail is exaggerated."></a>
  <br><em>Figure 11. Edge 3249 at the 5-minute break. The tail is exaggerated. The diagram is not to scale.</em>
</p>

<h3 id="cutoff-calculation">19.3 Calculate the split position</h3>
<p>
The edge has one speed and one cost per direction.
Travel time along this edge is proportional to distance.
For this crossing, the start-side path determines the reached interval.
Let <code>c0</code> be the travel time to the edge start.
Let <code>w</code> be the travel time along the complete edge.
Let <code>B</code> be the break.
</p>
<pre><code>c0 = 3.5492812118132644 min
w  = 5.000032509772196 - c0
   = 1.4507512979589317 min
B  = 5 min

cutoff_position = (B - c0) / w
                = 0.9999775910783317</code></pre>
<p>
The position is a fraction of the complete edge length.
It is not a coordinate and it is not a travel time.
CUDA reaches approximately 99.99776% of this edge.
The remaining length is approximately 0.085981 US survey feet, or 0.0262 metres.
</p>
<p>
The general engine also checks travel from the other end and from a facility on its own edge.
The formula above describes this specific crossing only.
</p>

<h3 id="cutoff-repair">19.4 Test A: repair geometry and rebuild the network</h3>
<p>
The test used the named source geodatabase.
It did not substitute a derived source dataset.
Before the repair, a backup preserved the complete source geodatabase.
Separate backups preserved the prepared Adams geodatabase and the sample outputs.
</p>
<p>
The repair used both ESRI and OGC validation methods.
The repair used <code>KEEP_NULL</code>.
Feature-count checks confirmed that no record was lost.
</p>
<table>
  <tr><th>Layer</th><th>Features before</th><th>Features after</th><th>ESRI problems before / after</th><th>OGC problems before / after</th></tr>
  <tr><td>Source <code>Adams_Streets</code></td><td>3,063</td><td>3,063</td><td>0 / 0</td><td>0 / 0</td></tr>
  <tr><td>Source <code>Adams_Crashes</code></td><td>2,483</td><td>2,483</td><td>0 / 0</td><td>0 / 0</td></tr>
  <tr><td>Prepared <code>Net/Streets</code></td><td>5,035</td><td>5,035</td><td>0 / 0</td><td>0 / 0</td></tr>
  <tr><td>Prepared <code>Crashes</code></td><td>2,483</td><td>2,483</td><td>0 / 0</td><td>0 / 0</td></tr>
</table>
<p>
Source street repair reported <code>WARNING 003598: Updated feature class extent</code>.
The checks reported no geometry defects.
Preparation again removed 2,301 duplicate streets.
It removed no zero-length streets.
The result again had 5,035 edges, 4,357 nodes, and 22 connected components.
The largest component held 98.7% of the nodes.
</p>
<p>
The network dataset rebuilt successfully.
The fresh solve used the same 100 crashes.
It exported 84,676 line pieces and 300 native polygons.
All five exported Parquet files were byte-identical to the baseline.
The fresh CUDA reached and polygon files were also byte-identical to their baseline files.
</p>
<p>
The result did not improve.
The line gate still had one interval mismatch.
The polygon gate still passed 299 of 300 pairs.
For crash 1800 at 5 minutes, shared-builder IoU remained 0.9396.
Hausdorff distance remained 2,131.2 feet.
</p>
<p>
These values use the current nearest-street polygon rule.
An older investigation recorded IoU 0.939716 and Hausdorff distance 2,143.624 feet.
Do not use the older values as the baseline for this test.
</p>

<h3 id="cutoff-split">19.5 Test B: split one edge on a network copy</h3>
<p>
The test copied the prepared Adams geodatabase to a separate experiment geodatabase.
The test did not edit the source geodatabase or the original prepared network.
It removed the network dataset from the copy before the geometry edit.
</p>
<p>
ArcPy <code>segmentAlongLine</code> made two child geometries at the calculated cutoff position.
The long child retained source OID and <code>EID</code> 3249.
The new tail received source OID and <code>EID</code> 7337.
Each source OID matched its exported <code>EID</code>.
This match is necessary because the ArcGIS line output identifies streets by source OID.
</p>
<table>
  <tr><th>Property</th><th>Original edge</th><th>Long child, EID 3249</th><th>Tail, EID 7337</th></tr>
  <tr><td>Length, US survey feet</td><td>3,829.9834266115795</td><td>3,829.8974456544256</td><td>0.0859809918316327</td></tr>
  <tr><td>Travel time, minutes</td><td>1.4507512979589317</td><td>1.4507187881867265</td><td>0.0000325097722052645</td></tr>
  <tr><td>Arrival time at end, minutes</td><td>5.000032509772196</td><td>4.999999999999991</td><td>5.000032509772196</td></tr>
</table>
<p>
The existing speed table calculated each child cost from its stored geometry length.
The sum of the child costs differed from the original cost by 2.220446049250313e-16 minutes.
The test did not change the speed to force a result.
</p>
<p>
The new junction arrival time was 4.999999999999991 minutes.
This time is below 5 minutes by approximately 9e-15 minutes.
This floating-point result is part of the evidence.
It must not be rounded to exactly 5 minutes in a reproduction script.
</p>
<table>
  <tr><th>Spatial setting</th><th>Value, US survey feet</th></tr>
  <tr><td>Network XY tolerance</td><td>0.00328083333333333</td></tr>
  <tr><td>Network XY resolution</td><td>0.00032808333333333355</td></tr>
  <tr><td>Tail length</td><td>0.0859809918316327</td></tr>
</table>
<p>
The tail length is approximately 26 times the XY tolerance.
It remained a separate positive-length edge.
The modified network had 5,036 edges and 4,358 nodes.
</p>
<p>The experiment checked these conditions before the solve:</p>
<ul>
  <li>Both child edges had positive lengths.</li>
  <li>The two child edges had exactly equal coordinates at their shared junction.</li>
  <li>The two outer endpoints matched the original edge endpoints.</li>
  <li>Every other edge retained its geometry and travel time.</li>
  <li>Every source OID matched its <code>EID</code>.</li>
  <li>The OGC geometry check reported zero problems.</li>
</ul>
<p>
The copied network rebuilt successfully.
The solve used the same sample names and the same seed.
ArcGIS exported 84,686 line pieces and 300 native polygons.
The long child ended below the break.
The tail appeared as a separate line that extended above the break.
</p>

<h3 id="cutoff-gates">19.6 Gate results</h3>
<p>
Both engines read the same edge table for each test.
The split-network ArcGIS output was not compared against the original CUDA network.
The CUDA batch used <code>--locations esri</code> and eight polygon workers.
The gate used its existing tolerances.
</p>
<table>
  <tr><th>Gate condition</th><th>Limit</th></tr>
  <tr><td>Cumulative-cost difference</td><td>At most 1e-6 minutes</td></tr>
  <tr><td>Reached-interval position difference</td><td>At most 1e-6 of the edge length</td></tr>
  <tr><td>Shared-builder polygon IoU</td><td>At least 0.99</td></tr>
  <tr><td>Shared-builder boundary Hausdorff distance</td><td>At most 50 US survey feet</td></tr>
</table>
<table>
  <tr><th>Measurement</th><th>Original baseline</th><th>Repair and rebuild</th><th>Cutoff split</th></tr>
  <tr><td>Located facilities</td><td>100</td><td>100</td><td>100</td></tr>
  <tr><td>ArcGIS line pieces</td><td>84,676</td><td>84,676</td><td>84,686</td></tr>
  <tr><td>Cumulative-cost mismatches</td><td>0</td><td>0</td><td>0</td></tr>
  <tr><td>Maximum cost difference, minutes</td><td>1.776e-15</td><td>1.776e-15</td><td>1.776e-15</td></tr>
  <tr><td>Reached-interval mismatches</td><td>1</td><td>1</td><td>0</td></tr>
  <tr><td>Unsplit break crossings in the sample</td><td>1</td><td>1</td><td>0</td></tr>
  <tr><td>Line gate</td><td>FAIL</td><td>FAIL</td><td>PASS</td></tr>
  <tr><td>Shared-builder polygon pairs within both limits</td><td>299 / 300</td><td>299 / 300</td><td>300 / 300</td></tr>
  <tr><td>Shared-builder polygon gate</td><td>FAIL</td><td>FAIL</td><td>PASS</td></tr>
  <tr><td>ArcGIS solve time, seconds</td><td>69.274490</td><td>69.454876</td><td>67.750360</td></tr>
</table>
<p>
The repair report exits with status 1 because the known gates fail.
The split report exits with status 0 because both gates pass.
The split report rounds each break's shared-builder IoU to 1.0000 and Hausdorff distance to 0.0 feet.
These rounded values do not establish identical vertex coordinates.
Each solve time is one measurement.
The times do not establish a performance improvement.
</p>

<p align="center">
  <a href="docs/images/cutoff_polygons.png"><img src="docs/images/cutoff_polygons.png" width="680" alt="Two maps show the shared Builder on ArcGIS lines against CUDA at crash 1800 and 5 minutes. The original network has a polygon difference near edge 3249. The cutoff-split network removes that difference."></a>
  <br><em>Figure 12. Crash 1800 at 5 minutes. Both panels use the same map extent and the same Builder. Orange is the Builder result from ArcGIS lines. Blue is the CUDA result. These are not native ArcGIS polygons.</em>
</p>

<h3 id="cutoff-native">19.7 Native polygons and the line-output explanation</h3>
<p>
The split changed the edge table and the exported ArcGIS lines.
It did not change the native ArcGIS polygon file.
The complete native polygon Parquet file was byte-identical before and after the split.
The crash and facility-location files were also byte-identical.
</p>
<p>
The original shared-builder failure came from the ArcGIS line input at the 5-minute break.
That line input omitted most of edge 3249.
The Builder therefore received different reached streets from the two engines.
A missing street can change buffers, node disks, filled faces, and the nearest-street territory.
A short unreached tail can therefore accompany a much larger polygon difference.
The polygon difference is not limited to the length of the tail.
</p>
<p>
The split supplied the long reached child as a complete line below the break.
The shared Builder then passed all 300 polygon comparisons.
Native polygon equality does not follow from this gate pass.
The separate native-polygon reference comparison remains unchanged.
</p>
<p>
<b>Inference:</b> these results support a line-output splitting or band-assignment explanation.
They do not identify the internal ArcGIS implementation cause.
The test introduced a junction and changed floating-point operations.
It did not isolate those two effects from each other.
</p>

<h3 id="cutoff-hashes">19.8 File identity checks</h3>
<p>
SHA-256 checks compare complete files.
The repair experiment checked each fresh Windows export against its baseline file.
The split experiment checked the GPU input hashes against the transferred Windows exports.
The checks confirm that the GPU gate used the intended edge and reference files.
</p>
<table>
  <tr><th>File</th><th>After repair and rebuild</th><th>After cutoff split</th></tr>
  <tr><td><code>edges.parquet</code></td><td>Byte-identical to baseline</td><td>Changed</td></tr>
  <tr><td><code>crashes.parquet</code></td><td>Byte-identical to baseline</td><td>Byte-identical to baseline</td></tr>
  <tr><td><code>esri_facilities.parquet</code></td><td>Byte-identical to baseline</td><td>Byte-identical to baseline</td></tr>
  <tr><td><code>esri_lines.parquet</code></td><td>Byte-identical to baseline</td><td>Changed</td></tr>
  <tr><td><code>esri_polygons.parquet</code></td><td>Byte-identical to baseline</td><td>Byte-identical to baseline</td></tr>
</table>
<p>Key hashes:</p>
<pre><code>Original and repaired edges.parquet:
bb2cf3f190bfe49a2f53877c84fefb55a61ec881f0f934478088f1da3dfebf65

Split edges.parquet:
a267e7351820f1942db4844b0bc001e01b40d574d466eb43e3fb1794fb040b87

Original and repaired esri_lines.parquet:
c3de3b54bed7393115266cbcac8fa855b8fe21247c3dccf1835c312dba180477

Split esri_lines.parquet:
08dbac78ae7d9c33442a42cb61c10291eb990583a57f101b2384b5a4f8e77232

Native esri_polygons.parquet in all three cases:
fe8ae839116a71d01fb0c62bff1f472137f365ef4c8f54d193b4977f9ff38f42</code></pre>
<p>
The complete repair hashes are in the repair record.
The CUDA timing JSON records the input and output hashes for each completed batch.
</p>

<h3 id="cutoff-procedure">19.9 Procedure for another split test</h3>
<p>
Use a separate experiment name for each test.
Do not overwrite the original network.
The preserved one-off scripts are on the experiment hosts; they are not installed project commands.
The steps below describe their controlled procedure.
</p>
<ol>
  <li>Record the baseline input hashes.</li>
  <li>Copy the prepared Adams geodatabase to a new experiment path.</li>
  <li>Remove the network dataset from the experiment copy.</li>
  <li>Read the affected edge's endpoint costs from the baseline ArcGIS line output.</li>
  <li>Calculate the cutoff position with the formula in section 19.3.</li>
  <li>Extract the long child geometry with <code>segmentAlongLine(0, cutoff_position, True)</code>.</li>
  <li>Extract the tail geometry with <code>segmentAlongLine(cutoff_position, 1, True)</code>.</li>
  <li>Replace the affected edge geometry with the long child geometry.</li>
  <li>Insert the tail as a new edge.</li>
  <li>Set the tail's <code>EID</code> to its source OID.</li>
  <li>Calculate each child cost with the existing <code>speeds.minutes</code> function.</li>
  <li>Check the child lengths.</li>
  <li>Check the shared junction coordinates.</li>
  <li>Check the original outer endpoint coordinates.</li>
  <li>Check the sum of the child costs.</li>
  <li>Check the geometry and cost of each unchanged edge against the baseline.</li>
  <li>Check source OID and <code>EID</code> agreement.</li>
  <li>Run the geometry check on the experiment streets.</li>
  <li>Build the experiment network dataset.</li>
  <li>Solve the same 100-crash sample with seed 7.</li>
  <li>Check the exported facility names against the baseline sample.</li>
  <li>Copy the experiment exports to a separate GPU work folder.</li>
  <li>Check the copied input hashes.</li>
  <li>Run the CUDA batch on the experiment edge table.</li>
  <li>Run the unchanged parity gate.</li>
  <li>Record the gate exit status.</li>
  <li>Compare the native ArcGIS polygon file hash with the baseline hash.</li>
  <li>Check the original network snapshot against its saved state.</li>
</ol>
<p>
The following commands use the preserved experiment name.
Run Windows commands from <code>C:\Users\mraad\service-area</code>.
Run GPU commands from <code>~/service-area</code> on <code>gc5</code>.
Re-running the solve or CUDA batch replaces outputs in that experiment folder.
The original <code>Adams_s100</code> folder is a different folder.
</p>
<p><b>Windows: build the split network.</b></p>
<pre><code>"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" prep\02_build_nd.py Adams_split_20261114T121005Z</code></pre>
<p><b>Windows: solve the split sample.</b></p>
<pre><code>"C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" prep\03_solve_arcpy.py Adams_split_20261114T121005Z --sample 100 --seed 7</code></pre>
<p><b>GPU: calculate CUDA results from the split edge table.</b></p>
<pre><code>.venv/bin/python cuda/batch.py Adams_split_20261114T121005Z_s100 --locations esri --workers 8</code></pre>
<p><b>GPU: compare the two engines.</b></p>
<pre><code>.venv/bin/python parity/compare.py Adams_split_20261114T121005Z_s100 --locations esri</code></pre>
<p><b>GPU: make Figure 12 from the preserved outputs.</b></p>
<pre><code>.venv/bin/python docs/make_cutoff_figures.py</code></pre>
<p>
The figure script checks the expected before and after metrics.
It also checks native polygon file identity.
It exits before plotting if those checks fail.
</p>

<h3 id="cutoff-artifacts">19.10 Evidence and artifact locations</h3>
<table>
  <tr><th>Record</th><th>Repository path</th></tr>
  <tr><td>Repair and rebuild details</td><td><a href="results/adams_repair_rebuild_20261114.md"><code>results/adams_repair_rebuild_20261114.md</code></a></td></tr>
  <tr><td>Repair parity report</td><td><a href="results/parity_adams_repair_20261114_esri.md"><code>results/parity_adams_repair_20261114_esri.md</code></a></td></tr>
  <tr><td>Cutoff split details</td><td><a href="results/adams_split_cutoff_20261114.md"><code>results/adams_split_cutoff_20261114.md</code></a></td></tr>
  <tr><td>Split parity report</td><td><a href="results/parity_adams_split_cutoff_20261114_esri.md"><code>results/parity_adams_split_cutoff_20261114_esri.md</code></a></td></tr>
  <tr><td>Open findings</td><td><a href="tasks/todo.md"><code>tasks/todo.md</code></a></td></tr>
  <tr><td>Polygon figure script</td><td><a href="docs/make_cutoff_figures.py"><code>docs/make_cutoff_figures.py</code></a></td></tr>
</table>
<p>Windows paths are relative to <code>C:\Users\mraad\service-area</code>:</p>
<table>
  <tr><th>Artifact</th><th>Windows path</th></tr>
  <tr><td>Repair script</td><td><code>work\repair_rebuild_20261114.py</code></td></tr>
  <tr><td>Repair backups, checks, logs, and manifest</td><td><code>work\keep\repair_rebuild_20261114T120055Z</code></td></tr>
  <tr><td>Split script</td><td><code>work\split_edge_20261114.py</code></td></tr>
  <tr><td>Split network geodatabase</td><td><code>work\Adams_split_20261114T121005Z.gdb</code></td></tr>
  <tr><td>Split checks, logs, and manifest</td><td><code>work\keep\Adams_split_20261114T121005Z</code></td></tr>
  <tr><td>Split sample exports</td><td><code>work\Adams_split_20261114T121005Z_s100</code></td></tr>
</table>
<p>GPU paths are relative to <code>/home/ubuntu/service-area</code> on <code>gc5</code>:</p>
<table>
  <tr><th>Artifact</th><th>GPU path</th></tr>
  <tr><td>Repair comparison inputs and CUDA outputs</td><td><code>work/Adams_repair_20261114T120055Z</code></td></tr>
  <tr><td>Split comparison inputs and CUDA outputs</td><td><code>work/Adams_split_20261114T121005Z_s100</code></td></tr>
  <tr><td>Repair comparison script</td><td><code>work/Adams_repair_20261114T120055Z/check.py</code></td></tr>
</table>
<p>
Each Windows experiment manifest records the checks and stage results.
The repair manifest also records the original and fresh export hashes.
The split manifest records the child geometry, costs, and exported crossing lines.
The script preserves the original sample hashes for the final identity check.
</p>

<h3 id="cutoff-limits">19.11 What the tests establish</h3>
<ul>
  <li>Geometry repair and network rebuild do not remove this reproducible mismatch.</li>
  <li>A junction at this calculated cutoff removes the mismatch on the test copy.</li>
  <li>The same 100-crash sample passes both gates on the split network.</li>
  <li>The split does not change the native ArcGIS polygon file.</li>
  <li>The original network retains its known mismatch.</li>
</ul>
<p>These questions remain open:</p>
<ul>
  <li>Which internal ArcGIS rule controls the unsplit output line?</li>
  <li>Does a midpoint split change the result?</li>
  <li>Does a split just before or just after the calculated cutoff change the result?</li>
  <li>How much does floating-point rounding at the new junction affect the result?</li>
  <li>Does the same controlled split remove the other full-Adams or Franklin crossings?</li>
</ul>
<p>
The split was selected for one crash and one break.
Different crashes have different cutoff positions.
A facility-specific split is therefore not a general network preparation rule.
No full-Adams solve, Franklin solve, own-location gate, or browser fixture rebuild was performed for the split network.
The production network and client data were not replaced.
</p>
<p>
The deferred failure must remain visible in baseline reports.
Do not widen tolerances to hide it.
Do not report the split-network pass as a pass for the original network.
</p>
