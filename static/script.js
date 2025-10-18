// ====== Helpers ======
function showError(msg){
  const el = document.getElementById('uiError');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  console.error(msg);
}
function $(id){ return document.getElementById(id); }

// ====== Elements ======
const tabUpload = $("tab-upload");
const tabCamera = $("tab-camera");
const panelUpload = $("panel-upload");
const panelCamera = $("panel-camera");
const dropzone = $("dropzone");
const pickFileBtn = $("pickFile");
const fileInput = $("file");
const video = $("video");
const startCamBtn = $("startCam");
const stopCamBtn = $("stopCam");
const flipCamBtn = $("flipCam");
const snapDetectBtn = $("snapDetect");
const liveToggleBtn = $("liveToggle");
const btn = $("btn");
const downloadBtn = $("download");
const clearBtn = $("clear");
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const legend = $("legend");
const summary = $("summary");
const gallery = $("gallery");
const fpsEl = $("fps");
const modelInfo = $("modelInfo");
const domIndicator = $("domIndicator");
const autoToggle = $("autoToggle");

// mode-aware sliders
const fileControls = $("file-controls");
const cameraControls = $("camera-controls");
const confSlider = $("conf");
const confVal = $("confVal");
const iouFile = $("iou");
const iouFileVal = $("iouVal");
const thickSlider = $("thick");
const thickVal = $("thickVal");
const filterInput = $("filter");
const iouCam = $("iou_cam");
const iouCamVal = $("iouCamVal");

let activeMode = "upload"; // 'upload' | 'camera'
let showLabels = true, showScores = true;
document.addEventListener("keydown", (e)=>{
  if(e.key?.toLowerCase() === 'l'){ showLabels = !showLabels; drawDetections(); }
  if(e.key?.toLowerCase() === 's'){ showScores = !showScores; drawDetections(); }
});

let currentFile = null;
let baseImage = new Image();
let imgNaturalW = 0, imgNaturalH = 0;
let detections = [];

// highlight
let activeClasses = new Set();
let autoHighlightEnabled = true;
let userHasChosenHighlight = false;

// camera state
let stream = null;
let facingMode = "environment";
let liveDetect = false;
let liveTimer = null;

// DPR & view
let dpr = Math.max(1, window.devicePixelRatio || 1);
let view = { scale: 1, tx: 0, ty: 0 };
let isPanning = false;
let lastPos = {x:0, y:0};

// ====== Canvas Utils ======
function setCanvasSizeCSS(widthCss, heightCss){
  widthCss = Math.max(1, Math.floor(widthCss || 1));
  heightCss = Math.max(1, Math.floor(heightCss || 1));
  canvas.style.width = widthCss + "px";
  canvas.style.height = heightCss + "px";
  canvas.width = Math.max(2, Math.round(widthCss * dpr));
  canvas.height = Math.max(2, Math.round(heightCss * dpr));
}
function computeCanvasCssSize(){
  const parentWidth = canvas?.parentElement?.clientWidth || 640;
  if(!imgNaturalW || !imgNaturalH) return {w: parentWidth, h: Math.round(parentWidth*9/16)};
  const w = Math.min(parentWidth, imgNaturalW);
  const h = (imgNaturalH * w) / imgNaturalW;
  return {w, h};
}
function resetView(){ view.scale = 1; view.tx = 0; view.ty = 0; }
function applyView(){
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr*view.tx, dpr*view.ty);
}
function toCanvasCoords(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width * canvas.width / dpr;
  const y = (clientY - rect.top) / rect.height * canvas.height / dpr;
  return {x, y};
}
function drawBase(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!baseImage?.src) return;
  applyView();
  const {w, h} = computeCanvasCssSize();
  if(w && h) ctx.drawImage(baseImage, 0, 0, w, h);
}
function colorFromName(name){
  const str = String(name || "");
  let h = 0;
  for(let i=0;i<str.length;i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  h = Math.abs(h) % 360;
  return `hsl(${h} 95% 60%)`;
}
function strokeBBox(x, y, w, h, col, thick){
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, thick / Math.max(0.6, view.scale)) + 2;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.strokeRect(x, y, w, h);
  ctx.lineWidth = Math.max(2, thick / Math.max(0.6, view.scale));
  ctx.strokeStyle = col;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}
function getFilterSet(){
  const val = (filterInput?.value || "").trim();
  if(!val) return null;
  const arr = val.split(",").map(s => s.trim()).filter(Boolean);
  if(!arr.length) return null;
  return new Set(arr.map(s => s.toLowerCase()));
}

// ====== Drawing ======
function drawDetections(){
  drawBase();
  if(!detections || detections.length === 0){
    fpsEl.textContent = "0 deteksi";
    summary.innerHTML = ""; legend.innerHTML = ""; domIndicator.textContent = "—";
    return;
  }
  const {w: cw, h: ch} = computeCanvasCssSize();
  const scaleX = cw / imgNaturalW;
  const scaleY = ch / imgNaturalH;
  const thick = parseInt((thickSlider?.value || "3"), 10);
  const fset = getFilterSet();

  // Hitung SEMUA kelas untuk legend/summary (hanya hormati Filter Kelas)
  const countsAll = {};
  for(const det of detections){
    const cname = (det.name ?? det.cls).toString().toLowerCase();
    if(fset && !fset.has(cname)) continue;
    countsAll[cname] = (countsAll[cname] || 0) + 1;
  }

  // Gambar sesuai highlight aktif
  for(const det of detections){
    const cname = (det.name ?? det.cls).toString();
    const cnameL = cname.toLowerCase();
    if(fset && !fset.has(cnameL)) continue;
    if(activeClasses.size && !activeClasses.has(cnameL)) continue;

    const x1 = det.x1 * scaleX;
    const y1 = det.y1 * scaleY;
    const x2 = det.x2 * scaleX;
    const y2 = det.y2 * scaleY;
    const w = x2 - x1;
    const h = y2 - y1;

    const col = colorFromName(cname);
    strokeBBox(x1, y1, w, h, col, thick);

    const parts = [cname];
    if(showScores) parts.push(Number(det.conf||0).toFixed(2));
    const label = parts.join(" ");
    if(showLabels){
      ctx.save();
      ctx.scale(1/view.scale, 1/view.scale);
      ctx.font = "bold 13px ui-sans-serif, system-ui";
      const tw = ctx.measureText(label).width + 10;
      const th = 20;
      ctx.fillStyle = "rgba(0,0,0,.8)";
      ctx.fillRect(x1*view.scale, y1*view.scale - th, tw, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x1*view.scale + 5, y1*view.scale - 6);
      ctx.restore();
    }
  }

  // Legend: berdasarkan countsAll
  legend.innerHTML = "";
  const allChip = document.createElement("button");
  allChip.type = "button"; allChip.className = "chip"; allChip.textContent = "Semua"; allChip.tabIndex = 0;
  if(activeClasses.size===0) allChip.classList.add("active");
  legend.appendChild(allChip);

  Object.keys(countsAll).sort().forEach(k=>{
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "chip"; chip.tabIndex = 0;
    if(activeClasses.has(k)) chip.classList.add("active");
    chip.textContent = `${k} × ${countsAll[k]}`;
    legend.appendChild(chip);
  });

  // Summary
  renderSummary(countsAll);

  // Auto highlight dominan
  if(autoHighlightEnabled && !userHasChosenHighlight){
    let domName = null, domCount = -1;
    Object.keys(countsAll).forEach(name => {
      const c = countsAll[name] || 0;
      if(c > domCount){ domCount = c; domName = name; }
    });
    if(domName){
      activeClasses.clear();
      activeClasses.add(domName);
      domIndicator.textContent = `${domName} (${domCount})`;
      requestAnimationFrame(()=> drawDetections());
      return;
    } else {
      domIndicator.textContent = "—";
    }
  }else{
    if(activeClasses.size===0) domIndicator.textContent = "Semua";
    else domIndicator.textContent = Array.from(activeClasses).join(", ");
  }
}

function renderSummary(counts){
  if(!summary) return;
  summary.innerHTML = "";
  const total = Object.values(counts).reduce((a,b)=>a+b,0) || 1;
  Object.keys(counts).sort().forEach(k=>{
    const row = document.createElement("div");
    const pct = Math.round(counts[k]*100/total);
    row.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:12px;color:#9aa3b2">
        <span>${k}</span><span>${counts[k]} (${pct}%)</span>
      </div>
      <div class="bar"><span style="width:${pct}%"></span></div>`;
    summary.appendChild(row);
  });
}

// ====== Predict / Model ======
async function runPredictFromBlob(blob, conf, iou, imgsz=640){
  const fd = new FormData();
  fd.append("file", blob, "frame.jpg");
  if(typeof conf === "number") fd.append("conf", String(conf));
  fd.append("iou", String(iou));
  fd.append("imgsz", String(imgsz));
  const r = await fetch("/predict", { method:"POST", body: fd });
  let data = null;
  try{ data = await r.json(); }catch(_){}
  if(!r.ok || !data || data.error){
    const msg = data?.error || `HTTP ${r.status}`;
    showError("Predict gagal: " + msg);
    throw new Error(msg);
  }
  return data;
}

// ====== Tabs / Mode ======
function setMode(mode){
  activeMode = mode;
  if(mode === "upload"){
    fileControls.classList.remove("hidden");
    cameraControls.classList.add("hidden");
  }else{
    cameraControls.classList.remove("hidden");
    fileControls.classList.add("hidden");
  }
}
function setTab(tab){
  if(tab === "upload"){
    tabUpload.classList.add("active");
    tabCamera.classList.remove("active");
    panelUpload.style.display = "";
    panelCamera.style.display = "none";
    stopCamera();
    setMode("upload");
  }else{
    tabCamera.classList.add("active");
    tabUpload.classList.remove("active");
    panelCamera.style.display = "";
    panelUpload.style.display = "none";
    setMode("camera");
  }
}
tabUpload.addEventListener("click", ()=> setTab("upload"));
tabCamera.addEventListener("click", ()=> setTab("camera"));

// ====== File Input (simple) ======
pickFileBtn.addEventListener("click", ()=> fileInput.click());
dropzone.addEventListener("click", ()=> fileInput.click());
dropzone.addEventListener("dragover", (e)=>{ e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", ()=> dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e)=>{
  e.preventDefault(); dropzone.classList.remove("dragover");
  const f = e.dataTransfer?.files?.[0]; if(f) loadFile(f);
});
fileInput.addEventListener("change", (e)=>{ const f = e.target?.files?.[0]; if(f) loadFile(f); });

function loadFile(f){
  userHasChosenHighlight = false;
  autoHighlightEnabled = true;
  activeClasses.clear();
  currentFile = f;
  const url = URL.createObjectURL(f);
  baseImage.onload = () => {
    imgNaturalW = baseImage.naturalWidth; imgNaturalH = baseImage.naturalHeight;
    const {w,h} = computeCanvasCssSize(); setCanvasSizeCSS(w,h);
    resetView(); detections = []; legend.innerHTML = ""; summary.innerHTML = "";
    drawDetections();
  };
  baseImage.onerror = ()=> showError("Gagal memuat gambar yang dipilih");
  baseImage.src = url;
}

// ====== Camera ======

async function ensureVideoReady(){
  const maxWait = 2000; // 2s
  const start = performance.now();
  while((video.readyState || 0) < 2 || video.videoWidth===0 || video.videoHeight===0){
    await new Promise(r=> setTimeout(r, 60));
    if(performance.now() - start > maxWait) break;
  }
}

async function startCamera(){
  try{
    const constraints = { video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } } };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream; await video.play();
    const updateSize = () => {
      imgNaturalW = video.videoWidth; imgNaturalH = video.videoHeight;
      if(imgNaturalW && imgNaturalH){
        const {w,h} = computeCanvasCssSize(); setCanvasSizeCSS(w,h);
        resetView(); drawFromVideoToCanvas();
      } else { requestAnimationFrame(updateSize); }
    }; updateSize();
  }catch(err){ showError("Akses kamera ditolak/ gagal: " + err.message); }
}
function stopCamera(){
  liveDetect = false;
  if(liveTimer){ clearInterval(liveTimer); liveTimer = null; }
  liveToggleBtn.textContent = "Live: OFF";
  if(stream){ stream.getTracks().forEach(t => t.stop()); stream = null; }
}
function flipCamera(){ facingMode = (facingMode === "environment" ? "user" : "environment"); stopCamera(); startCamera(); }
function drawFromVideoToCanvas(){
  if(!video || video.readyState < 2) return;
  applyView();
  const {w, h} = computeCanvasCssSize();
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,canvas.width,canvas.height);
  applyView();
  ctx.drawImage(video, 0, 0, w, h);
}
startCamBtn.addEventListener("click", ()=>{ setTab("camera"); startCamera(); });
stopCamBtn.addEventListener("click", stopCamera);
flipCamBtn.addEventListener("click", flipCamera);
snapDetectBtn.addEventListener("click", async ()=>{
  try{
    if(!stream){ showError("Kamera belum aktif."); return; }
    await ensureVideoReady();
    if(video.videoWidth===0 || video.videoHeight===0){ showError("Frame kamera belum siap."); return; }
    const off = document.createElement("canvas");
    off.width = video.videoWidth; off.height = video.videoHeight;
    off.getContext("2d").drawImage(video, 0, 0, off.width, off.height);
    const blob = await new Promise(res=> off.toBlob(res, "image/jpeg", 0.9));
    const conf = Number(confSlider?.value ?? "0.25");
    const iou = Number(iouCam?.value ?? "0.45");
    const data = await runPredictFromBlob(blob, conf, iou, 640);
    detections = data.boxes || [];
    imgNaturalW = off.width; imgNaturalH = off.height;
    baseImage.src = off.toDataURL("image/jpeg");
    baseImage.onload = ()=>{ resetView(); userHasChosenHighlight = false; autoHighlightEnabled = true; drawDetections(); addSnapshot(); };
  }catch(e){ /* handled */ }
});
function toggleLive(){
  if(!stream){ showError("Kamera belum aktif."); return; }
  liveDetect = !liveDetect;
  liveToggleBtn.textContent = "Live: " + (liveDetect ? "ON" : "OFF");
  if(liveDetect){
    if(liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(async ()=>{
      try{
        await ensureVideoReady();
        const w = video.videoWidth, h = video.videoHeight;
        if(!w || !h) return;
        const off = document.createElement("canvas");
        off.width = w; off.height = h;
        off.getContext("2d").drawImage(video, 0, 0, w, h);
        const blob = await new Promise(res=> off.toBlob(res, "image/jpeg", 0.7));
        const conf = Number(confSlider?.value ?? "0.25");
        const iou = Number(iouCam?.value ?? "0.45");
        const data = await runPredictFromBlob(blob, conf, iou, 640);
        detections = data.boxes || [];
        imgNaturalW = w; imgNaturalH = h;
        if(baseImage.complete){ baseImage.src = off.toDataURL("image/jpeg"); } else { baseImage.src = off.toDataURL("image/jpeg"); }
        baseImage.onload = ()=>{ drawDetections(); };
        const now = performance.now();
      }catch(_){}
    }, 700);
  }else{
    if(liveTimer){ clearInterval(liveTimer); liveTimer = null; }
  }
}
liveToggleBtn.addEventListener("click", toggleLive);

// ====== Detect button ======
btn.addEventListener("click", async ()=>{
  try{
    let data = null;
    if(activeMode === "upload"){
      if(!currentFile){ showError("Pilih file terlebih dahulu."); return; }
      const fd = new FormData();
      fd.append("file", currentFile);
      fd.append("iou", String(Number(iouFile?.value ?? "0.45")));
      fd.append("imgsz", "640");
      const r = await fetch("/predict", { method:"POST", body: fd });
      data = await r.json().catch(()=> ({}));
      if(!r.ok || data?.error) throw new Error(data?.error || ("HTTP " + r.status));
      detections = data.boxes || [];
      drawDetections(); addSnapshot();
    }else{
      if(!stream){ showError("Kamera belum aktif."); return; }
      const w = video.videoWidth, h = video.videoHeight;
      const off = document.createElement("canvas");
      off.width = w; off.height = h;
      off.getContext("2d").drawImage(video, 0, 0, w, h);
      const blob = await new Promise(res=> off.toBlob(res, "image/jpeg", 0.9));
      const conf = Number(confSlider?.value ?? "0.25");
      const iou = Number(iouCam?.value ?? "0.45");
      data = await runPredictFromBlob(blob, conf, iou, 640);
      detections = data.boxes || [];
      imgNaturalW = w; imgNaturalH = h;
      baseImage.src = off.toDataURL("image/jpeg");
      baseImage.onload = ()=>{ resetView(); drawDetections(); addSnapshot(); };
    }
  }catch(err){ showError("Gagal inferensi: " + (err?.message || err)); }
});

// ====== Sliders & filter ======
confSlider?.addEventListener("input", ()=> confVal.textContent = Number(confSlider.value).toFixed(2));
iouFile?.addEventListener("input", ()=> iouFileVal.textContent = Number(iouFile.value).toFixed(2));
thickSlider?.addEventListener("input", ()=>{ thickVal.textContent = parseInt(thickSlider.value,10); drawDetections(); });
filterInput?.addEventListener("change", ()=>{ resetView(); userHasChosenHighlight = false; autoHighlightEnabled = true; drawDetections(); });
iouCam?.addEventListener("input", ()=> iouCamVal.textContent = Number(iouCam.value).toFixed(2));

// ====== Zoom & Pan ======
canvas.addEventListener("wheel", (e)=>{
  e.preventDefault();
  const delta = -e.deltaY;
  const factor = Math.exp(delta * 0.0015);
  const mouse = toCanvasCoords(e.clientX, e.clientY);
  view.tx = mouse.x - factor*(mouse.x - view.tx);
  view.ty = mouse.y - factor*(mouse.y - view.ty);
  view.scale *= factor;
  view.scale = Math.max(0.3, Math.min(5, view.scale));
  drawDetections();
},{passive:false});

canvas.addEventListener("mousedown", (e)=>{
  isPanning = true;
  lastPos = toCanvasCoords(e.clientX, e.clientY);
});
window.addEventListener("mouseup", ()=> isPanning = false);
canvas.addEventListener("mousemove", (e)=>{
  if(!isPanning) return;
  const pos = toCanvasCoords(e.clientX, e.clientY);
  view.tx += (pos.x - lastPos.x);
  view.ty += (pos.y - lastPos.y);
  lastPos = pos;
  drawDetections();
});

// ====== Snapshots ======
const SNAP_MAX = 10;
function addSnapshot(){
  try{
    const url = canvas.toDataURL("image/png");
    const wrap = document.createElement("div"); wrap.className = "thumb";
    const img = document.createElement("img"); img.src = url;
    img.title = "Klik untuk tampilkan di kanvas";
    img.addEventListener("click", ()=>{
      baseImage.src = url;
      baseImage.onload = ()=>{ resetView(); drawDetections(); };
    });
    if(gallery){
      gallery.prepend(wrap);
      while(gallery.children.length > SNAP_MAX){ gallery.removeChild(gallery.lastChild); }
    }
    wrap.appendChild(img);
  }catch(err){ console.warn("Snapshot gagal:", err); }
}

// ====== Legend Click Delegation (click/touch/keyboard) ======
if(legend){
  function handleChip(btn){
    const text = (btn.textContent || "").trim().toLowerCase();
    if(text === "semua"){
      activeClasses.clear();
      userHasChosenHighlight = true;
      autoHighlightEnabled = false;
      autoToggle.textContent = "Auto Highlight: OFF";
      drawDetections();
      return;
    }
    // parse 'name × N' or 'name x N'
    const name = text.includes("×") ? text.split("×")[0].trim() : text.split("x")[0].trim();
    userHasChosenHighlight = true;
    autoHighlightEnabled = false;
    autoToggle.textContent = "Auto Highlight: OFF";
    if(activeClasses.has(name)) activeClasses.delete(name);
    else { activeClasses.clear(); activeClasses.add(name); }
    drawDetections();
  }

  legend.addEventListener("click", (e)=>{
    const btn = e.target.closest(".chip");
    if(!btn) return;
    e.preventDefault(); e.stopPropagation();
    handleChip(btn);
  });
  legend.addEventListener("touchstart", (e)=>{
    const btn = e.target.closest(".chip");
    if(!btn) return;
    e.preventDefault();
    handleChip(btn);
  }, {passive:false});
  legend.addEventListener("keydown", (e)=>{
    if(e.key !== "Enter" && e.key !== " " && e.code !== "Enter" && e.code !== "Space") return;
    const btn = e.target.closest(".chip");
    if(!btn) return;
    e.preventDefault();
    handleChip(btn);
  });
}

// ====== Auto Toggle ======
if(autoToggle){
  autoToggle.addEventListener('click', ()=>{
    autoHighlightEnabled = !autoHighlightEnabled;
    autoToggle.textContent = 'Auto Highlight: ' + (autoHighlightEnabled ? 'ON' : 'OFF');
    if(!autoHighlightEnabled){
      activeClasses.clear();
      userHasChosenHighlight = true;
    } else {
      userHasChosenHighlight = false;
    }
    drawDetections();
  });
}

// ====== Model info ======
fetch('/model').then(async r=>{
  let data = null; try{ data = await r.json(); }catch(_){}
  if(!r.ok || !data || data.error){
    showError("Model belum siap: " + (data?.error || ("HTTP " + r.status)));
    return;
  }
  modelInfo.textContent = `Model: ${data.model_path} · ${data.classes.length} kelas`;
}).catch(err=> showError("Gagal memuat info model"));

// ====== Misc ======
downloadBtn.addEventListener("click", ()=>{
  try{
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = "yolo_result.png";
    link.click();
  }catch(err){ showError("Download gagal"); }
});
clearBtn.addEventListener("click", ()=>{
  detections = []; legend.innerHTML=""; summary.innerHTML=""; gallery.innerHTML="";
  domIndicator.textContent = "—";
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,canvas.width,canvas.height);
  resetView();
});

// ====== Resize / DPR ======
function refreshDPR(){
  const newDpr = Math.max(1, window.devicePixelRatio || 1);
  if(newDpr !== dpr){ dpr = newDpr; const {w,h}=computeCanvasCssSize(); setCanvasSizeCSS(w,h); drawDetections(); }
}
window.addEventListener("resize", ()=>{ const {w,h}=computeCanvasCssSize(); setCanvasSizeCSS(w,h); drawDetections(); });
window.addEventListener("orientationchange", ()=>{ setTimeout(()=>{ const {w,h}=computeCanvasCssSize(); setCanvasSizeCSS(w,h); drawDetections(); }, 250); });
window.matchMedia && window.matchMedia("(resolution: 2dppx)").addEventListener("change", refreshDPR);

// ====== Init ======
(function(){ const {w,h}=computeCanvasCssSize(); setCanvasSizeCSS(w,h); setTab("upload"); })();
