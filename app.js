/* ============================================================
   Palava Voice — app.js
   All audio work (recording, noise removal, tone shaping,
   loudness levelling, mp3 export) runs client-side. Nothing is
   uploaded anywhere unless you explicitly send it to Drive.
   ============================================================ */

(() => {
  "use strict";

  /* ---------------------------------------------------------
     Small helpers
  --------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const fmtTime = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = Math.floor(secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };
  const slugify = (str) =>
    (str || "palava-voice-story")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "palava-voice-story";

  /* ---------------------------------------------------------
     1. STORY COMPOSER
  --------------------------------------------------------- */

  const themeLabels = {
    education: "education access",
    "child-rights": "child rights",
    "early-pregnancy": "early pregnancy prevention",
    "rape-prevention": "protection from sexual violence",
    general: "community advocacy",
  };

  const fieldIds = [
    "f-setting", "f-characters", "f-hardship",
    "f-tension", "f-decision", "f-link", "f-cta",
  ];

  function weaveStory() {
    const get = (id) => $(id).value.trim();
    const title = $("story-title").value.trim() || "Untitled story";
    const theme = $("story-theme").value;

    const setting = get("f-setting");
    const characters = get("f-characters");
    const hardship = get("f-hardship");
    const tension = get("f-tension");
    const decision = get("f-decision");
    const link = get("f-link");
    const cta = get("f-cta");

    const paragraphs = [];

    if (setting) paragraphs.push(setting);
    if (characters) paragraphs.push(characters);
    if (hardship) paragraphs.push(hardship);
    if (tension) paragraphs.push(tension);
    if (decision) paragraphs.push(decision);

    if (link) {
      const bridge = theme && themeLabels[theme]
        ? `This is what it looks like in our own homes, when we talk about ${themeLabels[theme]}.`
        : `This is what it looks like in our own homes.`;
      paragraphs.push(`${bridge} ${link}`);
    }

    if (cta) paragraphs.push(cta);

    return { title, theme, paragraphs };
  }

  function renderTelling() {
    const { title, paragraphs } = weaveStory();
    $("telling-title").textContent = title;

    const container = $("telling-text");
    container.innerHTML = "";

    if (paragraphs.length === 0) {
      const p = document.createElement("p");
      p.className = "telling-empty";
      p.textContent = "Start filling the stepping stones — your woven story will appear here as you go, and you can read straight from it while recording.";
      container.appendChild(p);
      return;
    }

    paragraphs.forEach((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      container.appendChild(p);
    });
  }

  function sendToRecorder() {
    const { paragraphs } = weaveStory();
    const readout = $("script-readout");
    readout.innerHTML = "";

    if (paragraphs.length === 0) {
      readout.innerHTML = '<p class="telling-empty">No story loaded yet. Compose one above, or just start recording freely below.</p>';
    } else {
      paragraphs.forEach((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        readout.appendChild(p);
      });
    }

    const filename = slugify($("story-title").value);
    $("export-filename").value = filename;

    document.querySelector("#record").scrollIntoView({ behavior: "smooth" });
  }

  /* ---- persistence for stories (text only — small, localStorage is fine) ---- */
  const STORY_KEY = "palava_voice_stories_v1";

  function loadStories() {
    try {
      return JSON.parse(localStorage.getItem(STORY_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveStoryToLibrary() {
    const { title, theme, paragraphs } = weaveStory();
    if (paragraphs.length === 0) {
      $("export-status").textContent = "Add at least one stepping stone before saving.";
      return;
    }
    const stories = loadStories();
    const entry = {
      id: `story_${Date.now()}`,
      type: "story",
      title,
      theme,
      audience: $("story-audience").value.trim(),
      language: $("story-language").value.trim(),
      text: paragraphs.join("\n\n"),
      createdAt: new Date().toISOString(),
    };
    stories.unshift(entry);
    localStorage.setItem(STORY_KEY, JSON.stringify(stories));
    renderLibrary();
  }

  function clearForm() {
    $("story-title").value = "";
    $("story-audience").value = "";
    $("story-language").value = "";
    fieldIds.forEach((id) => { $(id).value = ""; });
    renderTelling();
  }

  /* ---------------------------------------------------------
     2. RECORDER — capture + live meter
  --------------------------------------------------------- */

  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let liveAudioCtx = null;
  let liveAnalyser = null;
  let meterRAF = null;
  let recordStartTime = 0;
  let timerInterval = null;

  let decodedBuffer = null;   // raw AudioBuffer straight from the mic
  let lastProcessed = null;   // { samples: Float32Array, sampleRate }

  const canvas = $("meter");
  const ctx2d = canvas.getContext("2d");

  function drawIdleMeter() {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.strokeStyle = "rgba(242,232,213,0.25)";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, canvas.height / 2);
    ctx2d.lineTo(canvas.width, canvas.height / 2);
    ctx2d.stroke();
  }
  drawIdleMeter();

  function drawLiveMeter() {
    if (!liveAnalyser) return;
    const bufferLength = liveAnalyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    liveAnalyser.getByteTimeDomainData(dataArray);

    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = "#E8A93B";
    ctx2d.beginPath();
    const sliceWidth = canvas.width / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
      x += sliceWidth;
    }
    ctx2d.stroke();

    meterRAF = requestAnimationFrame(drawLiveMeter);
  }

  function drawStaticWaveform(buffer) {
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / canvas.width);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = "rgba(232,169,59,0.5)";
    for (let i = 0; i < canvas.width; i++) {
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step; j++) {
        const idx = i * step + j;
        if (idx >= data.length) break;
        const v = data[idx];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = ((1 + min) / 2) * canvas.height;
      const y2 = ((1 + max) / 2) * canvas.height;
      ctx2d.fillRect(i, y1, 1, Math.max(1, y2 - y1));
    }
  }

  async function startRecording() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          autoGainControl: false,
          noiseSuppression: false, // we run our own noise removal, tuned for speech
        },
      });
    } catch (err) {
      $("rec-status").textContent = "Microphone access denied";
      $("export-status").textContent =
        "Palava Voice needs microphone permission to record. Please allow access and try again.";
      return;
    }

    recordedChunks = [];
    decodedBuffer = null;
    lastProcessed = null;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus" : "");

    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = handleRecordingStopped;
    mediaRecorder.start();

    // live meter
    liveAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = liveAudioCtx.createMediaStreamSource(mediaStream);
    liveAnalyser = liveAudioCtx.createAnalyser();
    liveAnalyser.fftSize = 2048;
    source.connect(liveAnalyser);
    drawLiveMeter();

    recordStartTime = Date.now();
    $("rec-timer").textContent = "00:00";
    timerInterval = setInterval(() => {
      $("rec-timer").textContent = fmtTime((Date.now() - recordStartTime) / 1000);
    }, 250);

    $("rec-status").textContent = "Recording…";
    $("btn-record").disabled = true;
    $("btn-stop").disabled = false;
    $("btn-play").disabled = true;
    $("btn-rerecord").disabled = true;
    $("btn-export").disabled = true;
    $("export-status").textContent = "";
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    if (meterRAF) cancelAnimationFrame(meterRAF);
    if (timerInterval) clearInterval(timerInterval);
    $("btn-record").disabled = false;
    $("btn-stop").disabled = true;
    $("rec-status").textContent = "Processing…";
  }

  async function handleRecordingStopped() {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();

    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      decodedBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
    } catch (err) {
      $("rec-status").textContent = "Could not read recording";
      $("export-status").textContent = "Something went wrong decoding the recording. Please try again.";
      return;
    }

    drawStaticWaveform(decodedBuffer);
    $("rec-status").textContent = "Take ready";
    $("btn-play").disabled = false;
    $("btn-rerecord").disabled = false;
    $("btn-export").disabled = false;
  }

  function discardRecording() {
    decodedBuffer = null;
    lastProcessed = null;
    drawIdleMeter();
    $("rec-timer").textContent = "00:00";
    $("rec-status").textContent = "Ready";
    $("btn-play").disabled = true;
    $("btn-rerecord").disabled = true;
    $("btn-export").disabled = true;
    $("export-status").textContent = "";
  }

  /* ---------------------------------------------------------
     3. DSP — noise removal, tone shaping, loudness levelling
     Implemented directly on the decoded PCM so it works with
     no external audio libraries and no server round-trip.
  --------------------------------------------------------- */

  // -- one-pole high-pass: strips rumble, generator hum, handling noise --
  function highPass(samples, sampleRate, cutoffHz) {
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sampleRate;
    const alpha = rc / (rc + dt);
    const out = new Float32Array(samples.length);
    let prevIn = samples[0] || 0;
    let prevOut = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = alpha * (prevOut + x - prevIn);
      out[i] = y;
      prevIn = x;
      prevOut = y;
    }
    return out;
  }

  // -- RBJ-style biquad coefficient builders (peaking / shelving) --
  function coefPeaking(sampleRate, freq, gainDB, Q) {
    const A = Math.pow(10, gainDB / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const cw = Math.cos(w0);
    const b0 = 1 + alpha * A, b1 = -2 * cw, b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A, a1 = -2 * cw, a2 = 1 - alpha / A;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function coefShelf(sampleRate, freq, gainDB, isHigh, Q = 0.85) {
    const A = Math.pow(10, gainDB / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / Q - 1) + 2);
    const sq = 2 * Math.sqrt(A) * alpha;
    let b0, b1, b2, a0, a1, a2;
    if (isHigh) {
      b0 = A * ((A + 1) + (A - 1) * cw + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - sq);
      a0 = (A + 1) - (A - 1) * cw + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - sq;
    } else {
      b0 = A * ((A + 1) - (A - 1) * cw + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sq);
      a0 = (A + 1) + (A - 1) * cw + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sq;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function applyBiquad(samples, coef) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = coef.b0 * x0 + coef.b1 * x1 + coef.b2 * x2 - coef.a1 * y1 - coef.a2 * y2;
      out[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    return out;
  }

  // -- envelope-follower noise gate: quiets the steady hiss/hum floor
  //    between and under words, without chopping speech --
  function noiseGate(samples, sampleRate, strength /* 0..100 */) {
    if (strength <= 0) return samples;
    const frame = Math.round(sampleRate * 0.02); // 20ms frames
    const numFrames = Math.ceil(samples.length / frame);
    const rms = new Float32Array(numFrames);

    for (let f = 0; f < numFrames; f++) {
      let sum = 0;
      const start = f * frame;
      const end = Math.min(start + frame, samples.length);
      for (let i = start; i < end; i++) sum += samples[i] * samples[i];
      rms[f] = Math.sqrt(sum / Math.max(1, end - start));
    }

    // estimate noise floor as a low percentile of frame RMS
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * 0.15)] || 0.0001;

    const strengthNorm = strength / 100; // 0..1
    const thresholdMult = 1.4 + strengthNorm * 3.2; // higher strength = wider gate
    const threshold = noiseFloor * thresholdMult;
    const floorGain = 1 - strengthNorm * 0.92; // never fully mute — avoids robotic cut-outs

    // target gain per frame
    const targetGain = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
      targetGain[f] = rms[f] >= threshold ? 1 : floorGain;
    }

    // smooth gain (attack faster than release, avoids clicking)
    const smoothGain = new Float32Array(numFrames);
    let current = 1;
    const attack = 0.6, release = 0.15;
    for (let f = 0; f < numFrames; f++) {
      const t = targetGain[f];
      current += (t > current ? attack : release) * (t - current);
      smoothGain[f] = current;
    }

    const out = new Float32Array(samples.length);
    for (let f = 0; f < numFrames; f++) {
      const start = f * frame;
      const end = Math.min(start + frame, samples.length);
      const g = smoothGain[f];
      for (let i = start; i < end; i++) out[i] = samples[i] * g;
    }
    return out;
  }

  // -- loudness levelling: gentle RMS-based compression + peak safety limiter --
  function levelLoudness(samples, sampleRate, amount /* 0..100 */) {
    if (amount <= 0) return samples;
    const frame = Math.round(sampleRate * 0.05); // 50ms frames
    const numFrames = Math.ceil(samples.length / frame);
    const targetRMS = 0.14;
    const maxGainDB = 4 + (amount / 100) * 10; // up to +14dB on quiet passages
    const maxGain = Math.pow(10, maxGainDB / 20);

    const out = new Float32Array(samples.length);
    let current = 1;
    for (let f = 0; f < numFrames; f++) {
      const start = f * frame;
      const end = Math.min(start + frame, samples.length);
      let sum = 0;
      for (let i = start; i < end; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / Math.max(1, end - start)) || 0.0001;

      let target = targetRMS / rms;
      target = Math.min(target, maxGain);
      target = Math.max(target, 0.3);

      current += 0.35 * (target - current); // smooth to avoid pumping
      for (let i = start; i < end; i++) out[i] = samples[i] * current;
    }

    // final peak safety limiter
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const ceiling = 0.97;
    if (peak > ceiling) {
      const g = ceiling / peak;
      for (let i = 0; i < out.length; i++) out[i] *= g;
    }
    return out;
  }

  const tonePresets = {
    natural: (samples, sr) => samples, // light touch only — noise removal + levelling do the work
    warm: (samples, sr) => {
      let s = applyBiquad(samples, coefShelf(sr, 220, 2.5, false));
      s = applyBiquad(s, coefPeaking(sr, 2200, 1.5, 1.1));
      s = applyBiquad(s, coefShelf(sr, 6500, -2, true));
      return s;
    },
    bright: (samples, sr) => {
      let s = applyBiquad(samples, coefShelf(sr, 160, -2, false));
      s = applyBiquad(s, coefPeaking(sr, 3200, 2.5, 1.0));
      s = applyBiquad(s, coefShelf(sr, 5500, 3, true));
      return s;
    },
    broadcast: (samples, sr) => {
      let s = highPass(samples, sr, 110);
      s = applyBiquad(s, coefPeaking(sr, 3000, 3.5, 0.9));
      s = applyBiquad(s, coefShelf(sr, 8000, 2, true));
      s = applyBiquad(s, coefShelf(sr, 150, -1.5, false));
      return s;
    },
  };

  function processBuffer(buffer) {
    // downmix to mono — the right choice for a single storyteller's voice
    const ch0 = buffer.getChannelData(0);
    let mono;
    if (buffer.numberOfChannels > 1) {
      const ch1 = buffer.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    } else {
      mono = ch0.slice();
    }

    const sr = buffer.sampleRate;
    const noiseOn = $("chk-noise").checked;
    const noiseStrength = parseInt($("rng-noise-strength").value, 10);
    const tone = $("sel-tone").value;
    const levelAmount = parseInt($("rng-level").value, 10);

    let s = mono;
    if (noiseOn) {
      s = highPass(s, sr, 90);
      s = noiseGate(s, sr, noiseStrength);
    }
    s = tonePresets[tone](s, sr);
    s = levelLoudness(s, sr, levelAmount);

    return { samples: s, sampleRate: sr };
  }

  function getProcessed() {
    if (!decodedBuffer) return null;
    lastProcessed = processBuffer(decodedBuffer);
    return lastProcessed;
  }

  /* ---------------------------------------------------------
     4. Playback of processed audio
  --------------------------------------------------------- */

  let playbackCtx = null;

  function playProcessed() {
    const result = getProcessed();
    if (!result) return;

    if (playbackCtx) playbackCtx.close();
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();

    const buffer = playbackCtx.createBuffer(1, result.samples.length, result.sampleRate);
    buffer.copyToChannel(result.samples, 0);

    const src = playbackCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(playbackCtx.destination);
    src.start();

    $("rec-status").textContent = "Playing back (processed)…";
    src.onended = () => { $("rec-status").textContent = "Take ready"; };
  }

  /* ---------------------------------------------------------
     5. MP3 export via lamejs
  --------------------------------------------------------- */

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeMp3(samples, sampleRate) {
    const kbps = 128;
    const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const pcm = floatTo16BitPCM(samples);
    const blockSize = 1152;
    const dataChunks = [];

    for (let i = 0; i < pcm.length; i += blockSize) {
      const chunk = pcm.subarray(i, i + blockSize);
      const mp3buf = encoder.encodeBuffer(chunk);
      if (mp3buf.length > 0) dataChunks.push(mp3buf);
    }
    const endBuf = encoder.flush();
    if (endBuf.length > 0) dataChunks.push(endBuf);

    return new Blob(dataChunks, { type: "audio/mp3" });
  }

  async function exportRecording() {
    const result = getProcessed();
    if (!result) return;

    $("export-status").textContent = "Encoding MP3…";
    $("btn-export").disabled = true;

    // let the status message paint before the (synchronous) encode runs
    await new Promise((r) => setTimeout(r, 30));

    let blob;
    try {
      blob = encodeMp3(result.samples, result.sampleRate);
    } catch (err) {
      $("export-status").textContent = "MP3 encoding failed. Please try again.";
      $("btn-export").disabled = false;
      return;
    }

    const filename = `${slugify($("export-filename").value)}.mp3`;

    // trigger download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    // save into the on-device library
    await saveRecordingToLibrary(blob, filename, "audio");

    $("export-status").textContent = `Saved "${filename}" and added it to your library.`;
    $("btn-export").disabled = false;
  }

  /* ---------------------------------------------------------
     6. LIBRARY — text stories (localStorage) + audio (IndexedDB)
  --------------------------------------------------------- */

  const DB_NAME = "palava_voice_db";
  const STORE_NAME = "recordings";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveRecordingToLibrary(blob, filename, kind = "audio") {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({
        id: `rec_${Date.now()}`,
        type: "recording",
        kind, // "audio" | "video"
        title: filename.replace(/\.[a-z0-9]+$/i, ""),
        filename,
        mimeType: blob.type,
        blob,
        createdAt: new Date().toISOString(),
      });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch (err) {
      console.warn("Could not save recording to on-device library:", err);
    }
    renderLibrary();
  }

  async function getAllRecordings() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  async function deleteRecording(id) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      await new Promise((res) => { tx.oncomplete = res; });
    } catch (err) {
      console.warn(err);
    }
    renderLibrary();
  }

  function deleteStory(id) {
    const stories = loadStories().filter((s) => s.id !== id);
    localStorage.setItem(STORY_KEY, JSON.stringify(stories));
    renderLibrary();
  }

  async function renderLibrary() {
    const container = $("library-list");
    const stories = loadStories();
    const recordings = await getAllRecordings();

    if (stories.length === 0 && recordings.length === 0) {
      container.innerHTML = '<p class="telling-empty">No saved stories yet.</p>';
      return;
    }

    container.innerHTML = "";

    recordings
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .forEach((rec) => {
        const item = document.createElement("div");
        item.className = "library-item";
        const kind = rec.kind || "audio";
        const isVideo = kind === "video";

        const url = URL.createObjectURL(rec.blob);
        const mediaTag = isVideo
          ? `<video controls src="${url}" class="library-video"></video>`
          : `<audio controls src="${url}"></audio>`;
        item.innerHTML = `
          <div class="library-item-info">
            <h4>${escapeHtml(rec.title)}</h4>
            <p>${isVideo ? "Video recording" : "Audio recording"} · saved ${new Date(rec.createdAt).toLocaleDateString()}</p>
          </div>
          <div class="library-item-actions">
            ${mediaTag}
            <button type="button" class="btn btn-ghost btn-small" data-share="${rec.id}">Share</button>
            <button type="button" class="btn btn-ghost btn-small" data-drive="${rec.id}">Send to Drive</button>
            <button type="button" class="btn btn-text" data-del-rec="${rec.id}">Delete</button>
          </div>
        `;
        container.appendChild(item);
      });

    stories.forEach((story) => {
      const item = document.createElement("div");
      item.className = "library-item";
      item.innerHTML = `
        <div class="library-item-info">
          <h4>${escapeHtml(story.title)}</h4>
          <p>Story text · ${themeLabels[story.theme] || "advocacy"} · saved ${new Date(story.createdAt).toLocaleDateString()}</p>
        </div>
        <div class="library-item-actions">
          <button type="button" class="btn btn-ghost btn-small" data-load-story="${story.id}">Load into recorder</button>
          <button type="button" class="btn btn-text" data-del-story="${story.id}">Delete</button>
        </div>
      `;
      container.appendChild(item);
    });

    // wire up dynamic buttons
    container.querySelectorAll("[data-del-rec]").forEach((btn) => {
      btn.addEventListener("click", () => deleteRecording(btn.dataset.delRec));
    });
    container.querySelectorAll("[data-del-story]").forEach((btn) => {
      btn.addEventListener("click", () => deleteStory(btn.dataset.delStory));
    });
    container.querySelectorAll("[data-load-story]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const story = stories.find((s) => s.id === btn.dataset.loadStory);
        if (!story) return;
        const readout = $("script-readout");
        readout.innerHTML = "";
        story.text.split("\n\n").forEach((para) => {
          const p = document.createElement("p");
          p.textContent = para;
          readout.appendChild(p);
        });
        $("export-filename").value = slugify(story.title);
        document.querySelector("#record").scrollIntoView({ behavior: "smooth" });
      });
    });
    container.querySelectorAll("[data-drive]").forEach((btn) => {
      btn.addEventListener("click", () => sendRecordingToDrive(btn.dataset.drive, btn));
    });
    container.querySelectorAll("[data-share]").forEach((btn) => {
      btn.addEventListener("click", () => shareRecording(btn.dataset.share, btn));
    });
  }

  async function shareRecording(id, btn) {
    const recordings = await getAllRecordings();
    const rec = recordings.find((r) => r.id === id);
    if (!rec) return;

    const file = new File([rec.blob], rec.filename, { type: rec.mimeType || rec.blob.type });
    const originalLabel = btn.textContent;

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: rec.title });
      } catch (err) {
        // user cancelled the share sheet — not an error worth reporting
      }
      return;
    }

    btn.textContent = "Use downloaded file";
    setTimeout(() => { btn.textContent = originalLabel; }, 2500);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---------------------------------------------------------
     7. DRIVE SYNC via Apps Script web app
  --------------------------------------------------------- */

  const URL_KEY = "https://script.google.com/macros/s/AKfycbwZ0hD0W-Awx4ZcKmpGl5bhMQ_JcfHRwMLNGUa39sO4sUh07nsu_ErmiDiBPp6o7Y1OVQ/exec";

  function loadAppsScriptUrl() {
    const saved = localStorage.getItem(URL_KEY) || "";
    $("apps-script-url").value = saved;
  }

  function saveAppsScriptUrl() {
    const url = $("apps-script-url").value.trim();
    localStorage.setItem(URL_KEY, url);
    $("sync-status").textContent = url
      ? "Connection saved on this device."
      : "Connection cleared.";
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function sendRecordingToDrive(id, btn) {
    const url = localStorage.getItem(URL_KEY);
    if (!url) {
      $("sync-status").textContent = "Add and save an Apps Script Web App URL below first.";
      document.querySelector("#sync").scrollIntoView({ behavior: "smooth" });
      return;
    }

    const recordings = await getAllRecordings();
    const rec = recordings.find((r) => r.id === id);
    if (!rec) return;

    const originalLabel = btn.textContent;
    btn.textContent = "Sending…";
    btn.disabled = true;

    try {
      const base64 = await blobToBase64(rec.blob);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight against Apps Script
        body: JSON.stringify({
          filename: rec.filename,
          mimeType: rec.mimeType || "audio/mp3",
          base64,
          title: rec.title,
        }),
      });
      const text = await res.text();
      let ok = res.ok;
      try {
        const json = JSON.parse(text);
        ok = ok && json.status === "ok";
      } catch { /* non-JSON response, fall back to HTTP status */ }

      btn.textContent = ok ? "Sent ✓" : "Failed — retry";
      if (!ok) btn.disabled = false;
    } catch (err) {
      btn.textContent = "Failed — retry";
      btn.disabled = false;
      console.warn(err);
    }
  }

  /* ---------------------------------------------------------
     8. BROADCAST STUDIO
     TV-style multi-person video: local camera (same room, one
     device) and/or remote panelists joining live over WebRTC.
     Signaling (just finding each other and swapping connection
     details) runs over a Firebase Realtime Database project you
     connect once — no third-party broker, no branding, no
     watermark. The video and audio itself still flow directly
     between devices, peer-to-peer, same as before.
     Everything is composited onto a canvas with a lower-third
     name banner and a scrolling headline ticker, then recorded
     with MediaRecorder and saved on-device.
  --------------------------------------------------------- */

  const urlParams = new URLSearchParams(location.search);
  const roomParam = urlParams.get("room");
  const fbParam = urlParams.get("fb");

  // Public, free STUN servers (Google) for NAT traversal, plus a small
  // free public TURN fallback (openrelay.metered.ca) for the harder cases
  // — mobile networks and strict firewalls — where a direct connection
  // can't be found. Advanced users can override this list in Broadcast
  // Studio settings with their own TURN credentials for heavier use.
  const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ];

  const FIREBASE_CONFIG_KEY = "palava_voice_firebase_config";
  const ICE_SERVERS_KEY = "palava_voice_ice_servers";

  function getIceServers() {
    try {
      const custom = JSON.parse(localStorage.getItem(ICE_SERVERS_KEY));
      if (Array.isArray(custom) && custom.length) return custom;
    } catch { /* fall through to defaults */ }
    return DEFAULT_ICE_SERVERS;
  }

  let fbApp = null;
  let fbDb = null;

  function getSavedFirebaseConfig() {
    try {
      return JSON.parse(localStorage.getItem(FIREBASE_CONFIG_KEY) || "null");
    } catch {
      return null;
    }
  }

  function initFirebase(config) {
    if (fbDb) return fbDb;
    if (typeof firebase === "undefined") {
      throw new Error("Firebase library did not load — check your connection and reload.");
    }
    fbApp = firebase.apps && firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(config);
    fbDb = firebase.database();
    return fbDb;
  }

  function randomId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---- roster: everyone who can appear in the lower third ----
  let roster = []; // { id, name, role, source: 'local'|'remote', peerId, active }

  function addRosterEntry(name, role, opts = {}) {
    if (!name) return null;
    const entry = {
      id: opts.id || `panel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      role: role || "",
      source: opts.source || "local",
      peerId: opts.peerId || null,
    };
    roster.push(entry);
    if (roster.length === 1) setActivePanelist(entry.id);
    renderRoster();
    return entry;
  }

  function upsertRosterForPeer(peerId, name, role) {
    const existing = roster.find((r) => r.peerId === peerId);
    if (existing) {
      existing.name = name || existing.name;
      existing.role = role || existing.role;
      renderRoster();
      return existing;
    }
    return addRosterEntry(name || "Remote panelist", role || "", { source: "remote", peerId });
  }

  function removeRosterByPeer(peerId) {
    roster = roster.filter((r) => r.peerId !== peerId);
    if (activeLowerThird && activeLowerThird.peerId === peerId) activeLowerThird = null;
    renderRoster();
  }

  function removeRosterEntry(id) {
    roster = roster.filter((r) => r.id !== id);
    renderRoster();
  }

  let activeLowerThird = null; // { name, role, since, peerId }

  function setActivePanelist(id) {
    const entry = roster.find((r) => r.id === id);
    if (!entry) return;
    activeLowerThird = { name: entry.name, role: entry.role, since: performance.now(), peerId: entry.peerId };
    renderRoster();
  }

  function renderRoster() {
    const list = $("roster-list");
    if (!list) return;
    if (roster.length === 0) {
      list.innerHTML = '<p class="telling-empty">No panelists added yet.</p>';
      return;
    }
    list.innerHTML = "";
    roster.forEach((entry) => {
      const row = document.createElement("div");
      const isActive = activeLowerThird && activeLowerThird.name === entry.name && activeLowerThird.role === entry.role;
      row.className = "roster-row" + (isActive ? " roster-row-active" : "");
      row.innerHTML = `
        <button type="button" class="roster-select" data-activate="${entry.id}">
          <span class="roster-name">${escapeHtml(entry.name)}</span>
          <span class="roster-role">${escapeHtml(entry.role || (entry.source === "remote" ? "remote panelist" : ""))}</span>
        </button>
        <button type="button" class="roster-remove" data-remove="${entry.id}" aria-label="Remove ${escapeHtml(entry.name)}">&times;</button>
      `;
      list.appendChild(row);
    });
    list.querySelectorAll("[data-activate]").forEach((btn) => {
      btn.addEventListener("click", () => setActivePanelist(btn.dataset.activate));
    });
    list.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => removeRosterEntry(btn.dataset.remove));
    });
  }

  // ---- local camera ----
  let localStream = null;
  let currentFacingMode = "user";
  const localVideoEl = document.createElement("video");
  localVideoEl.muted = true;
  localVideoEl.playsInline = true;
  localVideoEl.autoplay = true;

  let studioAudioCtx = null;
  let mixDest = null;

  function ensureAudioMixer() {
    if (!studioAudioCtx) {
      studioAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      mixDest = studioAudioCtx.createMediaStreamDestination();
    }
    return mixDest;
  }

  async function startLocalCamera() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: currentFacingMode },
        audio: { echoCancellation: true },
      });
    } catch (err) {
      $("video-status").textContent = "Camera/microphone access denied.";
      return;
    }
    localVideoEl.srcObject = localStream;
    localVideoEl.play().catch(() => {});

    const dest = ensureAudioMixer();
    const src = studioAudioCtx.createMediaStreamSource(localStream);
    src.connect(dest);

    $("btn-cam-start").textContent = "Camera on";
    $("btn-cam-start").disabled = true;
    $("btn-video-record").disabled = false;
    $("btn-cam-flip").hidden = false;
    startDrawLoop();
  }

  // switches between front/back camera without dropping the ongoing call —
  // only the video track is replaced, so remote panelists keep hearing audio
  // and the recording (if running) continues uninterrupted
  async function flipHostCamera() {
    if (!localStream) return;
    const newFacing = currentFacingMode === "user" ? "environment" : "user";
    let newVideoTrack;
    try {
      const swapStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: newFacing }, width: 1280, height: 720 },
      });
      newVideoTrack = swapStream.getVideoTracks()[0];
    } catch (err) {
      $("video-status").textContent = "Could not switch camera — this device may only have one.";
      return;
    }

    const oldVideoTrack = localStream.getVideoTracks()[0];
    if (oldVideoTrack) {
      localStream.removeTrack(oldVideoTrack);
      oldVideoTrack.stop();
    }
    localStream.addTrack(newVideoTrack);
    localVideoEl.srcObject = localStream;
    localVideoEl.play().catch(() => {});

    remoteTiles.forEach((tile) => {
      if (!tile.pc) return;
      const sender = tile.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(newVideoTrack);
    });

    currentFacingMode = newFacing;
  }

  // ---- remote panelists (host side) — WebRTC signaled over Firebase ----
  const remoteTiles = new Map(); // peerId -> { videoEl, audioNode, pc }
  let currentSessionId = null;
  let sessionPeersRef = null;

  function saveFirebaseConfig(configText) {
    try {
      const parsed = JSON.parse(configText);
      localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(parsed));
      return parsed;
    } catch {
      return null;
    }
  }

  async function createRoom() {
    const config = getSavedFirebaseConfig();
    if (!config) {
      $("remote-status").textContent = "Paste and save your Firebase config below first.";
      return;
    }
    if (!localStream) await startLocalCamera();

    try {
      initFirebase(config);
    } catch (err) {
      $("remote-status").textContent = err.message;
      return;
    }

    currentSessionId = randomId("session");
    sessionPeersRef = fbDb.ref(`sessions/${currentSessionId}/peers`);

    const fbParamValue = btoa(JSON.stringify(config));
    const link = `${location.origin}${location.pathname}?room=${currentSessionId}&fb=${fbParamValue}`;
    $("room-link").value = link;
    $("room-link-block").hidden = false;
    $("remote-status").textContent = "Share this link with a remote panelist. They'll appear on screen once they join.";

    sessionPeersRef.on("child_added", (snap) => handleNewPanelistNode(snap.key, snap.ref));
    sessionPeersRef.on("child_removed", (snap) => {
      removeRemoteTile(snap.key);
      removeRosterByPeer(snap.key);
    });
  }

  function handleNewPanelistNode(peerId, peerRef) {
    let answered = false;
    upsertRosterForPeer(peerId, "Remote panelist", "connecting…");

    peerRef.on("value", async (snap) => {
      const data = snap.val();
      if (!data) return;

      if (data.identify) {
        upsertRosterForPeer(peerId, data.identify.name, data.identify.role);
      }

      if (data.offer && !answered) {
        answered = true;
        const pc = new RTCPeerConnection({ iceServers: getIceServers() });

        if (localStream) {
          localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        }
        pc.ontrack = (event) => addRemoteTile(peerId, event.streams[0], pc);
        pc.onicecandidate = (event) => {
          if (event.candidate) peerRef.child("hostCandidates").push(event.candidate.toJSON());
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        peerRef.child("answer").set({ type: answer.type, sdp: answer.sdp });

        peerRef.child("panelistCandidates").on("child_added", (candSnap) => {
          pc.addIceCandidate(new RTCIceCandidate(candSnap.val())).catch(() => {});
        });
      }
    });
  }

  function addRemoteTile(peerId, stream, pc) {
    if (remoteTiles.has(peerId)) return;
    const videoEl = document.createElement("video");
    videoEl.srcObject = stream;
    videoEl.muted = false;
    videoEl.playsInline = true;
    videoEl.autoplay = true;
    videoEl.play().catch(() => {});

    let audioNode = null;
    if (stream.getAudioTracks().length > 0) {
      const dest = ensureAudioMixer();
      audioNode = studioAudioCtx.createMediaStreamSource(stream);
      audioNode.connect(dest);
    }

    remoteTiles.set(peerId, { videoEl, audioNode, pc });
    startDrawLoop();
  }

  function removeRemoteTile(peerId) {
    const tile = remoteTiles.get(peerId);
    if (tile) {
      if (tile.audioNode) { try { tile.audioNode.disconnect(); } catch {} }
      if (tile.pc) { try { tile.pc.close(); } catch {} }
    }
    remoteTiles.delete(peerId);
  }

  /* ---- panelist (joiner) side ---- */
  function initPanelistJoin() {
    document.body.classList.add("panelist-mode");
    $("panelist-join").hidden = false;

    let joinerStream = null;
    let pc = null;
    let panelistFacing = "user";

    $("btn-panelist-flip").addEventListener("click", async () => {
      if (!joinerStream) return;
      const newFacing = panelistFacing === "user" ? "environment" : "user";
      let newVideoTrack;
      try {
        const swapStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: newFacing }, width: 1280, height: 720 },
        });
        newVideoTrack = swapStream.getVideoTracks()[0];
      } catch (err) {
        $("panelist-status").textContent = "Could not switch camera — this device may only have one.";
        return;
      }

      const oldVideoTrack = joinerStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        joinerStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
      }
      joinerStream.addTrack(newVideoTrack);
      $("panelist-preview").srcObject = joinerStream;

      if (pc) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(newVideoTrack);
      }
      panelistFacing = newFacing;
    });

    $("btn-panelist-start").addEventListener("click", async () => {
      const name = $("panelist-name").value.trim();
      if (!name) {
        $("panelist-status").textContent = "Please enter your name first.";
        return;
      }
      const role = $("panelist-title").value.trim();

      let config;
      try {
        config = JSON.parse(atob(fbParam));
      } catch {
        $("panelist-status").textContent = "This join link looks incomplete. Ask the host to resend it.";
        return;
      }

      try {
        joinerStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: panelistFacing },
          audio: { echoCancellation: true },
        });
      } catch (err) {
        $("panelist-status").textContent = "Camera/microphone access denied.";
        return;
      }
      $("panelist-preview").srcObject = joinerStream;
      $("btn-panelist-start").disabled = true;
      $("btn-panelist-flip").hidden = false;
      $("panelist-status").textContent = "Connecting to the host…";

      try {
        initFirebase(config);
      } catch (err) {
        $("panelist-status").textContent = err.message;
        return;
      }

      const peerId = randomId("peer");
      const peerRef = fbDb.ref(`sessions/${roomParam}/peers/${peerId}`);
      peerRef.onDisconnect().remove();

      pc = new RTCPeerConnection({ iceServers: getIceServers() });
      joinerStream.getTracks().forEach((track) => pc.addTrack(track, joinerStream));

      pc.ontrack = () => {
        $("panelist-status").textContent = "You're live — connected to the host.";
      };
      pc.onicecandidate = (event) => {
        if (event.candidate) peerRef.child("panelistCandidates").push(event.candidate.toJSON());
      };
      pc.oniceconnectionstatechange = () => {
        if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
          $("panelist-status").textContent = "Connection lost. Ask the host for a fresh link if this doesn't recover.";
        }
      };

      await peerRef.child("identify").set({ name, role });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await peerRef.child("offer").set({ type: offer.type, sdp: offer.sdp });

      peerRef.child("answer").on("value", async (snap) => {
        const answer = snap.val();
        if (answer && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
      });
      peerRef.child("hostCandidates").on("child_added", (candSnap) => {
        pc.addIceCandidate(new RTCIceCandidate(candSnap.val())).catch(() => {});
      });
    });
  }

  // ---- canvas compositing: grid of tiles + TV lower third + ticker ----
  const bcCanvas = $("broadcast-canvas");
  const bcCtx = bcCanvas ? bcCanvas.getContext("2d") : null;
  let drawLoopRunning = false;
  let tickerX = null;
  let lastTs = 0;

  function computeGrid(n, w, h) {
    if (n <= 0) return [];
    if (n === 1) return [[0, 0, w, h]];
    if (n === 2) return [[0, 0, w / 2, h], [w / 2, 0, w / 2, h]];
    if (n === 3) return [[0, 0, w / 2, h / 2], [w / 2, 0, w / 2, h / 2], [0, h / 2, w, h / 2]];
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const rects = [];
    for (let i = 0; i < n; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      rects.push([col * (w / cols), row * (h / rows), w / cols, h / rows]);
    }
    return rects;
  }

  function drawVideoCover(video, x, y, w, h) {
    if (!video.videoWidth) return;
    const vRatio = video.videoWidth / video.videoHeight;
    const cRatio = w / h;
    let sx, sy, sw, sh;
    if (vRatio > cRatio) {
      sh = video.videoHeight;
      sw = sh * cRatio;
      sx = (video.videoWidth - sw) / 2;
      sy = 0;
    } else {
      sw = video.videoWidth;
      sh = sw / cRatio;
      sx = 0;
      sy = (video.videoHeight - sh) / 2;
    }
    bcCtx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
  }

  function drawFrame(ts) {
    if (!bcCtx) return;
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    const W = bcCanvas.width, H = bcCanvas.height;

    bcCtx.fillStyle = "#121D34";
    bcCtx.fillRect(0, 0, W, H);

    const tiles = [];
    if (localStream) tiles.push({ video: localVideoEl, label: "" });
    remoteTiles.forEach((t) => tiles.push({ video: t.videoEl, label: "" }));

    if (tiles.length === 0) {
      bcCtx.fillStyle = "rgba(242,232,213,0.55)";
      bcCtx.font = "28px Karla, sans-serif";
      bcCtx.textAlign = "center";
      bcCtx.fillText("Turn on the camera to begin", W / 2, H / 2);
      bcCtx.textAlign = "left";
    } else {
      const rects = computeGrid(tiles.length, W, H);
      tiles.forEach((tile, i) => {
        const [x, y, w, h] = rects[i];
        bcCtx.save();
        bcCtx.beginPath();
        bcCtx.rect(x, y, w, h);
        bcCtx.clip();
        drawVideoCover(tile.video, x, y, w, h);
        bcCtx.restore();
        if (tiles.length > 1) {
          bcCtx.strokeStyle = "rgba(18,29,52,0.9)";
          bcCtx.lineWidth = 3;
          bcCtx.strokeRect(x, y, w, h);
        }
      });
    }

    drawTopBar(W, H);
    if (activeLowerThird) drawLowerThird(W, H, ts);
    drawTicker(W, H, dt);

    if (drawLoopRunning) requestAnimationFrame(drawFrame);
  }

  function drawTopBar(W, H) {
    const title = $("program-title") ? $("program-title").value.trim() : "";
    bcCtx.fillStyle = "rgba(18,29,52,0.78)";
    bcCtx.fillRect(0, 0, W, 56);

    // blinking LIVE badge
    const blink = Math.floor(performance.now() / 600) % 2 === 0;
    bcCtx.fillStyle = blink ? "#C6491B" : "#8a3313";
    bcCtx.fillRect(20, 14, 66, 28);
    bcCtx.fillStyle = "#F2E8D5";
    bcCtx.font = "700 15px Karla, sans-serif";
    bcCtx.textAlign = "center";
    bcCtx.fillText("LIVE", 53, 33);

    if (title) {
      bcCtx.textAlign = "left";
      bcCtx.fillStyle = "#F2E8D5";
      bcCtx.font = "600 22px Fraunces, serif";
      bcCtx.fillText(title, 104, 36);
    }
    bcCtx.textAlign = "left";
  }

  function drawLowerThird(W, H, ts) {
    const elapsed = ts - activeLowerThird.since;
    const slideProgress = Math.min(1, elapsed / 350);
    const eased = 1 - Math.pow(1 - slideProgress, 3);
    const barY = H - 150;
    const barH = 78;
    const xOffset = (1 - eased) * -420;

    bcCtx.save();
    bcCtx.translate(xOffset, 0);

    bcCtx.fillStyle = "#C6491B";
    bcCtx.fillRect(0, barY, 8, barH);
    bcCtx.fillStyle = "rgba(18,29,52,0.88)";
    bcCtx.fillRect(8, barY, 460, barH);

    bcCtx.fillStyle = "#F2E8D5";
    bcCtx.font = "600 26px Fraunces, serif";
    bcCtx.fillText(activeLowerThird.name, 30, barY + 32);

    if (activeLowerThird.role) {
      bcCtx.fillStyle = "#E8A93B";
      bcCtx.font = "400 17px Karla, sans-serif";
      bcCtx.fillText(activeLowerThird.role, 30, barY + 58);
    }
    bcCtx.restore();
  }

  function drawTicker(W, H, dt) {
    const raw = $("ticker-text") ? $("ticker-text").value : "";
    const items = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    const tickerY = H - 44;

    bcCtx.fillStyle = "rgba(198,73,27,0.92)";
    bcCtx.fillRect(0, tickerY, W, 44);

    if (items.length === 0) return;

    const text = items.join("      •      ") + "      •      ";
    bcCtx.font = "600 20px Karla, sans-serif";
    const textWidth = bcCtx.measureText(text).width;

    const speed = 90; // px/sec
    if (tickerX === null) tickerX = W;
    tickerX -= speed * (dt || 1 / 60);
    if (tickerX <= -textWidth) tickerX = W;

    bcCtx.fillStyle = "#F2E8D5";
    bcCtx.textBaseline = "middle";
    bcCtx.fillText(text, tickerX, tickerY + 22);
    bcCtx.fillText(text, tickerX + textWidth, tickerY + 22);
    bcCtx.textBaseline = "alphabetic";
  }

  function startDrawLoop() {
    if (drawLoopRunning || !bcCtx) return;
    drawLoopRunning = true;
    requestAnimationFrame(drawFrame);
  }

  // ---- recording the composited canvas + mixed audio ----
  let videoRecorder = null;
  let videoChunks = [];
  let recordedVideoBlob = null;
  let videoStartTime = 0;
  let videoTimerInterval = null;

  function pickVideoMimeType() {
    const candidates = [
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  }

  function startVideoRecording() {
    if (!bcCanvas) return;
    const canvasStream = bcCanvas.captureStream(30);
    const audioTracks = mixDest ? mixDest.stream.getAudioTracks() : [];
    const combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

    const mimeType = pickVideoMimeType();
    videoRecorder = mimeType
      ? new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 2_500_000 })
      : new MediaRecorder(combined);

    videoChunks = [];
    videoRecorder.ondataavailable = (e) => { if (e.data.size > 0) videoChunks.push(e.data); };
    videoRecorder.onstop = handleVideoStopped;
    videoRecorder.start(1000);

    videoStartTime = Date.now();
    $("video-timer").textContent = "00:00";
    videoTimerInterval = setInterval(() => {
      $("video-timer").textContent = fmtTime((Date.now() - videoStartTime) / 1000);
    }, 250);

    $("btn-video-record").disabled = true;
    $("btn-video-stop").disabled = false;
    $("btn-video-export").disabled = true;
    $("video-status").textContent = "Recording the screening…";
  }

  function stopVideoRecording() {
    if (videoRecorder && videoRecorder.state !== "inactive") videoRecorder.stop();
    if (videoTimerInterval) clearInterval(videoTimerInterval);
    $("btn-video-record").disabled = false;
    $("btn-video-stop").disabled = true;
  }

  function handleVideoStopped() {
    const mimeType = videoRecorder.mimeType || "video/webm";
    recordedVideoBlob = new Blob(videoChunks, { type: mimeType });
    $("btn-video-export").disabled = false;
    $("video-status").textContent = "Recording ready — save it to your device.";
  }

  async function exportVideoRecording() {
    if (!recordedVideoBlob) return;
    const ext = recordedVideoBlob.type.includes("mp4") ? "mp4" : "webm";
    const filename = `${slugify($("video-filename").value)}.${ext}`;

    const url = URL.createObjectURL(recordedVideoBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    await saveRecordingToLibrary(recordedVideoBlob, filename, "video");
    $("video-status").textContent = `Saved "${filename}" and added it to your library.`;
  }

  function initBroadcastStudio() {
    if (!bcCanvas) return; // page doesn't have the studio (defensive)
    startDrawLoop(); // shows the idle "turn on camera" placeholder immediately

    $("btn-cam-start").addEventListener("click", startLocalCamera);
    $("btn-cam-flip").addEventListener("click", flipHostCamera);
    $("btn-video-record").addEventListener("click", startVideoRecording);
    $("btn-video-stop").addEventListener("click", stopVideoRecording);
    $("btn-video-export").addEventListener("click", exportVideoRecording);

    $("btn-roster-add").addEventListener("click", () => {
      const name = $("roster-name").value.trim();
      const role = $("roster-role").value.trim();
      if (!name) return;
      addRosterEntry(name, role, { source: "local" });
      $("roster-name").value = "";
      $("roster-role").value = "";
    });

    $("btn-create-room").addEventListener("click", createRoom);
    $("btn-copy-link").addEventListener("click", async () => {
      const field = $("room-link");
      field.select();
      try {
        await navigator.clipboard.writeText(field.value);
        $("btn-copy-link").textContent = "Copied";
        setTimeout(() => { $("btn-copy-link").textContent = "Copy"; }, 1800);
      } catch {
        // clipboard API unavailable — the field is selected for manual copy
      }
    });

    const savedConfig = getSavedFirebaseConfig();
    if (savedConfig) {
      $("firebase-config").value = JSON.stringify(savedConfig, null, 2);
      $("calling-setup-status").textContent = "Calling service connected on this device.";
    }
    $("btn-save-firebase-config").addEventListener("click", () => {
      const parsed = saveFirebaseConfig($("firebase-config").value.trim());
      $("calling-setup-status").textContent = parsed
        ? "Calling service connected on this device."
        : "That doesn't look like a valid Firebase config — paste the full snippet from the Firebase console.";
    });

    renderRoster();
  }

  /* ---------------------------------------------------------
     9. Wire everything up
  --------------------------------------------------------- */

  function init() {
    // a remote panelist opened a ?room=... join link — show only that screen
    if (roomParam) {
      initPanelistJoin();
      return;
    }

    // mobile nav
    const navToggle = $("nav-toggle");
    const topnav = $("topnav");
    navToggle.addEventListener("click", () => {
      const isOpen = topnav.classList.toggle("topnav-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });
    topnav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        topnav.classList.remove("topnav-open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });

    // composer
    [
      "story-title", "story-theme", ...fieldIds,
    ].forEach((id) => $(id).addEventListener("input", renderTelling));
    $("btn-compose").addEventListener("click", renderTelling);
    $("btn-clear-form").addEventListener("click", clearForm);
    $("btn-save-story").addEventListener("click", saveStoryToLibrary);
    $("btn-send-to-recorder").addEventListener("click", sendToRecorder);

    // recorder
    $("btn-record").addEventListener("click", startRecording);
    $("btn-stop").addEventListener("click", stopRecording);
    $("btn-play").addEventListener("click", playProcessed);
    $("btn-rerecord").addEventListener("click", discardRecording);
    $("btn-export").addEventListener("click", exportRecording);

    // broadcast studio
    initBroadcastStudio();

    // sync
    $("btn-save-url").addEventListener("click", saveAppsScriptUrl);
    loadAppsScriptUrl();

    renderTelling();
    renderLibrary();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
