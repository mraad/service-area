// WebGPU spike: the CUDA kernel of cuda/engine.py (worklist Bellman-Ford, one workgroup per source) in WGSL.
// Plain fp32: WGSL has no f64 and no 64-bit atomics. Non-negative f32 values order like their u32 bits,
// so atomicMin on the bits keeps the minimum cost, as atomicMin on double bits does in CUDA.
// Results come back through the CPU (mapAsync): the map SDK draws with WebGL2, which cannot read WebGPU buffers.

const WG = 256;
const WGSL = /* wgsl */ `
struct Params { N: u32, S: u32, cutoff: f32, pad: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> rowptr: array<u32>;
@group(0) @binding(2) var<storage, read> col: array<u32>;
@group(0) @binding(3) var<storage, read> w: array<f32>;
@group(0) @binding(4) var<storage, read> seedNode: array<u32>;   // u, v per source
@group(0) @binding(5) var<storage, read> seedCost: array<f32>;   // cu, cv per source
@group(0) @binding(6) var<storage, read_write> dist: array<atomic<u32>>;  // S * N, f32 bits
@group(0) @binding(7) var<storage, read_write> queue: array<u32>;         // S * 2N: current and next lists
@group(0) @binding(8) var<storage, read_write> inq: array<atomic<u32>>;   // S * N
var<workgroup> ncur: u32;
var<workgroup> nnext: atomic<u32>;
const INF: u32 = 0x7f800000u;

@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let s = wg.x;
  let N = p.N;
  let off = s * N;
  for (var i = li; i < N; i += ${WG}u) { atomicStore(&dist[off + i], INF); atomicStore(&inq[off + i], 0u); }
  storageBarrier(); workgroupBarrier();
  var cur = s * 2u * N;
  var nxt = cur + N;
  if (li == 0u) {
    let u = seedNode[2u * s]; let v = seedNode[2u * s + 1u];
    let cu = seedCost[2u * s]; let cv = seedCost[2u * s + 1u];
    var n = 0u;
    if (cu <= p.cutoff) { atomicStore(&dist[off + u], bitcast<u32>(cu)); queue[cur + n] = u; n++; }
    if (cv <= p.cutoff) {
      if (v == u) {
        if (bitcast<u32>(cv) < atomicLoad(&dist[off + u])) { atomicStore(&dist[off + u], bitcast<u32>(cv)); }
        if (n == 0u) { queue[cur + n] = u; n++; }
      } else { atomicStore(&dist[off + v], bitcast<u32>(cv)); queue[cur + n] = v; n++; }
    }
    ncur = n;
    atomicStore(&nnext, 0u);
  }
  storageBarrier(); workgroupBarrier();
  loop {
    let n = workgroupUniformLoad(&ncur);
    if (n == 0u) { break; }
    for (var k = li; k < n; k += ${WG}u) {
      let i = queue[cur + k];
      let di = bitcast<f32>(atomicLoad(&dist[off + i]));
      for (var a = rowptr[i]; a < rowptr[i + 1u]; a++) {
        let nd = di + w[a];
        if (nd > p.cutoff) { continue; }
        let j = col[a];
        let nb = bitcast<u32>(nd);
        if (atomicMin(&dist[off + j], nb) > nb) {
          if (atomicExchange(&inq[off + j], 1u) == 0u) { queue[nxt + atomicAdd(&nnext, 1u)] = j; }
        }
      }
    }
    storageBarrier(); workgroupBarrier();
    let m = atomicLoad(&nnext);
    for (var k = li; k < m; k += ${WG}u) { atomicStore(&inq[off + queue[nxt + k]], 0u); }
    storageBarrier(); workgroupBarrier();
    if (li == 0u) { ncur = m; atomicStore(&nnext, 0u); }
    let t = cur; cur = nxt; nxt = t;
    storageBarrier(); workgroupBarrier();
  }
}`;

export class GpuSssp {
  static async create(sa, maxSources) {
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("no WebGPU adapter");
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize, maxStorageBuffersPerShaderStage: 8 },
    });
    return new GpuSssp(device, sa, maxSources, adapter.info ?? {});
  }

  constructor(device, sa, maxSources, info) {
    this.device = device; this.N = sa.N; this.maxS = maxSources; this.info = info;
    const buf = (data, usage) => {
      const b = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage, mappedAtCreation: true });
      new data.constructor(b.getMappedRange(0, data.byteLength)).set(data);
      b.unmap();
      return b;
    };
    const S = GPUBufferUsage.STORAGE, C = GPUBufferUsage.COPY_SRC, D = GPUBufferUsage.COPY_DST;
    this.rowptr = buf(new Uint32Array(sa.rowptr), S);
    this.col = buf(new Uint32Array(sa.col), S);
    this.w = buf(new Float32Array(sa.warc), S);  // fp32 arc minutes: the precision loss starts here
    this.seedNode = device.createBuffer({ size: 8 * maxSources, usage: S | D });
    this.seedCost = device.createBuffer({ size: 8 * maxSources, usage: S | D });
    const nS = 4 * sa.N * maxSources;
    this.dist = device.createBuffer({ size: nS, usage: S | C });
    this.queue = device.createBuffer({ size: 2 * nS, usage: S });
    this.inq = device.createBuffer({ size: nS, usage: S });
    this.read = device.createBuffer({ size: nS, usage: GPUBufferUsage.MAP_READ | D });
    this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | D });
    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    this.bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [this.params, this.rowptr, this.col, this.w, this.seedNode, this.seedCost, this.dist, this.queue, this.inq]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  // seeds: [{u, v, cu, cv}] (one per source). Returns Float32Array(S * N) of node costs, Infinity beyond cutoff.
  async run(seeds, cutoff) {
    const { device, N } = this, S = seeds.length;
    if (S > this.maxS) throw new Error(`at most ${this.maxS} sources`);
    const node = new Uint32Array(2 * S), cost = new Float32Array(2 * S);
    seeds.forEach((s, i) => { node[2 * i] = s.u; node[2 * i + 1] = s.v; cost[2 * i] = s.cu; cost[2 * i + 1] = s.cv; });
    device.queue.writeBuffer(this.seedNode, 0, node);
    device.queue.writeBuffer(this.seedCost, 0, cost);
    const params = new ArrayBuffer(16);
    new Uint32Array(params, 0, 2).set([N, S]);
    new Float32Array(params, 8, 1)[0] = cutoff;
    device.queue.writeBuffer(this.params, 0, params);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.dispatchWorkgroups(S);
    pass.end();
    enc.copyBufferToBuffer(this.dist, 0, this.read, 0, 4 * N * S);
    device.queue.submit([enc.finish()]);
    await this.read.mapAsync(GPUMapMode.READ, 0, 4 * N * S);
    const out = new Float32Array(this.read.getMappedRange(0, 4 * N * S).slice(0));
    this.read.unmap();
    return out;
  }
}
