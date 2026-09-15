// Generate deterministic synthetic thin-section micrographs with known overlap
// so the stitcher has real image content to align. No external deps.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../lib/png.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.FIXTURE_DIR || join(__dirname, "..", "data", "fixtures");

const TILE = 320;
const OVERLAP = 0.25;
const STEP = TILE * (1 - OVERLAP); // 240

// Deterministic pseudo-noise so every run produces identical files.
function noise2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const CRYSTALS = Array.from({ length: 46 }, (_, i) => ({
  x: 40 + noise2(i, 1, 7) * 720,
  y: 40 + noise2(i, 2, 7) * 720,
  r: 10 + noise2(i, 3, 7) * 30,
  hue: noise2(i, 4, 7),
  // unique speckle texture scale keeps each region from looking like any other
  scale: 3 + noise2(i, 5, 7) * 9,
  phase: noise2(i, 6, 7) * 6.28
}));

function virtualPixel(x, y) {
  // background grain (fine, non-periodic)
  let r = 120 + noise2(x * 2, y * 2, 11) * 22;
  let g = 112 + noise2(x * 2, y * 2, 12) * 20;
  let b = 96 + noise2(x * 2, y * 2, 13) * 18;
  // slow mineral shading, one broad wave (not a repeating stripe)
  const band = Math.sin(x / 130 + y / 210) * 12 + Math.cos(x / 300 - y / 170) * 8;
  r += band; g += band * 0.8; b += band * 0.5;
  for (const c of CRYSTALS) {
    const dx = x - c.x;
    const dy = y - c.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < c.r) {
      const edge = 1 - d / c.r;
      // internal cleavage speckle unique to each crystal
      const grain = noise2((x / c.scale) | 0, (y / c.scale) | 0, c.phase | 0 || 21) * 46;
      const tint = c.hue;
      r += (40 + tint * 40) * edge + grain * edge;
      g += (10 + (1 - tint) * 45) * edge + grain * edge * 0.7;
      b += (tint * 60) * edge;
    }
  }
  return [Math.min(255, r) | 0, Math.min(255, g) | 0, Math.min(255, b) | 0, 255];
}

function cropTile(row, col, { blur = false } = {}) {
  const data = Buffer.alloc(TILE * TILE * 4);
  const ox = col * STEP;
  const oy = row * STEP;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let px;
      if (blur) {
        // 7x7 box average: destroys the high-frequency detail -> out-of-focus field
        let rr = 0, gg = 0, bb = 0, n = 0;
        for (let ky = -3; ky <= 3; ky += 2) {
          for (let kx = -3; kx <= 3; kx += 2) {
            const p = virtualPixel(ox + x + kx, oy + y + ky);
            rr += p[0]; gg += p[1]; bb += p[2]; n++;
          }
        }
        px = [(rr / n) | 0, (gg / n) | 0, (bb / n) | 0, 255];
      } else {
        px = virtualPixel(ox + x, oy + y);
      }
      const i = (y * TILE + x) * 4;
      data[i] = px[0]; data[i + 1] = px[1]; data[i + 2] = px[2]; data[i + 3] = 255;
    }
  }
  return encodePng({ width: TILE, height: TILE, data });
}

async function writeSet(name, rows, cols, mutate) {
  await mkdir(join(outDir, name), { recursive: true });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let key = `${r}-${c}`;
      let opts = {};
      if (mutate) ({ key, opts } = mutate(r, c) || { key: `${r}-${c}`, opts: {} });
      await writeFile(join(outDir, name, `${key}.png`), cropTile(r, c, opts));
    }
  }
}

async function main() {
  // good: 3x3 sharp tiles
  await writeSet("good", 3, 3, null);
  // blurry: 2x2 with field 1-1 defocused
  await writeSet("blurry", 2, 2, (r, c) => ({ key: `${r}-${c}`, opts: { blur: r === 1 && c === 1 } }));
  // swapped: 2x2 with bottom-row tiles swapped (filenames still claim 1-0 / 1-1)
  await writeSet("swapped", 2, 2, (r, c) => {
    if (r === 1 && c === 0) return { key: "1-0", opts: {} }; // placeholder, replaced below
    return { key: `${r}-${c}`, opts: {} };
  });
  // rewrite swapped bottom row explicitly from opposite crops
  const buf01 = cropTile(1, 1); // image content belonging to position 1-1
  const buf10 = cropTile(1, 0); // content belonging to 1-0
  await writeFile(join(outDir, "swapped", "1-0.png"), buf01); // mis-filed
  await writeFile(join(outDir, "swapped", "1-1.png"), buf10); // mis-filed
  console.log(`fixtures written to ${outDir}`);
}

main().catch(err => { console.error(err); process.exit(1); });
