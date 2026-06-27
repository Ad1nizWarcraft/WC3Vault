/**
 * mdx-viewer.js  —  WC3 MDX model renderer (Three.js r128)
 *
 * MDX / MDLX binary format (little-endian):
 *   [0]   "MDLX"  magic (4 bytes)
 *   then repeating top-level chunks:
 *     [tag  4B] [size 4B] [data …]
 *
 *   VERS  →  uint32 version
 *   GEOS  →  array of geoset records; each record starts with:
 *              uint32  recordByteSize
 *            then sub-chunks inside the record:
 *              VRTX  float32[n×3]   vertex positions
 *              NRMS  float32[n×3]   normals
 *              UVBS  float32[n×2]   UV layer 0  (there may be several UVBS)
 *              TRIS  uint16[…]      triangle index list   ← NO leading count!
 *              GNDX  uint8[…]       vertex-group indices
 *              MTGC  uint32[…]      group sizes
 *              MATS  uint32[…]      material layer refs
 *              … (other sub-chunks we skip)
 *
 *   NOTE: The TRIS sub-chunk size field gives the BYTE count of uint16 indices
 *         directly.  There is no uint32 "index count" prefix (that was a
 *         mis-reading of older documentation).
 */

const MDXViewer = (() => {

  // ── Helpers ───────────────────────────────────────────────────────────────
  function readTag(u8, off) {
    return String.fromCharCode(u8[off], u8[off+1], u8[off+2], u8[off+3]);
  }

  // ── Parser ────────────────────────────────────────────────────────────────
  function parseMDX(buffer) {
    const u8  = new Uint8Array(buffer);
    const dv  = new DataView(buffer);
    const len = u8.length;

    const magic = readTag(u8, 0);
    if (magic !== 'MDLX') throw new Error(`Not an MDX/MDLX file (magic "${magic}")`);

    const geosets = [];
    let pos = 4;

    // ── Top-level chunk loop ──────────────────────────────────────────────
    while (pos + 8 <= len) {
      const chunkTag  = readTag(u8, pos);
      const chunkSize = dv.getUint32(pos + 4, true);
      pos += 8;

      if (chunkTag === 'GEOS') {
        const geoEnd = pos + chunkSize;
        let   gp     = pos;

        // Each geoset is a self-delimiting record prefixed with its byte size
        while (gp + 4 <= geoEnd) {
          const recSize = dv.getUint32(gp, true);
          if (recSize < 8 || gp + recSize > geoEnd) break;
          const recEnd = gp + recSize;
          gp += 4; // skip the size field; sub-chunks start here

          const geo = {
            vertices: null,
            normals:  null,
            uvs:      null,   // first UV set
            indices:  null,
          };

          // ── Sub-chunk loop inside the geoset record ──────────────────
          while (gp + 8 <= recEnd) {
            const subTag  = readTag(u8, gp);
            const subSize = dv.getUint32(gp + 4, true);
            gp += 8;

            if (subSize < 0 || gp + subSize > recEnd + 8) {
              // Corrupt — skip to end of record
              gp = recEnd;
              break;
            }

            if (subTag === 'VRTX') {
              const n = subSize / 12; // float32 × 3 per vertex
              geo.vertices = new Float32Array(n * 3);
              for (let i = 0; i < n; i++) {
                geo.vertices[i*3]   = dv.getFloat32(gp + i*12,     true);
                geo.vertices[i*3+1] = dv.getFloat32(gp + i*12 + 4, true);
                geo.vertices[i*3+2] = dv.getFloat32(gp + i*12 + 8, true);
              }

            } else if (subTag === 'NRMS') {
              const n = subSize / 12;
              geo.normals = new Float32Array(n * 3);
              for (let i = 0; i < n; i++) {
                geo.normals[i*3]   = dv.getFloat32(gp + i*12,     true);
                geo.normals[i*3+1] = dv.getFloat32(gp + i*12 + 4, true);
                geo.normals[i*3+2] = dv.getFloat32(gp + i*12 + 8, true);
              }

            } else if (subTag === 'UVBS') {
              // Only grab the first UV layer
              if (!geo.uvs) {
                const n = subSize / 8; // float32 × 2 per vertex
                geo.uvs = new Float32Array(n * 2);
                for (let i = 0; i < n; i++) {
                  geo.uvs[i*2]   = dv.getFloat32(gp + i*8,     true);
                  geo.uvs[i*2+1] = dv.getFloat32(gp + i*8 + 4, true);
                }
              }

            } else if (subTag === 'TRIS') {
              // subSize is the BYTE count of uint16 triangle indices — NO prefix!
              const n = subSize / 2;
              geo.indices = new Uint16Array(n);
              for (let i = 0; i < n; i++) {
                geo.indices[i] = dv.getUint16(gp + i*2, true);
              }
            }
            // All other sub-chunks (GNDX, MTGC, MATS, UVAS, TANG, SKIN…) are skipped

            gp += subSize;
          }

          if (geo.vertices && geo.indices && geo.indices.length > 0) {
            geosets.push(geo);
          }

          gp = recEnd; // always advance to the end of the record
        }
      }

      pos += chunkSize;
    }

    if (geosets.length === 0) {
      throw new Error('No renderable geometry found in this MDX file');
    }
    return geosets;
  }

  // ── Bounding box ──────────────────────────────────────────────────────────
  function computeBounds(geosets) {
    let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const g of geosets) {
      for (let i = 0; i < g.vertices.length; i += 3) {
        const x = g.vertices[i], y = g.vertices[i+1], z = g.vertices[i+2];
        if (x < minX) minX = x;  if (x > maxX) maxX = x;
        if (y < minY) minY = y;  if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;  if (z > maxZ) maxZ = z;
      }
    }
    return {
      cx: (minX+maxX)/2, cy: (minY+maxY)/2, cz: (minZ+maxZ)/2,
      maxExt: Math.max(maxX-minX, maxY-minY, maxZ-minZ) || 1,
    };
  }

  // WC3-flavoured palette for geoset colours
  const PALETTE = [
    0x7aaa60, 0x6a9ab8, 0xc0a060, 0x9870b8,
    0xb87070, 0x60a898, 0xa89060, 0x7080b0,
  ];

  // ── Scene builder ─────────────────────────────────────────────────────────
  function buildScene(THREE, geosets) {
    const scene  = new THREE.Scene();
    const bounds = computeBounds(geosets);

    // Scale so the largest extent fits within ±1.4 units
    const scale = 2.8 / bounds.maxExt;

    const group = new THREE.Group();
    group.position.set(
      -bounds.cx * scale,
      -bounds.cy * scale,
      -bounds.cz * scale,
    );
    group.scale.setScalar(scale);

    geosets.forEach((geo, gi) => {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(geo.vertices, 3));
      if (geo.normals) bg.setAttribute('normal', new THREE.BufferAttribute(geo.normals, 3));
      if (geo.uvs)     bg.setAttribute('uv',     new THREE.BufferAttribute(geo.uvs,     2));
      bg.setIndex(new THREE.BufferAttribute(geo.indices, 1));
      if (!geo.normals) bg.computeVertexNormals();

      const mat  = new THREE.MeshStandardMaterial({
        color:     PALETTE[gi % PALETTE.length],
        roughness: 0.6,
        metalness: 0.1,
        side:      THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(bg, mat);
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      // Very subtle wireframe
      const wMat = new THREE.MeshBasicMaterial({
        color: 0x000000, wireframe: true,
        opacity: 0.07, transparent: true,
      });
      group.add(new THREE.Mesh(bg, wMat));
    });

    scene.add(group);
    return scene;
  }

  // ── Mount ─────────────────────────────────────────────────────────────────
  /**
   * @param {ArrayBuffer} buffer   Raw MDX bytes
   * @param {HTMLElement} container  DOM element to render into
   * @returns {{ dispose: Function, info: Object }}
   */
  function mount(buffer, container) {
    const THREE = window.THREE;
    if (!THREE) throw new Error('Three.js not loaded');

    const geosets    = parseMDX(buffer);
    const totalVerts = geosets.reduce((s, g) => s + g.vertices.length / 3, 0);
    const totalTris  = geosets.reduce((s, g) => s + g.indices.length  / 3, 0);

    const W = container.clientWidth  || 720;
    const H = container.clientHeight || 420;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const scene = buildScene(THREE, geosets);

    // Camera
    const camera = new THREE.PerspectiveCamera(42, W / H, 0.01, 500);
    camera.position.set(0, 1.5, 5);

    // Lighting
    scene.add(new THREE.AmbientLight(0xfff4e0, 0.55));

    const sun = new THREE.DirectionalLight(0xfff0cc, 1.1);
    sun.position.set(4, 8, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(1024);
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x8090cc, 0.35);
    fill.position.set(-4, 2, -3);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffa030, 0.25);
    rim.position.set(0, -2, -4);
    scene.add(rim);

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x1a2010, roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.5;
    ground.receiveShadow = true;
    scene.add(ground);
    scene.add(new THREE.GridHelper(10, 20, 0x3a4a20, 0x252e14));

    // Orbit controls (manual)
    let theta = 0.4, phi = 0.35, radius = 5;
    let dragging = false, lastX = 0, lastY = 0;
    let autoSpin = true;

    renderer.domElement.addEventListener('mousedown', e => {
      dragging = true; lastX = e.clientX; lastY = e.clientY; autoSpin = false;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      theta -= (e.clientX - lastX) * 0.012;
      phi    = Math.max(0.05, Math.min(1.45, phi - (e.clientY - lastY) * 0.009));
      lastX = e.clientX; lastY = e.clientY;
    });
    renderer.domElement.addEventListener('wheel', e => {
      radius = Math.max(1.5, Math.min(20, radius + e.deltaY * 0.012));
      e.preventDefault();
    }, { passive: false });

    // Touch
    let lastTouch = null, lastPinch = null;
    renderer.domElement.addEventListener('touchstart', e => {
      autoSpin = false;
      if (e.touches.length === 1) lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinch = Math.hypot(dx, dy);
      }
    });
    renderer.domElement.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && lastTouch) {
        theta -= (e.touches[0].clientX - lastTouch.x) * 0.012;
        phi    = Math.max(0.05, Math.min(1.45, phi - (e.touches[0].clientY - lastTouch.y) * 0.009));
        lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2 && lastPinch !== null) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const d  = Math.hypot(dx, dy);
        radius = Math.max(1.5, Math.min(20, radius * (lastPinch / d)));
        lastPinch = d;
      }
    }, { passive: false });

    // Render loop
    let rafId;
    function animate() {
      rafId = requestAnimationFrame(animate);
      if (autoSpin) theta += 0.005;
      camera.position.set(
        radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.sin(phi),
        radius * Math.cos(theta) * Math.cos(phi),
      );
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }
    animate();

    // Resize observer
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    return {
      dispose() {
        cancelAnimationFrame(rafId);
        ro.disconnect();
        renderer.dispose();
        if (renderer.domElement.parentNode) renderer.domElement.remove();
      },
      info: {
        geosets:   geosets.length,
        vertices:  Math.round(totalVerts),
        triangles: Math.round(totalTris),
      },
    };
  }

  return { mount, parseMDX };
})();

if (typeof module !== 'undefined') module.exports = MDXViewer;
