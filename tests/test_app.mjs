// Exercise URL initialization without loading the map SDK.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const startup = source.slice(source.indexOf("const params = new URLSearchParams"));
for (const selected of ["server", "client", "both"]) {
  let loads = 0;
  const area = {};
  await runInNewContext(`(async () => { ${startup} })()`, {
    URLSearchParams, location: { search: `?engine=${selected}` },
    CSS: { escape: (s) => s }, document: { querySelector: () => ({ checked: false }) },
    engine: () => selected, loadClient: async () => { loads++; },
    area, FILLED: "filled", OUTLINE: "outline",
  });
  assert.equal(loads, selected === "server" ? 0 : 1);
  assert.equal(area.symbol, selected === "both" ? "outline" : "filled");
}
console.log("OK engine deep links without a starting location");
