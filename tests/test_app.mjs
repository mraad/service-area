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

// An aborted request may finish after its replacement has already started.
const server = source.slice(source.indexOf("async function solveServer"), source.indexOf("let rafPoint"));
const requests = [], state = { area: {}, hudText: {} };
const context = {
  ...state, AbortController, performance,
  minutes: () => 5, showHud: () => {}, toPolygon: (g) => g,
  fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
};
const api = runInNewContext(`
  let inFlight = null, pending = null;
  ${server}
  ({ solveServer, cancel() { inFlight?.abort(); inFlight = null; pending = null; } })
`, context);
const point = (x) => ({ longitude: x, latitude: 38 });
const response = (geometry) => ({ ok: true, json: async () => ({ geometry, properties: { solve_ms: 1 } }) });
for (const stale of ["success", "abort", "error"]) {
  requests.length = 0;
  state.area.geometry = null;
  state.hudText.server = "";
  const old = api.solveServer(point(1));
  api.cancel();
  const current = api.solveServer(point(2));
  await api.solveServer(point(3)); // queued behind the current request
  if (stale === "success") requests[0].resolve(response("stale"));
  else requests[0].reject(Object.assign(new Error("old request"), { name: stale === "abort" ? "AbortError" : "Error" }));
  await old;
  assert.equal(state.area.geometry, null, `${stale}: old response cannot draw`);
  assert.equal(state.hudText.server, "", `${stale}: old error cannot replace current status`);
  assert.equal(requests.length, 2, `${stale}: old completion cannot drain the new queue`);
  requests[1].resolve(response("current"));
  await current;
  assert.equal(state.area.geometry, "current");
  assert.equal(requests.length, 3, "current completion starts the newest pending request");
  requests[2].resolve(response("newest"));
  await new Promise(setImmediate);
  assert.equal(state.area.geometry, "newest");
}
console.log("OK superseded server requests preserve the current response and queue");
