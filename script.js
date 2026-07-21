/* ============================================================
   ClearFrame — Watermark Remover + Video Compressor
   100% client-side. No uploads. Output format: WEBM.
   ============================================================ */

const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

const $ = (id) => document.getElementById(id);

function pickMime() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

function validFile(file, errEl) {
  errEl.textContent = "";
  if (!file) return false;
  if (!/^video\/(mp4|webm)$/.test(file.type)) {
    errEl.textContent = "Unsupported format. Please use MP4 or WEBM.";
    return false;
  }
  if (file.size > MAX_SIZE) {
    errEl.textContent = "File too large. Maximum is 2 GB.";
    return false;
  }
  return true;
}

function wireDropzone(zone, input, onFile) {
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => onFile(input.files[0]));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    onFile(e.dataTransfer.files[0]);
  });
}

/* Reliable seek — resolves even if the video is already at the
   target time (setting currentTime to the same value never fires
   "seeked", which used to hang the whole pipeline). */
function seekTo(v, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener("seeked", finish);
      resolve();
    };
    if (Math.abs(v.currentTime - t) < 0.05 && v.readyState >= 2) return finish();
    v.addEventListener("seeked", finish);
    v.currentTime = t;
    setTimeout(finish, 2000); // safety net — never hang forever
  });
}

/* MediaRecorder WEBMs report Infinity duration, which breaks the
   result player's timeline (and can crash playback when scrubbing).
   This forces the browser to compute the real duration. */
function fixResultDuration(v) {
  v.addEventListener("loadedmetadata", function onMeta() {
    if (v.duration === Infinity || isNaN(v.duration)) {
      v.currentTime = 1e7;
      v.addEventListener("timeupdate", function onTU() {
        v.removeEventListener("timeupdate", onTU);
        v.currentTime = 0;
      });
    }
  }, { once: true });
}

/* ============================================================
   TAB SWITCHING
   ============================================================ */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    $("removerTool").classList.toggle("hidden", tab.dataset.tool !== "remover");
    $("compressorTool").classList.toggle("hidden", tab.dataset.tool !== "compressor");
  });
});

/* ============================================================
   ABOUT MODAL
   ============================================================ */
(() => {
  const overlay = $("aboutOverlay");
  const openBtn = $("aboutBtn");
  const closeBtn = $("aboutClose");
  let lastFocused = null;

  function openModal(e) {
    if (e) e.preventDefault();
    lastFocused = document.activeElement;
    overlay.hidden = false;
    // Double rAF ensures the browser registers the initial state
    // before the transition class is applied (reliable fade-in).
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("visible")));
    document.body.classList.add("modal-open");
    closeBtn.focus();
    document.addEventListener("keydown", onKeydown);
  }

  function closeModal() {
    overlay.classList.remove("visible");
    document.removeEventListener("keydown", onKeydown);
    document.body.classList.remove("modal-open");
    const finish = () => {
      overlay.hidden = true;
      if (lastFocused) lastFocused.focus();
    };
    // Wait for fade-out; fallback in case transitionend never fires
    let done = false;
    overlay.addEventListener("transitionend", () => { if (!done) { done = true; finish(); } }, { once: true });
    setTimeout(() => { if (!done) { done = true; finish(); } }, 350);
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      closeModal();
      return;
    }
    // Simple focus trap — keep Tab cycling inside the modal
    if (e.key === "Tab") {
      const focusables = overlay.querySelectorAll("button, a[href]");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  openBtn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal(); // click outside the popup
  });
})();

/* ============================================================
   TOOL 1 — WATERMARK REMOVER
   ============================================================ */
(() => {
  const video = $("video");
  const maskCanvas = $("maskCanvas");
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
  let drawing = false;
  let busy = false;
  let resultUrl = null;

  wireDropzone($("dropzone"), $("fileInput"), (file) => {
    if (!validFile(file, $("uploadError"))) return;
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
    video.load();
  });

  video.addEventListener("loadedmetadata", () => {
    maskCanvas.width = video.videoWidth;
    maskCanvas.height = video.videoHeight;
    mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    $("trimEnd").value = video.duration.toFixed(1);
    $("trimStart").value = 0;
    $("uploadPanel").classList.add("hidden");
    $("editorPanel").classList.remove("hidden");
  });

  /* ---------- Brush ---------- */
  $("brushSize").addEventListener("input", (e) => ($("brushVal").textContent = e.target.value));

  function canvasPos(e) {
    const rect = maskCanvas.getBoundingClientRect();
    const scale = maskCanvas.width / rect.width;
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * scale,
      scale,
    };
  }

  function paint(e) {
    const { x, y, scale } = canvasPos(e);
    const r = (+$("brushSize").value / 2) * scale;
    mctx.fillStyle = "rgba(108,92,231,0.55)";
    mctx.beginPath();
    mctx.arc(x, y, r, 0, Math.PI * 2);
    mctx.fill();
  }

  maskCanvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    maskCanvas.setPointerCapture(e.pointerId);
    paint(e);
  });
  maskCanvas.addEventListener("pointermove", (e) => drawing && paint(e));
  maskCanvas.addEventListener("pointerup", () => (drawing = false));
  maskCanvas.addEventListener("pointercancel", () => (drawing = false));

  $("clearMask").addEventListener("click", () =>
    mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
  );

  /* ---------- Inpainting engine (bounding-box optimized) ----------
     KEY FIX: instead of reading/writing the ENTIRE frame every
     frame (which froze the tab on HD video), we compute the small
     bounding box around the painted mask once, and per frame we
     only touch that region. 100× less pixel work per frame.      */
  function buildFillPlan(fullW, fullH) {
    const maskImg = mctx.getImageData(0, 0, fullW, fullH).data;

    // 1. Find mask bounding box
    let minX = fullW, minY = fullH, maxX = -1, maxY = -1;
    for (let y = 0; y < fullH; y++) {
      for (let x = 0; x < fullW; x++) {
        if (maskImg[(y * fullW + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;

    // 2. Pad the box so the fill has known pixels to sample from
    const pad = 6;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(fullW - 1, maxX + pad);
    maxY = Math.min(fullH - 1, maxY + pad);

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;

    // 3. Build region-local mask
    const mask = new Uint8Array(w * h);
    const known = new Uint8Array(w * h);
    const maskIdx = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (maskImg[((y + minY) * fullW + (x + minX)) * 4 + 3] > 10) {
          mask[i] = 1;
          maskIdx.push(i);
        } else {
          known[i] = 1;
        }
      }
    }

    // 4. BFS from the mask border inward, layer by layer
    const off = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1];
    const order = [];
    let frontier = [];
    const inFrontier = new Uint8Array(w * h);

    for (const i of maskIdx) {
      const x = i % w;
      for (const o of off) {
        const n = i + o;
        if (n < 0 || n >= w * h) continue;
        if (Math.abs((n % w) - x) > 1) continue;
        if (known[n]) { frontier.push(i); inFrontier[i] = 1; break; }
      }
    }

    while (frontier.length) {
      const layer = [];
      for (const i of frontier) {
        const x = i % w;
        const nb = [];
        for (const o of off) {
          const n = i + o;
          if (n < 0 || n >= w * h) continue;
          if (Math.abs((n % w) - x) > 1) continue;
          if (known[n]) nb.push(n);
        }
        if (nb.length) layer.push({ idx: i, nb });
      }
      for (const { idx } of layer) known[idx] = 1;
      order.push(...layer);

      const next = [];
      for (const { idx } of layer) {
        const x = idx % w;
        for (const o of off) {
          const n = idx + o;
          if (n < 0 || n >= w * h) continue;
          if (Math.abs((n % w) - x) > 1) continue;
          if (mask[n] && !known[n] && !inFrontier[n]) {
            inFrontier[n] = 1;
            next.push(n);
          }
        }
      }
      frontier = next;
    }

    return { order, maskIdx, w, h, x: minX, y: minY };
  }

  function inpaintFrame(d, plan) {
    // Layer-by-layer reconstruction from known neighbours
    for (const { idx, nb } of plan.order) {
      let r = 0, g = 0, b = 0;
      for (const n of nb) { r += d[n * 4]; g += d[n * 4 + 1]; b += d[n * 4 + 2]; }
      const len = nb.length;
      d[idx * 4] = r / len; d[idx * 4 + 1] = g / len; d[idx * 4 + 2] = b / len;
    }
    // Smoothing passes — blend the fill so it looks seamless
    const { w, h } = plan;
    const off4 = [-1, 1, -w, w];
    for (let pass = 0; pass < 2; pass++) {
      for (const i of plan.maskIdx) {
        const x = i % w;
        let r = 0, g = 0, b = 0, c = 0;
        for (const o of off4) {
          const n = i + o;
          if (n < 0 || n >= w * h) continue;
          if (o === -1 && x === 0) continue;
          if (o === 1 && x === w - 1) continue;
          r += d[n * 4]; g += d[n * 4 + 1]; b += d[n * 4 + 2]; c++;
        }
        if (c) { d[i * 4] = r / c; d[i * 4 + 1] = g / c; d[i * 4 + 2] = b / c; }
      }
    }
  }

  /* ---------- Processing ---------- */
  $("removeBtn").addEventListener("click", async () => {
    if (busy) return;
    const errEl = $("editError");
    errEl.textContent = "";

    const w = video.videoWidth, h = video.videoHeight;
    const plan = buildFillPlan(w, h);
    if (!plan) { errEl.textContent = "Please paint over the watermark first."; return; }

    const tStart = Math.max(0, +$("trimStart").value || 0);
    const tEnd = Math.min(video.duration, +$("trimEnd").value || video.duration);
    if (tEnd <= tStart) { errEl.textContent = "Trim end must be greater than trim start."; return; }

    busy = true;
    $("editorPanel").classList.add("hidden");
    $("processPanel").classList.remove("hidden");

    const proc = document.createElement("canvas");
    proc.width = w; proc.height = h;
    const pctx = proc.getContext("2d", { willReadFrequently: true });

    const stream = proc.captureStream(30);
    try {
      const src = video.captureStream ? video.captureStream() : null;
      if (src) src.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (e) { /* audio capture unsupported — video-only output */ }

    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 8_000_000 });

    let stopped = false;
    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      video.pause();
      if (rec.state !== "inactive") rec.stop();
    };

    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = () => {
      stopAll();
      busy = false;
      $("processPanel").classList.add("hidden");
      $("editorPanel").classList.remove("hidden");
      errEl.textContent = "Recording failed. Please try again.";
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); // release resources
      const blob = new Blob(chunks, { type: "video/webm" });
      chunks.length = 0; // free memory
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      const rv = $("resultVideo");
      fixResultDuration(rv);
      rv.src = resultUrl;
      $("downloadBtn").href = resultUrl;
      $("processPanel").classList.add("hidden");
      $("resultPanel").classList.remove("hidden");
      busy = false;
    };

    const drawFrame = () => {
      if (stopped) return;
      try {
        pctx.drawImage(video, 0, 0, w, h);
        // Only the masked region is read, rebuilt, and written back
        const region = pctx.getImageData(plan.x, plan.y, plan.w, plan.h);
        inpaintFrame(region.data, plan);
        pctx.putImageData(region, plan.x, plan.y);
      } catch (e) {
        stopAll();
        return;
      }

      const pct = Math.min(100, ((video.currentTime - tStart) / (tEnd - tStart)) * 100);
      $("progressBar").style.width = pct + "%";
      $("progressText").textContent = Math.round(pct) + "%";

      if (video.currentTime >= tEnd || video.ended) { stopAll(); return; }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => drawFrame());
      else requestAnimationFrame(drawFrame);
    };

    await seekTo(video, tStart);
    video.muted = true;
    rec.start(250);
    try {
      await video.play();
    } catch (e) {
      rec.onerror();
      return;
    }
    drawFrame();
    video.addEventListener("ended", stopAll, { once: true });
  });

  $("restartBtn").addEventListener("click", () => location.reload());
})();

/* ============================================================
   TOOL 2 — VIDEO COMPRESSOR
   ============================================================ */
(() => {
  const video = $("cVideo");
  let currentFile = null;
  let busy = false;
  let resultUrl = null;

  const PRESETS = {
    high:   { scale: 1.0,  vBits: 4_000_000, aBits: 128_000 },
    medium: { scale: 0.75, vBits: 1_500_000, aBits: 96_000 },
    low:    { scale: 0.5,  vBits: 600_000,   aBits: 64_000 },
  };

  wireDropzone($("cDropzone"), $("cFileInput"), (file) => {
    if (!validFile(file, $("cUploadError"))) return;
    currentFile = file;
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
    video.load();
  });

  video.addEventListener("loadedmetadata", () => {
    $("cFileInfo").textContent =
      `${currentFile.name} — ${fmtSize(currentFile.size)} · ${video.videoWidth}×${video.videoHeight} · ${video.duration.toFixed(1)}s`;
    $("cUploadPanel").classList.add("hidden");
    $("cOptionsPanel").classList.remove("hidden");
  });

  $("compressBtn").addEventListener("click", async () => {
    if (busy) return;
    busy = true;

    const q = document.querySelector('input[name="quality"]:checked').value;
    const p = PRESETS[q];

    $("cOptionsPanel").classList.add("hidden");
    $("cProcessPanel").classList.remove("hidden");

    const w = Math.round((video.videoWidth * p.scale) / 2) * 2;
    const h = Math.round((video.videoHeight * p.scale) / 2) * 2;

    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");

    const stream = canvas.captureStream(30);
    try {
      const src = video.captureStream ? video.captureStream() : null;
      if (src) src.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (e) { /* video-only output */ }

    const chunks = [];
    const rec = new MediaRecorder(stream, {
      mimeType: pickMime(),
      videoBitsPerSecond: p.vBits,
      audioBitsPerSecond: p.aBits,
    });

    let stopped = false;
    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      video.pause();
      if (rec.state !== "inactive") rec.stop();
    };

    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = () => {
      stopAll();
      busy = false;
      $("cProcessPanel").classList.add("hidden");
      $("cOptionsPanel").classList.remove("hidden");
      $("cError").textContent = "Compression failed. Please try again.";
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: "video/webm" });
      chunks.length = 0;
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      const saved = Math.max(0, 100 - (blob.size / currentFile.size) * 100);
      $("cResultInfo").textContent =
        `Original: ${fmtSize(currentFile.size)} → Compressed: ${fmtSize(blob.size)} (${saved.toFixed(0)}% smaller)`;
      const rv = $("cResultVideo");
      fixResultDuration(rv);
      rv.src = resultUrl;
      $("cDownloadBtn").href = resultUrl;
      $("cProcessPanel").classList.add("hidden");
      $("cResultPanel").classList.remove("hidden");
      busy = false;
    };

    const drawFrame = () => {
      if (stopped) return;
      ctx.drawImage(video, 0, 0, w, h);
      const pct = Math.min(100, (video.currentTime / video.duration) * 100);
      $("cProgressBar").style.width = pct + "%";
      $("cProgressText").textContent = Math.round(pct) + "%";
      if (video.ended) { stopAll(); return; }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => drawFrame());
      else requestAnimationFrame(drawFrame);
    };

    await seekTo(video, 0);
    video.muted = true;
    rec.start(250);
    try {
      await video.play();
    } catch (e) {
      rec.onerror();
      return;
    }
    drawFrame();
    video.addEventListener("ended", stopAll, { once: true });
  });

  const cRestart = () => location.reload();
  $("cRestartBtn1").addEventListener("click", cRestart);
  $("cRestartBtn2").addEventListener("click", cRestart);
})();
