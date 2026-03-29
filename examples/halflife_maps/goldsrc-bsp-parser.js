/**
 * GoldSrc BSP Parser (BSP v30 - Half-Life 1)
 *
 * Parses a .bsp file and extracts geometry data suitable for 3D rendering:
 *   - Triangulated meshes with positions, normals, and UVs
 *   - Texture metadata (name, dimensions)
 *   - Entity string
 *
 * Usage:
 *   const bsp = await GoldSrcBsp.load("path/to/map.bsp");
 *   // bsp.meshes   — array of { texture, vertices: [{ pos, normal, uv }], indices }
 *   // bsp.textures — array of { name, width, height, mipData }
 *   // bsp.entities — raw entity string
 */

const GoldSrcBsp = (() => {
  // ─── BSP v30 constants ───────────────────────────────────────────────

  const BSP_VERSION = 30;

  const LUMP = {
    ENTITIES:     0,
    PLANES:       1,
    TEXTURES:     2,
    VERTICES:     3,
    VISIBILITY:   4,
    NODES:        5,
    TEXINFO:      6,
    FACES:        7,
    LIGHTING:     8,
    CLIPNODES:    9,
    LEAVES:      10,
    MARKSURFACES:11,
    EDGES:       12,
    SURFEDGES:   13,
    MODELS:      14,
  };

  const LUMP_COUNT = 15;

  // ─── Low-level readers ───────────────────────────────────────────────

  class BinaryReader {
    constructor(buffer) {
      this.view = new DataView(buffer);
      this.buf  = buffer;
      this.pos  = 0;
    }

    seek(offset) { this.pos = offset; }

    int32()   { const v = this.view.getInt32(this.pos, true);   this.pos += 4; return v; }
    uint32()  { const v = this.view.getUint32(this.pos, true);  this.pos += 4; return v; }
    uint16()  { const v = this.view.getUint16(this.pos, true);  this.pos += 2; return v; }
    int16()   { const v = this.view.getInt16(this.pos, true);   this.pos += 2; return v; }
    float32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
    uint8()   { const v = this.view.getUint8(this.pos);         this.pos += 1; return v; }

    vec3() {
      return [this.float32(), this.float32(), this.float32()];
    }

    string(maxLen) {
      const bytes = new Uint8Array(this.buf, this.pos, maxLen);
      this.pos += maxLen;
      let end = bytes.indexOf(0);
      if (end === -1) end = maxLen;
      return new TextDecoder("ascii").decode(bytes.subarray(0, end));
    }

    bytes(len) {
      const out = new Uint8Array(this.buf, this.pos, len);
      this.pos += len;
      return out;
    }
  }

  // ─── Header parsing ──────────────────────────────────────────────────

  function readHeader(r) {
    const version = r.int32();
    if (version !== BSP_VERSION) {
      throw new Error(`Unsupported BSP version ${version} (expected ${BSP_VERSION})`);
    }

    const lumps = [];
    for (let i = 0; i < LUMP_COUNT; i++) {
      lumps.push({ offset: r.int32(), length: r.int32() });
    }
    return { version, lumps };
  }

  // ─── Lump readers ────────────────────────────────────────────────────

  function readEntities(r, lump) {
    r.seek(lump.offset);
    return r.string(lump.length);
  }

  function readPlanes(r, lump) {
    const count = lump.length / 20; // 3 floats normal + 1 float dist + 1 int type = 20 bytes
    const planes = new Array(count);
    r.seek(lump.offset);
    for (let i = 0; i < count; i++) {
      planes[i] = {
        normal: r.vec3(),
        dist:   r.float32(),
        type:   r.int32(),
      };
    }
    return planes;
  }

  function readVertices(r, lump) {
    const count = lump.length / 12; // 3 floats = 12 bytes
    const verts = new Array(count);
    r.seek(lump.offset);
    for (let i = 0; i < count; i++) {
      verts[i] = r.vec3();
    }
    return verts;
  }

  function readEdges(r, lump) {
    const count = lump.length / 4; // 2 uint16 = 4 bytes
    const edges = new Array(count);
    r.seek(lump.offset);
    for (let i = 0; i < count; i++) {
      edges[i] = [r.uint16(), r.uint16()];
    }
    return edges;
  }

  function readSurfEdges(r, lump) {
    const count = lump.length / 4;
    const surfEdges = new Array(count);
    r.seek(lump.offset);
    for (let i = 0; i < count; i++) {
      surfEdges[i] = r.int32();
    }
    return surfEdges;
  }

  function readFaces(r, lump) {
    // face_t: 2 uint16, 4 int32, 2 int16, 4 uint8 = 20 bytes
    const FACE_SIZE = 20;
    const count = lump.length / FACE_SIZE;
    const faces = new Array(count);
    r.seek(lump.offset);
    for (let i = 0; i < count; i++) {
      faces[i] = {
        planeIndex:     r.uint16(),
        planeSide:      r.uint16(),
        firstEdge:      r.int32(),
        numEdges:       r.int16(),
        texInfoIndex:   r.int16(),
        lightStyles:    [r.uint8(), r.uint8(), r.uint8(), r.uint8()],
        lightmapOffset: r.int32(),
      };
    }
    return faces;
  }

  function readTexInfo(r, lump) {
    // texinfo_t: 2×(vec3 + float) + miptex index + flags = 40 bytes
    const TEXINFO_SIZE = 40;
    const count = lump.length / TEXINFO_SIZE;
    const infos = new Array(count);
    r.seek(lump.offset);
    for (let i = 0; i < count; i++) {
      infos[i] = {
        s: { axis: r.vec3(), offset: r.float32() },
        t: { axis: r.vec3(), offset: r.float32() },
        miptexIndex: r.int32(),
        flags:       r.int32(),
      };
    }
    return infos;
  }

  function readTextures(r, lump) {
    r.seek(lump.offset);
    const numTextures = r.int32();
    const offsets = new Array(numTextures);
    for (let i = 0; i < numTextures; i++) {
      offsets[i] = r.int32();
    }

    const textures = new Array(numTextures);
    for (let i = 0; i < numTextures; i++) {
      if (offsets[i] === -1) {
        textures[i] = { name: "", width: 0, height: 0, mipOffsets: [0,0,0,0], mipData: null };
        continue;
      }

      r.seek(lump.offset + offsets[i]);

      const name   = r.string(16);
      const width  = r.uint32();
      const height = r.uint32();
      const mipOffsets = [r.uint32(), r.uint32(), r.uint32(), r.uint32()];

      // Read mip level 0 pixel data (indexed color, 1 byte per pixel)
      let mipData = null;
      if (mipOffsets[0] !== 0) {
        r.seek(lump.offset + offsets[i] + mipOffsets[0]);
        mipData = new Uint8Array(r.bytes(width * height));
      }

      // Try to read the palette (located after all 4 mip levels + 2 byte padding)
      let palette = null;
      if (mipOffsets[0] !== 0) {
        const mip0Size = width * height;
        const mip1Size = (width >> 1) * (height >> 1);
        const mip2Size = (width >> 2) * (height >> 2);
        const mip3Size = (width >> 3) * (height >> 3);
        const paletteOffset = lump.offset + offsets[i] + mipOffsets[0] + mip0Size + mip1Size + mip2Size + mip3Size + 2;
        if (paletteOffset + 768 <= lump.offset + lump.length) {
          r.seek(paletteOffset);
          palette = new Uint8Array(r.bytes(768)); // 256 * RGB
        }
      }

      textures[i] = { name, width, height, mipOffsets, mipData, palette };
    }
    return textures;
  }

  function readModels(r, lump) {
    // model_t: 9 floats + 4 int32 + int32 (numfaces) = 64 bytes
    const MODEL_SIZE = 64;
    const count = lump.length / MODEL_SIZE;
    const models = new Array(count);
    r.seek(lump.offset);
    for (let i = 0; i < count; i++) {
      models[i] = {
        mins:          r.vec3(),
        maxs:          r.vec3(),
        origin:        r.vec3(),
        headNodes:     [r.int32(), r.int32(), r.int32(), r.int32()],
        numVisLeaves:  r.int32(),
        firstFace:     r.int32(),
        numFaces:      r.int32(),
      };
    }
    return models;
  }

  // ─── Mesh building ───────────────────────────────────────────────────

  /**
   * Converts BSP faces into triangle meshes grouped by texture.
   * Returns an array of mesh objects, each with:
   *   - texture: { name, width, height }
   *   - vertices: Float32Array  (interleaved: x,y,z, nx,ny,nz, u,v — stride 8)
   *   - indices:  Uint32Array   (triangle list)
   */
  function buildMeshes(vertices, edges, surfEdges, faces, texInfos, textures, planes) {
    // Group faces by texture index
    const groups = new Map();

    for (const face of faces) {
      const ti = texInfos[face.texInfoIndex];
      if (!ti) continue;
      const texIdx = ti.miptexIndex;
      if (!groups.has(texIdx)) {
        groups.set(texIdx, []);
      }
      groups.get(texIdx).push(face);
    }

    const meshes = [];

    for (const [texIdx, faceList] of groups) {
      const tex = textures[texIdx];
      if (!tex || tex.width === 0) continue;

      const verts  = [];  // will be flattened later
      const indices = [];
      let vertCount = 0;

      for (const face of faceList) {
        const plane  = planes[face.planeIndex];
        const normal = face.planeSide
          ? [-plane.normal[0], -plane.normal[1], -plane.normal[2]]
          : plane.normal;
        const ti = texInfos[face.texInfoIndex];

        // Collect face vertices via surfedge → edge → vertex
        const faceVerts = [];
        for (let e = 0; e < face.numEdges; e++) {
          const seIdx = face.firstEdge + e;
          const se    = surfEdges[seIdx];
          let vi;
          if (se >= 0) {
            vi = edges[se][0];
          } else {
            vi = edges[-se][1];
          }
          const pos = vertices[vi];

          // Compute UV
          const u = (pos[0] * ti.s.axis[0] + pos[1] * ti.s.axis[1] + pos[2] * ti.s.axis[2] + ti.s.offset) / tex.width;
          const v = (pos[0] * ti.t.axis[0] + pos[1] * ti.t.axis[1] + pos[2] * ti.t.axis[2] + ti.t.offset) / tex.height;

          faceVerts.push({ pos, normal, uv: [u, v] });
        }

        // Fan-triangulate the convex polygon
        const base = vertCount;
        for (const fv of faceVerts) {
          verts.push(
            fv.pos[0], -fv.pos[1], fv.pos[2],
            fv.normal[0], fv.normal[1], fv.normal[2],
            fv.uv[0], fv.uv[1]
          );
          vertCount++;
        }
        for (let t = 1; t < faceVerts.length - 1; t++) {
          indices.push(base, base + t, base + t + 1);
        }
      }

      meshes.push({
        texture: {
          name:    tex.name,
          width:   tex.width,
          height:  tex.height,
          mipData: tex.mipData,
          palette: tex.palette,
        },
        vertices: new Float32Array(verts),
        indices:  new Uint32Array(indices),
        stride:   8, // floats per vertex: pos(3) + normal(3) + uv(2)
      });
    }

    return meshes;
  }

  // ─── Texture RGBA conversion helper ──────────────────────────────────

  /**
   * Converts indexed mip data + palette to an RGBA Uint8Array.
   * If the texture has no embedded palette, returns null.
   */
  function textureToRGBA(textureMeta) {
    const { width, height, mipData, palette } = textureMeta;
    if (!mipData || !palette) return null;

    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const idx = mipData[i];
      rgba[i * 4 + 0] = palette[idx * 3 + 0];
      rgba[i * 4 + 1] = palette[idx * 3 + 1];
      rgba[i * 4 + 2] = palette[idx * 3 + 2];
      // Last palette entry is often the transparent color for '{' textures
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Parse a BSP from an ArrayBuffer.
   */
  function parse(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const header = readHeader(r);
    const lumps  = header.lumps;

    const entities  = readEntities(r, lumps[LUMP.ENTITIES]);
    const planes    = readPlanes(r, lumps[LUMP.PLANES]);
    const textures  = readTextures(r, lumps[LUMP.TEXTURES]);
    const vertices  = readVertices(r, lumps[LUMP.VERTICES]);
    const texInfos  = readTexInfo(r, lumps[LUMP.TEXINFO]);
    const faces     = readFaces(r, lumps[LUMP.FACES]);
    const edges     = readEdges(r, lumps[LUMP.EDGES]);
    const surfEdges = readSurfEdges(r, lumps[LUMP.SURFEDGES]);
    const models    = readModels(r, lumps[LUMP.MODELS]);

    const meshes = buildMeshes(vertices, edges, surfEdges, faces, texInfos, textures, planes);

    return {
      /** Raw entity string (you can parse key/value blocks yourself) */
      entities,

      /** Array of { texture: {name,width,height,mipData,palette}, vertices: Float32Array, indices: Uint32Array, stride } */
      meshes,

      /** Texture metadata array */
      textures: textures.map(t => ({
        name:    t.name,
        width:   t.width,
        height:  t.height,
        mipData: t.mipData,
        palette: t.palette,
      })),

      /** Brush models (model 0 = worldspawn) */
      models,

      /** Helper: convert indexed texture to RGBA */
      textureToRGBA,
    };
  }

  /**
   * Fetch a URL with byte-level progress tracking.
   * @param {string} url
   * @param {function} [onProgress] callback({loaded, total}) — total is -1 if unknown
   * @returns {Promise<ArrayBuffer>}
   */
  async function fetchWithProgress(url, onProgress) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
    const total = parseInt(resp.headers.get("content-length") || "-1", 10);
    if (!onProgress || !resp.body) {
      const buf = await resp.arrayBuffer();
      if (onProgress) onProgress({ loaded: buf.byteLength, total: buf.byteLength });
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress({ loaded, total });
    }
    const result = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  }

  /**
   * Fetch a BSP file by URL and parse it.
   * @param {string} url
   * @param {function} [onProgress] callback({loaded, total})
   * @returns {Promise<Object>} parsed BSP data
   */
  async function load(url, onProgress) {
    const buf = await fetchWithProgress(url, onProgress);
    return parse(buf);
  }

  // ─── WAD3 Parser ─────────────────────────────────────────────────────

  /**
   * Parse a WAD3 file from an ArrayBuffer.
   * Returns a Map of lowercase texture name → { name, width, height, mipData, palette }.
   */
  function parseWad(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const magic = r.string(4);
    if (magic !== "WAD3") {
      throw new Error(`Not a WAD3 file (magic: ${magic})`);
    }
    const numEntries = r.int32();
    const dirOffset  = r.int32();

    const textures = new Map();

    for (let i = 0; i < numEntries; i++) {
      r.seek(dirOffset + i * 32);
      const offset      = r.int32();
      const diskSize    = r.int32();
      const size        = r.int32();
      const type        = r.uint8();
      const compression = r.uint8();
      r.int16(); // padding
      const name = r.string(16);

      // Type 0x43 (67) = miptex
      if (type !== 0x43) continue;

      r.seek(offset);
      const texName = r.string(16);
      const width   = r.uint32();
      const height  = r.uint32();
      const mipOffsets = [r.uint32(), r.uint32(), r.uint32(), r.uint32()];

      let mipData = null;
      if (mipOffsets[0] !== 0) {
        r.seek(offset + mipOffsets[0]);
        mipData = new Uint8Array(r.bytes(width * height));
      }

      // Palette is after all 4 mip levels + 2 byte count
      let palette = null;
      if (mipOffsets[0] !== 0) {
        const mip0Size = width * height;
        const mip1Size = (width >> 1) * (height >> 1);
        const mip2Size = (width >> 2) * (height >> 2);
        const mip3Size = (width >> 3) * (height >> 3);
        const palOffset = offset + mipOffsets[0] + mip0Size + mip1Size + mip2Size + mip3Size + 2;
        r.seek(palOffset);
        palette = new Uint8Array(r.bytes(768));
      }

      textures.set(texName.toLowerCase(), { name: texName, width, height, mipData, palette });
    }

    return textures;
  }

  /**
   * Fetch a WAD3 file by URL and parse it.
   * @param {string} url
   * @param {function} [onProgress] callback({loaded, total})
   * @returns {Promise<Map>} map of lowercase name → texture data
   */
  async function loadWad(url, onProgress) {
    const buf = await fetchWithProgress(url, onProgress);
    return parseWad(buf);
  }

  return { load, parse, textureToRGBA, parseWad, loadWad };
})();

// Support ES module / CommonJS / browser global
if (typeof module !== "undefined" && module.exports) {
  module.exports = GoldSrcBsp;
}
