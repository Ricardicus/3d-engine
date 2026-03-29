const canvas = document.getElementById("canvas");
const debugEl = document.getElementById("debug");
const gl = canvas.getContext("webgl");

if (!gl) {
  throw new Error("WebGL not supported");
}

gl.getExtension("OES_element_index_uint");

/* =========================
   CANVAS / GL
========================= */

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.floor(window.innerWidth * dpr);
  const height = Math.floor(window.innerHeight * dpr);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

gl.clearColor(0.15, 0.2, 0.3, 1);
gl.enable(gl.DEPTH_TEST);
gl.depthFunc(gl.LEQUAL);

/* =========================
   PLAYER / CAMERA
========================= */

let player = {
  position: { x: 317.70, y: 12.51, z: -2407.96 }, // feet position
  velocity: { x: 0, y: 0, z: 0 },

  yaw: 12.51,
  pitch: -0.2,

  radius: 16,
  height: 56,
  eyeHeight: 48,
  stepHeight: 18,

  grounded: false
};

let camera = {
  x: player.position.x,
  y: player.position.y + player.eyeHeight,
  z: player.position.z,
  yaw: player.yaw,
  pitch: player.pitch
};

const keys = {};
let gpuDrawables = [];
let collisionTriangles = [];
let collisionBVH = null;
let groupRotationY = 0;
let omega = 0.0;
let baseColor = [1.0, 0.0, 0.0];
let lightDir = [1.0, 1.5, 0.8];
let jumpRequested = false;

/* =========================
   MOUSE LOOK
========================= */

let pointerLocked = false;
const mouseSensitivity = 0.0025;

function requestPointerLock() {
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock?.();
  }
}

canvas.addEventListener("click", () => {
  requestPointerLock();
});

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
});

document.addEventListener("mousemove", (e) => {
  if (!pointerLocked) return;

  player.yaw -= e.movementX * mouseSensitivity;
  player.pitch -= e.movementY * mouseSensitivity;

  const pitchLimit = Math.PI / 2 - 0.01;
  if (player.pitch > pitchLimit) player.pitch = pitchLimit;
  if (player.pitch < -pitchLimit) player.pitch = -pitchLimit;
});

/* =========================
   LOADING STATE
========================= */

let isLoading = true;
let loadingText = "Loading...";
let loadingProgress = 0;
let wadLoadStatus = [];
let loadingStartTime = 0;
let loadingBytesLoaded = 0;
let loadingBytesTotal = 0;
let loadingCurrentFileLoaded = 0;
let loadingCurrentFileTotal = 0;

/* =========================
   SHADERS
========================= */

const vertexShaderSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;

uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;

varying vec3 vNormal;
varying vec2 vUv;

void main() {
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
}
`;

const fragmentShaderSource = `
precision mediump float;

varying vec3 vNormal;
varying vec2 vUv;

uniform vec3 uLightDir;
uniform vec3 uBaseColor;
uniform sampler2D uTexture;
uniform bool uUseTexture;

void main() {
  vec3 N = normalize(vNormal);
  vec3 L = normalize(uLightDir);
  float diffuse = max(dot(N, L), 0.0);
  float ambient = 0.35;
  float light = ambient + diffuse * 0.65;

  vec3 color;
  if (uUseTexture) {
    color = texture2D(uTexture, vUv).rgb * light;
  } else {
    color = uBaseColor * light;
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Shader compile error:\n" + info);
  }

  return shader;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error("Program link error:\n" + info);
  }

  return program;
}

const program = createProgram(gl, vertexShaderSource, fragmentShaderSource);
gl.useProgram(program);

const attribs = {
  position: gl.getAttribLocation(program, "aPosition"),
  normal: gl.getAttribLocation(program, "aNormal"),
  uv: gl.getAttribLocation(program, "aUv"),
};

const uniforms = {
  projection: gl.getUniformLocation(program, "uProjection"),
  view: gl.getUniformLocation(program, "uView"),
  model: gl.getUniformLocation(program, "uModel"),
  lightDir: gl.getUniformLocation(program, "uLightDir"),
  baseColor: gl.getUniformLocation(program, "uBaseColor"),
  texture: gl.getUniformLocation(program, "uTexture"),
  useTexture: gl.getUniformLocation(program, "uUseTexture"),
};

/* =========================
   MATH
========================= */

function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function length(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function normalizeVec(v) {
  const len = length(v);
  if (len < 1e-8) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function crossVec(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function dotVec(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function getCameraBasis(cam) {
  const forward = normalize({
    x: Math.sin(cam.yaw) * Math.cos(cam.pitch),
    y: Math.sin(cam.pitch),
    z: Math.cos(cam.yaw) * Math.cos(cam.pitch)
  });

  const worldUp = { x: 0, y: 1, z: 0 };
  const right = normalize(cross(forward, worldUp));
  const up = normalize(cross(right, forward));

  return { forward, right, up };
}

function getWalkBasis(yaw) {
  const forward = normalizeVec({
    x: Math.sin(yaw),
    y: 0,
    z: Math.cos(yaw)
  });

  const right = normalizeVec({
    x: forward.z,
    y: 0,
    z: -forward.x
  });

  return { forward, right };
}

function makePerspectiveMatrix(fovYRadians, aspect, near, far) {
  const f = 1.0 / Math.tan(fovYRadians / 2);
  const rangeInv = 1 / (near - far);

  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * rangeInv, -1,
    0, 0, near * far * 2 * rangeInv, 0
  ]);
}

function makeLookAtViewMatrix(cam) {
  const { forward, right, up } = getCameraBasis(cam);
  const eye = { x: cam.x, y: cam.y, z: cam.z };

  return new Float32Array([
    right.x, up.x, -forward.x, 0,
    right.y, up.y, -forward.y, 0,
    right.z, up.z, -forward.z, 0,
    -dot(right, eye), -dot(up, eye), dot(forward, eye), 1
  ]);
}

function makeIdentityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]);
}

function makeTranslationMatrix(tx, ty, tz) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1
  ]);
}

function makeRotationYMatrix(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  return new Float32Array([
     c, 0, -s, 0,
     0, 1,  0, 0,
     s, 0,  c, 0,
     0, 0,  0, 1
  ]);
}

function multiplyMatrices(a, b) {
  const out = new Float32Array(16);

  const a00 = a[0],  a01 = a[1],  a02 = a[2],  a03 = a[3];
  const a10 = a[4],  a11 = a[5],  a12 = a[6],  a13 = a[7];
  const a20 = a[8],  a21 = a[9],  a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = b[0],  b01 = b[1],  b02 = b[2],  b03 = b[3];
  const b10 = b[4],  b11 = b[5],  b12 = b[6],  b13 = b[7];
  const b20 = b[8],  b21 = b[9],  b22 = b[10], b23 = b[11];
  const b30 = b[12], b31 = b[13], b32 = b[14], b33 = b[15];

  out[0]  = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
  out[1]  = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
  out[2]  = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
  out[3]  = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;

  out[4]  = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
  out[5]  = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
  out[6]  = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
  out[7]  = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;

  out[8]  = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
  out[9]  = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
  out[10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
  out[11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;

  out[12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
  out[13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
  out[14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
  out[15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;

  return out;
}

/* =========================
   INPUT
========================= */

document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;

  if (k === " ") {
    jumpRequested = true;
  }

  if (
    ["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d", "q", "e", " "].includes(k)
  ) {
    e.preventDefault();
  }
});

document.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keys[k] = false;
});

/* =========================
   COLLISION
========================= */

function closestPointOnTriangle(p, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);

  const d1 = dotVec(ab, ap);
  const d2 = dotVec(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dotVec(ab, bp);
  const d4 = dotVec(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }

  const cp = sub(p, c);
  const d5 = dotVec(ab, cp);
  const d6 = dotVec(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const v = d2 / (d2 - d6);
    return add(a, scale(ac, v));
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const bc = sub(c, b);
    const v = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(b, scale(bc, v));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return add(a, add(scale(ab, v), scale(ac, w)));
}

function resolveSphereVsTriangles(center, radius, bvhNode) {
  let pos = { ...center };
  let grounded = false;
  const groundNormalThreshold = 0.55;

  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;

    const nearby = [];
    queryBVH(bvhNode, pos.x, pos.y, pos.z, radius + 1, nearby);
    for (const tri of nearby) {
      const q = closestPointOnTriangle(pos, tri.a, tri.b, tri.c);
      const delta = sub(pos, q);
      const dist = length(delta);

      if (dist < radius && dist > 1e-6) {
        const normal = scale(delta, 1 / dist);
        const push = scale(normal, radius - dist);
        pos = add(pos, push);
        pushed = true;

        if (normal.y > groundNormalThreshold) grounded = true;
      } else if (dist <= 1e-6) {
        const push = scale(tri.n, radius);
        pos = add(pos, push);
        pushed = true;

        if (tri.n.y > groundNormalThreshold) grounded = true;
      }
    }

    if (!pushed) break;
  }

  return { pos, grounded };
}

function projectVelocityAgainstWalls() {
  const sphereOffsets = [8, player.height * 0.5, player.height - 8];

  for (const offY of sphereOffsets) {
    const center = {
      x: player.position.x,
      y: player.position.y + offY,
      z: player.position.z
    };

    const nearby = [];
    queryBVH(collisionBVH, center.x, center.y, center.z, player.radius + 1, nearby);
    for (const tri of nearby) {
      const q = closestPointOnTriangle(center, tri.a, tri.b, tri.c);
      const delta = sub(center, q);
      const dist = length(delta);

      if (dist < player.radius + 0.5 && dist > 1e-6) {
        const n = scale(delta, 1 / dist);

        if (Math.abs(n.y) < 0.4) {
          const vn = dotVec(player.velocity, n);
          if (vn < 0) {
            player.velocity = sub(player.velocity, scale(n, vn));
          }
        }
      }
    }
  }
}

function probeGroundSnap(maxSnap = 6) {
  if (player.velocity.y > 0) return;

  const probeBase = {
    x: player.position.x,
    y: player.position.y - maxSnap,
    z: player.position.z
  };

  const lowSphereCenter = {
    x: probeBase.x,
    y: probeBase.y + 8,
    z: probeBase.z
  };

  const res = resolveSphereVsTriangles(lowSphereCenter, player.radius, collisionBVH);
  const correction = sub(res.pos, lowSphereCenter);

  if (res.grounded && correction.y > 0 && correction.y <= maxSnap + 0.5) {
    player.position = add(probeBase, correction);
    player.grounded = true;
    if (player.velocity.y < 0) player.velocity.y = 0;
  }
}

function tryStepMove(prevPos, desiredPos) {
  const stepUp = player.stepHeight;

  const lifted = {
    x: prevPos.x,
    y: prevPos.y + stepUp,
    z: prevPos.z
  };

  let steppedPos = {
    x: desiredPos.x,
    y: lifted.y,
    z: desiredPos.z
  };

  const sphereOffsets = [8, player.height * 0.5, player.height - 8];

  for (let iter = 0; iter < 3; iter++) {
    let corrected = false;

    for (const offY of sphereOffsets) {
      const center = {
        x: steppedPos.x,
        y: steppedPos.y + offY,
        z: steppedPos.z
      };

      const res = resolveSphereVsTriangles(center, player.radius, collisionBVH);
      const correction = sub(res.pos, center);

      if (length(correction) > 1e-5) {
        steppedPos = add(steppedPos, correction);
        corrected = true;
      }
    }

    if (!corrected) break;
  }

  steppedPos.y -= stepUp;
  const beforeSnapY = steppedPos.y;
  player.position = steppedPos;
  player.grounded = false;
  probeGroundSnap(stepUp + 2);

  const climbed = player.position.y - beforeSnapY;
  if (player.grounded && climbed >= -0.5 && climbed <= stepUp + 1.0) {
    return { success: true, pos: { ...player.position } };
  }

  player.position = { ...prevPos };
  player.grounded = false;
  return { success: false, pos: desiredPos };
}

function movePlayerWithCollisions(dt) {
  const prevPos = { ...player.position };

  let newPos = {
    x: player.position.x + player.velocity.x * dt,
    y: player.position.y + player.velocity.y * dt,
    z: player.position.z + player.velocity.z * dt
  };

  const sphereOffsets = [8, player.height * 0.5, player.height - 8];

  let finalPos = { ...newPos };
  let grounded = false;
  let hadHorizontalBlock = false;

  for (let iter = 0; iter < 4; iter++) {
    let correctedBase = { ...finalPos };
    let anyCorrection = false;

    for (const offY of sphereOffsets) {
      const sphereCenter = {
        x: correctedBase.x,
        y: correctedBase.y + offY,
        z: correctedBase.z
      };

      const res = resolveSphereVsTriangles(sphereCenter, player.radius, collisionBVH);
      const correction = sub(res.pos, sphereCenter);

      if (length(correction) > 1e-5) {
        correctedBase = add(correctedBase, correction);
        anyCorrection = true;

        if (Math.abs(correction.x) + Math.abs(correction.z) > 0.01) {
          hadHorizontalBlock = true;
        }
      }

      if (res.grounded && offY <= player.height * 0.5) {
        grounded = true;
      }
    }

    finalPos = correctedBase;
    if (!anyCorrection) break;
  }

  const horizontalMove = Math.hypot(newPos.x - prevPos.x, newPos.z - prevPos.z);
  const fallingTooFast = player.velocity.y < -120;
  if (hadHorizontalBlock && horizontalMove > 0.01 && !fallingTooFast) {
    const stepResult = tryStepMove(prevPos, newPos);
    if (stepResult.success) {
      finalPos = stepResult.pos;
      grounded = true;
    }
  }

  player.position = finalPos;
  player.grounded = grounded;

  if (player.grounded && player.velocity.y < 0) {
    player.velocity.y = 0;
  }

  if (!player.grounded) {
    probeGroundSnap(6);
  }

  projectVelocityAgainstWalls();
}

function buildCollisionTrianglesFromBspMesh(mesh) {
  const tris = [];
  const stride = mesh.stride;
  const verts = mesh.vertices;
  const indices = mesh.indices;

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i + 0] * stride;
    const ib = indices[i + 1] * stride;
    const ic = indices[i + 2] * stride;

    const a = {
      x: verts[ia + 0],
      y: verts[ia + 2],
      z: verts[ia + 1]
    };
    const b = {
      x: verts[ib + 0],
      y: verts[ib + 2],
      z: verts[ib + 1]
    };
    const c = {
      x: verts[ic + 0],
      y: verts[ic + 2],
      z: verts[ic + 1]
    };

    const ab = sub(b, a);
    const ac = sub(c, a);
    const n = normalizeVec(crossVec(ab, ac));

    if (length(n) < 1e-6) continue;

    tris.push({ a, b, c, n });
  }

  return tris;
}

/* =========================
   BVH (Bounding Volume Hierarchy)
========================= */

const BVH_MAX_LEAF = 8;

function triAABB(tri) {
  return {
    minX: Math.min(tri.a.x, tri.b.x, tri.c.x),
    minY: Math.min(tri.a.y, tri.b.y, tri.c.y),
    minZ: Math.min(tri.a.z, tri.b.z, tri.c.z),
    maxX: Math.max(tri.a.x, tri.b.x, tri.c.x),
    maxY: Math.max(tri.a.y, tri.b.y, tri.c.y),
    maxZ: Math.max(tri.a.z, tri.b.z, tri.c.z),
  };
}

function buildBVH(triangles) {
  if (triangles.length === 0) return null;

  // Compute AABB for all triangles
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const centers = new Float64Array(triangles.length * 3);
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const ax = Math.min(t.a.x, t.b.x, t.c.x), ay = Math.min(t.a.y, t.b.y, t.c.y), az = Math.min(t.a.z, t.b.z, t.c.z);
    const bx = Math.max(t.a.x, t.b.x, t.c.x), by = Math.max(t.a.y, t.b.y, t.c.y), bz = Math.max(t.a.z, t.b.z, t.c.z);
    if (ax < minX) minX = ax; if (ay < minY) minY = ay; if (az < minZ) minZ = az;
    if (bx > maxX) maxX = bx; if (by > maxY) maxY = by; if (bz > maxZ) maxZ = bz;
    centers[i * 3 + 0] = (ax + bx) * 0.5;
    centers[i * 3 + 1] = (ay + by) * 0.5;
    centers[i * 3 + 2] = (az + bz) * 0.5;
  }

  const node = { minX, minY, minZ, maxX, maxY, maxZ, left: null, right: null, tris: null };

  if (triangles.length <= BVH_MAX_LEAF) {
    node.tris = triangles;
    return node;
  }

  // Split along longest axis at median
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const axis = dx >= dy && dx >= dz ? 0 : (dy >= dz ? 1 : 2);

  // Sort indices by center along axis
  const indices = new Array(triangles.length);
  for (let i = 0; i < triangles.length; i++) indices[i] = i;
  indices.sort((a, b) => centers[a * 3 + axis] - centers[b * 3 + axis]);

  const mid = indices.length >> 1;
  const leftTris = new Array(mid);
  const rightTris = new Array(indices.length - mid);
  for (let i = 0; i < mid; i++) leftTris[i] = triangles[indices[i]];
  for (let i = mid; i < indices.length; i++) rightTris[i - mid] = triangles[indices[i]];

  node.left = buildBVH(leftTris);
  node.right = buildBVH(rightTris);
  return node;
}

function sphereIntersectsAABB(cx, cy, cz, r, node) {
  // Closest point on AABB to sphere center
  const qx = cx < node.minX ? node.minX : (cx > node.maxX ? node.maxX : cx);
  const qy = cy < node.minY ? node.minY : (cy > node.maxY ? node.maxY : cy);
  const qz = cz < node.minZ ? node.minZ : (cz > node.maxZ ? node.maxZ : cz);
  const dx = cx - qx, dy = cy - qy, dz = cz - qz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

function queryBVH(node, cx, cy, cz, radius, result) {
  if (!node) return;
  if (!sphereIntersectsAABB(cx, cy, cz, radius, node)) return;

  if (node.tris) {
    for (let i = 0; i < node.tris.length; i++) result.push(node.tris[i]);
    return;
  }

  queryBVH(node.left, cx, cy, cz, radius, result);
  queryBVH(node.right, cx, cy, cz, radius, result);
}

/* =========================
   PLAYER UPDATE
========================= */

function updatePlayer(dt) {
  const turnSpeed = 1.8 * dt;
  const moveSpeed = player.grounded ? 220.0 : 140.0;
  const accel = player.grounded ? 1800.0 : 700.0;
  const friction = player.grounded ? 10.0 : 1.5;
  const gravity = 800.0;
  const jumpSpeed = 260.0;

  if (keys["arrowleft"]) player.yaw += turnSpeed;
  if (keys["arrowright"]) player.yaw -= turnSpeed;
  if (keys["arrowup"]) player.pitch += turnSpeed;
  if (keys["arrowdown"]) player.pitch -= turnSpeed;

  const pitchLimit = Math.PI / 2 - 0.01;
  if (player.pitch > pitchLimit) player.pitch = pitchLimit;
  if (player.pitch < -pitchLimit) player.pitch = -pitchLimit;

  const { forward, right } = getWalkBasis(player.yaw);

  let wish = vec3(0, 0, 0);

  if (keys["w"]) wish = add(wish, forward);
  if (keys["s"]) wish = sub(wish, forward);
  if (keys["d"]) wish = sub(wish, right);
  if (keys["a"]) wish = add(wish, right);

  const wishLen = length(wish);
  if (wishLen > 0) {
    wish = scale(wish, 1 / wishLen);
  }

  const targetVX = wish.x * moveSpeed;
  const targetVZ = wish.z * moveSpeed;

  const dvx = targetVX - player.velocity.x;
  const dvz = targetVZ - player.velocity.z;

  const maxDelta = accel * dt;
  const deltaLen = Math.hypot(dvx, dvz);

  if (deltaLen > maxDelta && deltaLen > 0) {
    player.velocity.x += (dvx / deltaLen) * maxDelta;
    player.velocity.z += (dvz / deltaLen) * maxDelta;
  } else {
    player.velocity.x = targetVX;
    player.velocity.z = targetVZ;
  }

  if (wishLen === 0 && player.grounded) {
    const damp = Math.max(0, 1 - friction * dt);
    player.velocity.x *= damp;
    player.velocity.z *= damp;
  }

  if (jumpRequested && player.grounded) {
    player.velocity.y = jumpSpeed;
    player.grounded = false;
  }
  jumpRequested = false;

  player.velocity.y -= gravity * dt;

  movePlayerWithCollisions(dt);

  camera.x = player.position.x;
  camera.y = player.position.y + player.eyeHeight;
  camera.z = player.position.z;
  camera.yaw = player.yaw;
  camera.pitch = player.pitch;
}

function updateDebug() {
  if (!debugEl) return;

  let text =
    `pos:   (${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)})\n` +
    `vel:   (${player.velocity.x.toFixed(2)}, ${player.velocity.y.toFixed(2)}, ${player.velocity.z.toFixed(2)})\n` +
    `yaw:   ${player.yaw.toFixed(2)}\n` +
    `pitch: ${player.pitch.toFixed(2)}\n` +
    `grounded: ${player.grounded}\n` +
    `mouse: ${pointerLocked ? "locked" : "click canvas"}\n` +
    `meshes: ${gpuDrawables.length}\n` +
    `tris: ${collisionTriangles.length}\n` +
    `group rot y: ${groupRotationY.toFixed(2)}`;

  if (isLoading) {
    const barW = 20;
    const filled = Math.round(loadingProgress * barW);
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(barW - filled);
    const pct = (loadingProgress * 100).toFixed(0);
    text += `\n${loadingText}\n[${bar}] ${pct}%`;

    const elapsed = (performance.now() - loadingStartTime) / 1000;
    const fmtTime = (s) => {
      if (s < 0 || !isFinite(s)) return "--:--";
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };
    const fmtBytes = (b) => {
      if (b < 1024) return b + " B";
      if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
      return (b / (1024 * 1024)).toFixed(1) + " MB";
    };

    text += `\nelapsed: ${fmtTime(elapsed)}`;

    if (loadingBytesTotal > 0) {
      const speed = elapsed > 0 ? loadingBytesLoaded / elapsed : 0;
      const remaining = speed > 0 ? (loadingBytesTotal - loadingBytesLoaded) / speed : -1;
      text += `  \u2502  ${fmtBytes(loadingBytesLoaded)} / ${fmtBytes(loadingBytesTotal)}`;
      if (speed > 0) text += `  \u2502  ${fmtBytes(speed)}/s`;
      if (remaining >= 0) text += `  \u2502  ETA ${fmtTime(remaining)}`;
    }

    if (wadLoadStatus.length > 0) {
      text += "\n\nWAD files:";
      for (const ws of wadLoadStatus) {
        const icon = ws.status === "done" ? "\u2713" : ws.status === "failed" ? "\u2717" : ws.status === "loading" ? "\u23F3" : "\u00B7";
        let info = "";
        if (ws.status === "done") {
          info = ` (${ws.texCount} tex, ${fmtBytes(ws.loaded)})`;
        } else if (ws.status === "failed") {
          info = " (failed)";
        } else if (ws.status === "loading" && ws.total > 0) {
          const wPct = ((ws.loaded / ws.total) * 100).toFixed(0);
          const wFilled = Math.round((ws.loaded / ws.total) * 10);
          const wBar = "\u2588".repeat(wFilled) + "\u2591".repeat(10 - wFilled);
          info = ` [${wBar}] ${wPct}% (${fmtBytes(ws.loaded)}/${fmtBytes(ws.total)})`;
        } else if (ws.status === "loading") {
          info = ` (${fmtBytes(ws.loaded)}...)`;
        }
        text += `\n  ${icon} ${ws.name}${info}`;
      }
    }
  }

  debugEl.textContent = text;
}

/* =========================
   TEXTURES
========================= */

function createFallbackTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  const pixel = new Uint8Array([180, 220, 180, 255]);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel
  );

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
}

function createWebGLTextureFromImage(gl, image) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    image
  );

  const isPowerOf2 =
    (image.width & (image.width - 1)) === 0 &&
    (image.height & (image.height - 1)) === 0;

  if (isPowerOf2) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  return texture;
}

/* =========================
   GLB -> GPU DRAWABLES
========================= */

function buildGeometryForMesh(mesh) {
  const geometry = mesh.geometry;
  const positionAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;

  if (!positionAttr) return null;

  const positions = [];
  const uvs = [];

  for (let i = 0; i < positionAttr.count; i++) {
    positions.push(
      positionAttr.getX(i),
      positionAttr.getY(i),
      positionAttr.getZ(i)
    );

    if (uvAttr) {
      uvs.push(uvAttr.getX(i), uvAttr.getY(i));
    } else {
      uvs.push(0, 0);
    }
  }

  let indices;
  if (geometry.index) {
    indices = Array.from(geometry.index.array);
  } else {
    indices = [];
    for (let i = 0; i < positionAttr.count; i++) {
      indices.push(i);
    }
  }

  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices
  };
}

function buildGeometryForCube(pos, pointsPerSide, sideLength = 1.0) {
  const originX = pos.x;
  const originY = pos.y;
  const originZ = pos.z;
  const delta = sideLength / (pointsPerSide - 1);

  const positions = [];
  const indices = [];
  const normals = [];
  const uvs = [];

  function pushFaceNormal(nx, ny, nz, count) {
    for (let i = 0; i < count; i++) {
      normals.push(nx, ny, nz);
    }
  }

  function pushFaceUvs(count) {
    for (let i = 0; i < count; i++) {
      uvs.push(0, 0);
    }
  }

  {
    for (let xi = 0; xi < pointsPerSide; xi++) {
      for (let yi = 0; yi < pointsPerSide; yi++) {
        let x = originX + delta * xi;
        let y = originY + delta * yi;
        let z = originZ;
        positions.push(x, y, z);
      }
    }
    pushFaceNormal(0, 0, -1, pointsPerSide * pointsPerSide);
    pushFaceUvs(pointsPerSide * pointsPerSide);
    for (let xi = 0; xi < pointsPerSide - 1; xi++) {
      for (let yi = 0; yi < pointsPerSide - 1; yi++) {
        let i0 = yi + pointsPerSide * xi;
        let i1 = (yi + 1) + pointsPerSide * xi;
        let i2 = yi + pointsPerSide * (xi + 1);
        let i3 = (yi + 1) + pointsPerSide * (xi + 1);

        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }
  }

  {
    const len = positions.length / 3;
    for (let xi = 0; xi < pointsPerSide; xi++) {
      for (let yi = 0; yi < pointsPerSide; yi++) {
        let x = originX + delta * xi;
        let y = originY + delta * yi;
        let z = originZ + sideLength;
        positions.push(x, y, z);
      }
    }
    pushFaceNormal(0, 0, 1, pointsPerSide * pointsPerSide);
    pushFaceUvs(pointsPerSide * pointsPerSide);
    for (let xi = 0; xi < pointsPerSide - 1; xi++) {
      for (let yi = 0; yi < pointsPerSide - 1; yi++) {
        let i0 = len + yi + pointsPerSide * xi;
        let i1 = len + (yi + 1) + pointsPerSide * xi;
        let i2 = len + yi + pointsPerSide * (xi + 1);
        let i3 = len + (yi + 1) + pointsPerSide * (xi + 1);

        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
      }
    }
  }

  {
    const len = positions.length / 3;
    for (let xi = 0; xi < pointsPerSide; xi++) {
      for (let yi = 0; yi < pointsPerSide; yi++) {
        let x = originX + delta * xi;
        let y = originY;
        let z = originZ + delta * yi;
        positions.push(x, y, z);
      }
    }
    pushFaceNormal(0, -1, 0, pointsPerSide * pointsPerSide);
    pushFaceUvs(pointsPerSide * pointsPerSide);
    for (let xi = 0; xi < pointsPerSide - 1; xi++) {
      for (let yi = 0; yi < pointsPerSide - 1; yi++) {
        let i0 = len + yi + pointsPerSide * xi;
        let i1 = len + (yi + 1) + pointsPerSide * xi;
        let i2 = len + yi + pointsPerSide * (xi + 1);
        let i3 = len + (yi + 1) + pointsPerSide * (xi + 1);

        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
      }
    }
  }

  {
    const len = positions.length / 3;
    for (let xi = 0; xi < pointsPerSide; xi++) {
      for (let yi = 0; yi < pointsPerSide; yi++) {
        let x = originX + delta * xi;
        let y = originY + sideLength;
        let z = originZ + delta * yi;
        positions.push(x, y, z);
      }
    }
    pushFaceNormal(0, 1, 0, pointsPerSide * pointsPerSide);
    pushFaceUvs(pointsPerSide * pointsPerSide);
    for (let xi = 0; xi < pointsPerSide - 1; xi++) {
      for (let yi = 0; yi < pointsPerSide - 1; yi++) {
        let i0 = len + yi + pointsPerSide * xi;
        let i1 = len + (yi + 1) + pointsPerSide * xi;
        let i2 = len + yi + pointsPerSide * (xi + 1);
        let i3 = len + (yi + 1) + pointsPerSide * (xi + 1);

        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }
  }

  {
    const len = positions.length / 3;
    for (let xi = 0; xi < pointsPerSide; xi++) {
      for (let yi = 0; yi < pointsPerSide; yi++) {
        let x = originX;
        let y = originY + delta * xi;
        let z = originZ + delta * yi;
        positions.push(x, y, z);
      }
    }
    pushFaceNormal(-1, 0, 0, pointsPerSide * pointsPerSide);
    pushFaceUvs(pointsPerSide * pointsPerSide);
    for (let xi = 0; xi < pointsPerSide - 1; xi++) {
      for (let yi = 0; yi < pointsPerSide - 1; yi++) {
        let i0 = len + yi + pointsPerSide * xi;
        let i1 = len + (yi + 1) + pointsPerSide * xi;
        let i2 = len + yi + pointsPerSide * (xi + 1);
        let i3 = len + (yi + 1) + pointsPerSide * (xi + 1);

        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }
  }

  {
    const len = positions.length / 3;
    for (let xi = 0; xi < pointsPerSide; xi++) {
      for (let yi = 0; yi < pointsPerSide; yi++) {
        let x = originX + sideLength;
        let y = originY + delta * xi;
        let z = originZ + delta * yi;
        positions.push(x, y, z);
      }
    }
    pushFaceNormal(1, 0, 0, pointsPerSide * pointsPerSide);
    pushFaceUvs(pointsPerSide * pointsPerSide);
    for (let xi = 0; xi < pointsPerSide - 1; xi++) {
      for (let yi = 0; yi < pointsPerSide - 1; yi++) {
        let i0 = len + yi + pointsPerSide * xi;
        let i1 = len + (yi + 1) + pointsPerSide * xi;
        let i2 = len + yi + pointsPerSide * (xi + 1);
        let i3 = len + (yi + 1) + pointsPerSide * (xi + 1);

        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
  };
}

function createGpuDrawableCube(gl, pos, pointsPerSide, sideLength, tick = 0.0) {
  const cube = buildGeometryForCube(pos, pointsPerSide, sideLength);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW);

  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, cube.normals, gl.STATIC_DRAW);

  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, cube.uvs, gl.STATIC_DRAW);

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

  let indexType;
  let indexCount = cube.indices.length;

  if (indexCount > 65535) {
    const arr = new Uint32Array(cube.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    indexType = gl.UNSIGNED_INT;
  } else {
    const arr = new Uint16Array(cube.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    indexType = gl.UNSIGNED_SHORT;
  }

  let texture = createFallbackTexture(gl);
  let hasTexture = false;

  return {
    name: cube.name || "(unnamed mesh)",
    positionBuffer,
    indexBuffer,
    normalBuffer,
    uvBuffer,
    indexCount,
    indexType,
    texture,
    hasTexture,
    tick
  };
}

function computeGroupCenter(drawables) {
  if (drawables.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }

  let sx = 0;
  let sy = 0;
  let sz = 0;
  let count = 0;

  for (const d of drawables) {
    if (!d.localModel) continue;
    sx += d.localModel[12];
    sy += d.localModel[13];
    sz += d.localModel[14];
    count += 1;
  }

  if (count === 0) return { x: 0, y: 0, z: 0 };

  return {
    x: sx / count,
    y: sy / count,
    z: sz / count
  };
}

let groupCenter = { x: 0, y: 0, z: 0 };

/* =========================
   DRAW
========================= */

function drawDrawable(drawable, projection, view) {
  const model = makeIdentityMatrix();

  gl.uniformMatrix4fv(uniforms.projection, false, projection);
  gl.uniformMatrix4fv(uniforms.view, false, view);
  gl.uniformMatrix4fv(uniforms.model, false, model);

  gl.uniform3fv(uniforms.lightDir, new Float32Array(lightDir));
  gl.uniform3fv(uniforms.baseColor, new Float32Array(drawable.color || baseColor));

  gl.uniform1i(uniforms.useTexture, drawable.hasTexture ? 1 : 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, drawable.texture);
  gl.uniform1i(uniforms.texture, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, drawable.positionBuffer);
  gl.enableVertexAttribArray(attribs.position);
  gl.vertexAttribPointer(attribs.position, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, drawable.normalBuffer);
  gl.enableVertexAttribArray(attribs.normal);
  gl.vertexAttribPointer(attribs.normal, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, drawable.uvBuffer);
  gl.enableVertexAttribArray(attribs.uv);
  gl.vertexAttribPointer(attribs.uv, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, drawable.indexBuffer);
  gl.drawElements(gl.TRIANGLES, drawable.indexCount, drawable.indexType, 0);
}

function makeGroupModelMatrix() {
  const toOrigin = makeTranslationMatrix(-groupCenter.x, -groupCenter.y, -groupCenter.z);
  const rotation = makeRotationYMatrix(groupRotationY);
  const back = makeTranslationMatrix(groupCenter.x, groupCenter.y, groupCenter.z);

  return multiplyMatrices(back, multiplyMatrices(rotation, toOrigin));
}

function drawScene() {
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (gpuDrawables.length === 0) {
    return;
  }

  const aspect = canvas.width / canvas.height;
  const projection = makePerspectiveMatrix(Math.PI / 3, aspect, 1, 50000);
  const view = makeLookAtViewMatrix(camera);
  gl.useProgram(program);

  for (const drawable of gpuDrawables) {
    drawDrawable(drawable, projection, view);
  }
}

/* =========================
   LOOP
========================= */

let lastTime = 0;

function loop(timeMs) {
  const dt = Math.min(0.05, (timeMs - lastTime) / 1000 || 0);
  lastTime = timeMs;

  resizeCanvas();
  updatePlayer(dt);

  omega += (dt * 2.5) % (4 * Math.PI);

  updateDebug();
  drawScene();

  requestAnimationFrame(loop);
}

/* =========================
   PROCEDURAL TEXTURE GENERATOR
========================= */

function generateProceduralTexture(name, width, height) {
  const w = Math.min(width || 64, 128);
  const h = Math.min(height || 64, 128);
  const rgba = new Uint8Array(w * h * 4);
  const lowerName = name.toLowerCase();

  let seed = 0;
  for (let i = 0; i < name.length; i++) seed = ((seed << 5) - seed + name.charCodeAt(i)) | 0;
  function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

  let r0, g0, b0;
  if (lowerName.includes("sand")) {
    r0 = 180 + rand() * 30; g0 = 155 + rand() * 25; b0 = 100 + rand() * 20;
  } else if (lowerName.includes("crt") || lowerName.includes("crete")) {
    r0 = 140 + rand() * 20; g0 = 135 + rand() * 20; b0 = 125 + rand() * 20;
  } else if (lowerName.includes("road")) {
    r0 = 150 + rand() * 15; g0 = 140 + rand() * 15; b0 = 110 + rand() * 15;
  } else if (lowerName.includes("door") || lowerName.includes("wndw")) {
    r0 = 120 + rand() * 30; g0 = 95 + rand() * 25; b0 = 65 + rand() * 20;
  } else if (lowerName.includes("trim")) {
    r0 = 160 + rand() * 20; g0 = 150 + rand() * 20; b0 = 120 + rand() * 15;
  } else if (lowerName.includes("wall")) {
    r0 = 175 + rand() * 20; g0 = 160 + rand() * 20; b0 = 120 + rand() * 15;
  } else if (lowerName.includes("lgt") || lowerName.includes("light")) {
    r0 = 240; g0 = 230; b0 = 180;
  } else if (lowerName.includes("generic")) {
    r0 = 130 + rand() * 20; g0 = 130 + rand() * 20; b0 = 130 + rand() * 20;
  } else if (lowerName.includes("mltry") || lowerName.includes("crate")) {
    r0 = 110 + rand() * 20; g0 = 105 + rand() * 20; b0 = 80 + rand() * 15;
  } else {
    r0 = 150 + rand() * 50; g0 = 140 + rand() * 50; b0 = 120 + rand() * 40;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const noise = (rand() - 0.5) * 30;
      const grid = ((x % 32 === 0) || (y % 32 === 0)) ? -15 : 0;
      const i = (y * w + x) * 4;
      rgba[i + 0] = Math.max(0, Math.min(255, r0 + noise + grid));
      rgba[i + 1] = Math.max(0, Math.min(255, g0 + noise + grid));
      rgba[i + 2] = Math.max(0, Math.min(255, b0 + noise + grid));
      rgba[i + 3] = 255;
    }
  }
  return { rgba, width: w, height: h };
}

/* =========================
   BSP MAP LOADING
========================= */

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  const r = ((h & 0xFF) / 255) * 0.5 + 0.35;
  const g = (((h >> 8) & 0xFF) / 255) * 0.5 + 0.35;
  const b = (((h >> 16) & 0xFF) / 255) * 0.5 + 0.35;
  return [r, g, b];
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function createWebGLTextureFromRGBA(gl, rgba, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);

  const isPow2 = (width & (width - 1)) === 0 && (height & (height - 1)) === 0;

  if (isPow2) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  } else {
    const potW = nextPow2(width);
    const potH = nextPow2(height);
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = width;
    srcCanvas.height = height;
    const srcCtx = srcCanvas.getContext("2d");
    const imgData = srcCtx.createImageData(width, height);
    imgData.data.set(rgba);
    srcCtx.putImageData(imgData, 0, 0);

    const potCanvas = document.createElement("canvas");
    potCanvas.width = potW;
    potCanvas.height = potH;
    const potCtx = potCanvas.getContext("2d");
    potCtx.drawImage(srcCanvas, 0, 0, potW, potH);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, potCanvas);
  }

  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  return tex;
}

function createGpuDrawableFromBspMesh(gl, mesh, textureToRGBA, wadTextures) {
  const vertCount = mesh.vertices.length / mesh.stride;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  for (let i = 0; i < vertCount; i++) {
    const off = i * mesh.stride;
    positions[i * 3 + 0] = mesh.vertices[off + 0];
    positions[i * 3 + 1] = mesh.vertices[off + 2];
    positions[i * 3 + 2] = mesh.vertices[off + 1];

    normals[i * 3 + 0] = mesh.vertices[off + 3];
    normals[i * 3 + 1] = mesh.vertices[off + 5];
    normals[i * 3 + 2] = mesh.vertices[off + 4];

    uvs[i * 2 + 0] = mesh.vertices[off + 6];
    uvs[i * 2 + 1] = mesh.vertices[off + 7];
  }

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

  let indexType;
  if (vertCount > 65535) {
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    indexType = gl.UNSIGNED_INT;
  } else {
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices), gl.STATIC_DRAW);
    indexType = gl.UNSIGNED_SHORT;
  }

  let glTexture = null;
  let hasTexture = false;

  let rgba = textureToRGBA(mesh.texture);
  let texW = mesh.texture.width;
  let texH = mesh.texture.height;

  if (!rgba && wadTextures) {
    const wadTex = wadTextures.get(mesh.texture.name.toLowerCase());
    if (wadTex) {
      rgba = textureToRGBA(wadTex);
      texW = wadTex.width;
      texH = wadTex.height;
      console.log("Found:", mesh.texture.name);
    } else {
      console.log("Failed to find:", mesh.texture.name);
    }
  }

  if (!rgba) {
    const proc = generateProceduralTexture(mesh.texture.name, mesh.texture.width, mesh.texture.height);
    rgba = proc.rgba;
    texW = proc.width;
    texH = proc.height;
  }

  if (rgba) {
    glTexture = createWebGLTextureFromRGBA(gl, rgba, texW, texH);
    hasTexture = true;
  } else {
    glTexture = createFallbackTexture(gl);
  }

  return {
    name: mesh.texture.name,
    positionBuffer,
    normalBuffer,
    uvBuffer,
    indexBuffer,
    indexCount: mesh.indices.length,
    indexType,
    texture: glTexture,
    hasTexture,
    color: hashColor(mesh.texture.name),
    tick: 0,
  };
}

async function loadBspMap(url, wadUrls) {
  isLoading = true;
  loadingProgress = 0;
  loadingText = "Preparing...";
  loadingStartTime = performance.now();
  loadingBytesLoaded = 0;
  loadingBytesTotal = 0;
  loadingCurrentFileLoaded = 0;
  loadingCurrentFileTotal = 0;
  gpuDrawables = [];
  collisionTriangles = [];
  collisionBVH = null;

  const allUrls = [url, ...(wadUrls || [])];
  const totalSteps = 1 + (wadUrls ? wadUrls.length : 0) + 1;
  let step = 0;

  loadingText = "Checking file sizes...";
  const sizes = await Promise.all(allUrls.map(async (u) => {
    try {
      const head = await fetch(u, { method: "HEAD" });
      if (!head.ok) return 0;
      return parseInt(head.headers.get("content-length") || "0", 10);
    } catch {
      return 0;
    }
  }));
  loadingBytesTotal = sizes.reduce((a, b) => a + b, 0);

  loadingText = "Loading BSP...";
  let bspBytesBase = 0;
  const bsp = await GoldSrcBsp.load(url, ({ loaded, total }) => {
    loadingCurrentFileLoaded = loaded;
    loadingCurrentFileTotal = total;
    loadingBytesLoaded = bspBytesBase + loaded;
  });
  bspBytesBase = sizes[0] || loadingCurrentFileLoaded;
  loadingBytesLoaded = bspBytesBase;
  step++;
  loadingProgress = step / totalSteps;

  const wadTextures = new Map();
  wadLoadStatus = [];
  let wadBytesBase = bspBytesBase;
  if (wadUrls && wadUrls.length) {
    for (let wi = 0; wi < wadUrls.length; wi++) {
      const wadUrl = wadUrls[wi];
      const wadName = wadUrl.split("/").pop();
      wadLoadStatus.push({ name: wadName, status: "pending", texCount: 0, loaded: 0, total: sizes[1 + wi] || 0 });
    }

    for (let wi = 0; wi < wadUrls.length; wi++) {
      const wadUrl = wadUrls[wi];
      wadLoadStatus[wi].status = "loading";
      loadingText = "Loading WAD " + (wi + 1) + "/" + wadUrls.length + ": " + wadLoadStatus[wi].name;
      const wBase = wadBytesBase;
      try {
        const wad = await GoldSrcBsp.loadWad(wadUrl, ({ loaded, total }) => {
          wadLoadStatus[wi].loaded = loaded;
          if (total > 0) wadLoadStatus[wi].total = total;
          loadingBytesLoaded = wBase + loaded;
        });
        for (const [k, v] of wad) wadTextures.set(k, v);
        wadLoadStatus[wi].status = "done";
        wadLoadStatus[wi].texCount = wad.size;
        console.log(`Loaded WAD ${wadUrl}: ${wad.size} textures`);
      } catch (e) {
        wadLoadStatus[wi].status = "failed";
        console.warn("Failed to load WAD:", wadUrl, e.message);
      }
      wadBytesBase += wadLoadStatus[wi].loaded || (sizes[1 + wi] || 0);
      loadingBytesLoaded = wadBytesBase;
      step++;
      loadingProgress = step / totalSteps;
    }
  }

  loadingText = "Building meshes...";

  const renderSkipNames = new Set(["sky", "clip", "aaatrigger", "origin", "null"]);
  const collisionSkipNames = new Set(["sky", "aaatrigger", "origin", "null"]);

  const renderMeshList = bsp.meshes.filter(m => {
    const n = m.texture.name.toLowerCase();
    return !renderSkipNames.has(n) && !n.startsWith("sky");
  });

  const collisionMeshList = bsp.meshes.filter(m => {
    const n = m.texture.name.toLowerCase();
    if (collisionSkipNames.has(n)) return false;
    if (n.startsWith("sky")) return false;
    return true;
  });

  for (let mi = 0; mi < renderMeshList.length; mi++) {
    gpuDrawables.push(createGpuDrawableFromBspMesh(gl, renderMeshList[mi], bsp.textureToRGBA, wadTextures));
    loadingProgress = step / totalSteps + ((mi + 1) / Math.max(renderMeshList.length, 1)) * (0.5 / totalSteps);
    loadingText = "Building render meshes... " + (mi + 1) + "/" + renderMeshList.length;
  }

  for (let mi = 0; mi < collisionMeshList.length; mi++) {
    collisionTriangles.push(...buildCollisionTrianglesFromBspMesh(collisionMeshList[mi]));
    loadingProgress = step / totalSteps + 0.5 / totalSteps + ((mi + 1) / Math.max(collisionMeshList.length, 1)) * (0.4 / totalSteps);
    loadingText = "Building collision mesh... " + (mi + 1) + "/" + collisionMeshList.length;
  }

  loadingText = "Building BVH...";
  collisionBVH = buildBVH(collisionTriangles);
  loadingProgress = step / totalSteps + 0.9 / totalSteps;

  player.position.x = 317.70;
  player.position.y = 12.51;
  player.position.z = -2407.96;
  player.velocity.x = 0;
  player.velocity.y = 0;
  player.velocity.z = 0;
  player.yaw = 12.51;
  player.pitch = -0.2;
  player.grounded = false;

  camera.x = player.position.x;
  camera.y = player.position.y + player.eyeHeight;
  camera.z = player.position.z;
  camera.yaw = player.yaw;
  camera.pitch = player.pitch;

  probeGroundSnap(64);

  loadingProgress = 1;
  isLoading = false;
  console.log(`Loaded ${gpuDrawables.length} render meshes from BSP`);
  console.log(`Built ${collisionTriangles.length} collision triangles`);
}

async function start(bspUrl) {
  const baseName = bspUrl.replace(/\.bsp$/i, "");
  const allWads = [
    "cs_dust.wad"
  ].map(w => "examples/" + w);

  const matchingWad = baseName + ".wad";
  const wadUrls = allWads.includes(matchingWad) ? [matchingWad, ...allWads.filter(w => w !== matchingWad)] : allWads;

  await loadBspMap(bspUrl, wadUrls);
}

start("examples/de_dust2.bsp");
requestAnimationFrame(loop);