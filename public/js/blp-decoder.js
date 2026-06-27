/**
 * blp-decoder.js  —  BLP1 + BLP2 pure-JS decoder
 *
 * BLP1 layout (little-endian):
 *   0x00  magic        "BLP1"
 *   0x04  compression  uint32  (0=JPEG, 1=palette)
 *   0x08  alphaDepth   uint32  (0,1,4,8)
 *   0x0C  alphaType    uint32
 *   0x10  flags        uint32
 *   0x14  width        uint32
 *   0x18  height       uint32
 *   0x1C  mipOffsets   uint32[16]  (0x1C .. 0x58)
 *   0x5C  mipSizes     uint32[16]  (0x5C .. 0x98 — WC3 BLP1 uses 0x9C start for palette!)
 *   For JPEG content: jpegHeaderSize uint32 at 0x9C, then jpegHeader bytes
 *   For palette:      256 × BGRA at 0x9C
 *
 * BLP2 layout (little-endian):
 *   0x00  magic         "BLP2"
 *   0x04  type          uint8   (0=JPEG, 1=palette/DXTC)
 *   0x05  encoding      uint8   (1=raw/palette, 2=DXTC)
 *   0x06  alphaDepth    uint8
 *   0x07  alphaEncoding uint8   (0=DXT1, 1=DXT3, 7=DXT5)
 *   0x08  hasMips       uint8
 *   0x09  width         uint32 (overlaps — actually at 0x08 uint32)
 *   BLP2 spec:
 *   0x08  width         uint32
 *   0x0C  height        uint32
 *   0x10  mipOffsets    uint32[16]
 *   0x50  mipSizes      uint32[16]
 *   0x90  palette       BGRA[256]  (only for encoding=1)
 */

const BLPDecoder = (() => {

  // ── RGB565 helper ────────────────────────────────────────────────────────
  function unpack565(v) {
    return [
      Math.round(((v >>> 11) & 0x1F) * (255 / 31)),
      Math.round(((v >>>  5) & 0x3F) * (255 / 63)),
      Math.round(( v         & 0x1F) * (255 / 31))
    ];
  }

  // ── DXT1 ─────────────────────────────────────────────────────────────────
  function decodeDXT1(src, off, dst, bx, by, w) {
    const c0v = (src[off+1] << 8) | src[off];
    const c1v = (src[off+3] << 8) | src[off+2];
    const c0 = unpack565(c0v);
    const c1 = unpack565(c1v);
    const palette = [
      [...c0, 255],
      [...c1, 255],
      null,
      null,
    ];
    if (c0v > c1v) {
      palette[2] = [((2*c0[0]+c1[0]+1)/3)|0, ((2*c0[1]+c1[1]+1)/3)|0, ((2*c0[2]+c1[2]+1)/3)|0, 255];
      palette[3] = [((c0[0]+2*c1[0]+1)/3)|0, ((c0[1]+2*c1[1]+1)/3)|0, ((c0[2]+2*c1[2]+1)/3)|0, 255];
    } else {
      palette[2] = [((c0[0]+c1[0])>>1), ((c0[1]+c1[1])>>1), ((c0[2]+c1[2])>>1), 255];
      palette[3] = [0, 0, 0, 0];
    }
    const bits = src[off+4] | (src[off+5]<<8) | (src[off+6]<<16) | (src[off+7]<<24);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const px = by + row, py = bx + col;
        if (px >= 0 && py >= 0) {
          const ci = (bits >>> ((row*4 + col)*2)) & 3;
          const p  = (px * w + py) * 4;
          const c  = palette[ci];
          dst[p] = c[0]; dst[p+1] = c[1]; dst[p+2] = c[2]; dst[p+3] = c[3];
        }
      }
    }
  }

  // ── DXT3 ─────────────────────────────────────────────────────────────────
  function decodeDXT3(src, off, dst, bx, by, w) {
    const alphas = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      alphas[i*2]   = ((src[off+i] & 0x0F) * 17)|0;
      alphas[i*2+1] = ((src[off+i] >> 4)   * 17)|0;
    }
    const c0v = (src[off+9]  << 8) | src[off+8];
    const c1v = (src[off+11] << 8) | src[off+10];
    const c0 = unpack565(c0v), c1 = unpack565(c1v);
    const colors = [
      [...c0], [...c1],
      [((2*c0[0]+c1[0]+1)/3)|0, ((2*c0[1]+c1[1]+1)/3)|0, ((2*c0[2]+c1[2]+1)/3)|0],
      [((c0[0]+2*c1[0]+1)/3)|0, ((c0[1]+2*c1[1]+1)/3)|0, ((c0[2]+2*c1[2]+1)/3)|0],
    ];
    const bits = src[off+12] | (src[off+13]<<8) | (src[off+14]<<16) | (src[off+15]<<24);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const px = by + row, py = bx + col;
        if (px >= 0 && py >= 0) {
          const ci = (bits >>> ((row*4 + col)*2)) & 3;
          const ai = row*4 + col;
          const p  = (px * w + py) * 4;
          const c  = colors[ci];
          dst[p] = c[0]; dst[p+1] = c[1]; dst[p+2] = c[2]; dst[p+3] = alphas[ai];
        }
      }
    }
  }

  // ── DXT5 ─────────────────────────────────────────────────────────────────
  function decodeDXT5(src, off, dst, bx, by, w) {
    const a0 = src[off], a1 = src[off+1];
    const aTable = [a0, a1, 0, 0, 0, 0, 0, 0];
    if (a0 > a1) {
      for (let i = 1; i <= 6; i++) aTable[i+1] = (((7-i)*a0 + i*a1) / 7) | 0;
    } else {
      for (let i = 1; i <= 4; i++) aTable[i+1] = (((5-i)*a0 + i*a1) / 5) | 0;
      aTable[6] = 0; aTable[7] = 255;
    }
    // 6 bytes of 3-bit indices (48 bits = 16 × 3 bits)
    let lo = src[off+2] | (src[off+3]<<8) | (src[off+4]<<16);
    let hi = src[off+5] | (src[off+6]<<8) | (src[off+7]<<16);

    const c0v = (src[off+9]  << 8) | src[off+8];
    const c1v = (src[off+11] << 8) | src[off+10];
    const c0 = unpack565(c0v), c1 = unpack565(c1v);
    const colors = [
      [...c0], [...c1],
      [((2*c0[0]+c1[0]+1)/3)|0, ((2*c0[1]+c1[1]+1)/3)|0, ((2*c0[2]+c1[2]+1)/3)|0],
      [((c0[0]+2*c1[0]+1)/3)|0, ((c0[1]+2*c1[1]+1)/3)|0, ((c0[2]+2*c1[2]+1)/3)|0],
    ];
    const bits = src[off+12] | (src[off+13]<<8) | (src[off+14]<<16) | (src[off+15]<<24);

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const px = by + row, py = bx + col;
        if (px >= 0 && py >= 0) {
          const linear = row*4 + col;
          const ci = (bits >>> (linear*2)) & 3;
          let ai;
          if (linear < 8) {
            ai = (lo >>> (linear*3)) & 7;
          } else {
            ai = (hi >>> ((linear-8)*3)) & 7;
          }
          const p = (px * w + py) * 4;
          const c = colors[ci];
          dst[p] = c[0]; dst[p+1] = c[1]; dst[p+2] = c[2]; dst[p+3] = aTable[ai];
        }
      }
    }
  }

  // ── BLP1 ─────────────────────────────────────────────────────────────────
  async function decodeBLP1(dv, u8) {
    const compression = dv.getUint32(0x04, true); // 0=JPEG, 1=palette
    const alphaDepth  = dv.getUint32(0x08, true);
    const width       = dv.getUint32(0x14, true);
    const height      = dv.getUint32(0x18, true);

    const mipOffsets = [], mipSizes = [];
    for (let i = 0; i < 16; i++) {
      mipOffsets.push(dv.getUint32(0x1C + i*4, true));
      mipSizes.push(  dv.getUint32(0x5C + i*4, true));
    }

    if (compression === 0) {
      // JPEG: shared header is stored at a fixed location after the mip tables
      // The JPEG header size uint32 lives at 0x9C in WC3 BLP1
      const jpegHeaderSize = dv.getUint32(0x9C, true);
      const jpegHeaderData = u8.slice(0xA0, 0xA0 + jpegHeaderSize);

      // Find first non-zero mip
      let mipOff = 0, mipSize = 0;
      for (let i = 0; i < 16; i++) {
        if (mipOffsets[i] > 0 && mipSizes[i] > 0) {
          mipOff  = mipOffsets[i];
          mipSize = mipSizes[i];
          break;
        }
      }
      const mipData = u8.slice(mipOff, mipOff + mipSize);
      const jpeg = new Uint8Array(jpegHeaderSize + mipSize);
      jpeg.set(jpegHeaderData, 0);
      jpeg.set(mipData, jpegHeaderSize);

      // Render via an offscreen Image
      const blob = new Blob([jpeg], { type: 'image/jpeg' });
      const url  = URL.createObjectURL(blob);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const oc  = document.createElement('canvas');
          oc.width  = img.naturalWidth;
          oc.height = img.naturalHeight;
          oc.getContext('2d').drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve({ canvas: oc });
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('JPEG decode failed')); };
        img.src = url;
      });
    }

    if (compression === 1) {
      // Palette: 256 BGRA entries starting at 0x9C
      const palOff = 0x9C;
      const palette = new Array(256);
      for (let i = 0; i < 256; i++) {
        const o = palOff + i*4;
        palette[i] = [u8[o+2], u8[o+1], u8[o], u8[o+3]]; // BGRA → RGBA
      }
      const mipOff  = mipOffsets[0];
      const pixCount = width * height;
      const rgba = new Uint8ClampedArray(pixCount * 4);

      for (let i = 0; i < pixCount; i++) {
        const [r, g, b] = palette[u8[mipOff + i]];
        let a = 255;
        if (alphaDepth === 0) {
          a = 255;
        } else if (alphaDepth === 1) {
          const alphaOff = mipOff + pixCount;
          a = ((u8[alphaOff + (i >> 3)] >>> (i & 7)) & 1) ? 255 : 0;
        } else if (alphaDepth === 4) {
          const alphaOff = mipOff + pixCount;
          const nibble = (i & 1) ? (u8[alphaOff + (i >> 1)] >>> 4) : (u8[alphaOff + (i >> 1)] & 0xF);
          a = (nibble * 17)|0;
        } else if (alphaDepth === 8) {
          a = u8[mipOff + pixCount + i];
        }
        rgba[i*4]   = r;
        rgba[i*4+1] = g;
        rgba[i*4+2] = b;
        rgba[i*4+3] = a;
      }
      return { rgba, width, height };
    }

    throw new Error(`BLP1: unsupported compression type ${compression}`);
  }

  // ── BLP2 ─────────────────────────────────────────────────────────────────
  async function decodeBLP2(dv, u8) {
    // Byte fields
    const encoding      = u8[0x04]; // 1=palette/raw, 2=DXTC
    const alphaDepth    = u8[0x05]; // 0,1,4,8
    const alphaEncoding = u8[0x06]; // 0=DXT1, 1=DXT3, 7=DXT5
    const width         = dv.getUint32(0x08, true);
    const height        = dv.getUint32(0x0C, true);

    const mipOffsets = [], mipSizes = [];
    for (let i = 0; i < 16; i++) {
      mipOffsets.push(dv.getUint32(0x10 + i*4, true));
      mipSizes.push(  dv.getUint32(0x50 + i*4, true));
    }

    const mipOff  = mipOffsets[0];
    const mipSize = mipSizes[0];
    const rgba    = new Uint8ClampedArray(width * height * 4);

    if (encoding === 1) {
      // Palette at 0x94 (148 decimal)
      const palOff = 0x94;
      const palette = new Array(256);
      for (let i = 0; i < 256; i++) {
        const o = palOff + i*4;
        palette[i] = [u8[o+2], u8[o+1], u8[o], u8[o+3]]; // BGRA → RGBA
      }
      const pixCount = width * height;
      for (let i = 0; i < pixCount; i++) {
        const [r, g, b] = palette[u8[mipOff + i]];
        let a = 255;
        if (alphaDepth === 1) {
          const aOff = mipOff + pixCount;
          a = ((u8[aOff + (i >> 3)] >>> (i & 7)) & 1) ? 255 : 0;
        } else if (alphaDepth === 4) {
          const aOff = mipOff + pixCount;
          const nibble = (i & 1) ? (u8[aOff + (i >> 1)] >>> 4) : (u8[aOff + (i >> 1)] & 0xF);
          a = (nibble * 17)|0;
        } else if (alphaDepth === 8) {
          a = u8[mipOff + pixCount + i];
        }
        rgba[i*4]   = r;
        rgba[i*4+1] = g;
        rgba[i*4+2] = b;
        rgba[i*4+3] = a;
      }
    } else if (encoding === 2) {
      // DXTC
      const src = u8.slice(mipOff, mipOff + mipSize);
      const bw  = Math.ceil(width  / 4);
      const bh  = Math.ceil(height / 4);

      // Determine which DXT variant
      // alphaDepth 0 or alphaEncoding 0 → DXT1 (8 bytes/block)
      // alphaEncoding 1 → DXT3 (16 bytes/block)
      // alphaEncoding 7 → DXT5 (16 bytes/block)
      const isDXT1 = (alphaDepth === 0 || alphaEncoding === 0);
      const isDXT3 = (alphaEncoding === 1);
      const blockSize = isDXT1 ? 8 : 16;

      let off = 0;
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          if (isDXT1)      decodeDXT1(src, off, rgba, bx*4, by*4, width);
          else if (isDXT3) decodeDXT3(src, off, rgba, bx*4, by*4, width);
          else             decodeDXT5(src, off, rgba, bx*4, by*4, width);
          off += blockSize;
        }
      }
    } else if (encoding === 3) {
      // ARGB8888 raw
      for (let i = 0; i < width * height; i++) {
        const o = mipOff + i*4;
        rgba[i*4]   = u8[o+2]; // R (was B)
        rgba[i*4+1] = u8[o+1]; // G
        rgba[i*4+2] = u8[o];   // B (was R)
        rgba[i*4+3] = u8[o+3]; // A
      }
    } else {
      throw new Error(`BLP2: unsupported encoding ${encoding}`);
    }

    return { rgba, width, height };
  }

  // ── Public: decode BLP to { canvas } or { rgba, width, height } ──────────
  async function decodeBLP(arrayBuffer) {
    const u8     = new Uint8Array(arrayBuffer);
    const dv     = new DataView(arrayBuffer);
    const magic  = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);

    if (magic === 'BLP1') return decodeBLP1(dv, u8);
    if (magic === 'BLP2') return decodeBLP2(dv, u8);
    throw new Error(`Not a BLP file (magic bytes: "${magic}")`);
  }

  // ── Public: draw decoded BLP onto a <canvas> element ────────────────────
  async function drawBLPToCanvas(arrayBuffer, canvas) {
    const result = await decodeBLP(arrayBuffer);

    if (result.canvas) {
      // JPEG path — already rendered to an offscreen canvas
      canvas.width  = result.canvas.width;
      canvas.height = result.canvas.height;
      canvas.getContext('2d').drawImage(result.canvas, 0, 0);
      return;
    }

    const { rgba, width, height } = result;
    canvas.width  = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  }

  return { decodeBLP, drawBLPToCanvas };
})();

if (typeof module !== 'undefined') module.exports = BLPDecoder;
