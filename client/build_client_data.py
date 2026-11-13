"""Build the static data for the browser engine (web/client/): graph, snap geometry, WebGL mesh.

usage: python client/build_client_data.py Adams [--fixture Adams_s100] [--n 100]

Writes web/data/<county>.bin + <county>.json (array directory), web/data/fixture.json
(CUDA node costs and Builder.classify results for N crashes; tests/test_client.mjs compares) and
web/data/fixture_poly.json (reached pieces and Builder.polygon WKB; tests/test_client_geom.mjs compares).
All mesh vertices are offset by the trim distance in EPSG:3735, then projected to Web Mercator.
"""
import hashlib
import json
import math
import os
import sys

import numpy as np
import pyarrow.parquet as pq
import shapely
from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "cuda"))
from batch import BREAKS, located_esri  # noqa: E402
from engine import Graph, intervals  # noqa: E402
from polygons import POS_EPS, TRIM_FT, Builder  # noqa: E402

a = sys.argv[1:]
county = a[0]
fixture_dir = a[a.index("--fixture") + 1] if "--fixture" in a else f"{county}_s100"
n_fix = int(a[a.index("--n") + 1]) if "--n" in a else 100
MIN_JOIN_RAD = 0.001  # shortcut: bends under 0.06 deg get no join wedge (gap < 0.33 ft, below one pixel at any zoom)
ARC_STEP = math.pi / 16  # GEOS quad_segs=8

edges_parquet = os.path.join(ROOT, "work", county, "edges.parquet")
g = Graph(edges_parquet)
b = Builder(g)
to_merc = Transformer.from_crs(3735, 3857, always_xy=True)


def merc(xy):
    x, y = to_merc.transform(xy[:, 0], xy[:, 1])
    return np.column_stack([x, y])


# ---- snap geometry: per-edge vertices (Web Mercator) with position along the edge (EPSG:3735 lengths)
vert_off, vert_xy, vert_p = [0], [], []
# ---- mesh: x, y (3735 until projected), a, b, idx ; one index list per kind
# street vertices: a = position along the edge, |b| = distance from the street / trim distance (nearest-street pass)
mv, street_i, disk_i, face_i = [], [], [], []


def add(x, y, a_, b_, idx):
    mv.append((x, y, a_, b_, idx))
    return len(mv) - 1


for e, geom in enumerate(g.geom):
    xy = shapely.get_coordinates(geom)
    seg = np.hypot(*np.diff(xy, axis=0).T)
    keep = np.r_[True, seg > 0]  # drop repeated vertices
    xy, seg = xy[keep], seg[seg > 0]
    p = np.r_[0.0, np.cumsum(seg)] / seg.sum()
    p[-1] = 1.0
    vert_xy.append(xy)
    vert_p.append(p)
    vert_off.append(vert_off[-1] + len(xy))
    d = np.diff(xy, axis=0) / seg[:, None]
    nrm = np.column_stack([-d[:, 1], d[:, 0]]) * TRIM_FT  # left normal
    for i in range(len(seg)):
        (ax, ay), (bx, by), (nx, ny) = xy[i], xy[i + 1], nrm[i]
        q = [add(ax + nx, ay + ny, p[i], 1, e), add(ax - nx, ay - ny, p[i], -1, e),
             add(bx + nx, by + ny, p[i + 1], 1, e), add(bx - nx, by - ny, p[i + 1], -1, e)]
        street_i += [q[0], q[1], q[2], q[2], q[1], q[3]]
    for i in range(1, len(seg)):  # round join on the outer side of each bend
        cross = d[i - 1, 0] * d[i, 1] - d[i - 1, 1] * d[i, 0]
        s = -1.0 if cross > 0 else 1.0
        a0 = math.atan2(s * nrm[i - 1, 1], s * nrm[i - 1, 0])
        a1 = math.atan2(s * nrm[i, 1], s * nrm[i, 0])
        delta = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        if abs(delta) < MIN_JOIN_RAD:
            continue
        steps = max(1, math.ceil(abs(delta) / ARC_STEP))
        vx, vy = xy[i]
        c = add(vx, vy, p[i], 0, e)
        arc = [add(vx + TRIM_FT * math.cos(a0 + delta * k / steps), vy + TRIM_FT * math.sin(a0 + delta * k / steps), p[i], 1, e)
               for k in range(steps + 1)]
        for k in range(steps):
            street_i += [c, arc[k], arc[k + 1]]
n_street_v = len(mv)

for n, (x, y) in enumerate(b.node_xy):  # disk = quad + circle test on (a, b) in the shader
    q = [add(x + sx * TRIM_FT, y + sy * TRIM_FT, sx, sy, n) for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1))]
    disk_i += [q[0], q[1], q[2], q[2], q[1], q[3]]

for f, poly in enumerate(b.faces):
    for tri in shapely.get_parts(shapely.constrained_delaunay_triangles(poly)):
        face_i += [add(x, y, 0, 0, f) for x, y in shapely.get_coordinates(tri)[:3]]

mv = np.array(mv, dtype=np.float64)
vert_3735 = np.vstack(vert_xy)  # browser polygons (web/client/geom.js) are built in EPSG:3735, as Builder does
vert_xy = merc(vert_3735)
mesh_xy = merc(mv[:, :2])
origin = (vert_xy.min(axis=0) + vert_xy.max(axis=0)) / 2
mesh = np.column_stack([mesh_xy - origin, mv[:, 2:]]).astype(np.float32)


def csr(lists):
    off = np.zeros(len(lists) + 1, np.int32)
    off[1:] = np.cumsum([len(x) for x in lists])
    flat = np.concatenate([np.asarray(x, np.int32) for x in lists]) if off[-1] else np.zeros(0, np.int32)
    return off, flat


face_off, face_edges = csr(b.face_edges)
_wkb = [shapely.to_wkb(f) for f in b.faces]  # little-endian WKB, read by GEOS in the browser
face_wkb_off = np.r_[0, np.cumsum([len(x) for x in _wkb])].astype(np.int32)
face_wkb = np.frombuffer(b"".join(_wkb), np.uint8)
inc_off, inc_edges = csr(b.inc)
arrays = {
    "rowptr": g.rowptr.astype(np.int32), "col": g.col.astype(np.int32), "warc": g.warc.astype(np.float64),
    "eu": g.eu.astype(np.int32), "ev": g.ev.astype(np.int32), "w": g.w.astype(np.float64),
    "vertOff": np.asarray(vert_off, np.int32), "vertXY": vert_xy.astype(np.float64).ravel(),
    "vertP": np.concatenate(vert_p).astype(np.float64),
    "faceOff": face_off, "faceEdges": face_edges, "incOff": inc_off, "incEdges": inc_edges,
    "mesh": mesh.ravel(),
    "streetIdx": np.asarray(street_i, np.uint32), "diskIdx": np.asarray(disk_i, np.uint32),
    "faceIdx": np.asarray(face_i, np.uint32),
    "vert3735": vert_3735.astype(np.float64).ravel(), "nodeXY": b.node_xy.astype(np.float64).ravel(),
    "faceWkbOff": face_wkb_off, "faceWkb": face_wkb,
    # nearest-street cells (Builder territory): pieces per edge, cell of each piece, cell points (EPSG:3735)
    "pieceN": b.piece_n.astype(np.int32), "pieceCell": b.piece_cell.astype(np.int32),
    "cellXY": b.cell_xy.astype(np.float64).ravel(),
}
out = os.path.join(ROOT, "web", "data")
os.makedirs(out, exist_ok=True)
directory, blob = {}, bytearray()
for name, arr in arrays.items():
    blob += b"\0" * (-len(blob) % 8)  # typed-array views need aligned offsets
    directory[name] = {"dtype": arr.dtype.name, "offset": len(blob), "length": int(arr.size)}
    blob += arr.tobytes()
open(os.path.join(out, f"{county.lower()}.bin"), "wb").write(blob)
header = {"county": county, "nodes": g.N, "edges": int(len(g.w)), "faces": len(b.faces),
          "origin": origin.tolist(), "maxSnapM": 5000, "meshStride": 5,
          # the web map compares this with the server's /config to detect stale client data
          "edgesSha256": hashlib.sha256(open(edges_parquet, "rb").read()).hexdigest(),
          "arrays": directory}
json.dump(header, open(os.path.join(out, f"{county.lower()}.json"), "w"))
print(f"{county}: {len(blob) / 1e6:.1f} MB, mesh vertices {len(mesh)} (streets {n_street_v}), "
      f"triangles street {len(street_i) // 3} disk {len(disk_i) // 3} face {len(face_i) // 3}")

# ---- fixture for tests/test_client.mjs
d = os.path.join(ROOT, "work", fixture_dir)
fac = located_esri(d).to_pylist()[:n_fix]
crash = {c["CID"]: c for c in pq.read_table(os.path.join(d, "crashes.parquet"), columns=["CID", "x", "y"]).to_pylist()}
edge = np.array([g.eid_to_idx[f["SourceOID"]] for f in fac])
frac = np.array([f["PosAlong"] for f in fac])
dist = g.sssp(edge, frac, max(BREAKS))
r = g.reached(dist, edge, frac, BREAKS)
dist = dist.get()
cx = np.array([[crash[int(f["Name"])]["x"], crash[int(f["Name"])]["y"]] for f in fac])
own_edge, own_frac, _ = g.locate(cx[:, 0], cx[:, 1])
cm = merc(cx)
cases, polys = [], []
esri_lines = pq.read_table(os.path.join(d, "esri_lines.parquet"), columns=[
    "FacilityID", "SourceOID", "FromPosition", "ToPosition", "FromCumul_Minutes", "ToCumul_Minutes"]).to_pylist()
for i, f in enumerate(fac):
    case = {"cid": int(f["Name"]), "edge": int(edge[i]), "frac": float(frac[i]),
            "mx": float(cm[i, 0]), "my": float(cm[i, 1]),
            "ownEdge": int(own_edge[i]), "ownFrac": float(own_frac[i]),
            "dist": [None if not math.isfinite(v) else float(v) for v in dist[i]], "breaks": {}}
    for B in BREAKS:
        m = (r["fac"] == i) & (r["brk"] == B)
        ivs = [intervals(*v) for v in zip(r["a1"][m], r["b0"][m], r["s0"][m], r["s1"][m])]
        full, _, disk, faces = b.classify(r["edge"][m], ivs)
        case["breaks"][f"{B:g}"] = {"full": sorted(full), "disk": sorted(int(n) for n in disk), "faces": faces}
        pieces = sorted((int(e), float(lo), float(hi)) for e, iv in zip(r["edge"][m], ivs)
                        for lo, hi in iv if hi - lo > POS_EPS)
        polys.append({"cid": case["cid"], "minutes": B, "pieces": pieces,
                      "wkb": shapely.to_wkb(b.polygon(r["edge"][m], ivs), hex=True)})
    cases.append(case)
    case["esriLines"] = [[g.eid_to_idx[ln["SourceOID"]], ln["FromPosition"], ln["ToPosition"],
                          ln["FromCumul_Minutes"], ln["ToCumul_Minutes"]]
                         for ln in esri_lines if ln["FacilityID"] == f["OID"]]
json.dump(cases, open(os.path.join(out, "fixture.json"), "w"))
json.dump(polys, open(os.path.join(out, "fixture_poly.json"), "w"))
print(f"fixture: {len(cases)} crashes, {len(polys)} polygons")
