// Planner selection against a plain set-based reference; no county fixtures or GPU needed.
import assert from "node:assert/strict";
import { greedy } from "../web/client/planner.js";

function reference(costs, S, B, k) {
  const covered = new Set(), picked = [], gains = [];
  for (let step = 0; step < k; step++) {
    let best = -1, gain = 0;
    for (let s = 0; s < S; s++) {
      let n = 0;
      for (let i = 0; i < S; i++) if (costs[s * S + i] <= B && !covered.has(i)) n++;
      if (n > gain) { best = s; gain = n; }
    }
    if (best < 0) break;
    picked.push(best); gains.push(gain);
    for (let i = 0; i < S; i++) if (costs[best * S + i] <= B) covered.add(i);
  }
  return { picked, gains };
}

let seed = 7;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
let cases = 0;
for (const S of [0, 1, 2, 31, 32, 33, 65, 100]) {
  for (const density of [0, 0.1, 0.5, 1]) {
    const costs = Float32Array.from({ length: S * S }, () => random() < density ? Math.floor(random() * 11) : Infinity);
    for (const B of [0, 1, 5, 10]) for (const k of [0, 1, 5, S + 1]) {
      assert.deepEqual(greedy(costs, S, B, k), reference(costs, S, B, k), `S=${S}, density=${density}, B=${B}, k=${k}`);
      cases++;
    }
  }
}
assert.deepEqual(greedy(new Float32Array(33 * 33), 33, 0, 10), { picked: [0], gains: [33] }, "ties pick the lowest index");
console.log(`OK greedy: ${cases} reference comparisons, word boundaries, ties and empty coverage`);
