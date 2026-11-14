"""Plot crash 1800 before and after the cutoff split. Run on the GPU host.

usage: .venv/bin/python docs/make_cutoff_figures.py
The defaults refer to the preserved 14 November 2026 experiment artifacts.
"""
from pathlib import Path
import argparse
import hashlib
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import numpy as np
import pyarrow.parquet as pq
import shapely

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'cuda'))
sys.path.insert(0, str(ROOT / 'parity'))
from engine import Graph
from polygons import Builder
from compare import COST_TOL, merge, _metrics


def load(sample):
    d = ROOT / 'work' / sample
    g = Graph(d / 'edges.parquet')
    fac = next(r['OID'] for r in pq.read_table(d / 'esri_facilities.parquet').to_pylist() if r['Name'] == '1800')
    reached = {}
    for r in pq.read_table(d / 'esri_lines.parquet').to_pylist():
        if r['FacilityID'] == fac and r['ToCumul_Minutes'] <= 5 + COST_TOL:
            reached.setdefault(r['SourceOID'], []).append(sorted([r['FromPosition'], r['ToPosition']]))
    shared = Builder(g).polygon([g.eid_to_idx[e] for e in reached], [merge(iv) for iv in reached.values()])
    cuda = next(shapely.from_wkb(r['wkb']) for r in pq.read_table(d / 'cuda_polygons_esri.parquet').to_pylist()
                if r['CID'] == 1800 and r['ToBreak'] == 5)
    return d, g, shared, cuda, _metrics((shared, cuda))


def outline(ax, geometry, color, width=1.4):
    for p in shapely.get_parts(geometry):
        if p.geom_type != 'Polygon' or p.is_empty:
            continue
        for ring in [p.exterior, *p.interiors]:
            xy = np.asarray(ring.coords)
            ax.plot(xy[:, 0], xy[:, 1], color=color, lw=width)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', default='Adams_repair_20261114T120055Z')
    parser.add_argument('--split', default='Adams_split_20261114T121005Z_s100')
    args = parser.parse_args()
    before, after = load(args.baseline), load(args.split)
    assert before[4][0] < .99 and after[4][0] >= .99 and after[4][1] <= 50, 'Unexpected experiment results'
    assert hashlib.sha256((before[0] / 'esri_polygons.parquet').read_bytes()).digest() == hashlib.sha256((after[0] / 'esri_polygons.parquet').read_bytes()).digest(), 'Native polygon files changed'
    edge = before[1].geom[before[1].eid_to_idx[3249]]
    region = shapely.union_all([shapely.symmetric_difference(before[2], before[3]), edge])
    x0, y0, x1, y1 = region.bounds
    pad = 450
    blue, orange, ink = '#2a78d6', '#eb6834', '#252525'
    plt.rcParams.update({'font.size': 10, 'figure.facecolor': 'white', 'axes.facecolor': 'white'})
    fig, axes = plt.subplots(1, 2, figsize=(10, 5.2))
    for ax, case, title in zip(axes, [before, after], ['Original network: mismatch', 'Cutoff split: agreement']):
        _, g, shared, cuda, (iou, haus) = case
        box = shapely.box(x0 - pad, y0 - pad, x1 + pad, y1 + pad)
        for street in g.geom[shapely.intersects(g.geom, box)]:
            xy = shapely.get_coordinates(street)
            ax.plot(xy[:, 0], xy[:, 1], color='#d1d1ce', lw=.65)
        for p in shapely.get_parts(cuda):
            if p.geom_type == 'Polygon':
                ax.fill(*p.exterior.xy, color=blue, alpha=.12, lw=0)
                for h in p.interiors:
                    ax.fill(*h.xy, color='white', lw=0)
        outline(ax, cuda, blue, 2.1)
        outline(ax, shared, orange, 1.2)
        xy = shapely.get_coordinates(edge)
        ax.plot(xy[:, 0], xy[:, 1], color=ink, lw=2, label='affected street')
        ax.set(xlim=(x0-pad, x1+pad), ylim=(y0-pad, y1+pad), aspect='equal')
        ax.set_title(f'{title}\nIoU {iou:.6f}; Hausdorff {haus:.2f} ft', loc='left', fontsize=11)
        ax.set_xticks([])
        ax.set_yticks([])
        for spine in ax.spines.values():
            spine.set_visible(False)
    # A shared scale and a scale bar keep the two maps comparable.
    bx, by = x0 - pad + 150, y0 - pad + 150
    axes[0].plot([bx, bx + 1000], [by, by], color=ink, lw=2)
    axes[0].text(bx, by + 90, '1,000 US survey feet', fontsize=9)
    fig.legend(handles=[Line2D([], [], color=blue, lw=2, label='CUDA polygon'),
                        Line2D([], [], color=orange, lw=1.5, label='Builder on ArcGIS lines'),
                        Line2D([], [], color=ink, lw=2, label='Affected street')],
               loc='lower center', ncol=3, frameon=False)
    fig.suptitle('Crash 1800, 5 minutes: same Builder, same map extent', fontsize=12)
    fig.tight_layout(rect=(0, .07, 1, .94))
    out = ROOT / 'docs' / 'images' / 'cutoff_polygons.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(out)
    print('Before:', before[4], 'After:', after[4])


if __name__ == '__main__':
    main()
