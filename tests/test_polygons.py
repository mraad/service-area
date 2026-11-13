"""Builder.polygon rules on small synthetic networks: nearest-street cut, plain buffer, block fill."""
import os
import sys
import tempfile
import unittest

import numpy as np
import shapely

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cuda"))
import engine  # noqa: E402
from polygons import TERR_FT, TRIM_FT, Builder  # noqa: E402
from test_engine import write  # noqa: E402


def builder(lines):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "edges.parquet")
        write(lines, np.ones(len(lines)), path)
        return Builder(engine.Graph(path))


def edge(b, a, c):
    """Index of the edge from point a to point c."""
    return next(i for i, g in enumerate(b.g.geom) if g.equals(shapely.LineString([a, c])))


class PolygonRules(unittest.TestCase):
    def test_unreached_parallel_street_cuts_the_buffer(self):
        # two streets 150 ft apart, joined far to the right; only the lower one is reached
        b = builder([shapely.LineString([(0, 0), (2000, 0)]), shapely.LineString([(0, 150), (2000, 150)]),
                     shapely.LineString([(2000, 0), (2000, 150)])])
        p = b.polygon([edge(b, (0, 0), (2000, 0))], [[[0.0, 0.5]]])
        ys = shapely.get_coordinates(p)[:, 1]
        self.assertAlmostEqual(ys.max(), 75.0, delta=1.0)     # stops at the midline, not at the trim distance
        self.assertAlmostEqual(ys.min(), -TRIM_FT, delta=1e-6)  # the free side keeps the full trim distance
        self.assertTrue(p.is_valid)

    def test_street_alone_is_the_plain_buffer(self):
        line = shapely.LineString([(0, 0), (2000, 0)])
        b = builder([line])
        p = b.polygon([0], [[[0.2, 0.6]]])
        want = shapely.buffer(shapely.LineString([(400, 0), (1200, 0)]), TRIM_FT, cap_style="flat")
        self.assertLess(shapely.symmetric_difference(p, want).area, 1e-6 * want.area)

    def test_reached_block_is_filled(self):
        s = 1000.0  # block larger than twice the trim distance: its middle is beyond every buffer
        ring = [(0, 0), (s, 0), (s, s), (0, s), (0, 0)]
        b = builder([shapely.LineString([ring[i], ring[i + 1]]) for i in range(4)])
        p = b.polygon([0, 1, 2, 3], [[[0.0, 1.0]]] * 4)
        self.assertTrue(p.contains(shapely.Point(s / 2, s / 2)))
        self.assertEqual(len(p.interiors), 0)

    def test_pieces_are_at_most_terr_ft(self):
        b = builder([shapely.LineString([(0, 0), (2000, 0)])])
        self.assertEqual(b.piece_n[0], int(np.ceil(2000 / TERR_FT)))


if __name__ == "__main__":
    unittest.main()
