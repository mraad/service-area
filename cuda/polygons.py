"""Shared service-area polygon builder (used for both the CUDA and the ArcGIS reached lines).

Rule, calibrated against ArcGIS NA "High" polygons (results/parity_*.md reports the residual):
- each reached line piece is buffered by the trim distance with FLAT caps (Esri cuts flat at cutoff tips);
- a round disk of the trim radius is added at reached nodes whose incident edges are all fully
  reached (junction interiors), and at reached dead ends;
- a network face (block) is filled when every edge on its boundary and inside it is fully reached;
- the union of the above is cut to the ground whose nearest street is reached there. A buffer along a
  freeway otherwise covers the unreached streets beside it; ArcGIS does not include that ground;
- the result is the polygon.
"""
import numpy as np
import shapely
from shapely.ops import substring

TRIM_FT = 100.0 / 0.3048006096012192  # 100 m in US survey feet (EPSG:3735)
POS_EPS = 1e-9  # positions this close are equal: float noise must not create slivers or flip "full edge"
TERR_FT = 50.0  # streets are cut into pieces of at most this length for the nearest-street cells
MIN_HOLE_FT2 = 1e-6  # union leaves zero-area holes (~1e-20 ft2) where flat caps nearly touch; real holes are >10 ft2


class Builder:
    def __init__(self, graph, trim_ft=TRIM_FT):
        self.g, self.trim = graph, trim_ft
        g = graph
        _, first = np.unique(shapely.to_wkb(shapely.normalize(g.geom)), return_index=True)
        self.faces = shapely.get_parts(shapely.polygonize(g.geom[np.sort(first)]))
        # A freeway or ramp crossing a street with no node (an overpass) can make polygonize return a
        # self-intersecting ring; union_all then fails. Only those faces are repaired: valid faces stay as they are.
        bad = ~shapely.is_valid(self.faces)
        self.faces[bad] = shapely.make_valid(self.faces[bad])
        self.face_edges = [
            np.union1d(g.tree.query(shapely.buffer(f.boundary, 0.05), predicate="contains"),
                       g.tree.query(shapely.buffer(f, -0.05), predicate="intersects"))
            for f in self.faces]
        self.faces_of_edge = [[] for _ in range(len(g.w))]
        for i, fe in enumerate(self.face_edges):
            for e in fe:
                self.faces_of_edge[e].append(i)
        self.deg = np.bincount(np.concatenate([g.eu, g.ev]), minlength=g.N)
        self.inc = [[] for _ in range(g.N)]
        for e, (u, v) in enumerate(zip(g.eu, g.ev)):
            self.inc[u].append(e)
            self.inc[v].append(e)
        xy = np.empty((g.N, 2))
        xy[g.eu] = shapely.get_coordinates(shapely.get_point(g.geom, 0))
        xy[g.ev] = shapely.get_coordinates(shapely.get_point(g.geom, -1))
        self.node_xy = xy
        # Buffers of whole edges and node disks never change: made once, not per polygon.
        self.edge_buf = shapely.buffer(g.geom, trim_ft, cap_style="flat")
        self.disk_buf = shapely.buffer(shapely.points(xy), trim_ft)
        # Territory: the ground nearer to one street piece than to any other piece. Edge e has piece_n[e]
        # equal pieces; piece k is cells[piece_cell[piece_off[e] + k]], the Voronoi cell of its midpoint.
        # shortcut: cells are point-Voronoi cells of piece midpoints, so a border between two streets is off by
        # up to TERR_FT / 2; use a segment Voronoi if borders must be exact.
        self.piece_n = np.maximum(1, np.ceil(shapely.length(g.geom) / TERR_FT)).astype(np.int64)
        self.piece_off = np.concatenate([[0], np.cumsum(self.piece_n)])
        e = np.repeat(np.arange(len(g.w)), self.piece_n)
        k = np.arange(self.piece_off[-1]) - self.piece_off[e]
        mid = shapely.get_coordinates(shapely.line_interpolate_point(g.geom[e], (k + 0.5) / self.piece_n[e], normalized=True))
        # 0.001 ft: unrounded midpoints gave one Voronoi cell with a float-noise spike (Franklin), which breaks the coverage
        mid, self.piece_cell = np.unique(np.round(mid, 3), axis=0, return_inverse=True)  # pieces at one point share a cell
        self.cell_xy = mid  # the browser (web/client/geom.js) makes the same cells from these points
        self.piece_cell = self.piece_cell.ravel()
        box = shapely.buffer(shapely.box(*mid.min(axis=0), *mid.max(axis=0)), 4 * trim_ft)
        self.cells = shapely.get_parts(shapely.voronoi_polygons(shapely.multipoints(mid), extend_to=box, ordered=True))

    def classify(self, edges, ivs):
        """Parts of one polygon: (full edge set, reached pieces, disk nodes, filled face indices).

        A reached piece is (edge, line); line is None when the piece is the full edge.
        edges: edge indices; ivs: merged [[lo, hi], ...] per edge (normalized positions).
        The WebGL client (web/client/sa.js) applies the same rules; tests/test_client.mjs compares.
        """
        g = self.g
        full, segs, nodes = set(), [], set()
        for e, iv in zip(edges, ivs):
            geom = g.geom[e]
            for lo, hi in iv:
                if hi - lo <= POS_EPS:
                    continue
                if lo <= POS_EPS and hi >= 1.0 - POS_EPS:
                    full.add(int(e))
                    segs.append((int(e), None))
                else:
                    segs.append((int(e), substring(geom, lo, hi, normalized=True)))
                if lo <= POS_EPS:
                    nodes.add(int(g.eu[e]))
                if hi >= 1.0 - POS_EPS:
                    nodes.add(int(g.ev[e]))
        disk = [n for n in nodes if self.deg[n] == 1 or all(e in full for e in self.inc[n])]
        cand = {i for e in full for i in self.faces_of_edge[e]}  # only blocks touching a full edge
        faces = [i for i in sorted(cand) if all(int(e) in full for e in self.face_edges[i])]
        return full, segs, disk, faces

    def polygon(self, edges, ivs, pool=None):
        """pool: optional ThreadPoolExecutor. The union then runs in parallel on spatial groups of the parts.
        The result is the same set; vertices differ from the serial union by float noise (< 1e-4 ft measured).
        """
        full, segs, disk, faces = self.classify(edges, ivs)
        if not segs:
            return shapely.Polygon()
        parts = [self.edge_buf[e] if s is None else shapely.buffer(s, self.trim, cap_style="flat") for e, s in segs]
        parts += list(self.disk_buf[disk]) if disk else []
        parts += [self.faces[i] for i in faces]
        if pool is not None and len(parts) >= 64:  # small unions are faster serial
            parts = np.array(parts, dtype=object)
            c = shapely.get_coordinates(shapely.centroid(parts)).sum(axis=1)  # neighbours stay together
            parts = list(pool.map(shapely.union_all, np.array_split(parts[np.argsort(c, kind="stable")], pool._max_workers)))
        # Keep only the ground whose nearest street piece is reached.
        # shortcut: a piece that is reached in part counts as reached, so up to TERR_FT of ground past a break
        # position stays where another reached street covers it. Cutting the cell there made thin slits that
        # moved with float noise in the positions; cut only with a rule that is stable against that noise.
        cells = set()
        for e, iv in zip(edges, ivs):
            n, off = self.piece_n[e], self.piece_off[e]
            for lo, hi in iv:
                if hi - lo > POS_EPS:
                    cells.update(self.piece_cell[off + int(lo * n):off + min(n, int(np.ceil(hi * n)))].tolist())
        territory = shapely.coverage_union_all(self.cells[sorted(cells)])
        return _drop_micro_holes(shapely.intersection(shapely.union_all(parts), territory))


def _drop_micro_holes(geom):
    polys = []
    for p in shapely.get_parts(geom):
        if p.geom_type != "Polygon" or p.is_empty:  # an intersection can leave points or lines where parts only touch
            continue
        holes = [r for r in p.interiors if shapely.area(shapely.Polygon(r)) >= MIN_HOLE_FT2]
        polys.append(shapely.Polygon(p.exterior, holes))
    return polys[0] if len(polys) == 1 else shapely.MultiPolygon(polys) if polys else shapely.Polygon()
