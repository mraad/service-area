"""The parity gate must pass on matching lines and count a deliberate mismatch."""
import os
import sys
import tempfile
import unittest

import pyarrow as pa
import pyarrow.parquet as pq
import shapely

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "cuda"))
sys.path.insert(0, os.path.join(HERE, "parity"))
import batch  # noqa: E402
import compare  # noqa: E402


def write_case(root, to_pos):
    """One 1000 ft, 1-minute edge; a crash at its middle; Esri lines with the given far end."""
    d = os.path.join(root, "work", "T")
    os.makedirs(d, exist_ok=True)
    line = shapely.LineString([(0, 0), (1000, 0)])
    pq.write_table(pa.table({"EID": [1], "MTFCC": ["S1400"], "Minutes": [1.0], "length_ft": [1000.0],
                             "wkb": [shapely.to_wkb(line)]}), os.path.join(d, "edges.parquet"))
    pq.write_table(pa.table({"OID": [1], "Name": ["1"], "SourceOID": [1], "PosAlong": [0.5], "Status": [0]}),
                   os.path.join(d, "esri_facilities.parquet"))
    pq.write_table(pa.table({"FacilityID": [1, 1], "SourceOID": [1, 1], "FromPosition": [0.5, 0.5],
                             "ToPosition": [0.0, to_pos], "FromCumul_Minutes": [0.0, 0.0],
                             "ToCumul_Minutes": [0.5, abs(to_pos - 0.5)]}),
                   os.path.join(d, "esri_lines.parquet"))


def run(root):
    batch.ROOT = compare.ROOT = root
    sys.argv = ["batch", "T", "--locations", "esri", "--no-polygons"]
    batch.main()
    sys.argv = ["compare", "T", "--locations", "esri", "--lines-only"]
    status = compare.main()
    with open(os.path.join(root, "results", "parity_t_esri.md")) as f:
        report = f.read()
    assert status == (0 if "**FAIL**" not in report else 1)
    return report


class CompareTest(unittest.TestCase):
    def test_missing_polygons_and_stale_lines_fail(self):
        with tempfile.TemporaryDirectory() as root:
            write_case(root, 1.0)
            run(root)
            sys.argv = ["compare", "T", "--locations", "esri"]
            self.assertEqual(compare.main(), 1)
            sys.argv.append("--lines-only")
            path = os.path.join(root, "work", "T", "cuda_reached_esri.parquet")
            with open(path, "ab") as f:
                f.write(b"changed")
            self.assertEqual(compare.main(), 1)

    def test_match_passes(self):
        with tempfile.TemporaryDirectory() as root:
            write_case(root, 1.0)
            rpt = run(root)
            self.assertIn("Reached-interval mismatches (> 1e-06): **0**", rpt)
            self.assertIn("Gate: **PASS**", rpt)

    def test_mismatch_is_counted(self):
        with tempfile.TemporaryDirectory() as root:
            write_case(root, 0.9)  # Esri stops at 0.9; CUDA reaches the whole edge at every break
            rpt = run(root)
            self.assertIn("Reached-interval mismatches (> 1e-06): **3**", rpt)
            self.assertIn("Gate: **FAIL**", rpt)


if __name__ == "__main__":
    unittest.main()
