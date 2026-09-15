// End-to-end walk-through: calibration -> stitch -> measurement -> blocking
// -> concurrent duplicate -> failure rollback -> restart persistence.
// Spawns the real server against an isolated DATA_DIR.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const fixtures = path.join(root, "data", "fixtures");

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗ FAIL:", name, extra ?? ""); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

async function fixture(setName, key) {
  return readFile(path.join(fixtures, setName, `${key}.png`));
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", d => { logs += d; });
  child.stderr.on("data", d => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(base + "/api/samples");
      if (res.ok) return { child, base, logs };
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not start\n" + logs);
}

async function req(base, method, p, body, raw) {
  const opts = { method };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(base + p, opts);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
}
const J = (base, method, p, body) => req(base, method, p, body, false);
const B = (base, method, p, buf) => req(base, method, p, buf, true);

async function newSample(base, sliceId) {
  const { status, data } = await J(base, "POST", "/api/samples", {
    project: "测试项目-" + sliceId, borehole: "ZK-T", coreBox: "BX-T", depth: "10m",
    owner: "测试员", sliceId, method: "无染色"
  });
  if (status !== 201) throw new Error("sample create failed: " + JSON.stringify(data));
  return data.id;
}

async function calib(base, slice, rows, cols, extra = {}) {
  return J(base, "PUT", `/api/slices/${slice}/calibration`, {
    magnification: 100, scaleLengthUm: 100, scalePixels: 200, // 0.5 µm/px
    rows, cols, overlap: 25, ...extra
  });
}

const run = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "corelab-e2e-"));
  const port = 3000 + Math.floor(Math.random() * 500);
  console.log("data dir:", dataDir, "port:", port);
  let server = await startServer(dataDir, port);
  const base = server.base;

  // ---- 0. legacy entry + API preserved ----
  console.log("\n[legacy] 旧入口与旧接口保留");
  const home = await fetch(base + "/");
  check("GET / 旧页面可打开", home.status === 200 && (await home.text()).includes("岩芯样本切片实验室"));
  const micro = await fetch(base + "/micro");
  check("GET /micro 新工作台可打开", micro.status === 200 && (await micro.text()).includes("显微影像采集"));
  const seeded = await J(base, "GET", "/api/samples");
  check("种子数据仍在 (CORE-001)", seeded.data.some(s => s.id === "CORE-001"));

  await newSample(base, "S-MAIN");
  await newSample(base, "S-BLUR");
  await newSample(base, "S-SWAP");
  await newSample(base, "S-DUP");
  await newSample(base, "S-SMALL");
  const log = await J(base, "POST", "/api/samples/CORE-001/slices/SL-001-A/logs", { step: "观察", note: "旧流程记录" });
  check("旧接口步骤记录正常", log.status === 200);

  // ---- 1. calibration gates ----
  console.log("\n[calibration] 标尺校准与校验");
  const beforeCalib = await B(base, "PUT", "/api/slices/S-MAIN/tiles/0-0", await fixture("good", "0-0"));
  check("未校准不能上传视野", beforeCalib.status === 409 && beforeCalib.data.error === "scale_not_calibrated");
  const measEarly = await J(base, "POST", "/api/slices/S-MAIN/measurements", { type: "point", point: { x: 1, y: 1 } });
  check("未校准不能测量", measEarly.status === 409 && measEarly.data.error === "scale_not_calibrated");

  const badMag = await calib(base, "S-MAIN", 3, 3, { magnification: 7 });
  check("非法倍率拒绝", badMag.status === 422 && badMag.data.error === "invalid_magnification");
  const badScale = await calib(base, "S-MAIN", 3, 3, { scalePixels: 0 });
  check("非法标尺拒绝", badScale.status === 422 && badScale.data.error === "invalid_scale");
  const badGrid = await calib(base, "S-MAIN", 0, 3);
  check("非法网格拒绝", badGrid.status === 422 && badGrid.data.error === "invalid_grid");

  // Non-finite / oversized scale must be rejected up front (no null umPerPx later).
  const infScale = await calib(base, "S-MAIN", 3, 3, { scaleLengthUm: 1e999, scalePixels: 1 });
  check("超大标尺(Infinity)拒绝", infScale.status === 422 && infScale.data.error === "invalid_scale");
  const nanScale = await calib(base, "S-MAIN", 3, 3, { scaleLengthUm: "abc", scalePixels: 10 });
  check("非数值标尺(NaN)拒绝", nanScale.status === 422 && nanScale.data.error === "invalid_scale");
  const negScale = await calib(base, "S-MAIN", 3, 3, { scaleLengthUm: -5, scalePixels: 10 });
  check("负标尺拒绝", negScale.status === 422 && negScale.data.error === "invalid_scale");
  const hugeButFinite = await calib(base, "S-MAIN", 3, 3, { scaleLengthUm: 1e12, scalePixels: 1 });
  check("超量程标尺拒绝", hugeButFinite.status === 422 && hugeButFinite.data.error === "invalid_scale");
  check("非法标尺未落库为已校准", (await J(base, "GET", "/api/slices/S-MAIN/micro")).data.calibrated === false);

  const c1 = await calib(base, "S-MAIN", 3, 3);
  check("校准成功 1px=0.5µm", c1.status === 200 && c1.data.calibration.umPerPx === 0.5);

  await calib(base, "S-BLUR", 2, 2);
  await calib(base, "S-SWAP", 2, 2);
  await calib(base, "S-DUP", 2, 2);
  await calib(base, "S-SMALL", 1, 1);

  // ---- 2. uploads: duplicate content, non-PNG rollback ----
  console.log("\n[upload] 上传质检与失败回滚");
  const junk = await B(base, "PUT", "/api/slices/S-DUP/tiles/0-1", Buffer.from("not a png at all"));
  check("非 PNG 拒绝", junk.status === 422 && junk.data.error === "not_a_png");
  check("失败后不留半张图", !existsSync(path.join(dataDir, "images", "S-DUP", "tile-0-1.png")));

  // Corrupt PNG compression: valid signature/IHDR but a bit-flipped IDAT stream.
  const validPng = await fixture("good", "0-1");
  const corrupt = Buffer.from(validPng);
  const idatPos = corrupt.indexOf(Buffer.from("IDAT")) + 4;
  for (let k = 0; k < 40; k++) corrupt[idatPos + k] ^= 0xff;
  const corruptUp = await B(base, "PUT", "/api/slices/S-DUP/tiles/0-1", corrupt);
  check("损坏 PNG 返回 422 校验失败(非 500)",
    corruptUp.status === 422
    && ["invalid_compressed_data", "bad_image_data", "crc_mismatch", "truncated_chunk"].includes(corruptUp.data.error),
    JSON.stringify(corruptUp.data));
  check("损坏 PNG 不留半张图/记录",
    !existsSync(path.join(dataDir, "images", "S-DUP", "tile-0-1.png"))
    && (await J(base, "GET", "/api/slices/S-DUP/micro")).data.tiles.length === 0);

  const dupMicro = await J(base, "GET", "/api/slices/S-DUP/micro");
  check("失败后不留视野记录", dupMicro.data.tiles.length === 0);

  const first = await B(base, "PUT", "/api/slices/S-DUP/tiles/0-0", await fixture("good", "0-0"));
  check("首次上传成功", first.status === 201 && first.data.sharpnessPassed === true);
  const sameKey = await B(base, "PUT", "/api/slices/S-DUP/tiles/0-0", await fixture("good", "0-0"));
  check("同视野重复上传 409", sameKey.status === 409 && sameKey.data.error === "field_already_uploaded");
  const sameContent = await B(base, "PUT", "/api/slices/S-DUP/tiles/0-1", await fixture("good", "0-0"));
  check("内容重复图片 409", sameContent.status === 409 && sameContent.data.error === "duplicate_image_content");
  const invalidKey = await B(base, "PUT", "/api/slices/S-DUP/tiles/9-9", await fixture("good", "0-1"));
  check("网格外视野位置拒绝", invalidKey.status === 422 && invalidKey.data.error === "invalid_field_key");

  // ---- 3. concurrent upload of the same FOV ----
  console.log("\n[concurrency] 同一视野并发上传只成功一次");
  const buf = await fixture("good", "0-1");
  const races = await Promise.all(Array.from({ length: 8 }, () =>
    B(base, "PUT", "/api/slices/S-SMALL/tiles/0-0", buf)));
  const wins = races.filter(r => r.status === 201).length;
  const occupied = races.filter(r => r.status === 409 && r.data.error === "field_already_uploaded").length;
  check("8 个并发请求恰好 1 个成功", wins === 1, "wins=" + wins);
  check("其余 7 个为 field_already_uploaded", occupied === 7, "occupied=" + occupied);
  const afterRace = await J(base, "GET", "/api/slices/S-SMALL/micro");
  check("只有 1 条视野记录", afterRace.data.tiles.length === 1);
  const tileFiles = await readdir(path.join(dataDir, "images", "S-SMALL"));
  check("只有 1 个视野文件、无 tmp 残留", tileFiles.length === 1 && tileFiles[0] === "tile-0-0.png", JSON.stringify(tileFiles));

  // ---- 3b. slice-id isolation: traversal must never touch the filesystem ----
  console.log("\n[security] 非法/越界切片编号隔离");
  const traversalIds = [
    "..%2F..%2Fpwned",
    "..%2F..%2Fpwned%2F",
    encodeURIComponent("../../pwned"),
    encodeURIComponent("../pwned"),
    "a%00.png",
    encodeURIComponent("x/y"),
    encodeURIComponent("x\\y"),
    "%2Fetc"
  ];
  for (const id of traversalIds) {
    const up = await B(base, "PUT", `/api/slices/${id}/tiles/0-0`, buf);
    check(`越界编号上传拒绝 ${id}`, up.status === 400 && up.data.error === "invalid_slice_id", JSON.stringify(up.data));
  }
  // Traversal must never create files/dirs outside the images directory.
  check("images 目录之外无逃逸文件",
    !existsSync(path.join(dataDir, "pwned"))
    && !existsSync(path.join(dataDir, "pwned.png"))
    && !existsSync(path.join(dataDir, "images", "..", "pwned")));
  const created = await J(base, "POST", "/api/samples", {
    project: "evil", borehole: "b", coreBox: "c", depth: "d", owner: "o",
    sliceId: "../evil-slice", method: "m"
  });
  check("建档时非法切片编号拒绝", created.status === 422 && created.data.error === "invalid_slice_id");
  const addSliceEvil = await J(base, "POST", "/api/samples/CORE-001/slices", { id: "../evil2", method: "m" });
  check("加切片时非法编号拒绝", addSliceEvil.status === 422 && addSliceEvil.data.error === "invalid_slice_id");
  const dupId = await J(base, "POST", "/api/samples/CORE-001/slices", { id: "SL-001-A", method: "m" });
  check("同样本重复切片编号拒绝", dupId.status === 409 && dupId.data.error === "slice_id_exists");

  // ---- 3c. slice id must be unique across ALL samples ----
  console.log("\n[unique] 切片编号跨样本全局唯一");
  const sampleCountBefore = (await J(base, "GET", "/api/samples")).data.length;
  // A normal first creation with a Chinese id (legacy-friendly) must still work.
  const cnId = "薄片-全局-甲";
  const ownerSample = await newSample(base, cnId);
  check("合法中文编号建档成功", typeof ownerSample === "string" && ownerSample.startsWith("CORE-"));
  // Creating a NEW sample carrying the same slice id must be rejected.
  const createBody = {
    project: "另一个样本", borehole: "ZK-O", coreBox: "BX-O", depth: "9m",
    owner: "他人", sliceId: cnId, method: "无染色"
  };
  const crossCreate = await J(base, "POST", "/api/samples", createBody);
  check("跨样本建档重复编号拒绝", crossCreate.status === 409 && crossCreate.data.error === "slice_id_exists");
  // Adding that id to an unrelated sample must also be rejected.
  const crossAdd = await J(base, "POST", `/api/samples/${ownerSample}/slices`, { id: cnId, method: "m" });
  check("跨样本追加重复编号拒绝", crossAdd.status === 409 && crossAdd.data.error === "slice_id_exists");
  // Failure must not change the samples list, images, mosaic or measurements.
  const uniqAfter = await J(base, "GET", "/api/samples");
  const sliceOccurrences = uniqAfter.data.reduce(
    (n, s) => n + s.slices.filter(x => x.id === cnId).length, 0);
  check("失败后样本数不变", uniqAfter.data.length === sampleCountBefore + 1,
    `before+1=${sampleCountBefore + 1} got=${uniqAfter.data.length}`);
  check("失败后该编号仍只出现一次", sliceOccurrences === 1, "n=" + sliceOccurrences);
  check("失败后不产生影像目录", !existsSync(path.join(dataDir, "images", cnId)));

  // Concurrent duplicate creation across samples: exactly one must win.
  const raceId = "薄片-并发-同号";
  const raceReqs = Array.from({ length: 8 }, (_, i) =>
    J(base, "POST", "/api/samples", {
      project: "并发-" + i, borehole: "ZK-R", coreBox: "BX-R", depth: "1m",
      owner: "r", sliceId: raceId, method: "m"
    }));
  const raceResults = await Promise.all(raceReqs);
  const raceWins = raceResults.filter(r => r.status === 201).length;
  const raceLost = raceResults.filter(r => r.status === 409 && r.data.error === "slice_id_exists").length;
  check("并发建档同号恰好 1 个成功", raceWins === 1, "wins=" + raceWins);
  check("其余并发同号全部 409", raceLost === 7, "lost=" + raceLost);
  const raceSamples = await J(base, "GET", "/api/samples");
  const raceOccurrences = raceSamples.data.reduce(
    (n, s) => n + s.slices.filter(x => x.id === raceId).length, 0);
  check("并发后同号全局仅一条切片", raceOccurrences === 1, "n=" + raceOccurrences);
  check("并发失败不产生多余影像目录",
    (await readdir(path.join(dataDir, "images")).catch(() => [])).filter(f => f === raceId).length === 0);

  // Concurrent add-slice to two different existing samples with the same new id.
  const sA = await newSample(base, "S-CONC-A");
  const sB = await newSample(base, "S-CONC-B");
  const sharedId = "薄片-并发-追加";
  const addRace = await Promise.all([sA, sB].map(sampleId =>
    J(base, "POST", `/api/samples/${sampleId}/slices`, { id: sharedId, method: "m" })));
  const addWins = addRace.filter(r => r.status === 201).length;
  const addLost = addRace.filter(r => r.status === 409).length;
  check("并发追加同号到两样本恰好 1 个成功", addWins === 1 && addLost === 1,
    JSON.stringify(addRace.map(r => r.status)));
  const addSamples = await J(base, "GET", "/api/samples");
  const addOcc = addSamples.data.reduce(
    (n, s) => n + s.slices.filter(x => x.id === sharedId).length, 0);
  check("并发追加后同号全局仅一条切片", addOcc === 1, "n=" + addOcc);

  // ---- 4. coverage / sharpness / order blocking ----
  console.log("\n[blocking] 缺图、虚焦、乱序阻断拼图与测量");
  const missingStitch = await J(base, "POST", "/api/slices/S-DUP/stitch", {});
  check("覆盖不全不能拼图", missingStitch.status === 409 && missingStitch.data.error === "coverage_incomplete");
  const missingMeasure = await J(base, "POST", "/api/slices/S-DUP/measurements", { type: "point", point: { x: 0, y: 0 } });
  check("覆盖不全不能测量", missingMeasure.status === 409);

  for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const up = await B(base, "PUT", `/api/slices/S-BLUR/tiles/${r}-${c}`, await fixture("blurry", `${r}-${c}`));
    if (up.status !== 201) console.log("blur upload", r, c, up.status, up.data);
  }
  let blurState = await J(base, "GET", "/api/slices/S-BLUR/micro");
  check("虚焦视野被标记不合格", blurState.data.tiles.some(t => t.sharpnessPassed === false));
  const blurStitch = await J(base, "POST", "/api/slices/S-BLUR/stitch", {});
  check("虚焦视野阻断拼图", blurStitch.status === 409 && blurStitch.data.error === "unsharp_tiles");
  const blurMeasure = await J(base, "POST", "/api/slices/S-BLUR/measurements", { type: "point", point: { x: 0, y: 0 } });
  check("任一图不合格不能测量", blurMeasure.status === 409 && blurMeasure.data.error === "unsharp_tiles");

  for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const up = await B(base, "PUT", `/api/slices/S-SWAP/tiles/${r}-${c}`, await fixture("swapped", `${r}-${c}`));
    if (up.status !== 201) console.log("swap upload", r, c, up.status, up.data);
  }
  const swapStitch = await J(base, "POST", "/api/slices/S-SWAP/stitch", {});
  check("乱序视野阻断拼图", swapStitch.status === 422 && swapStitch.data.error === "fields_misordered");
  const swapList = await J(base, "GET", "/api/slices/S-SWAP/micro");
  check("乱序诊断给出疑似错位", (swapList.data.analysis?.misordered || []).length >= 1 || swapStitch.data.error === "fields_misordered");

  // ---- 5. happy path: stitch 3x3 ----
  console.log("\n[stitch] 正常拼图");
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const up = await B(base, "PUT", `/api/slices/S-MAIN/tiles/${r}-${c}`, await fixture("good", `${r}-${c}`));
    if (up.status !== 201) throw new Error("good upload failed " + r + "-" + c + " " + JSON.stringify(up.data));
  }
  const stitched = await J(base, "POST", "/api/slices/S-MAIN/stitch", {});
  check("3x3 拼图成功", stitched.status === 200 && stitched.data.mosaic.width > 320 && stitched.data.mosaic.height > 320);
  const mosaicW = stitched.data.mosaic.width;
  const mosaicH = stitched.data.mosaic.height;
  console.log("    mosaic:", mosaicW + "x" + mosaicH, "step", stitched.data.mosaic.stepX + "/" + stitched.data.mosaic.stepY);
  const mosaicPng = await fetch(base + "/api/slices/S-MAIN/mosaic.png");
  check("mosaic.png 可下载", mosaicPng.status === 200 && (await mosaicPng.arrayBuffer()).byteLength > 0);
  check("拼图诊断无弱匹配", (stitched.data.analysis?.weakPairs || []).length === 0, JSON.stringify(stitched.data.analysis?.weakPairs));

  // ---- 6. failure rollback: stitch failure keeps the existing mosaic ----
  console.log("\n[rollback] 故障时旧拼图保留、无测量记录污染");
  await writeFile(path.join(dataDir, "images", "S-MAIN", "tile-0-0.png"), Buffer.from("CORRUPTED"));
  const reStitch = await J(base, "POST", "/api/slices/S-MAIN/stitch", {});
  check("损坏视野导致拼图失败", reStitch.status === 422 && reStitch.data.error === "tile_unreadable");
  const afterFail = await J(base, "GET", "/api/slices/S-MAIN/micro");
  check("失败后旧拼图记录保留", afterFail.data.mosaic && afterFail.data.mosaic.width === mosaicW);
  const oldPng = await fetch(base + "/api/slices/S-MAIN/mosaic.png");
  check("失败后旧拼图文件仍可下载", oldPng.status === 200);
  // restore the good tile: clear mosaic -> delete -> re-upload -> re-stitch
  await J(base, "DELETE", "/api/slices/S-MAIN/stitch");
  const del = await J(base, "DELETE", "/api/slices/S-MAIN/tiles/0-0");
  check("删除损坏视野成功", del.status === 200);
  const reUp = await B(base, "PUT", "/api/slices/S-MAIN/tiles/0-0", await fixture("good", "0-0"));
  check("补传成功", reUp.status === 201);
  const stitched2 = await J(base, "POST", "/api/slices/S-MAIN/stitch", {});
  check("重新拼图成功", stitched2.status === 200);

  // ---- 7. measurements ----
  console.log("\n[measure] 点/线/面积：像素坐标 + µm 换算与异常阻断");
  const pt = await J(base, "POST", "/api/slices/S-MAIN/measurements", { type: "point", point: { x: 10, y: 20 } });
  check("点测量像素坐标保留", pt.status === 201 && pt.data.pixels.x === 10 && pt.data.pixels.y === 20);
  check("点测量 µm 换算正确 (0.5 µm/px)", approx(pt.data.micrometres.x, 5) && approx(pt.data.micrometres.y, 10));

  const ptOut = await J(base, "POST", "/api/slices/S-MAIN/measurements", { type: "point", point: { x: mosaicW, y: 0 } });
  check("图外点失败", ptOut.status === 422 && ptOut.data.error === "point_outside_image");
  const ptEdge = await J(base, "POST", "/api/slices/S-MAIN/measurements", { type: "point", point: { x: mosaicW - 1, y: mosaicH - 1 } });
  check("边界内最后一像素点成功", ptEdge.status === 201);
  const ptBad = await J(base, "POST", "/api/slices/S-MAIN/measurements", { type: "point", point: { x: "a", y: 0 } });
  check("非法坐标失败", ptBad.status === 422 && ptBad.data.error === "point_coordinate_invalid");

  const line = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "line", start: { x: 0, y: 0 }, end: { x: 3, y: 4 }
  });
  check("线测量 5px / 2.5µm", line.status === 201 && approx(line.data.pixelLength, 5) && approx(line.data.micrometres.length, 2.5));
  const zeroLine = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "line", start: { x: 5, y: 5 }, end: { x: 5, y: 5 }
  });
  check("零长度线失败", zeroLine.status === 422 && zeroLine.data.error === "zero_length_line");
  const lineOut = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "line", start: { x: 0, y: 0 }, end: { x: 0, y: mosaicH + 10 }
  });
  check("端点越界线失败", lineOut.status === 422 && lineOut.data.error === "line_endpoint_outside");

  const area = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "area", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }]
  });
  check("面积测量 6px² / 1.5µm²", area.status === 201 && approx(area.data.pixelArea, 6) && approx(area.data.micrometres.area, 1.5));

  // Double-click close appends the last vertex twice; server must collapse it
  // rather than store a repeated point (and still return the correct area).
  const dupClose = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "area", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }, { x: 0, y: 3 }]
  });
  check("重复收尾顶点被折叠", dupClose.status === 201 && dupClose.data.pixels.length === 3 && approx(dupClose.data.pixelArea, 6));
  const dupCyclic = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "area", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }, { x: 0, y: 0 }]
  });
  check("闭合点=起点被折叠", dupCyclic.status === 201 && dupCyclic.data.pixels.length === 3);
  const allDup = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "area", points: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }]
  });
  check("三点完全重合判退化/点数不足", allDup.status === 422
    && ["area_needs_three_points", "degenerate_area"].includes(allDup.data.error));
  const degArea = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "area", points: [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 8, y: 8 }]
  });
  check("退化面积失败", degArea.status === 422 && degArea.data.error === "degenerate_area");
  const shortArea = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "area", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }]
  });
  check("不足三点面积失败", shortArea.status === 422 && shortArea.data.error === "area_needs_three_points");
  const areaOut = await J(base, "POST", "/api/slices/S-MAIN/measurements", {
    type: "area", points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: mosaicH + 50 }]
  });
  check("顶点越界面积失败", areaOut.status === 422 && areaOut.data.error === "area_point_outside");

  const badType = await J(base, "POST", "/api/slices/S-MAIN/measurements", { type: "volume" });
  check("未知测量类型失败", badType.status === 422 && badType.data.error === "unknown_measurement_type");

  const measList = await J(base, "GET", "/api/slices/S-MAIN/measurements");
  // successful: 2 points + line + area + two deduped areas = 6; every failure wrote no record
  check("失败测量不落库 (恰 6 条成功记录)", measList.status === 200 && measList.data.length === 6, "n=" + measList.data?.length);

  // ---- 8. cross-slice coordinate isolation ----
  console.log("\n[isolation] 跨切片坐标失败");
  const smallStitch = await J(base, "POST", "/api/slices/S-SMALL/stitch", {});
  check("1x1 小切片拼图成功", smallStitch.status === 200 && smallStitch.data.mosaic.width === 320);
  const cross = await J(base, "POST", "/api/slices/S-SMALL/measurements", { type: "point", point: { x: 500, y: 500 } });
  check("大薄片坐标用于小切片失败", cross.status === 422 && cross.data.error === "point_outside_image");
  const crossLine = await J(base, "POST", "/api/slices/S-SMALL/measurements", {
    type: "line", start: { x: 0, y: 0 }, end: { x: 3, y: 4 }
  });
  check("小切片自身坐标可测量", crossLine.status === 201 && approx(crossLine.data.micrometres.length, 2.5));

  // ---- 9. calibration lock after measurements ----
  console.log("\n[lock] 测量后校准锁定");
  const recalib = await calib(base, "S-MAIN", 3, 3, { scalePixels: 400 });
  check("已有测量后改标尺被拒", recalib.status === 409 && recalib.data.error === "calibration_locked_by_measurements");

  // ---- 10. restart persistence + startup reconcile ----
  console.log("\n[restart] 重启数据不丢、孤儿/临时文件清理");
  // plant orphan slice dir and a stranded upload temp
  const ghostDir = path.join(dataDir, "images", "GHOST");
  await mkdir(ghostDir, { recursive: true });
  await writeFile(path.join(ghostDir, "tile-0-0.png.upload-9-9"), "junk");
  await writeFile(path.join(ghostDir, "tile-0-0.png"), "junk");
  const stranded = path.join(dataDir, "images", "S-MAIN", "mosaic.png.upload-9-10");
  await writeFile(stranded, "junk");
  // simulated crash mid stitch: old mosaic moved to .stage-backup, new stage abandoned
  const mainDir = path.join(dataDir, "images", "S-MAIN");
  const currentMosaic = await readFile(path.join(mainDir, "mosaic.png"));
  await rename(path.join(mainDir, "mosaic.png"), path.join(mainDir, ".stage-backup-7-11"));
  await writeFile(path.join(mainDir, ".stage-mosaic-7-12"), "partial-new-mosaic");

  server.child.kill("SIGTERM");
  await new Promise(r => server.child.on("exit", r));
  server = await startServer(dataDir, port);

  const after = await J(server.base, "GET", "/api/slices/S-MAIN/micro");
  check("重启后校准/视野/拼图仍在", after.data.calibrated && after.data.tiles.length === 9 && after.data.mosaic);
  const measAfter = await J(server.base, "GET", "/api/slices/S-MAIN/measurements");
  check("重启后测量记录仍在", measAfter.data.length === 6 && approx(measAfter.data.find(m=>m.type==="line").micrometres.length, 2.5));
  const pngAfter = await fetch(server.base + "/api/slices/S-MAIN/mosaic.png");
  check("重启后拼图文件仍可下载", pngAfter.status === 200);
  const restoredBytes = Buffer.from(await pngAfter.arrayBuffer());
  check("崩溃恢复还原旧拼图字节", restoredBytes.equals(currentMosaic));
  check("崩溃残留 stage 已清理", !existsSync(path.join(mainDir, ".stage-mosaic-7-12"))
    && !existsSync(path.join(mainDir, ".stage-backup-7-11")));
  check("启动清理 .upload 临时文件", !existsSync(stranded));
  check("启动清理无主切片目录文件", !existsSync(path.join(ghostDir, "tile-0-0.png")) && !existsSync(path.join(ghostDir, "tile-0-0.png.upload-9-9")));

  const samplesAfter = await J(server.base, "GET", "/api/samples");
  // seed CORE-001 + 5 setup samples + 4 uniqueness samples
  // (one Chinese-id owner, one concurrent-create winner, CONC-A, CONC-B);
  // every rejected/raced duplicate created nothing.
  const expectedSamples = 10;
  check("重启后样本与旧数据完整", samplesAfter.data.some(s => s.id === "CORE-001")
    && samplesAfter.data.length === expectedSamples,
    `got=${samplesAfter.data.length} want=${expectedSamples}`);

  server.child.kill("SIGTERM");
  await new Promise(r => server.child.on("exit", r));
  await rm(dataDir, { recursive: true, force: true });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed) process.exit(1);
};

run().catch(err => { console.error(err); process.exit(1); });
