import http from "node:http";
import { readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Store, isValidSliceId, PathEscapeError, SliceKeyConflict } from "./lib/store.js";
import { decodePng, PngError } from "./lib/png.js";
import { laplacianVariance, imageHash } from "./lib/vision.js";
import { analyzeGrid, stitchMosaic } from "./lib/stitch.js";
import { MeasureError, measurePoint, measureLine, measureArea } from "./lib/measure.js";
import { microPage } from "./lib/micro-page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
const port = Number(process.env.PORT || 3025);

// Below this Laplacian variance a field of view is treated as out of focus.
// Tuned against the synthetic fixture set (sharp tiles ~300, blurred ~25).
const SHARPNESS_MIN = 30;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ]
};

const store = new Store(dataDir, "core-slices.json", seed);

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, "payload_too_large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function rawBody(req, limit = MAX_IMAGE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "image_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res, error) {
  let status;
  if (error instanceof HttpError) status = error.status;
  else if (error instanceof PathEscapeError) status = 400;
  else if (error instanceof PngError) status = 422;
  else if (error instanceof MeasureError) status = 422;
  else status = 500;
  const code = error.code || error.message || "internal_error";
  sendJson(res, status, { error: code });
}

function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function findSlice(db, sliceId) {
  for (const sample of db.samples) {
    const slice = sample.slices.find(s => s.id === sliceId);
    if (slice) return { sample, slice };
  }
  return null;
}

// Slice ids are the key for every microscopy route, so they must be unique
// across ALL samples (not just within one). Check inside the write lock so
// concurrent creates of the same id only succeed once.
function assertSliceIdFree(db, sliceId) {
  for (const sample of db.samples) {
    if (sample.slices.some(s => s.id === sliceId)) {
      throw new HttpError(409, "slice_id_exists");
    }
  }
}

function requireSlice(db, sliceId) {
  const hit = findSlice(db, sliceId);
  if (!hit) throw new HttpError(404, "slice_not_found");
  return hit;
}

// Decode a slice id from a URL and reject anything that is not a plain label,
// so traversal sequences (.. %2f, encoded separators, NUL) never reach storage.
function decodeSliceId(raw) {
  let id;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_slice_id");
  }
  if (!isValidSliceId(id)) throw new HttpError(400, "invalid_slice_id");
  return id;
}

// ---- Microscopy domain rules ------------------------------------------------

function validKey(key, grid) {
  const m = /^(\d+)-(\d+)$/.exec(String(key || ""));
  if (!m) return false;
  const row = Number(m[1]);
  const col = Number(m[2]);
  return row >= 0 && row < grid.rows && col >= 0 && col < grid.cols;
}

function overlapPx(calib, tileWidthPx, tileHeightPx) {
  return {
    x: Math.round(tileWidthPx * calib.overlap / 100),
    y: Math.round(tileHeightPx * calib.overlap / 100)
  };
}

function microSummary(slice) {
  const m = slice.micro;
  if (!m) return { calibrated: false };
  const tiles = m.tiles.map(t => ({
    key: t.key,
    width: t.width,
    height: t.height,
    sharpness: round3(t.sharpness),
    sharpnessPassed: t.sharpnessPassed,
    uploadedAt: t.uploadedAt
  }));
  return {
    calibrated: true,
    calibration: m.calibration,
    tiles,
    mosaic: m.mosaic ? { at: m.mosaic.at, width: m.mosaic.width, height: m.mosaic.height, stepX: m.mosaic.stepX, stepY: m.mosaic.stepY } : null,
    analysis: m.analysis || null,
    measurementCount: (m.measurements || []).length
  };
}

// Measurement gate: scale calibrated + full coverage + every tile sharp + stitched.
function ensureMeasurable(slice) {
  const m = slice.micro;
  if (!m?.calibration) throw new HttpError(409, "scale_not_calibrated");
  const { rows, cols } = m.calibration.grid;
  if (m.tiles.length !== rows * cols) throw new HttpError(409, "coverage_incomplete");
  const blurry = m.tiles.filter(t => !t.sharpnessPassed).map(t => t.key);
  if (blurry.length) throw new HttpError(409, "unsharp_tiles");
  if (!m.mosaic) throw new HttpError(409, "mosaic_not_stitched");
}

async function registerCalibration(db, slice, input) {
  const magnification = Number(input.magnification);
  const scaleLengthUm = Number(input.scaleLengthUm);
  const scalePixels = Number(input.scalePixels);
  const rows = Number(input.rows);
  const cols = Number(input.cols);
  const overlap = Number(input.overlap);
  if (![40, 100, 200, 400].includes(magnification)) throw new HttpError(422, "invalid_magnification");
  // Both scale values must be finite, positive, and within sane physical bounds.
  // Non-finite input (Infinity/NaN) must be rejected up front, otherwise umPerPx
  // serialises to null and every later measurement silently fails downstream.
  if (!Number.isFinite(scaleLengthUm) || !Number.isFinite(scalePixels)
    || !(scaleLengthUm > 0) || !(scalePixels > 0)
    || scaleLengthUm > 1_000_000 || scalePixels > 100_000_000) {
    throw new HttpError(422, "invalid_scale");
  }
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 10 || cols > 10) {
    throw new HttpError(422, "invalid_grid");
  }
  if (!(overlap >= 5 && overlap <= 60)) throw new HttpError(422, "invalid_overlap");
  const umPerPx = scaleLengthUm / scalePixels;
  if (!Number.isFinite(umPerPx) || !(umPerPx > 0)) throw new HttpError(422, "invalid_scale");

  const existing = slice.micro;
  const shapeChanged = existing?.calibration && (
    existing.calibration.grid.rows !== rows
    || existing.calibration.grid.cols !== cols
    || Math.abs(existing.calibration.overlap - overlap) > 1e-9
  );
  if (shapeChanged && existing.tiles.length) {
    throw new HttpError(409, "grid_change_requires_clearing");
  }
  // Calibration is frozen once measurements depend on it.
  if (existing?.measurements?.length) throw new HttpError(409, "calibration_locked_by_measurements");

  let calibMosaicBackup = null;
  if (existing?.mosaic) {
    // Keep the previous bytes until the new state is durably flushed.
    calibMosaicBackup = store.privateStagePath(slice.id, "backup");
    await rename(store.mosaicPath(slice.id), calibMosaicBackup);
  }
  const prevMicro = slice.micro;
  slice.micro = {
    calibration: {
      magnification,
      scaleLengthUm,
      scalePixels,
      umPerPx: round3(umPerPx),
      grid: { rows, cols },
      overlap,
      calibratedAt: new Date().toISOString()
    },
    tiles: existing?.tiles || [],
    mosaic: null,
    analysis: null,
    measurements: []
  };
  try {
    await store.flush();
  } catch (error) {
    slice.micro = prevMicro;
    if (calibMosaicBackup) await rename(calibMosaicBackup, store.mosaicPath(slice.id)).catch(() => {});
    throw new HttpError(500, "calibration_failed");
  }
  if (calibMosaicBackup) await store.removeImage(calibMosaicBackup);
  return microSummary(slice);
}

async function uploadTile(db, slice, key, buffer) {
  const calib = slice.micro?.calibration;
  if (!calib) throw new HttpError(409, "scale_not_calibrated");
  if (!validKey(key, calib.grid)) throw new HttpError(422, "invalid_field_key");
  if (slice.micro.tiles.some(t => t.key === key)) throw new HttpError(409, "field_already_uploaded");

  let img;
  try {
    img = decodePng(buffer);
  } catch (error) {
    throw new HttpError(error instanceof PngError ? 422 : 500, error.message || "invalid_png");
  }
  if (img.width < 16 || img.height < 16) throw new HttpError(422, "image_too_small");

  // All fields of one acquisition must share dimensions (same lens/camera).
  const reference = slice.micro.tiles[0];
  if (reference && (reference.width !== img.width || reference.height !== img.height)) {
    throw new HttpError(422, "tile_dimensions_mismatch");
  }

  const hash = imageHash(buffer);
  if (slice.micro.tiles.some(t => t.hash === hash)) throw new HttpError(409, "duplicate_image_content");

  const sharpness = laplacianVariance(img);
  const passed = sharpness >= SHARPNESS_MIN;

  const record = {
    key,
    hash,
    width: img.width,
    height: img.height,
    sharpness: round3(sharpness),
    sharpnessPassed: passed,
    uploadedAt: new Date().toISOString()
  };

  const savedPath = await store.saveImage(slice.id, "tile", key, buffer);
  const prevMosaic = slice.micro.mosaic;
  const prevAnalysis = slice.micro.analysis;
  let mosaicBackup = null;
  if (prevMosaic) {
    // Move the old mosaic aside rather than delete it, so a flush failure can restore it.
    mosaicBackup = store.privateStagePath(slice.id, "backup");
    try {
      await rename(store.mosaicPath(slice.id), mosaicBackup);
    } catch (error) {
      await store.removeImage(savedPath);
      throw new HttpError(500, "upload_failed");
    }
    slice.micro.mosaic = null;
    slice.micro.analysis = null;
  }
  slice.micro.tiles.push(record);
  try {
    await store.flush();
  } catch (error) {
    // Roll back every observable effect: file, record, and any invalidated mosaic.
    await store.removeImage(savedPath);
    slice.micro.tiles.pop();
    if (mosaicBackup) await rename(mosaicBackup, store.mosaicPath(slice.id)).catch(() => {});
    slice.micro.mosaic = prevMosaic;
    slice.micro.analysis = prevAnalysis;
    throw new HttpError(500, "upload_failed");
  }
  if (mosaicBackup) await store.removeImage(mosaicBackup);
  return { tile: record, sharpnessPassed: passed };
}

async function deleteTile(db, slice, key) {
  const tiles = slice.micro?.tiles;
  if (!tiles) throw new HttpError(409, "scale_not_calibrated");
  if (!validKey(key, slice.micro.calibration.grid)) throw new HttpError(422, "invalid_field_key");
  if (slice.micro.mosaic) throw new HttpError(409, "clear_mosaic_first");
  const idx = tiles.findIndex(t => t.key === key);
  if (idx < 0) throw new HttpError(404, "field_not_found");
  const [removed] = tiles.splice(idx, 1);
  // Move the file aside first; only drop it once the DB state is durably flushed.
  const backup = store.tileBackupPath(slice.id, removed.key);
  let moved = false;
  try {
    await rename(store.tilePath(slice.id, removed.key), backup);
    moved = true;
  } catch { /* file already absent; DB still drives truth */ }
  try {
    await store.flush();
  } catch (error) {
    tiles.splice(idx, 0, removed);
    if (moved) await rename(backup, store.tilePath(slice.id, removed.key)).catch(() => {});
    throw new HttpError(500, "delete_failed");
  }
  if (moved) await store.removeImage(backup);
  return { removed: removed.key };
}

async function runStitch(db, slice) {
  const m = slice.micro;
  if (!m?.calibration) throw new HttpError(409, "scale_not_calibrated");
  const { grid } = m.calibration;
  if (m.tiles.length !== grid.rows * grid.cols) {
    throw new HttpError(409, "coverage_incomplete");
  }
  const blurry = m.tiles.filter(t => !t.sharpnessPassed).map(t => t.key);
  if (blurry.length) throw new HttpError(409, "unsharp_tiles");

  // Decode everything first — any decode failure aborts before anything is written.
  const decoded = new Map();
  for (const t of m.tiles) {
    const file = await readFile(store.tilePath(slice.id, t.key));
    try {
      decoded.set(t.key, { ...t, img: decodePng(file) });
    } catch {
      throw new HttpError(422, "tile_unreadable");
    }
  }
  const ordered = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const t = decoded.get(`${r}-${c}`);
      ordered.push({ ...t, row: r, col: c });
    }
  }

  const first = ordered[0].img;
  const expectedOverlap = overlapPx(m.calibration, first.width, first.height);
  const analysis = analyzeGrid(ordered, grid, expectedOverlap);
  if (!analysis.complete) throw new HttpError(409, "coverage_incomplete");
  if (analysis.misordered.length) throw new HttpError(422, "fields_misordered");
  if (analysis.weakPairs.length) throw new HttpError(422, "fields_not_aligned");

  const prevMosaic = m.mosaic;
  const prevAnalysis = m.analysis;
  let stage = null;
  let backup = null;
  let committed = false;
  try {
    const result = stitchMosaic(ordered, grid, expectedOverlap);
    stage = await store.stageMosaic(slice.id, result.png);
    // Swap files first (old bytes kept as a backup); reconcile handles a crash
    // in the middle of these renames.
    const swap = await store.commitMosaic(slice.id, stage);
    backup = swap.backup;
    committed = true;
    m.mosaic = {
      at: new Date().toISOString(),
      width: result.width,
      height: result.height,
      stepX: result.stepX,
      stepY: result.stepY,
      placements: result.placements
    };
    m.analysis = {
      at: new Date().toISOString(),
      stepX: result.stepX,
      stepY: result.stepY,
      pairs: analysis.pairs,
      weakPairs: analysis.weakPairs
    };
    await store.flush();
    await store.finishMosaicCommit(slice.id, backup);
  } catch (error) {
    // Full rollback: previous bytes and previous in-memory state are restored.
    m.mosaic = prevMosaic;
    m.analysis = prevAnalysis;
    if (committed) await store.abortMosaicCommit(slice.id, backup).catch(() => {});
    else if (stage) await store.removeImage(stage).catch(() => {});
    throw error instanceof HttpError ? error : new HttpError(500, "stitch_failed");
  }
  return microSummary(slice);
}

async function clearMosaic(db, slice) {
  const m = slice.micro;
  if (!m?.calibration) throw new HttpError(409, "scale_not_calibrated");
  if (!m.mosaic) throw new HttpError(404, "mosaic_not_found");
  if (m.measurements?.length) throw new HttpError(409, "mosaic_locked_by_measurements");
  const prevMosaic = m.mosaic;
  const prevAnalysis = m.analysis;
  const backup = store.privateStagePath(slice.id, "backup");
  await rename(store.mosaicPath(slice.id), backup);
  m.mosaic = null;
  m.analysis = null;
  try {
    await store.flush();
  } catch (error) {
    m.mosaic = prevMosaic;
    m.analysis = prevAnalysis;
    await rename(backup, store.mosaicPath(slice.id)).catch(() => {});
    throw new HttpError(500, "clear_failed");
  }
  await store.removeImage(backup);
  return microSummary(slice);
}

async function addMeasurement(db, slice, type, payload) {
  ensureMeasurable(slice);
  const { umPerPx } = slice.micro.calibration;
  const dims = { width: slice.micro.mosaic.width, height: slice.micro.mosaic.height };
  let result;
  if (type === "point") result = measurePoint(payload.point, umPerPx, dims);
  else if (type === "line") result = measureLine(payload.start, payload.end, umPerPx, dims);
  else if (type === "area") result = measureArea(payload.points, umPerPx, dims);
  else throw new HttpError(422, "unknown_measurement_type");

  const record = {
    id: `M-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    type,
    at: new Date().toISOString(),
    ...result
  };
  slice.micro.measurements.push(record);
  try {
    await store.flush();
  } catch (error) {
    slice.micro.measurements.pop();
    throw new HttpError(500, "measurement_failed");
  }
  return record;
}

// ---- HTTP server ------------------------------------------------------------

const page = await readFile(join(__dirname, "lib", "old-page.html"), "utf8");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && path === "/micro") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(microPage);
    }

    // ---- Legacy JSON API (unchanged behaviour) ----
    const db = store.db;
    if (req.method === "GET" && path === "/api/samples") return sendJson(res, 200, db.samples);

    if (req.method === "POST" && path === "/api/samples") {
      const input = await body(req);
      if (!isValidSliceId(input.sliceId)) throw new HttpError(422, "invalid_slice_id");
      const out = await store.withLock(async d => {
        assertSliceIdFree(d, input.sliceId);
        const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
        d.samples.unshift(sample);
        updateSampleStatus(sample);
        await store.flush();
        return sample;
      });
      return sendJson(res, 201, out);
    }

    const addSlice = path.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const input = await body(req);
      if (!isValidSliceId(input.id)) throw new HttpError(422, "invalid_slice_id");
      const out = await store.withLock(async d => {
        const sample = d.samples.find(item => item.id === addSlice[1]);
        if (!sample) throw new HttpError(404, "sample_not_found");
        assertSliceIdFree(d, input.id); // unique across every sample
        sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
        updateSampleStatus(sample);
        await store.flush();
        return sample;
      });
      return sendJson(res, 201, out);
    }

    const logMatch = path.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const input = await body(req);
      const out = await store.withLock(async d => {
        const sample = d.samples.find(item => item.id === logMatch[1]);
        if (!sample) throw new HttpError(404, "sample_not_found");
        const slice = sample.slices.find(item => item.id === logMatch[2]);
        if (!slice) throw new HttpError(404, "slice_not_found");
        slice.status = input.step;
        if (input.step === "观察") slice.observation = input.note || slice.observation;
        slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
        updateSampleStatus(sample);
        await store.flush();
        return sample;
      });
      return sendJson(res, 200, out);
    }

    const deliverMatch = path.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const out = await store.withLock(async d => {
        const sample = d.samples.find(item => item.id === deliverMatch[1]);
        if (!sample) throw new HttpError(404, "sample_not_found");
        sample.delivery = "已交付";
        updateSampleStatus(sample);
        await store.flush();
        return sample;
      });
      return sendJson(res, 200, out);
    }

    // ---- Microscopy API ----
    const sliceMicro = path.match(/^\/api\/slices\/([^/]+)\/micro$/);
    if (sliceMicro && req.method === "GET") {
      const hit = findSlice(store.db, decodeSliceId(sliceMicro[1]));
      if (!hit) return sendJson(res, 404, { error: "slice_not_found" });
      return sendJson(res, 200, microSummary(hit.slice));
    }

    const calibMatch = path.match(/^\/api\/slices\/([^/]+)\/calibration$/);
    if (calibMatch && req.method === "PUT") {
      const input = await body(req);
      const out = await store.withLock(d => {
        const hit = requireSlice(d, decodeSliceId(calibMatch[1]));
        return registerCalibration(d, hit.slice, input);
      });
      return sendJson(res, 200, out);
    }

    const tileImage = path.match(/^\/api\/slices\/([^/]+)\/tiles\/([\d]+-[\d]+)\.png$/);
    if (tileImage && req.method === "GET") {
      const hit = findSlice(store.db, decodeSliceId(tileImage[1]));
      if (!hit) return sendJson(res, 404, { error: "slice_not_found" });
      const file = store.tilePath(hit.slice.id, tileImage[2]);
      if (!existsSync(file)) return sendJson(res, 404, { error: "tile_not_found" });
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(await readFile(file));
    }

    const mosaicImage = path.match(/^\/api\/slices\/([^/]+)\/mosaic\.png$/);
    if (mosaicImage && req.method === "GET") {
      const hit = findSlice(store.db, decodeSliceId(mosaicImage[1]));
      if (!hit) return sendJson(res, 404, { error: "slice_not_found" });
      const file = store.mosaicPath(hit.slice.id);
      if (!existsSync(file)) return sendJson(res, 404, { error: "mosaic_not_found" });
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(await readFile(file));
    }

    const tileMatch = path.match(/^\/api\/slices\/([^/]+)\/tiles\/([\d]+-[\d]+)$/);
    if (tileMatch && (req.method === "PUT" || req.method === "DELETE")) {
      const sliceId = decodeSliceId(tileMatch[1]);
      const key = tileMatch[2];
      if (req.method === "DELETE") {
        const out = await store.withLock(d => {
          const hit = requireSlice(d, sliceId);
          return deleteTile(d, hit.slice, key);
        });
        return sendJson(res, 200, out);
      }
      const buffer = await rawBody(req);
      const out = await store.withLock(d => {
        const hit = requireSlice(d, sliceId);
        return uploadTile(d, hit.slice, key, buffer);
      });
      return sendJson(res, 201, out);
    }

    const stitchMatch = path.match(/^\/api\/slices\/([^/]+)\/stitch$/);
    if (stitchMatch && req.method === "POST") {
      const out = await store.withLock(d => {
        const hit = requireSlice(d, decodeSliceId(stitchMatch[1]));
        return runStitch(d, hit.slice);
      });
      return sendJson(res, 200, out);
    }
    if (stitchMatch && req.method === "DELETE") {
      await body(req);
      const out = await store.withLock(d => {
        const hit = requireSlice(d, decodeSliceId(stitchMatch[1]));
        return clearMosaic(d, hit.slice);
      });
      return sendJson(res, 200, out);
    }

    const measureMatch = path.match(/^\/api\/slices\/([^/]+)\/measurements$/);
    if (measureMatch && req.method === "GET") {
      const hit = findSlice(store.db, decodeSliceId(measureMatch[1]));
      if (!hit) return sendJson(res, 404, { error: "slice_not_found" });
      return sendJson(res, 200, hit.slice.micro?.measurements || []);
    }
    if (measureMatch && req.method === "POST") {
      const input = await body(req);
      const out = await store.withLock(d => {
        const hit = requireSlice(d, decodeSliceId(measureMatch[1]));
        return addMeasurement(d, hit.slice, input.type, input);
      });
      return sendJson(res, 201, out);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof SyntaxError) return sendError(res, new HttpError(400, "invalid_json"));
    sendError(res, error);
  }
});

async function main() {
  try {
    await store.init();
  } catch (error) {
    if (error instanceof SliceKeyConflict) {
      console.error("启动中止：检测到切片编号在多个样本中重复（显微接口按编号定位，重复键会导致数据被错误占用）。");
      for (const c of error.conflicts) {
        console.error(`  重复切片编号 ${JSON.stringify(c.sliceId)}（${c.count} 处）：样本 ${c.sampleIds.map(id => JSON.stringify(id)).join("、")}`);
      }
      console.error("请先合并/改名冲突切片后再启动。本次启动未修改任何数据。");
      // Don't call process.exit() here: it can cut off piped console output
      // before it drains. The HTTP server has never listened, so setting the
      // exit code lets the event loop flush stderr and then terminate on its own.
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port} (micro workbench: /micro)`));
}

main();
