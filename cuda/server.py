"""Live CUDA service-area server (also serves web/).

usage: python cuda/server.py Adams [--port 8765]
GET /sa?lon=&lat=&minutes=1..10  -> GeoJSON Feature (WGS84), header X-Solve-ms
GET /crashes                     -> GeoJSON FeatureCollection of crash points (WGS84)
GET /config                      -> {portalUrl, clientId, edgesSha256}; first two from ARCGIS_PORTAL_URL / ARCGIS_CLIENT_ID
                                    (public OAuth client id, used by the page to sign in for the dark basemap)
"""
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow.parquet as pq
import shapely
import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pyproj import Transformer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine import MAX_SNAP_FT, Graph, intervals  # noqa: E402
from polygons import Builder  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COUNTY = sys.argv[1] if len(sys.argv) > 1 else "Adams"

d = os.path.join(ROOT, "work", COUNTY)
EDGES_SHA256 = hashlib.sha256(open(os.path.join(d, "edges.parquet"), "rb").read()).hexdigest()
g = Graph(os.path.join(d, "edges.parquet"))
builder = Builder(g)
union_pool = ThreadPoolExecutor(8)  # GEOS releases the GIL: the polygon union runs on 8 threads
to_sp = Transformer.from_crs(4326, 3735, always_xy=True)
to_ll = Transformer.from_crs(3735, 4326, always_xy=True)
g.sssp([0], [0.0], 1.0)  # compile + warm the kernel before the first request


def ll(geom):
    """To WGS84 with Esri ring order (exterior clockwise, holes counter-clockwise)."""
    geom = shapely.transform(geom, lambda c: np.column_stack(to_ll.transform(c[:, 0], c[:, 1])))
    return shapely.orient_polygons(geom, exterior_cw=True)


app = FastAPI()


@app.get("/sa")
def sa(lon: float = Query(ge=-180, le=180, allow_inf_nan=False),
       lat: float = Query(ge=-90, le=90, allow_inf_nan=False),
       minutes: float = Query(5.0, gt=0, le=10, allow_inf_nan=False)):
    t0 = time.perf_counter()
    x, y = to_sp.transform(lon, lat)
    edge, frac, snap = g.locate([x], [y])
    snap = float(snap[0])
    props = {"minutes": minutes, "snap_ft": round(snap, 1)}
    if snap > MAX_SNAP_FT:
        geom = shapely.Polygon()
    else:
        r = g.reached(g.sssp(edge, frac, minutes), edge, frac, [minutes])
        geom = builder.polygon(r["edge"], [intervals(*v) for v in zip(r["a1"], r["b0"], r["s0"], r["s1"])],
                               pool=union_pool)
    ms = (time.perf_counter() - t0) * 1000
    props["solve_ms"] = round(ms, 2)
    body = '{"type":"Feature","properties":%s,"geometry":%s}' % (json.dumps(props), shapely.to_geojson(ll(geom)))
    return Response(body, media_type="application/json", headers={"X-Solve-ms": f"{ms:.2f}"})


@app.get("/config")
def config():
    return {"portalUrl": os.environ.get("ARCGIS_PORTAL_URL"), "clientId": os.environ.get("ARCGIS_CLIENT_ID"),
            "edgesSha256": EDGES_SHA256}


CRASHES = None


@app.get("/crashes")
def crashes():
    global CRASHES
    if CRASHES is None:
        t = pq.read_table(os.path.join(d, "crashes.parquet"), columns=["CID", "x", "y"])
        lon, lat = to_ll.transform(t["x"].to_numpy(), t["y"].to_numpy())
        CRASHES = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"CID": int(c)},
             "geometry": {"type": "Point", "coordinates": [round(a, 6), round(b, 6)]}}
            for c, a, b in zip(t["CID"].to_pylist(), lon, lat)]}
    return CRASHES


app.mount("/", StaticFiles(directory=os.path.join(ROOT, "web"), html=True), name="web")

if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8765
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
