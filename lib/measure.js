// 2-D measurements in mosaic pixel coordinates with conversion to micrometres.
// Every measurement keeps its raw pixel coordinates alongside the µm results.

export class MeasureError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function measurePoint(point, umPerPx, dims) {
  const p = inside(asPoint(point), dims, "point_outside_image");
  return {
    pixels: p,
    micrometres: { x: round3(p.x * umPerPx), y: round3(p.y * umPerPx) }
  };
}

export function measureLine(a, b, umPerPx, dims) {
  const p1 = inside(asPoint(a), dims, "line_endpoint_outside");
  const p2 = inside(asPoint(b), dims, "line_endpoint_outside");
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthPx = Math.sqrt(dx * dx + dy * dy);
  if (lengthPx === 0) throw new MeasureError("zero_length_line");
  return {
    pixels: { start: p1, end: p2 },
    pixelLength: round3(lengthPx),
    micrometres: {
      start: { x: round3(p1.x * umPerPx), y: round3(p1.y * umPerPx) },
      end: { x: round3(p2.x * umPerPx), y: round3(p2.y * umPerPx) },
      length: round3(lengthPx * umPerPx)
    }
  };
}

export function measureArea(rawPoints, umPerPx, dims) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 3) throw new MeasureError("area_needs_three_points");
  const mapped = rawPoints.map(p => inside(asPoint(p), dims, "area_point_outside"));
  // Vertices must not repeat. A double-click to close the polygon can append the
  // closing point twice (and some clients re-send the first point as the last);
  // collapse consecutive duplicates and a duplicated closing vertex.
  const pts = [];
  for (const p of mapped) {
    const prev = pts[pts.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) continue;
    pts.push(p);
  }
  if (pts.length >= 2) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first.x === last.x && first.y === last.y) pts.pop();
  }
  if (pts.length < 3) throw new MeasureError("area_needs_three_points");
  const twiceArea = shoelace(pts);
  if (twiceArea === 0) throw new MeasureError("degenerate_area");
  return {
    pixels: pts,
    pixelArea: round3(Math.abs(twiceArea) / 2),
    micrometres: { area: round3(Math.abs(twiceArea) / 2 * umPerPx * umPerPx) }
  };
}

function shoelace(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum);
}

function asPoint(v) {
  if (Array.isArray(v) && v.length >= 2) return { x: Number(v[0]), y: Number(v[1]) };
  if (v && typeof v === "object") return { x: Number(v.x), y: Number(v.y) };
  return { x: NaN, y: NaN };
}

function isPixelInt(v) {
  return Number.isInteger(v);
}

function inside(p, dims, code) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new MeasureError("point_coordinate_invalid");
  if (!isPixelInt(p.x) || !isPixelInt(p.y)) throw new MeasureError("point_coordinate_invalid");
  if (p.x < 0 || p.y < 0 || p.x >= dims.width || p.y >= dims.height) throw new MeasureError(code);
  return p;
}
