// WebGL2 layer for the browser engine. The rasterizer does the polygon rules of cuda/polygons.py:
//   pass 1 draws every reached street piece, node disk and filled block into an offscreen mask (the union),
//   pass 1b finds the nearest street of each pixel with the depth buffer (depth = distance from the street)
//           shortcut: nearest street line here, nearest 50 ft piece midpoint in Builder and geom.js; a border
//           between two streets can differ by up to 25 ft (check.html gate, IoU >= 0.99). Draw the cells for equality.
//           and marks the pixel when that street is not reached there (Builder: nearest-street cells),
//   pass 2 composites the pixels that are in the union and whose nearest street is reached (fill + outline).
// The break cutoff is tested per pixel from the per-edge node costs, so no geometry is rebuilt per solve.
import { TEX_W } from "./sa.js";

const MASK_VS = `#version 300 es
layout(location = 0) in vec2 aPos;   // Web Mercator, relative to the data origin
layout(location = 1) in vec2 aAB;    // street: (position along edge, signed distance / trim) ; disk: unit-square uv
layout(location = 2) in float aIdx;  // edge, node or face index
uniform vec2 uOffset;                // data origin - view center
uniform vec2 uRot;                   // cos, sin of the view rotation
uniform vec2 uScale;                 // map units -> clip space
out vec2 vAB;
flat out int vIdx;
void main() {
  vec2 d = aPos + uOffset;
  vec2 r = vec2(d.x * uRot.x + d.y * uRot.y, -d.x * uRot.y + d.y * uRot.x);
  gl_Position = vec4(r * uScale, 0.0, 1.0);
  vAB = aAB;
  vIdx = int(aIdx + 0.5);
}`;

const MASK_FS = `#version 300 es
precision highp float;
precision highp int;
uniform int uKind;                   // 0 street, 1 node disk, 2 face
uniform int uNear;                   // 0: union pass. 1: nearest-street pass
uniform highp sampler2D uEdge;       // per edge: cost at start node, cost at end node, edge minutes, pieces
uniform highp sampler2D uNode;       // per node: disk flag
uniform highp sampler2D uFace;       // per face: fill flag
uniform float uB;                    // break (minutes)
uniform int uOwn;                    // edge that holds the start point
uniform float uFrac;                 // start position on that edge
in vec2 vAB;
flat in int vIdx;
out vec4 color;
ivec2 tc(int i) { return ivec2(i % ${TEX_W}, i / ${TEX_W}); }
float cost(vec4 t, float p) {        // minutes to position p of the edge with texel t
  float c = min(t.x + p * t.z, t.y + (1.0 - p) * t.z);
  return vIdx == uOwn ? min(c, abs(p - uFrac) * t.z) : c;
}
void main() {
  gl_FragDepth = gl_FragCoord.z;
  bool reached;
  if (uKind == 0) {
    vec4 t = texelFetch(uEdge, tc(vIdx), 0);
    float p = vAB.x;
    reached = cost(t, p) <= uB;      // interpolated p makes the cut perpendicular to the street: a flat cap
    if (uNear == 1) {
      // Builder: a street piece (edge / t.w) that is reached in part counts as reached. Cost is lowest at a
      // piece end, or zero at the start point when the piece holds it.
      float a = floor(min(p, 0.999999) * t.w) / t.w, b = a + 1.0 / t.w;
      // strictly below the break: a piece that only touches the reached interval at one end is not reached
      reached = min(cost(t, a), cost(t, b)) < uB || (vIdx == uOwn && uFrac >= a && uFrac <= b);
      gl_FragDepth = abs(vAB.y);
    }
  } else if (uKind == 1) {
    if (dot(vAB, vAB) > 1.0) discard;
    float f = texelFetch(uNode, tc(vIdx), 0).r;
    reached = uNear == 1 ? f > 0.2 : f > 0.5;  // nearest pass: any reached street end; union pass: disk nodes only
    if (uNear == 1) gl_FragDepth = length(vAB);
  } else {
    reached = texelFetch(uFace, tc(vIdx), 0).r > 0.5;
  }
  if (uNear == 0 && !reached) discard;
  color = vec4(reached ? 1.0 : 0.0);  // nearest pass: the nearest street wins the depth test and writes its state
}`;

const COMP_VS = `#version 300 es
void main() {  // one triangle that covers the viewport
  gl_Position = vec4(float((gl_VertexID << 1) & 2) * 2.0 - 1.0, float(gl_VertexID & 2) * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMP_FS = `#version 300 es
precision highp float;
uniform highp sampler2D uMask;
uniform ivec2 uOrigin;               // viewport origin in the target framebuffer
uniform vec4 uFill;
uniform vec4 uLine;
uniform int uWidth;                  // outline width in device pixels
out vec4 color;
float m(ivec2 q) {
  ivec2 s = textureSize(uMask, 0);
  if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) return 1.0;  // no outline along the screen border
  vec2 t = texelFetch(uMask, q, 0).rg;  // r: in the union. g: nearest street is reached (1 where no street is near)
  return min(t.r, t.g);
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) - uOrigin;
  if (m(q) < 0.5) discard;
  bool edge = m(q + ivec2(uWidth, 0)) < 0.5 || m(q - ivec2(uWidth, 0)) < 0.5
           || m(q + ivec2(0, uWidth)) < 0.5 || m(q - ivec2(0, uWidth)) < 0.5;
  vec4 c = edge ? uLine : uFill;
  color = vec4(c.rgb * c.a, c.a);    // premultiplied alpha
}`;

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

// Returns a layer bound to a ServiceArea engine. After sa.solve() + sa.flags(B), call layer.show(B);
// layer.clear() hides the area.
export function createServiceAreaLayer({ Layer, BaseLayerViewGL2D }, sa) {
  const View = BaseLayerViewGL2D.createSubclass({
    attach() {
      const gl = this.context;
      this.mask = program(gl, MASK_VS, MASK_FS);
      this.comp = program(gl, COMP_VS, COMP_FS);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, sa.mesh, gl.STATIC_DRAW);
      const stride = sa.header.meshStride * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
      // one index buffer: streets, then disks, then faces
      const idx = new Uint32Array(sa.streetIdx.length + sa.diskIdx.length + sa.faceIdx.length);
      idx.set(sa.streetIdx, 0); idx.set(sa.diskIdx, sa.streetIdx.length);
      idx.set(sa.faceIdx, sa.streetIdx.length + sa.diskIdx.length);
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.emptyVao = gl.createVertexArray();
      const tex = (internal, format, type, data) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, TEX_W, data.length / TEX_W / (format === gl.RGBA ? 4 : 1), 0, format, type, data);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
          [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        return { t, format, type, data };
      };
      this.tex = [tex(gl.RGBA32F, gl.RGBA, gl.FLOAT, sa.edgeTex), tex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, sa.nodeFlags),
        tex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, sa.faceFlags)];
      this.maskTex = gl.createTexture();
      this.fbo = gl.createFramebuffer();
      this.depth = gl.createRenderbuffer();
      this.maskSize = [0, 0];
      this.uploaded = -1;
      this.layer.views.add(this);
    },

    detach() {
      const gl = this.context;
      this.layer.views.delete(this);
      for (const { t } of this.tex) gl.deleteTexture(t);
      gl.deleteTexture(this.maskTex); gl.deleteFramebuffer(this.fbo); gl.deleteRenderbuffer(this.depth);
      gl.deleteBuffer(this.vbo); gl.deleteBuffer(this.ibo);
      gl.deleteVertexArray(this.vao); gl.deleteVertexArray(this.emptyVao);
      gl.deleteProgram(this.mask.p); gl.deleteProgram(this.comp.p);
    },

    render({ state }) {
      const layer = this.layer;
      if (layer.breakMinutes === null) return;
      const gl = this.context;
      const [vx, vy, vw, vh] = gl.getParameter(gl.VIEWPORT);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);  // the map may leave these set; rows must stay in index order
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (this.uploaded !== layer.version) {  // new solve: texture rows changed since the last upload, no geometry
        // sa marks the rows it changed. With more than one view each view uploads every row, because the
        // first view clears the marks.
        const all = layer.views.size > 1;
        [sa.dirty.edge, sa.dirty.node, sa.dirty.face].forEach((dirty, i) => {
          const { t, format, type, data } = this.tex[i];
          const perRow = TEX_W * (format === gl.RGBA ? 4 : 1);
          gl.bindTexture(gl.TEXTURE_2D, t);
          for (let r = 0; r < dirty.length; r++) {
            if (!all && !dirty[r]) continue;
            let end = r + 1;  // one upload per run of marked rows
            while (end < dirty.length && (all || dirty[end])) end++;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, end - r, format, type, data.subarray(r * perRow, end * perRow));
            r = end - 1;
          }
          dirty.fill(0);
        });
        this.uploaded = layer.version;
      }
      if (this.maskSize[0] !== vw || this.maskSize[1] !== vh) {
        gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, vw, vh, 0, gl.RG, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskTex, 0);
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, vw, vh);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
        this.maskSize = [vw, vh];
      }

      // pass 1: union by rasterization into the mask
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, vw, vh);
      for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE]) gl.disable(cap);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.clearColor(0, 1, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const { p, u } = this.mask;
      gl.useProgram(p);
      const [ox, oy] = sa.header.origin;
      const rot = (state.rotation * Math.PI) / 180;
      gl.uniform2f(u.uOffset, ox - state.center[0], oy - state.center[1]);
      gl.uniform2f(u.uRot, Math.cos(rot), Math.sin(rot));
      gl.uniform2f(u.uScale, 2 / (state.resolution * state.size[0]), 2 / (state.resolution * state.size[1]));
      gl.uniform1f(u.uB, layer.breakMinutes);
      gl.uniform1i(u.uOwn, sa.edge);
      gl.uniform1f(u.uFrac, sa.frac);
      this.tex.forEach(({ t }, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
      gl.uniform1i(u.uEdge, 0); gl.uniform1i(u.uNode, 1); gl.uniform1i(u.uFace, 2);
      gl.bindVertexArray(this.vao);
      const counts = [sa.streetIdx.length, sa.diskIdx.length, sa.faceIdx.length];
      const draw = (kinds) => {
        let first = 0;
        counts.forEach((count, kind) => {
          if (kinds.includes(kind)) { gl.uniform1i(u.uKind, kind); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4); }
          first += count;
        });
      };
      gl.uniform1i(u.uNear, 0);
      gl.colorMask(true, false, false, false);  // union into the red channel
      draw([0, 1, 2]);
      // pass 1b: every street and every node, reached or not; the nearest one decides the green channel
      gl.uniform1i(u.uNear, 1);
      gl.colorMask(false, true, false, false);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      draw([0, 1]);
      gl.disable(gl.DEPTH_TEST);
      gl.colorMask(true, true, true, true);

      // pass 2: composite the mask into the map frame
      this.bindRenderTarget();
      gl.useProgram(this.comp.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.uniform1i(this.comp.u.uMask, 0);
      gl.uniform2i(this.comp.u.uOrigin, vx, vy);
      gl.uniform4fv(this.comp.u.uFill, layer.fill);
      gl.uniform4fv(this.comp.u.uLine, layer.line);
      gl.uniform1i(this.comp.u.uWidth, Math.max(1, Math.round(1.5 * state.pixelRatio)));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.useProgram(null);
    },
  });

  const SaLayer = Layer.createSubclass({
    createLayerView(view) {
      if (view.type === "2d") return new View({ view, layer: this });
    },
  });
  const layer = new SaLayer({ title: "Service area (client)" });
  Object.assign(layer, {
    views: new Set(),
    version: 0,
    breakMinutes: null,                  // null: nothing to draw
    fill: [0, 110 / 255, 200 / 255, 0.25],
    line: [0, 80 / 255, 160 / 255, 0.9],
    show(B) { this.breakMinutes = B; this.version++; this.views.forEach((v) => v.requestRender()); },
    clear() { this.breakMinutes = null; this.views.forEach((v) => v.requestRender()); },
  });
  return layer;
}
