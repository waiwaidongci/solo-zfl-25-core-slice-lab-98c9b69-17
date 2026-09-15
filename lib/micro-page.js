// Server-rendered single page for the microscope image-acquisition & 2-D measurement workbench.
export const microPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>显微影像采集与二维测量</title>
<style>
  :root { --bg:#eef1ea; --panel:#fff; --ink:#232820; --muted:#6b7264; --line:#d4dbc9; --accent:#4f6e40; --accent2:#315c78; --danger:#9a3b2e; --warn:#8a6516; --ok:#3f7a45; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
  header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:16px; }
  header h1 { margin:0; font-size:22px; }
  header a { color:var(--accent); text-decoration:none; border:1px solid var(--accent); border-radius:999px; padding:7px 13px; font-size:13px; font-weight:700; }
  main { padding:20px 26px; display:grid; grid-template-columns:400px 1fr; gap:18px; align-items:start; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
  h2 { margin:0 0 10px; font-size:16px; }
  label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12px; }
  input,select,button { font:inherit; }
  input[type=number],input[type=text],select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; background:#fff; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; }
  button.secondary { background:#fff; color:var(--accent); border:1px solid var(--accent); }
  button.blue { background:var(--accent2); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .meta { color:var(--muted); font-size:12px; }
  .alerts { margin:8px 0; display:grid; gap:6px; }
  .alert { border-radius:6px; padding:8px 10px; font-size:13px; border:1px solid; }
  .alert.err { background:#fbecea; border-color:#e3b8b0; color:var(--danger); }
  .alert.warn { background:#fbf4e2; border-color:#e5d19a; color:var(--warn); }
  .alert.ok { background:#eaf5ec; border-color:#b5d6bb; color:var(--ok); }
  .grid-tiles { display:grid; gap:8px; margin-top:8px; }
  .tile { border:1px solid var(--line); border-radius:6px; padding:8px; position:relative; background:#fafbf8; }
  .tile .pos { font-weight:700; font-size:13px; }
  .tile img { width:100%; display:block; margin-top:6px; border-radius:4px; image-rendering:pixelated; background:#dfe4d8; }
  .badge { display:inline-block; border-radius:999px; padding:2px 8px; font-size:11px; margin-left:6px; }
  .badge.ok { background:#e0efe2; color:var(--ok); }
  .badge.bad { background:#f8e2de; color:var(--danger); }
  .badge.miss { background:#eee; color:var(--muted); }
  #viewer { background:#262b23; border-radius:8px; padding:10px; overflow:auto; max-height:78vh; }
  #mosaicCanvas { background:#111; display:block; margin:0 auto; cursor:crosshair; max-width:100%; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { border-bottom:1px solid var(--line); text-align:left; padding:5px 6px; vertical-align:top; }
  th { color:var(--muted); font-weight:700; }
  .tools { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; align-items:center; }
  .tools button.active { outline:3px solid #b9cf9b; }
  .hint { font-size:12px; color:var(--muted); margin:4px 0; }
  @media (max-width:980px){ main{grid-template-columns:1fr;} }
</style>
</head>
<body>
<header>
  <h1>显微影像采集与二维测量</h1>
  <a href="/">← 样本切片工作台</a>
  <button id="reload" class="secondary">刷新数据</button>
</header>
<main>
  <div>
    <section class="panel">
      <h2>1. 选择切片</h2>
      <select id="sliceSelect"></select>
      <div class="meta" id="sliceInfo"></div>
    </section>

    <section class="panel">
      <h2>2. 镜头倍率与标尺校准</h2>
      <label>镜头倍率</label>
      <select id="magnification">
        <option value="40">40×（4倍物镜）</option>
        <option value="100">100×（10倍物镜）</option>
        <option value="200">200×（20倍物镜）</option>
        <option value="400">400×（40倍物镜）</option>
      </select>
      <div class="row">
        <div><label>标尺长度（µm）</label><input id="scaleLengthUm" type="number" min="0" step="0.1" placeholder="如 100"></div>
        <div><label>标尺像素（px）</label><input id="scalePixels" type="number" min="1" step="1" placeholder="如 200"></div>
      </div>
      <div class="row">
        <div><label>视野行数</label><input id="rows" type="number" min="1" max="10" step="1" value="2"></div>
        <div><label>视野列数</label><input id="cols" type="number" min="1" max="10" step="1" value="2"></div>
      </div>
      <label>相邻视野重叠率（%）</label><input id="overlap" type="number" min="5" max="60" step="1" value="20">
      <div class="hint" id="umPerPx"></div>
      <button id="saveCalib" style="margin-top:10px">登记 / 更新校准</button>
      <div class="hint">已产生测量记录后校准将锁定；改变网格/重叠率需先清空视野。</div>
    </section>

    <section class="panel">
      <h2>3. 视野图上传（需有重叠）</h2>
      <div class="hint">同一视野并发上传只成功一次；重复图片、乱序、缺图、虚焦都会在下方提示。</div>
      <div id="fieldGrid" class="grid-tiles"></div>
    </section>
  </div>

  <div>
    <section class="panel">
      <h2>4. 拼图与质检</h2>
      <div class="tools">
        <button id="stitchBtn">按重叠位置拼合薄片图</button>
        <button id="clearMosaic" class="secondary">清空拼图（以便替换视野）</button>
      </div>
      <div class="alerts" id="alerts"></div>
      <div id="viewer"><canvas id="mosaicCanvas"></canvas></div>
      <div class="hint" id="mosaicMeta"></div>
    </section>

    <section class="panel">
      <h2>5. 二维测量（原始像素坐标 + µm 换算）</h2>
      <div class="tools">
        <button data-tool="point" class="secondary">点</button>
        <button data-tool="line" class="secondary">线（点击两点）</button>
        <button data-tool="area" class="secondary">面积（≥3 点后双击闭合）</button>
        <button id="cancelTool" class="secondary">取消绘制</button>
      </div>
      <div class="hint" id="measureHint">标尺已校准、覆盖完整、全部清晰且拼图完成后可测量。</div>
      <table>
        <thead><tr><th>类型</th><th>原始像素</th><th>微米结果</th></tr></thead>
        <tbody id="measureRows"></tbody>
      </table>
    </section>
  </div>
</main>

<script>
const $ = s => document.querySelector(s);
let samples = [];
let sliceId = null;
let micro = null;
let tool = null;
let pending = [];

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

async function loadSamples() {
  samples = await api("/api/samples");
  const sel = $("#sliceSelect");
  const current = sliceId;
  sel.innerHTML = samples.flatMap(s => s.slices.map(sl => '<option value="'+esc(sl.id)+'">'+esc(s.id)+' · '+esc(sl.id)+'（'+esc(sl.method)+'）</option>')).join("");
  if (current && samples.some(s => s.slices.some(sl => sl.id === current))) sel.value = current;
  else {
    const qs = new URLSearchParams(location.search).get("slice");
    if (qs && [...sel.options].some(o => o.value === qs)) sel.value = qs;
    sliceId = sel.value;
  }
}
async function loadMicro() {
  try {
    micro = await api("/api/slices/"+encodeURIComponent(sliceId)+"/micro");
  } catch (e) {
    micro = { calibrated:false };
  }
  renderAll();
}

function renderAll() {
  renderSliceInfo();
  renderCalib();
  renderFieldGrid();
  renderMosaic();
  renderMeasurements();
}

function renderSliceInfo() {
  const sample = samples.find(s => s.slices.some(sl => sl.id === sliceId));
  const slice = sample && sample.slices.find(sl => sl.id === sliceId);
  $("#sliceInfo").innerHTML = slice
    ? esc(sample.project)+" · "+esc(sample.borehole)+" · 当前步骤 "+esc(slice.status)
    : "";
}

function renderCalib() {
  const c = micro.calibrated ? micro.calibration : null;
  if (c) {
    $("#magnification").value = c.magnification;
    $("#scaleLengthUm").value = c.scaleLengthUm;
    $("#scalePixels").value = c.scalePixels;
    $("#rows").value = c.grid.rows;
    $("#cols").value = c.grid.cols;
    $("#overlap").value = c.overlap;
    $("#umPerPx").textContent = "已校准：1 px = "+c.umPerPx+" µm（"+c.magnification+"×），校准时间 "+new Date(c.calibratedAt).toLocaleString();
  } else {
    $("#umPerPx").textContent = "尚未校准：不能上传视野或测量。";
  }
}

function renderFieldGrid() {
  const box = $("#fieldGrid");
  if (!micro.calibrated) { box.innerHTML = '<div class="meta">请先完成标尺校准。</div>'; return; }
  const { rows, cols } = micro.calibration.grid;
  box.style.gridTemplateColumns = "repeat("+cols+", minmax(120px,1fr))";
  let html = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = r+"-"+c;
      const t = micro.tiles.find(x => x.key === key);
      if (t) {
        const badge = t.sharpnessPassed
          ? '<span class="badge ok">清晰 '+t.sharpness+'</span>'
          : '<span class="badge bad">虚焦不合格 '+t.sharpness+'</span>';
        const del = micro.mosaic ? "" : ' <button class="secondary" data-del-tile="'+key+'" style="padding:2px 7px;font-size:11px">删除</button>';
        html += '<div class="tile"><div><span class="pos">视野 ['+r+','+c+']</span>'+badge+del+'</div>'
          + '<img src="/api/slices/'+encodeURIComponent(sliceId)+'/tiles/'+key+'.png?ts='+Date.now()+'" alt="'+key+'"></div>';
      } else {
        html += '<div class="tile"><div><span class="pos">视野 ['+r+','+c+']</span><span class="badge miss">缺图</span></div>'
          + '<label class="meta">选择 PNG</label><input type="file" accept="image/png" data-file="'+key+'"></div>';
      }
    }
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-file]").forEach(inp => inp.onchange = () => uploadTile(inp.dataset.file, inp.files[0], inp));
  box.querySelectorAll("[data-del-tile]").forEach(btn => btn.onclick = async () => {
    try { await api("/api/slices/"+encodeURIComponent(sliceId)+"/tiles/"+btn.dataset.delTile, { method:"DELETE" }); await loadMicro(); }
    catch (e) { flash(e.message, "err"); }
  });
}

async function uploadTile(key, file, inp) {
  if (!file) return;
  flash("上传视野 ["+key+"] …", "warn");
  try {
    await api("/api/slices/"+encodeURIComponent(sliceId)+"/tiles/"+key, { method:"PUT", body: file });
    flash("视野 ["+key+"] 上传成功。", "ok");
    await loadMicro();
  } catch (e) {
    flash("视野 ["+key+"] 被拒绝："+errorText(e.message), "err");
    if (inp) inp.value = "";
  }
}

function errorText(code) {
  return ({
    scale_not_calibrated:"标尺未校准",
    field_already_uploaded:"该视野已存在（并发上传只成功一次）",
    duplicate_image_content:"与已有视野图片内容重复",
    not_a_png:"不是有效的 PNG 文件",
    unsupported_color_type:"仅支持灰度/RGB/RGBA PNG",
    unsupported_bit_depth:"仅支持 8 位图像",
    interlaced_unsupported:"不支持隔行扫描 PNG",
    image_too_large:"图片超过 20MB",
    image_too_small:"图片尺寸过小",
    tile_dimensions_mismatch:"视野尺寸与已上传视野不一致（需同一镜头下等尺寸图像）",
    coverage_incomplete:"视野覆盖不完整（存在缺图）",
    unsharp_tiles:"存在清晰度不合格的视野",
    fields_misordered:"检测到视野乱序，请按行优先顺序上传",
    fields_not_aligned:"存在视野在声明重叠位置无法对齐（重叠不足或内容不符）",
    mosaic_not_stitched:"尚未完成拼图",
    point_outside_image:"点落在薄片图之外",
    line_endpoint_outside:"线端点落在薄片图之外",
    zero_length_line:"零长度线",
    area_needs_three_points:"面积至少需要 3 个点",
    area_point_outside:"面积顶点落在薄片图之外",
    degenerate_area:"退化面积（共线/重合点）",
    grid_change_requires_clearing:"网格或重叠率变化前必须先清空已上传视野",
    calibration_locked_by_measurements:"已有测量记录，校准已锁定",
    clear_mosaic_first:"请先清空拼图再替换视野"
  })[code] || code;
}

function diagnostics() {
  const out = [];
  if (!micro.calibrated) { out.push(["err","标尺未校准，不能采集与测量。"]); return out; }
  const { rows, cols } = micro.calibration.grid;
  const total = rows * cols;
  if (micro.tiles.length < total) {
    const missing = [];
    for (let r=0;r<rows;r++) for (let c=0;c<cols;c++) if (!micro.tiles.some(t=>t.key===r+"-"+c)) missing.push("["+r+","+c+"]");
    out.push(["warn","缺图：共缺 "+missing.length+" 个视野 → "+missing.join(" ")]);
  }
  const blurry = micro.tiles.filter(t => !t.sharpnessPassed);
  if (blurry.length) out.push(["err","清晰度不合格："+blurry.map(t=>"["+t.key+"]").join(" ")+"，请删除后重拍上传。"]);
  if (micro.tiles.length === total && !blurry.length) out.push(["ok","覆盖完整且全部清晰，可以拼图与测量。"]);
  const weak = micro.analysis?.weakPairs || [];
  if (weak.length) out.push(["warn",weak.length+" 个相邻视野重叠匹配较弱（可能乱序或重叠不足）。"]);
  return out;
}

let flashTimer = null;
function flash(msg, level) {
  const box = $("#alerts");
  const div = document.createElement("div");
  div.className = "alert "+level;
  div.textContent = msg;
  box.appendChild(div);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => div.remove(), 6000);
}

// ---- mosaic canvas ----
let mosaicImg = null;
let scaleFit = 1;

async function renderMosaic() {
  const alerts = $("#alerts");
  alerts.innerHTML = "";
  diagnostics().forEach(([level, msg]) => {
    const d = document.createElement("div");
    d.className = "alert "+level; d.textContent = msg; alerts.appendChild(d);
  });
  const canvas = $("#mosaicCanvas");
  const ctx = canvas.getContext("2d");
  if (!micro.mosaic) {
    canvas.width = 640; canvas.height = 300;
    ctx.fillStyle = "#111"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = "#8b9580"; ctx.font = "15px sans-serif";
    ctx.fillText("完成校准、上传全部清晰视野并拼合后在此显示完整薄片图", 30, 150);
    $("#mosaicMeta").textContent = "";
    return;
  }
  const url = "/api/slices/"+encodeURIComponent(sliceId)+"/mosaic.png?ts="+Date.now();
  const img = new Image();
  img.onload = () => {
    mosaicImg = img;
    const maxW = Math.min(900, window.innerWidth - 480);
    scaleFit = img.width > maxW ? maxW / img.width : 1;
    canvas.width = img.width; canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    drawPending(ctx);
  };
  img.src = url;
  const m = micro.mosaic;
  $("#mosaicMeta").textContent = "薄片图 "+m.width+"×"+m.height+" px；视野步进 "+m.stepX+"/"+m.stepY+" px；1 px = "+micro.calibration.umPerPx+" µm";
}

function canvasPoint(evt) {
  const canvas = $("#mosaicCanvas");
  const rect = canvas.getBoundingClientRect();
  const x = Math.round((evt.clientX - rect.left) * canvas.width / rect.width);
  const y = Math.round((evt.clientY - rect.top) * canvas.height / rect.height);
  return { x, y };
}

function drawPending(ctx) {
  if (!mosaicImg) return;
  ctx = ctx || $("#mosaicCanvas").getContext("2d");
  ctx.lineWidth = Math.max(1, mosaicImg.width / 600);
  ctx.strokeStyle = "#ffd54a"; ctx.fillStyle = "#ffd54a";
  pending.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill(); });
  if (tool === "line" && pending.length === 2) {
    ctx.beginPath(); ctx.moveTo(pending[0].x, pending[0].y); ctx.lineTo(pending[1].x, pending[1].y); ctx.stroke();
  }
  if (tool === "area" && pending.length > 1) {
    ctx.beginPath(); ctx.moveTo(pending[0].x, pending[0].y);
    pending.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }
}

$("#mosaicCanvas").addEventListener("click", async evt => {
  if (!tool || !micro.mosaic) return;
  const p = canvasPoint(evt);
  pending.push(p);
  const ctx = $("#mosaicCanvas").getContext("2d");
  ctx.drawImage(mosaicImg, 0, 0); drawPending(ctx);
  try {
    if (tool === "point") {
      await submitMeasurement({ type:"point", point:p });
      pending = [];
    } else if (tool === "line" && pending.length === 2) {
      await submitMeasurement({ type:"line", start:pending[0], end:pending[1] });
      pending = [];
    }
  } catch (e) { flash(errorText(e.message), "err"); pending = []; renderMosaic(); }
});
$("#mosaicCanvas").addEventListener("dblclick", async evt => {
  if (tool !== "area" || pending.length < 3) return;
  try { await submitMeasurement({ type:"area", points:pending }); pending = []; }
  catch (e) { flash(errorText(e.message), "err"); pending = []; renderMosaic(); }
});

document.querySelectorAll("[data-tool]").forEach(btn => btn.onclick = () => {
  tool = btn.dataset.tool; pending = [];
  document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("active", b === btn));
  $("#measureHint").textContent = {
    point:"在薄片图上点击一个点。",
    line:"依次点击线的起点和终点。",
    area:"依次点击多边形顶点（≥3），双击闭合。"
  }[tool];
  const ctx = $("#mosaicCanvas").getContext("2d");
  if (mosaicImg) { ctx.drawImage(mosaicImg, 0, 0); drawPending(ctx); }
});
$("#cancelTool").onclick = () => {
  tool = null; pending = [];
  document.querySelectorAll("[data-tool]").forEach(b => b.classList.remove("active"));
  if (mosaicImg) $("#mosaicCanvas").getContext("2d").drawImage(mosaicImg, 0, 0);
};

async function submitMeasurement(payload) {
  const rec = await api("/api/slices/"+encodeURIComponent(sliceId)+"/measurements", {
    method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)
  });
  flash("测量 "+rec.id+" 已保存。", "ok");
  await loadMicro();
}

function fmtPoint(p) { return "("+p.x+", "+p.y+")"; }
function renderMeasurements() {
  apiMeasurements().then(rows => {
    $("#measureRows").innerHTML = rows.map(r => {
      let pix = "", um = "";
      if (r.type === "point") { pix = fmtPoint(r.pixels); um = "("+r.micrometres.x+", "+r.micrometres.y+") µm"; }
      if (r.type === "line") {
        pix = fmtPoint(r.pixels.start)+" → "+fmtPoint(r.pixels.end)+"，长度 "+r.pixelLength+" px";
        um = r.micrometres.length+" µm";
      }
      if (r.type === "area") {
        pix = r.pixels.map(fmtPoint).join(" ")+"，面积 "+r.pixelArea+" px²";
        um = r.micrometres.area+" µm²";
      }
      return "<tr><td>"+({point:"点",line:"线",area:"面积"})[r.type]+"</td><td>"+esc(pix)+"</td><td>"+esc(um)+"</td></tr>";
    }).join("") || '<tr><td colspan="3" class="meta">暂无测量记录</td></tr>';
  });
}
async function apiMeasurements() {
  try { return await api("/api/slices/"+encodeURIComponent(sliceId)+"/measurements"); } catch { return []; }
}

$("#saveCalib").onclick = async () => {
  const payload = {
    magnification: Number($("#magnification").value),
    scaleLengthUm: Number($("#scaleLengthUm").value),
    scalePixels: Number($("#scalePixels").value),
    rows: Number($("#rows").value), cols: Number($("#cols").value), overlap: Number($("#overlap").value)
  };
  try {
    await api("/api/slices/"+encodeURIComponent(sliceId)+"/calibration", {
      method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)
    });
    flash("校准已登记：1 px = "+(payload.scaleLengthUm/payload.scalePixels).toFixed(4)+" µm。", "ok");
    await loadMicro();
  } catch (e) { flash(errorText(e.message), "err"); }
};
$("#stitchBtn").onclick = async () => {
  try {
    const result = await api("/api/slices/"+encodeURIComponent(sliceId)+"/stitch", { method:"POST", body:"{}", headers:{"Content-Type":"application/json"} });
    flash("拼图完成："+result.mosaic.width+"×"+result.mosaic.height+" px。", "ok");
    await loadMicro();
  } catch (e) {
    try { await loadMicro(); } catch {}
    flash("拼图被阻断："+errorText(e.message), "err");
  }
};
$("#clearMosaic").onclick = async () => {
  if (!micro.mosaic) { flash("当前没有拼图。", "warn"); return; }
  try {
    await api("/api/slices/"+encodeURIComponent(sliceId)+"/stitch", { method:"DELETE" });
    flash("拼图已清空，可删除并替换视野后重新拼合。", "ok");
    await loadMicro();
  } catch (e) { flash(errorText(e.message), "err"); }
};
$("#reload").onclick = async () => { await loadSamples(); await loadMicro(); };
$("#sliceSelect").onchange = async () => { sliceId = $("#sliceSelect").value; tool=null; pending=[]; await loadMicro(); };

(async function init(){
  await loadSamples();
  sliceId = $("#sliceSelect").value;
  await loadMicro();
})();
</script>
</body>
</html>`;
