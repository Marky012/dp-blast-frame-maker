import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Precompute CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function hexToRgb(hex) {
  const clean = (hex || '#2563eb').replace('#', '');
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

/**
 * Generates a 1500x1500 RGBA transparent PNG frame with a colored border,
 * corner accents, and a bottom accent badge bar.
 */
export function generatePlaceholderFramePng(accentHex, teamIndex = 1) {
  const width = 1500;
  const height = 1500;
  const { r, g, b } = hexToRgb(accentHex);

  // Darker & lighter variants for dual-tone frame border
  const darkR = Math.max(0, Math.floor(r * 0.7));
  const darkG = Math.max(0, Math.floor(g * 0.7));
  const darkB = Math.max(0, Math.floor(b * 0.7));

  const rowStride = width * 4 + 1;
  const raw = Buffer.alloc(rowStride * height);

  const outerBorder = 56;
  const innerWhiteRing = 66;
  const innerAccentRing = 76;
  const bottomBarTop = 1320;

  // Pre-build reusable scanlines for speed
  // 1. Solid outer border row (y < outerBorder or y >= height - outerBorder)
  const solidRow = Buffer.alloc(rowStride);
  solidRow[0] = 0;
  for (let x = 0; x < width; x++) {
    const off = 1 + x * 4;
    solidRow[off] = r;
    solidRow[off + 1] = g;
    solidRow[off + 2] = b;
    solidRow[off + 3] = 255;
  }

  // 2. White ring top/bottom row
  const whiteRingRow = Buffer.alloc(rowStride);
  solidRow.copy(whiteRingRow);
  for (let x = outerBorder; x < width - outerBorder; x++) {
    const off = 1 + x * 4;
    whiteRingRow[off] = 255;
    whiteRingRow[off + 1] = 255;
    whiteRingRow[off + 2] = 255;
    whiteRingRow[off + 3] = 255;
  }

  // 3. Inner accent ring top/bottom row
  const innerAccentRow = Buffer.alloc(rowStride);
  whiteRingRow.copy(innerAccentRow);
  for (let x = innerWhiteRing; x < width - innerWhiteRing; x++) {
    const off = 1 + x * 4;
    innerAccentRow[off] = darkR;
    innerAccentRow[off + 1] = darkG;
    innerAccentRow[off + 2] = darkB;
    innerAccentRow[off + 3] = 255;
  }

  // 4. Middle transparent row (with left/right borders)
  const middleRow = Buffer.alloc(rowStride);
  middleRow[0] = 0;
  for (let x = 0; x < innerAccentRing; x++) {
    const rightX = width - 1 - x;
    let cr = r, cg = g, cb = b;
    if (x >= outerBorder && x < innerWhiteRing) {
      cr = 255; cg = 255; cb = 255;
    } else if (x >= innerWhiteRing) {
      cr = darkR; cg = darkG; cb = darkB;
    }
    const offL = 1 + x * 4;
    middleRow[offL] = cr;
    middleRow[offL + 1] = cg;
    middleRow[offL + 2] = cb;
    middleRow[offL + 3] = 255;

    const offR = 1 + rightX * 4;
    middleRow[offR] = cr;
    middleRow[offR + 1] = cg;
    middleRow[offR + 2] = cb;
    middleRow[offR + 3] = 255;
  }

  // 5. Bottom banner row (semi-transparent/solid badge bar at bottom)
  const bannerRow = Buffer.alloc(rowStride);
  middleRow.copy(bannerRow);
  for (let x = innerAccentRing; x < width - innerAccentRing; x++) {
    const off = 1 + x * 4;
    bannerRow[off] = darkR;
    bannerRow[off + 1] = darkG;
    bannerRow[off + 2] = darkB;
    bannerRow[off + 3] = 235;
  }

  // 6. Banner top gold/white trim row
  const bannerTrimRow = Buffer.alloc(rowStride);
  middleRow.copy(bannerTrimRow);
  for (let x = innerAccentRing; x < width - innerAccentRing; x++) {
    const off = 1 + x * 4;
    bannerTrimRow[off] = 255;
    bannerTrimRow[off + 1] = 255;
    bannerTrimRow[off + 2] = 255;
    bannerTrimRow[off + 3] = 255;
  }

  for (let y = 0; y < height; y++) {
    const targetOffset = y * rowStride;
    if (y < outerBorder || y >= height - outerBorder) {
      solidRow.copy(raw, targetOffset);
    } else if (y < innerWhiteRing || y >= height - innerWhiteRing) {
      whiteRingRow.copy(raw, targetOffset);
    } else if (y < innerAccentRing || y >= height - innerAccentRing) {
      innerAccentRow.copy(raw, targetOffset);
    } else if (y >= bottomBarTop && y < bottomBarTop + 8) {
      bannerTrimRow.copy(raw, targetOffset);
    } else if (y >= bottomBarTop + 8 && y < height - innerAccentRing) {
      bannerRow.copy(raw, targetOffset);
    } else {
      middleRow.copy(raw, targetOffset);
    }
  }

  // Add subtle corner brackets inside the transparent zone so each team frame feels like a real photo frame
  const bracketSize = 48;
  const bracketThick = 10;
  const startCoord = innerAccentRing + 20;
  const endCoord = width - innerAccentRing - 20;

  const setPixel = (px, py, pr, pg, pb, pa = 255) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const idx = py * rowStride + 1 + px * 4;
    raw[idx] = pr;
    raw[idx + 1] = pg;
    raw[idx + 2] = pb;
    raw[idx + 3] = pa;
  };

  // Top-left & Top-right corner brackets
  for (let dy = 0; dy < bracketSize; dy++) {
    for (let dx = 0; dx < bracketSize; dx++) {
      if (dx < bracketThick || dy < bracketThick) {
        setPixel(startCoord + dx, startCoord + dy, r, g, b, 255);
        setPixel(endCoord - dx, startCoord + dy, r, g, b, 255);
      }
    }
  }

  // Draw decorative dots on the bottom banner corresponding to teamIndex (1..20)
  const dotCount = Math.min(Math.max(1, teamIndex), 12);
  const dotRadius = 10;
  const dotSpacing = 34;
  const totalDotsWidth = (dotCount - 1) * dotSpacing;
  const dotStartX = Math.floor(width / 2 - totalDotsWidth / 2);
  const dotCenterY = Math.floor((bottomBarTop + 8 + (height - innerAccentRing)) / 2);

  for (let i = 0; i < dotCount; i++) {
    const cx = dotStartX + i * dotSpacing;
    for (let dy = -dotRadius; dy <= dotRadius; dy++) {
      for (let dx = -dotRadius; dx <= dotRadius; dx++) {
        if (dx * dx + dy * dy <= dotRadius * dotRadius) {
          setPixel(cx + dx, dotCenterY + dy, 255, 255, 255, 255);
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const compressed = zlib.deflateSync(raw, { level: 1 });
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', iend),
  ]);
}

/**
 * Validates that a buffer is a valid PNG of exact dimensions (1500x1500) and <= maxBytes.
 */
export function validatePngBuffer(buf, expectedWidth = 1500, expectedHeight = 1500, maxBytes = 5 * 1024 * 1024) {
  if (!buf || !Buffer.isBuffer(buf)) {
    return { valid: false, error: `Frame must be a ${expectedWidth}x${expectedHeight} PNG` };
  }
  if (buf.length > maxBytes) {
    return { valid: false, error: 'Frame PNG exceeds the 5 MB maximum file size.' };
  }
  if (buf.length < 24) {
    return { valid: false, error: `Frame must be a ${expectedWidth}x${expectedHeight} PNG` };
  }
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      return { valid: false, error: `Frame must be a ${expectedWidth}x${expectedHeight} PNG` };
    }
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    return { valid: false, error: `Frame must be a ${expectedWidth}x${expectedHeight} PNG` };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    return {
      valid: false,
      error: `Frame must be a ${expectedWidth}x${expectedHeight} PNG (received ${width}x${height}).`,
    };
  }
  return { valid: true, width, height };
}

