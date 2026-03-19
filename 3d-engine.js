import * as THREE from "./three.module.js";
import { GLTFLoader } from "./GLTFLoader.js";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const WIDTH = 1000;
const HEIGHT = 700;
canvas.width = WIDTH;
canvas.height = HEIGHT;

const GRID_WIDTH = 5;
const GRID_HEIGHT = 5;
const FOCAL = 300;

let camera = {
  x: 3.55,
  y: 5,
  z: -4,
  yaw: -0.60,
  pitch: 0
};

const keys = {};
let mesh = setupXYGrid(GRID_WIDTH, GRID_HEIGHT, 1);
let sampleTexture = null;

/* =========================
   MESH
========================= */

function setupXYGrid(width, height, z = 0) {
  const points = [];
  const faces = [];
  const uvs = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      points.push({ x, y, z });

      const u = width > 1 ? x / (width - 1) : 0;
      const v = height > 1 ? y / (height - 1) : 0;

      // flat array: [u0, v0, u1, v1, ...]
      uvs.push(u, v);
    }
  }

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i0 = x + y * width;
      const i1 = x + 1 + y * width;
      const i2 = x + 1 + (y + 1) * width;
      const i3 = x + (y + 1) * width;

      faces.push([i0, i1, i3]);
      faces.push([i1, i2, i3]);
    }
  }

  return {
    points,
    faces,
    uvs,
    texture: null
  };
}

/* =========================
   GLB / THREE HELPERS
========================= */

function colorToCss(c) {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function createTextureSampler(texture) {
  const image = texture?.image;
  if (!image) return null;

  const texCanvas = document.createElement("canvas");
  texCanvas.width = image.width;
  texCanvas.height = image.height;

  const texCtx = texCanvas.getContext("2d");
  texCtx.drawImage(image, 0, 0);

  const imageData = texCtx.getImageData(0, 0, image.width, image.height);
  const data = imageData.data;
  console.log(data);

  return function sample(u, v) {
    u = Math.max(0, Math.min(1, u));
    v = Math.max(0, Math.min(1, v));

    const x = Math.floor(u * (image.width));

    // Try this first. If the texture appears upside-down, switch to:
    // const y = Math.floor((1 - v) * (image.height - 1));
    const y = Math.floor(v * (image.height));

    const index = (y * image.width + x) * 4;

    return {
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
      a: data[index + 3]
    };
  };
}

function geometryToMeshData(geometry, material = null) {
  const positionAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;

  if (!positionAttr) {
    return {
      points: [],
      faces: [],
      uvs: [],
      texture: null
    };
  }

  const points = [];
  for (let i = 0; i < positionAttr.count; i++) {
    points.push({
      x: positionAttr.getX(i),
      y: positionAttr.getY(i),
      z: positionAttr.getZ(i)
    });
  }

  const uvs = uvAttr ? Array.from(uvAttr.array) : [];

  const faces = [];
  if (geometry.index) {
    const indexArray = geometry.index.array;
    for (let i = 0; i < indexArray.length; i += 3) {
      faces.push([indexArray[i], indexArray[i + 1], indexArray[i + 2]]);
    }
  } else {
    for (let i = 0; i < positionAttr.count; i += 3) {
      faces.push([i, i + 1, i + 2]);
    }
  }

  return {
    points,
    faces,
    uvs,
    texture: material && material.map ? material.map : null
  };
}

function meshToMeshDataWorld(meshObj) {
  const geometry = meshObj.geometry;
  const material = meshObj.material;
  const positionAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;

  if (!positionAttr) {
    return {
      points: [],
      faces: [],
      uvs: [],
      texture: null
    };
  }

  meshObj.updateWorldMatrix(true, false);

  const temp = new THREE.Vector3();
  const points = [];
  const uvs = [];

  for (let i = 0; i < positionAttr.count; i++) {
    temp.fromBufferAttribute(positionAttr, i);
    temp.applyMatrix4(meshObj.matrixWorld);
    points.push({ x: temp.x, y: temp.y, z: temp.z });
    if (uvAttr) {
      uvs.push({
        u: uvAttr.getX(i),
        v: uvAttr.getY(i)
      });
    }
  }

  const faces = [];
  if (geometry.index) {
    const indexArray = geometry.index.array;
    for (let i = 0; i < indexArray.length; i += 3) {
      faces.push([indexArray[i], indexArray[i + 1], indexArray[i + 2]]);
    }
  } else {
    for (let i = 0; i < positionAttr.count; i += 3) {
      faces.push([i, i + 1, i + 2]);
    }
  }

  return {
    points,
    faces,
    uvs,
    texture: material && material.map ? material.map : null
  };
}

function combineMeshes(meshes) {
  const allPoints = [];
  const allFaces = [];
  const allUvs = [];
  let pointOffset = 0;
  let texture = null;

  for (const m of meshes) {
    const part = meshToMeshDataWorld(m);

    for (const p of part.points) allPoints.push(p);
    for (const uv of part.uvs) allUvs.push(uv);

    for (const f of part.faces) {
      allFaces.push([
        f[0] + pointOffset,
        f[1] + pointOffset,
        f[2] + pointOffset
      ]);
    }

    if (!texture && part.texture) {
      texture = part.texture;
    }

    pointOffset += part.points.length;
  }

  return {
    points: allPoints,
    faces: allFaces,
    uvs: allUvs,
    texture
  };
}

function loadGLBAsMesh(url, onLoaded) {
  const loader = new GLTFLoader();

  loader.load(
    url,
    (gltf) => {
      const meshes = [];

      gltf.scene.traverse((child) => {
        if (child.isMesh) meshes.push(child);
      });

      onLoaded(combineMeshes(meshes));
    },
    undefined,
    (error) => {
      console.error("Failed to load GLB:", error);
    }
  );
}

/* =========================
   VECTOR HELPERS
========================= */

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/* =========================
   CAMERA BASIS
========================= */

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

function worldToCamera(point, cam) {
  const rel = {
    x: point.x - cam.x,
    y: point.y - cam.y,
    z: point.z - cam.z
  };

  const basis = getCameraBasis(cam);

  return {
    x: dot(rel, basis.right),
    y: dot(rel, basis.up),
    z: dot(rel, basis.forward)
  };
}

/* =========================
   PROJECTION
========================= */

function shouldCullFace(face, points, cam) {
  const a = worldToCamera(points[face[0]], cam);
  const b = worldToCamera(points[face[1]], cam);
  const c = worldToCamera(points[face[2]], cam);

  const ab = {
    x: b.x - a.x,
    y: b.y - a.y,
    z: b.z - a.z
  };

  const ac = {
    x: c.x - a.x,
    y: c.y - a.y,
    z: c.z - a.z
  };

  const normal = cross(ab, ac);

  return normal.z <= 0;
}

function toScreen(point, cam, focal = FOCAL) {
  const rel = {
    x: point.x - cam.x,
    y: point.y - cam.y,
    z: point.z - cam.z
  };

  const basis = getCameraBasis(cam);

  const camX = dot(rel, basis.right);
  const camY = dot(rel, basis.up);
  const camZ = dot(rel, basis.forward);

  if (camZ <= 0.01) return null;

  return {
    x: (camX / camZ) * focal,
    y: (camY / camZ) * focal
  };
}

function toCanvasCoords(p) {
  return {
    x: WIDTH / 2 + p.x,
    y: HEIGHT / 2 - p.y
  };
}

/* =========================
   DRAWING
========================= */

function drawDebugText() {
  const lines = [
    `pos: (${camera.x.toFixed(2)}, ${camera.y.toFixed(2)}, ${camera.z.toFixed(2)})`,
    `yaw: ${camera.yaw.toFixed(2)}`,
    `pitch: ${camera.pitch.toFixed(2)}`
  ];

  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillRect(5, 5, 200, lines.length * 18);

  ctx.fillStyle = "black";
  ctx.font = "14px monospace";

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 10, 20 + i * 16);
  }
}

function clearCanvas(color = "black") {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawTriangle(p1, p2, p3, color = "white") {
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();

  // optional outline so you can still see mesh structure
  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawFace(face, mesh, cam, focal, fallbackColor = "white", overwriteTextureColor = false) {
  if (shouldCullFace(face, mesh.points, cam)) {
    return;
  }

  const i0 = face[0];
  const i1 = face[1];
  const i2 = face[2];

  let color = fallbackColor;

  if (
    sampleTexture &&
    !overwriteTextureColor
  ) {
    const u0 = mesh.uvs[i0].u;
    const v0 = mesh.uvs[i0].v;

    const u1 = mesh.uvs[i1].u;
    const v1 = mesh.uvs[i1].v;

    const u2 = mesh.uvs[i2].u;
    const v2 = mesh.uvs[i2].v;

    const u = (u0 + u1 + u2) / 3;
    const v = (v0 + v1 + v2) / 3;

    color = colorToCss(sampleTexture(u, v));
  }

  const s1 = toScreen(mesh.points[i0], cam, focal);
  const s2 = toScreen(mesh.points[i1], cam, focal);
  const s3 = toScreen(mesh.points[i2], cam, focal);

  if (!s1 || !s2 || !s3) return;

  const p1 = toCanvasCoords(s1);
  const p2 = toCanvasCoords(s2);
  const p3 = toCanvasCoords(s3);

  drawTriangle(p1, p2, p3, color);
}

function drawMesh(mesh, cam, focal, color = "white") {
  for (const face of mesh.faces) {
    drawFace(face, mesh, cam, focal, color);
  }
}

/* =========================
   INPUT
========================= */

document.addEventListener("keydown", (e) => {
  keys[e.key.toLowerCase()] = true;
});

document.addEventListener("keyup", (e) => {
  keys[e.key.toLowerCase()] = false;
});

/* =========================
   CAMERA UPDATE
========================= */

function updateCamera() {
  const turnSpeed = 0.025;
  const moveSpeed = 0.08;
  const verticalSpeed = 0.08;

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

/* =========================
   LOOP
========================= */

function render() {
  clearCanvas("white");
  drawMesh(mesh, camera, FOCAL, "lime");
  drawDebugText();
}

function loop() {
  updateCamera();
  render();
  requestAnimationFrame(loop);
}

loadGLBAsMesh("./realistic_tree_min2.glb", (loadedMesh) => {
  mesh = loadedMesh;

  console.log("Loaded points:", mesh.points.length);
  console.log("Loaded faces:", mesh.faces.length);
  console.log("Loaded uvs:", mesh.uvs.length);

  if (mesh.texture) {
    sampleTexture = createTextureSampler(mesh.texture);
    console.log("Texture loaded");
  } else {
    console.log("No texture found on mesh");
  }
});

loop();