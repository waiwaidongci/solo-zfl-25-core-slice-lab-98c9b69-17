// Minimal zero-dependency PNG codec: decode 8-bit grayscale/RGB/RGBA (filters 0-4,
// non-interlaced) and encode 8-bit RGBA. Enough for microscope field-of-view tiles.
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export class PngError extends Error {}

export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngError("not_a_png");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new PngError("truncated_chunk");
    const data = buffer.subarray(dataStart, dataEnd);
    const storedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32(Buffer.concat([buffer.subarray(offset + 4, offset + 8), data])) !== storedCrc) {
      throw new PngError("crc_mismatch");
    }
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (data[10] !== 0 || data[11] !== 0) throw new PngError("unsupported_compression");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height) throw new PngError("missing_ihdr");
  if (bitDepth !== 8) throw new PngError("unsupported_bit_depth");
  if (interlace !== 0) throw new PngError("interlaced_unsupported");
  const channels = { 0: 1, 2: 3, 6: 4 }[colorType];
  if (!channels) throw new PngError("unsupported_color_type");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) throw new PngError("bad_image_data");

  const rgba = Buffer.alloc(width * height * 4);

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const prevStart = (y - 1) * (stride + 1) + 1;
    const outStart = y * width * 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? raw[rowStart + x - channels] : 0;
      const b = y > 0 ? raw[prevStart + x] : 0;
      const c = y > 0 && x >= channels ? raw[prevStart + x - channels] : 0;
      let v = raw[rowStart + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new PngError("bad_filter");
      v &= 0xff;
      raw[rowStart + x] = v;
      const pixel = (x / channels) | 0;
      const ch = x % channels;
      const outIdx = outStart + pixel * 4;
      if (colorType === 0) {
        rgba[outIdx] = rgba[outIdx + 1] = rgba[outIdx + 2] = v;
        rgba[outIdx + 3] = 255;
      } else if (colorType === 2) {
        rgba[outIdx + ch] = v;
        if (ch === 2) rgba[outIdx + 3] = 255;
      } else {
        rgba[outIdx + ch] = v;
      }
    }
  }

  return { width, height, data: rgba };
}

export function encodePng({ width, height, data }) {
  if (data.length !== width * height * 4) throw new PngError("bad_rgba_size");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
