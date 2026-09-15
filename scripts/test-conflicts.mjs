// Legacy-database slice-key conflict tests.
// Builds historical snapshots on disk and spawns the real server against them:
//   1. single conflict group  -> must exit 1, list the id, never listen, no rewrites
//   2. multiple conflict groups -> same, listing every id
//   3. unique legacy snapshot -> starts, serves, reconciles temp/orphan files
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function slice(id, micro) {
  const base = { id, method: "无染色", observation: "", status: "研磨", logs: [] };
  if (micro) base.micro = micro;
  return base;
}
function microWithTile(key) {
  return {
    calibration: {
      magnification: 100, scaleLengthUm: 100, scalePixels: 200, umPerPx: 0.5,
      grid: { rows: 1, cols: 1 }, overlap: 25, calibratedAt: "2026-01-01T00:00:00.000Z"
    },
    tiles: [{ key, hash: "x", width: 320, height: 320, sharpness: 300, sharpnessPassed: true, uploadedAt: "2026-01-01T00:00:00.000Z" }],
    mosaic: null, analysis: null, measurements: []
  };
}
function sample(id, slices) {
  return {
    id, project: "P-" + id, borehole: "ZK", coreBox: "BX", depth: "1m", owner: "陆川",
    status: "制片中", delivery: "未交付", slices
  };
}
async function snapshot(dir, db, { images } = {}) {
  await mkdir(path.join(dir, "images"), { recursive: true });
  await writeFile(path.join(dir, "core-slices.json"), JSON.stringify(db, null, 2));
  if (images) for (const [rel, content] of Object.entries(images)) {
    const full = path.join(dir, "images", rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

async function hashFile(p) {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}
async function walk(dir) {
  let out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(await walk(full));
    else out.push({ rel: path.relative(dir, full), hash: await hashFile(full) });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const buf = { text: "" };
  child.stdout.on("data", d => { buf.text += d; });
  child.stderr.on("data", d => { buf.text += d; });
  return { child, out: buf };
}

async function expectAbort(dir, port, expectedIds) {
  const { child, out } = startServer(dir, port);
  // Wait for "close" (not "exit") so all stdio has been drained before assertions.
  const code = await new Promise(resolve => child.on("close", resolve));
  check("进程以非零码退出", code === 1, "code=" + code);
  check("未开始监听（无 listening 日志）", !out.text.includes("listening"), out.text.slice(0, 200));
  check("日志标注启动中止", out.text.includes("启动中止"), "missing banner");
  for (const id of expectedIds) check(`日志列出冲突编号 ${id}`, out.text.includes(JSON.stringify(id)), out.text);
  // not listening: a request must fail to connect
  let refused = false;
  try { await fetch(`http://127.0.0.1:${port}/api/samples`); } catch { refused = true; }
  check("端口无服务", refused);
  return out;
}

const run = async () => {
  // ---- 1. single conflict group ----
  console.log("\n[conflict] 单组旧库冲突");
  const dir1 = await mkdtemp(path.join(os.tmpdir(), "corelab-conf1-"));
  const port1 = 3000 + Math.floor(Math.random() * 400);
  await snapshot(dir1, {
    samples: [
      sample("CORE-A", [slice("SL-OLD"), slice("SL-ONLY-A")]),
      sample("CORE-B", [slice("SL-OLD"), slice("SL-ONLY-B")])
    ]
  }, {
    images: {
      "SL-OLD/tile-0-0.png": "PNG-bytes-A",
      "SL-OLD/mosaic.png": "mosaic-A",
      "GHOST/tile-0-0.png.upload-1-1": "stranded"
    }
  });
  const before1 = await walk(dir1);
  await expectAbort(dir1, port1, ["SL-OLD"]);
  const after1 = await walk(dir1);
  check("停机过程未重写/删除任何文件", JSON.stringify(before1) === JSON.stringify(after1),
    JSON.stringify({ before: before1.map(f => f.rel), after: after1.map(f => f.rel) }));

  // ---- 2. multiple conflict groups, incl. triple + intra-sample duplicate ----
  console.log("\n[conflict] 多组旧库冲突");
  const dir2 = await mkdtemp(path.join(os.tmpdir(), "corelab-conf2-"));
  const port2 = port1 + 1;
  await snapshot(dir2, {
    samples: [
      sample("CORE-A", [slice("SL-X"), slice("SL-Z"), slice("SL-Z")]), // SL-Z duplicated within one sample
      sample("CORE-B", [slice("SL-X"), slice("SL-Q")]),
      sample("CORE-C", [slice("SL-X"), slice("SL-Y")]),                // SL-X across three samples
      sample("CORE-D", [slice("SL-Y")])
    ]
  }, {
    images: {
      "SL-X/mosaic.png": "mosaic-X",
      "SL-X/measurements-keep.txt": "measurements are db rows; this proves images untouched"
    }
  });
  const before2 = await walk(dir2);
  const out2 = await expectAbort(dir2, port2, ["SL-X", "SL-Y", "SL-Z"]);
  const grouped = ["SL-X", "SL-Y", "SL-Z"].every(id => out2.text.includes(JSON.stringify(id)));
  check("全部冲突编号都被列出", grouped);
  check("三组冲突计数正确", (() => {
    const countFor = id => {
      const m = out2.text.match(new RegExp(`${JSON.stringify(id)}（(\\d+) 处）`));
      return m ? Number(m[1]) : null;
    };
    return countFor("SL-X") === 3 && countFor("SL-Y") === 2 && countFor("SL-Z") === 2;
  })(), out2.text);
  const after2 = await walk(dir2);
  check("停机过程未重写/删除任何文件", JSON.stringify(before2) === JSON.stringify(after2));

  // ---- 3. normal unique legacy snapshot starts and serves ----
  console.log("\n[normal] 唯一编号旧库正常启动");
  const dir3 = await mkdtemp(path.join(os.tmpdir(), "corelab-clean-"));
  const port3 = port2 + 1;
  await snapshot(dir3, {
    samples: [
      sample("CORE-A", [slice("薄片-甲", microWithTile("0-0")), slice("薄片-乙")]),
      sample("CORE-B", [slice("薄片-丙")])
    ]
  }, {
    // orphan/temp files reconcile must clean; a referenced tile must survive
    images: {
      "薄片-甲/tile-0-0.png": "valid-tile",
      "薄片-甲/mosaic.png.upload-2-3": "temp-mosaic",
      "GHOST/tile-0-0.png": "orphan"
    }
  });
  const { child, out } = startServer(dir3, port3);
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port3}/api/samples`)).ok) { up = true; break; } } catch {}
    await sleep(100);
  }
  check("唯一编号旧库正常监听", up);
  const list = await (await fetch(`http://127.0.0.1:${port3}/api/samples`)).json();
  check("旧样本全部加载", list.length === 2);
  const legacy = await fetch(`http://127.0.0.1:${port3}/`);
  check("旧入口可打开", legacy.status === 200);
  const micro = await fetch(`http://127.0.0.1:${port3}/micro`);
  check("显微入口可打开", micro.status === 200);
  // referenced image preserved; temp + orphan removed by reconcile
  check("引用的影像保留", existsSync(path.join(dir3, "images", "薄片-甲", "tile-0-0.png")));
  check("临时文件被清理", !existsSync(path.join(dir3, "images", "薄片-甲", "mosaic.png.upload-2-3")));
  check("孤儿目录被清理", !existsSync(path.join(dir3, "images", "GHOST", "tile-0-0.png")));
  child.kill("SIGTERM");
  await new Promise(r => child.on("exit", r));

  await rm(dir1, { recursive: true, force: true });
  await rm(dir2, { recursive: true, force: true });
  await rm(dir3, { recursive: true, force: true });

  console.log(`\n旧库冲突复测: ${passed} 通过, ${failed} 失败`);
  if (failed) process.exit(1);
};

run().catch(err => { console.error(err); process.exit(1); });
