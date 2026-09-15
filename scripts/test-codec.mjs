// Unit tests for the PNG codec: grayscale / RGB / RGBA with filters 0-4,
// plus encoder roundtrip and corruption rejection.
import zlib from "node:zlib";
import { Buffer } from "node:buffer";
import { decodePng, encodePng, crc32, PngError } from "../lib/png.js";

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗ FAIL:", name, extra ?? ""); }
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width, height, channels, filterType, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = { 1: 0, 3: 2, 4: 6 }[channels];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const rawPix = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = pixelFn(x, y);
      for (let ch = 0; ch < channels; ch++) rawPix[(y * width + x) * channels + ch] = px[ch];
    }
  }
  function rb(i) { return i < 0 ? 0 : rawPix[i]; }
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filterType;
    for (let i = 0; i < stride; i++) {
      const abs = y * stride + i;
      const a = i >= channels ? rawPix[abs - channels] : 0;
      const b = y > 0 ? rawPix[abs - stride] : 0;
      const c = y > 0 && i >= channels ? rawPix[abs - stride - channels] : 0;
      const x = rawPix[abs];
      let v;
      switch (filterType) {
        case 0: v = x; break;
        case 1: v = x - a; break;
        case 2: v = x - b; break;
        case 3: v = x - ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = x - pr;
        }
      }
      raw[y * (stride + 1) + 1 + i] = v & 0xff;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const W = 7, H = 5;
const pixelFn = (x, y) => [(x * 37 + y * 11) & 0xff, (x * 7 + y * 53 + 40) & 0xff, (x * 91 + y * 5 + 90) & 0xff, 255];
const expected = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) expected.push(pixelFn(x, y));

for (const channels of [1, 3, 4]) {
  for (const filter of [0, 1, 2, 3, 4]) {
    const png = makePng(W, H, channels, filter, (x, y) => {
      const p = pixelFn(x, y);
      if (channels === 1) return [p[0]];
      if (channels === 3) return [p[0], p[1], p[2]];
      return p;
    });
    const img = decodePng(png);
    let ok = img.width === W && img.height === H;
    let i = 0;
    for (let y = 0; y < H && ok; y++) for (let x = 0; x < W && ok; x++, i++) {
      const e = expected[i];
      const g = channels === 1 ? [e[0], e[0], e[0], 255] : channels === 3 ? [e[0], e[1], e[2], 255] : e;
      const o = (y * W + x) * 4;
      for (let ch = 0; ch < 4; ch++) if (img.data[o + ch] !== g[ch]) ok = false;
    }
    check(`colorType ${channels} filter ${filter} 解码正确`, ok);
  }
}

// RGBA with real alpha
const alphaPng = makePng(2, 2, 4, 0, (x, y) => [10, 20, 30, x === y ? 128 : 255]);
const alphaImg = decodePng(alphaPng);
check("Alpha 通道保留", alphaImg.data[3] === 128 && alphaImg.data[7] === 255);

// encoder roundtrip preserves dimensions and pixels
const rgba = Buffer.alloc(4 * 3 * 2);
for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 53) & 0xff;
const encoded = encodePng({ width: 3, height: 2, data: rgba });
const round = decodePng(encoded);
check("编码后再解码像素一致", round.width === 3 && round.height === 2 && round.data.equals(rgba));

// corruption rejection
function rejects(name, buf) {
  try { decodePng(buf); check(name, false, "did not throw"); }
  catch (e) { check(name, e instanceof PngError); }
}
rejects("非 PNG 拒绝", Buffer.from("hello world this is not png"));
const broken = Buffer.from(encoded); broken[40] ^= 0xff;
rejects("CRC/数据损坏拒绝", broken);
const tiny = Buffer.alloc(10); SIGNATURE.copy(tiny);
rejects("截断文件拒绝", tiny);
check("尺寸不匹配编码拒绝", (() => {
  try { encodePng({ width: 2, height: 2, data: Buffer.alloc(8) }); return false; }
  catch { return true; }
})());

console.log(`\nPNG 编解码: ${passed} 通过, ${failed} 失败`);
if (failed) process.exit(1);
