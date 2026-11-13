// Records docs/images/live_hover.gif: the live page (web/live.html) while the mouse moves along one street
// segment near West Union at 5 minutes. Needs the server + tunnel (README 11.4), Chrome and ffmpeg.
//   1. "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --enable-unsafe-webgpu \
//        --remote-debugging-port=9333 --user-data-dir=/tmp/sa-chrome about:blank
//   2. node docs/make_hover_gif.mjs /tmp/sa-frames
//   3. ffmpeg -y -framerate 5 -i /tmp/sa-frames/f%03d.png -vf "scale=640:-1:flags=lanczos,split[a][b];
//        [a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
//        -loop 0 docs/images/live_hover.gif
const dir = process.argv[2] ?? "/tmp/sa-frames";
const fs = await import("node:fs");
fs.mkdirSync(dir, { recursive: true });
const t = await (await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent("http://localhost:8765/live.html?v=" + Date.now()), { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const wait = new Map();
ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d.result); wait.delete(d.id); } });
const call = (method, params = {}) => new Promise((r) => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 120 && !(await ev("window.liveResult?.engine ?? null")); i++) await sleep(1000);
await ev(`document.querySelector('input[name=mode][value="hover"]').click(); document.querySelector('input[name=min][value="5"]').click(); 1`);
// pick a 1.5-3 km street segment near West Union and centre the map on it
const pts = await ev(`(async () => {
  const { ServiceArea } = await import("/client/sa.js");
  const sa = await ServiceArea.load("/data/adams");
  const R = 6378137, cx = -83.545 * Math.PI / 180 * R, cy = Math.asinh(Math.tan(38.795 * Math.PI / 180)) * R;
  let best = null;
  for (let e = 0; e < sa.E; e++) {
    const a = sa.vertOff[e], b = sa.vertOff[e + 1];
    let len = 0; for (let v = a; v < b - 1; v++) len += Math.hypot(sa.vertXY[2*v+2] - sa.vertXY[2*v], sa.vertXY[2*v+3] - sa.vertXY[2*v+1]);
    if (len < 1900 || len > 3800) continue;
    const m = Math.floor((a + b) / 2), d = Math.hypot(sa.vertXY[2*m] - cx, sa.vertXY[2*m+1] - cy);
    if (!best || d < best.d) best = { e, d, a, b, len };
  }
  const xy = []; for (let v = best.a; v < best.b; v++) xy.push([sa.vertXY[2*v], sa.vertXY[2*v+1]]);
  const view = document.querySelector("arcgis-map");
  const mid = xy[Math.floor(xy.length / 2)];
  await view.goTo({ center: { type: "point", x: mid[0], y: mid[1], spatialReference: { wkid: 3857 } }, zoom: 12 }, { animate: false });
  // 28 points evenly along the segment
  const seg = []; let tot = 0; for (let i = 1; i < xy.length; i++) { const l = Math.hypot(xy[i][0]-xy[i-1][0], xy[i][1]-xy[i-1][1]); seg.push(l); tot += l; }
  const out = [];
  for (let k = 0; k < 28; k++) {
    let s = tot * k / 27, i = 0; while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
    const f = seg[i] ? s / seg[i] : 0;
    const p = view.toScreen({ type: "point", x: xy[i][0] + f * (xy[i+1][0] - xy[i][0]), y: xy[i][1] + f * (xy[i+1][1] - xy[i][1]), spatialReference: { wkid: 3857 } });
    out.push([Math.round(p.x), Math.round(p.y)]);
  }
  return { edge: best.e, lenM: Math.round(best.len), out };
})()`);
console.log("edge", pts.edge, "length (mercator m)", pts.lenM);
await sleep(3000);
let n = 0;
for (const [x, y] of pts.out) {
  const before = await ev("window.liveResult.solves");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  for (let i = 0; i < 40 && (await ev("window.liveResult.solves")) === before; i++) await sleep(100);
  await sleep(350);
  fs.writeFileSync(`${dir}/f${String(n++).padStart(3, "0")}.png`, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
}
console.log("frames", n, JSON.stringify(await ev("window.liveResult")));
process.exit(0);
