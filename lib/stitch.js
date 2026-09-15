// Mosaic assembly: estimate tile overlap by template matching, detect
// missing / mis-ordered fields of view, and feather-blend the complete thin-section image.
//
// Matching uses zero-normalised cross-correlation (ZNCC) on grayscale bands:
// genuinely overlapping content correlates near 1, unrelated texture near 0.
import { encodePng } from "./png.js";

const STEP_X = 2;
const STEP_Y = 2;

function grayAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
}

// ZNCC between left tile's right `ov` columns and right tile's left `ov` columns.
function horizontalZncc(left, right, ov) {
  const h = Math.min(left.height, right.height);
  const xs = [];
  const ys = [];
  for (let y = 0; y < h; y += STEP_Y) {
    for (let x = 0; x < ov; x += STEP_X) {
      xs.push(grayAt(left, left.width - ov + x, y));
      ys.push(grayAt(right, x, y));
    }
  }
  return zncc(xs, ys);
}

function verticalZncc(top, bottom, ov) {
  const w = Math.min(top.width, bottom.width);
  const xs = [];
  const ys = [];
  for (let y = 0; y < ov; y += STEP_Y) {
    for (let x = 0; x < w; x += STEP_X) {
      xs.push(grayAt(top, x, top.height - ov + y));
      ys.push(grayAt(bottom, x, y));
    }
  }
  return zncc(xs, ys);
}

function zncc(a, b) {
  const n = a.length;
  if (!n) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

// Search 5%-40% overlap for the strongest horizontal correlation.
function horizontalOverlap(left, right, declaredOverlap) {
  const minO = Math.max(4, Math.round(left.width * 0.05));
  const maxO = Math.round(left.width * 0.4);
  let best = { overlap: minO, score: -2 };
  for (let ov = minO; ov <= maxO; ov++) {
    const score = horizontalZncc(left, right, ov);
    if (score > best.score) best = { overlap: ov, score };
  }
  best.declaredScore = horizontalZncc(left, right, Math.min(Math.max(declaredOverlap, minO), maxO));
  best.expected = declaredOverlap;
  return best;
}

function verticalOverlap(top, bottom, declaredOverlap) {
  const minO = Math.max(4, Math.round(top.height * 0.05));
  const maxO = Math.round(top.height * 0.4);
  let best = { overlap: minO, score: -2 };
  for (let ov = minO; ov <= maxO; ov++) {
    const score = verticalZncc(top, bottom, ov);
    if (score > best.score) best = { overlap: ov, score };
  }
  best.declaredScore = verticalZncc(top, bottom, Math.min(Math.max(declaredOverlap, minO), maxO));
  best.expected = declaredOverlap;
  return best;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function round(n) {
  return n === null || Number.isNaN(n) ? null : Math.round(n * 1000) / 1000;
}

// Analyse present tiles without rendering. Caller guarantees calibration exists.
export function analyzeGrid(tiles, grid, overlapPx) {
  const expected = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) expected.push(`${r}-${c}`);
  }
  const missing = expected.filter(key => !tiles.some(t => t && t.key === key));

  const pairs = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols - 1; c++) {
      const a = tiles[r * grid.cols + c];
      const b = tiles[r * grid.cols + c + 1];
      if (a && b) pairs.push({ type: "horizontal", from: a.key, to: b.key, result: horizontalOverlap(a.img, b.img, overlapPx.x) });
    }
  }
  for (let r = 0; r < grid.rows - 1; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const a = tiles[r * grid.cols + c];
      const b = tiles[(r + 1) * grid.cols + c];
      if (a && b) pairs.push({ type: "vertical", from: a.key, to: b.key, result: verticalOverlap(a.img, b.img, overlapPx.y) });
    }
  }

  // A valid adjacency must correlate strongly AT the declared overlap, not merely
  // somewhere in the 5-40% search window.
  const DECLARED_MIN = 0.55;
  const weak = pairs
    .filter(p => p.result.declaredScore < DECLARED_MIN)
    .map(p => ({
      pair: `${p.from}→${p.to}`,
      direction: p.type,
      score: round(p.result.declaredScore),
      bestScore: round(p.result.score),
      foundOverlap: p.result.overlap,
      expectedOverlap: p.result.expected
    }));

  // Mis-ordering: the weak pair's left tile correlates much better with a
  // different tile's leading band — i.e. the field of view belongs elsewhere.
  const misordered = [];
  for (const w of weak) {
    const pair = pairs.find(p => `${p.from}→${p.to}` === w.pair && p.type === w.direction);
    if (!pair) continue;
    const leftImg = tiles.find(t => t.key === pair.from)?.img;
    if (!leftImg) continue;
    const span = pair.type === "horizontal" ? leftImg.width : leftImg.height;
    const band = Math.min(Math.max(pair.result.expected, 4), Math.round(span * 0.4));
    let better = { key: null, score: -2 };
    for (const cand of tiles) {
      if (!cand || cand.key === pair.from || cand.key === pair.to) continue;
      const score = pair.type === "horizontal"
        ? horizontalZncc(leftImg, cand.img, band)
        : verticalZncc(leftImg, cand.img, band);
      if (score > better.score) better = { key: cand.key, score };
    }
    if (better.key && better.score > w.score + 0.2 && better.score > DECLARED_MIN) {
      misordered.push({ pair: w.pair, likelyBelongsAfter: better.key, score: round(better.score) });
    }
  }

  return {
    complete: missing.length === 0,
    missing,
    pairs: pairs.map(p => ({
      direction: p.type, pair: `${p.from}→${p.to}`,
      score: round(p.result.declaredScore), bestScore: round(p.result.score),
      overlap: p.result.overlap, expectedOverlap: p.result.expected
    })),
    weakPairs: weak,
    misordered
  };
}

// Render the mosaic. Returns { png, width, height, stepX, stepY, placements }.
export function stitchMosaic(tiles, grid, overlapPx = { x: 0, y: 0 }) {
  const tileW = tiles[0].img.width;
  const tileH = tiles[0].img.height;
  if (tiles.some(t => !t.img || t.img.width !== tileW || t.img.height !== tileH)) {
    throw new Error("tile_dimensions_mismatch");
  }

  const horizontal = [];
  const vertical = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols - 1; c++) {
      horizontal.push(horizontalOverlap(tiles[r * grid.cols + c].img, tiles[r * grid.cols + c + 1].img, overlapPx.x));
    }
  }
  for (let r = 0; r < grid.rows - 1; r++) {
    for (let c = 0; c < grid.cols; c++) {
      vertical.push(verticalOverlap(tiles[r * grid.cols + c].img, tiles[(r + 1) * grid.cols + c].img, overlapPx.y));
    }
  }
  const medOvX = horizontal.length ? median(horizontal.map(p => p.overlap)) : overlapPx.x;
  const medOvY = vertical.length ? median(vertical.map(p => p.overlap)) : overlapPx.y;
  const stepX = tileW - medOvX;
  const stepY = tileH - medOvY;

  const width = (grid.cols - 1) * stepX + tileW;
  const height = (grid.rows - 1) * stepY + tileH;
  // Float accumulators: weighted RGB sums in overlap regions exceed 255, so a
  // uint8 buffer would silently wrap and produce dark seam artifacts.
  const accR = new Float64Array(width * height);
  const accG = new Float64Array(width * height);
  const accB = new Float64Array(width * height);
  const weight = new Float64Array(width * height);

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const tile = tiles[r * grid.cols + c];
      const ox = c * stepX;
      const oy = r * stepY;
      for (let y = 0; y < tileH; y++) {
        // Tent feather measured in each tile's own frame. It ramps across the
        // overlap band but never reaches 0, so singly-covered border pixels keep
        // their full colour after normalisation.
        const wy = grid.rows > 1
          ? r === 0 ? Math.min(1, (y + 1) / stepY)
          : r === grid.rows - 1 ? Math.min(1, (tileH - y) / stepY)
          : 1
          : 1;
        const srcRow = y * tileW * 4;
        const dstRow = (oy + y) * width + ox;
        for (let x = 0; x < tileW; x++) {
          const wx = grid.cols > 1
            ? c === 0 ? Math.min(1, (x + 1) / stepX)
            : c === grid.cols - 1 ? Math.min(1, (tileW - x) / stepX)
            : 1
            : 1;
          const wv = wx * wy;
          const di = dstRow + x;
          const si = srcRow + x * 4;
          accR[di] += tile.img.data[si] * wv;
          accG[di] += tile.img.data[si + 1] * wv;
          accB[di] += tile.img.data[si + 2] * wv;
          weight[di] += wv;
        }
      }
    }
  }
  const canvas = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const wv = weight[i] || 1;
    canvas[i * 4] = Math.max(0, Math.min(255, accR[i] / wv));
    canvas[i * 4 + 1] = Math.max(0, Math.min(255, accG[i] / wv));
    canvas[i * 4 + 2] = Math.max(0, Math.min(255, accB[i] / wv));
    canvas[i * 4 + 3] = 255;
  }

  return {
    png: encodePng({ width, height, data: canvas }),
    width,
    height,
    stepX,
    stepY,
    tileWidth: tileW,
    tileHeight: tileH,
    placements: tiles.map(t => ({ key: t.key, x: t.col * stepX, y: t.row * stepY }))
  };
}
