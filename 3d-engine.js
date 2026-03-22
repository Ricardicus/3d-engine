import * as THREE from "./three.module.js";
import { GLTFLoader } from "./GLTFLoader.js";

const canvas = document.getElementById("canvas");
const debugEl = document.getElementById("debug");
const gl = canvas.getContext("webgl");

if (!gl) {
  throw new Error("WebGL not supported");
}

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

gl.clearColor(1, 1, 1, 1);
gl.enable(gl.DEPTH_TEST);
gl.depthFunc(gl.LEQUAL);
gl.enable(gl.CULL_FACE);
gl.cullFace(gl.BACK);
gl.frontFace(gl.CCW);

/* =========================
   CAMERA
========================= */

let camera = {
  x: 0,
  y: 5,
  z: -2,
  yaw: 0,
  pitch: 0
};

const keys = {};
let gpuDrawables = [];
let groupRotationY = 0;

/* =========================
   LOADING STATE
========================= */

let isLoading = true;
let loadingText = "Loading...";

/* =========================
   SHADERS
========================= */

const vertexShaderSource = `
attribute vec3 aPosition;
attribute vec2 aUv;

uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;

varying vec2 vUv;

void main() {
  vUv = aUv;
  gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
}
`;

const fragmentShaderSource = `
precision mediump float;

uniform sampler2D uTexture;
uniform bool uUseTexture;
uniform vec4 uFallbackColor;

varying vec2 vUv;

void main() {
  if (uUseTexture) {
    gl_FragColor = texture2D(uTexture, vUv);
  } else {
    gl_FragColor = uFallbackColor;
  }
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
  uv: gl.getAttribLocation(program, "aUv")
};

const uniforms = {
  projection: gl.getUniformLocation(program, "uProjection"),
  view: gl.getUniformLocation(program, "uView"),
  model: gl.getUniformLocation(program, "uModel"),
  texture: gl.getUniformLocation(program, "uTexture"),
  useTexture: gl.getUniformLocation(program, "uUseTexture"),
  fallbackColor: gl.getUniformLocation(program, "uFallbackColor")
};

/* =========================
   MATH
========================= */

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

function dot(a, b) {
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
  keys[e.key.toLowerCase()] = true;

  if (
    ["arrowleft", "arrowright", "arrowup", "arrowdown", "w", "a", "s", "d", "q", "e"].includes(e.key.toLowerCase())
  ) {
    e.preventDefault();
  }
});

document.addEventListener("keyup", (e) => {
  keys[e.key.toLowerCase()] = false;
});

/* =========================
   CAMERA UPDATE
========================= */

function updateCamera(dt) {
  const turnSpeed = 1.8 * dt;
  const moveSpeed = 4.0 * dt;
  const verticalSpeed = 4.0 * dt;

  if (keys["arrowleft"]) camera.yaw -= turnSpeed;
  if (keys["arrowright"]) camera.yaw += turnSpeed;
  if (keys["arrowup"]) camera.pitch += turnSpeed;
  if (keys["arrowdown"]) camera.pitch -= turnSpeed;

  const pitchLimit = Math.PI / 2 - 0.01;
  if (camera.pitch > pitchLimit) camera.pitch = pitchLimit;
  if (camera.pitch < -pitchLimit) camera.pitch = -pitchLimit;

  const { forward, right } = getCameraBasis(camera);

  if (keys["w"]) {
    camera.x += forward.x * moveSpeed;
    camera.y += forward.y * moveSpeed;
    camera.z += forward.z * moveSpeed;
  }

  if (keys["s"]) {
    camera.x -= forward.x * moveSpeed;
    camera.y -= forward.y * moveSpeed;
    camera.z -= forward.z * moveSpeed;
  }

  if (keys["d"]) {
    camera.x += right.x * moveSpeed;
    camera.y += right.y * moveSpeed;
    camera.z += right.z * moveSpeed;
  }

  if (keys["a"]) {
    camera.x -= right.x * moveSpeed;
    camera.y -= right.y * moveSpeed;
    camera.z -= right.z * moveSpeed;
  }

  if (keys["q"]) camera.y += verticalSpeed;
  if (keys["e"]) camera.y -= verticalSpeed;
}

function updateDebug() {
  if (!debugEl) return;

  let text =
    `pos:   (${camera.x.toFixed(2)}, ${camera.y.toFixed(2)}, ${camera.z.toFixed(2)})\n` +
    `yaw:   ${camera.yaw.toFixed(2)}\n` +
    `pitch: ${camera.pitch.toFixed(2)}\n` +
    `meshes: ${gpuDrawables.length}\n` +
    `group rot y: ${groupRotationY.toFixed(2)}`;

  if (isLoading) {
    text += `\n${loadingText}`;
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

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

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

function createGpuDrawable(gl, mesh) {
  const built = buildGeometryForMesh(mesh);
  if (!built) return null;

  const hasUint32 = !!gl.getExtension("OES_element_index_uint");
  if (!hasUint32 && built.indices.length > 65535) {
    throw new Error(`Mesh "${mesh.name || "(unnamed)"}" is too large for 16-bit indices.`);
  }

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, built.positions, gl.STATIC_DRAW);

  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, built.uvs, gl.STATIC_DRAW);

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

  let indexType;
  let indexCount = built.indices.length;

  if (built.indices.length > 65535) {
    const arr = new Uint32Array(built.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    indexType = gl.UNSIGNED_INT;
  } else {
    const arr = new Uint16Array(built.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    indexType = gl.UNSIGNED_SHORT;
  }

  let texture = createFallbackTexture(gl);
  let hasTexture = false;

  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (material && material.map && material.map.image) {
    texture = createWebGLTextureFromImage(gl, material.map.image);
    hasTexture = true;
  }

  mesh.updateWorldMatrix(true, false);

  return {
    name: mesh.name || "(unnamed mesh)",
    positionBuffer,
    uvBuffer,
    indexBuffer,
    indexCount,
    indexType,
    texture,
    hasTexture,
    localModel: new Float32Array(mesh.matrixWorld.elements)
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
    sx += d.localModel[12];
    sy += d.localModel[13];
    sz += d.localModel[14];
    count += 1;
  }

  return {
    x: sx / count,
    y: sy / count,
    z: sz / count
  };
}

let groupCenter = { x: 0, y: 0, z: 0 };

function loadGLBToGpu(url, onLoaded) {
  const loader = new GLTFLoader();

  isLoading = true;
  loadingText = "Loading...";

  loader.load(
    url,
    (gltf) => {
      const drawables = [];

      gltf.scene.updateWorldMatrix(true, true);

      gltf.scene.traverse((child) => {
        if (child.isMesh) {
          const drawable = createGpuDrawable(gl, child);
          if (drawable) {
            drawables.push(drawable);
          }
        }
      });

      isLoading = false;
      loadingText = "Loaded";

      onLoaded(drawables);
    },
    (xhr) => {
      if (xhr.total) {
        const percent = ((xhr.loaded / xhr.total) * 100).toFixed(1);
        loadingText = `Loading... ${percent}%`;
      } else {
        loadingText = `Loading... ${Math.round(xhr.loaded / 1024)} KB`;
      }
    },
    (error) => {
      isLoading = false;
      loadingText = "Failed to load GLB";
      console.error("Failed to load GLB:", error);
    }
  );
}

/* =========================
   DRAW
========================= */

function drawDrawable(drawable, projection, view, groupModel) {
  const finalModel = multiplyMatrices(groupModel, drawable.localModel);

  gl.uniformMatrix4fv(uniforms.projection, false, projection);
  gl.uniformMatrix4fv(uniforms.view, false, view);
  gl.uniformMatrix4fv(uniforms.model, false, finalModel);
  gl.uniform1i(uniforms.useTexture, drawable.hasTexture ? 1 : 0);
  gl.uniform4f(uniforms.fallbackColor, 0.6, 1.0, 0.6, 1.0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, drawable.texture);
  gl.uniform1i(uniforms.texture, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, drawable.positionBuffer);
  gl.enableVertexAttribArray(attribs.position);
  gl.vertexAttribPointer(attribs.position, 3, gl.FLOAT, false, 0, 0);

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
  const projection = makePerspectiveMatrix(Math.PI / 3, aspect, 0.1, 1000);
  const view = makeLookAtViewMatrix(camera);
  const groupModel = makeGroupModelMatrix();

  gl.useProgram(program);

  for (const drawable of gpuDrawables) {
    drawDrawable(drawable, projection, view, groupModel);
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
  updateCamera(dt);

  if (!isLoading) {
    groupRotationY += dt * 0.05;
  }

  updateDebug();
  drawScene();

  requestAnimationFrame(loop);
}

loadGLBToGpu("./realistic_tree_min2.glb", (drawables) => {
  gpuDrawables = drawables;
  groupCenter = computeGroupCenter(drawables);

  console.log("Loaded drawables:", drawables.length);
  console.log("Group center:", groupCenter);

  for (const d of drawables) {
    console.log(`Mesh: ${d.name}, indices: ${d.indexCount}, hasTexture: ${d.hasTexture}`);
  }
});

requestAnimationFrame(loop);