(() => {
  'use strict';
  const C = window.LipSyncCore, M = window.LipSyncMedia;
  const $ = id => document.getElementById(id);
  const state = {
    mode: 2, mapping: C.defaultMapping(2), images: {}, expected: {},
    audio: null, audioFile: null, sheet: null, labelFile: null,
    jobs: [], folderName: '', droppedFolderName: '', busy: false, loading: 0, controller: null,
    context: null, source: null, playing: false, starting: false, playVersion: 0, raf: 0, position: 0, startedAt: 0,
    audioVersion: 0, labelVersion: 0, imageVersions: {}, urls: {},
  };
  const duration = () => Math.max(state.audio?.duration || 0, state.sheet?.duration || 0);
  const settings = () => ({mode: state.mode, fps: Number($('fps').value), mapping: {...state.mapping}});
  function message(text, success = false) {
    $('message').textContent = text;
    $('message').classList.toggle('success', success);
    $('message').hidden = !text;
  }
  function status(text, tone = '') {
    $('status-text').textContent = text;
    $('status').dataset.tone = tone;
  }
  function guard(fn) {
    return async (...args) => {
      try { await fn(...args); }
      catch (error) { message(error.message || String(error)); status('確認が必要です', 'error'); }
    };
  }
  function context() {
    if (!state.context) state.context = new AudioContext({sampleRate: 48000});
    return state.context;
  }
  async function decodeAudio(file) {
    if (file.size > 250_000_000) throw new Error(`${file.name}: 音声は250 MB以下にしてください。`);
    let audio;
    try { audio = await context().decodeAudioData(await file.arrayBuffer()); }
    catch { throw new Error(`${file.name}: Chromeで読み込めない音声です。WAV・MP3・FLACなどに変換してください。`); }
    if (audio.numberOfChannels > 2) throw new Error(`${file.name}: モノラルまたはステレオの音声を指定してください。`);
    return audio;
  }
  async function bitmap(blob, name) {
    if (blob.size > 80_000_000) throw new Error(`${name}: 画像は80 MB以下にしてください。`);
    let image;
    try { image = await createImageBitmap(blob); }
    catch { throw new Error(`${name}: 画像を読み込めません。PNG / WebPを指定してください。`); }
    try {
      if (image.width * image.height > 16_000_000) throw new Error(`${name}: 画像は1600万ピクセル以下にしてください。`);
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let transparent = false;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) { transparent = true; break; }
      if (!transparent) throw new Error(`${name}: 背景透過の画像を指定してください。この画像には透過部分がありません。`);
      const normalized = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像の変換に失敗しました。')), 'image/png'));
      return {bitmap: image, width: image.width, height: image.height, name, blob: normalized, url: URL.createObjectURL(normalized)};
    } catch (error) { image.close(); throw error; }
  }
  function disposeImage(image) {
    if (image) { image.bitmap.close(); URL.revokeObjectURL(image.url); }
  }
  function assetError() {
    const config = settings();
    try { C.validateSettings(config); } catch (error) { return error.message; }
    const missing = C.SLOTS[state.mode].filter(slot => !state.images[slot]);
    if (missing.length) return `画像を指定してください: ${missing.map(C.slotLabel).join('、')}`;
    const first = state.images[C.SLOTS[state.mode][0]];
    for (const slot of C.SLOTS[state.mode]) {
      const image = state.images[slot];
      if (image.width !== first.width || image.height !== first.height) return `画像サイズが揃っていません。基準 ${first.width}×${first.height} / ${image.name} ${image.width}×${image.height}`;
    }
    return '';
  }
  function singleReady() { return !!state.audio && !!state.sheet && !assetError(); }
  function updateReady() {
    const locked = state.busy || state.loading > 0;
    $('export').disabled = locked || !singleReady();
    $('play').disabled = locked || state.starting || !state.audio || !state.sheet;
    $('restart').disabled = locked || !state.audio || !state.sheet;
    $('seek').disabled = locked || !state.audio || !state.sheet;
    $('seek').max = duration() || 1;
    $('duration-time').textContent = C.formatTime(duration());
    $('batch-export').disabled = locked || !!assetError() || !state.jobs.some(job => job.label && !job.error);
    $('playback-label').textContent = state.playing ? '再生中' : state.audio && state.sheet ? 'プレビューを再生' : '音声とラベルを選択';
    if (!locked) {
      const sizeError = assetError();
      if (sizeError.startsWith('画像サイズ')) status('画像サイズを確認してください', 'error');
      else status(singleReady() ? '書き出しの準備完了' : '素材を選択してください', singleReady() ? 'success' : '');
    }
  }
  function invalidateOutput() {
    $('movie-download').hidden = true;
    if (state.urls.movie) { URL.revokeObjectURL(state.urls.movie); delete state.urls.movie; }
  }
  function imageSlots() {
    const host = $('image-slots'); host.replaceChildren(); host.className = `image-slots mode-${state.mode}`;
    for (const slot of C.SLOTS[state.mode]) {
      const image = state.images[slot];
      const label = document.createElement('label'); label.className = 'image-slot'; label.dataset.slot = slot;
      if (image) {
        label.classList.add('loaded');
        const img = document.createElement('img'); img.src = image.url; img.alt = C.slotLabel(slot); label.append(img);
      } else {
        label.innerHTML = '<svg class="slot-icon"><use href="#i-image"/></svg>';
        if (state.expected[slot]) label.classList.add('expected');
      }
      const title = document.createElement('span'); title.className = 'slot-title'; title.textContent = C.slotLabel(slot);
      const meta = document.createElement('span'); meta.className = 'slot-meta'; meta.textContent = image?.name || state.expected[slot] || '画像を選択'; meta.title = meta.textContent;
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.png,.webp,image/png,image/webp'; input.setAttribute('aria-label', `立ち絵 ${C.slotLabel(slot)}`);
      input.disabled = state.busy; input.addEventListener('change', guard(() => input.files[0] && loadImage(slot, input.files[0])));
      label.append(title, meta, input); host.append(label);
      fileDrop(label, file => loadImage(slot, file));
    }
    const loaded = C.SLOTS[state.mode].filter(slot => state.images[slot]);
    $('image-count').textContent = `${loaded.length} / ${C.SLOTS[state.mode].length}`;
    const first = state.images[loaded[0]];
    $('size-summary').lastElementChild.textContent = first ? `${first.width} × ${first.height} px · 全画像を同じサイズにしてください` : '元の画像サイズで書き出します';
    $('preview-size').textContent = first ? `${first.width} × ${first.height} px` : '— × — px';
  }
  function renderMapping() {
    const host = $('mapping-body'); host.replaceChildren();
    for (const shape of C.SHAPES) {
      const row = document.createElement('tr');
      const badge = document.createElement('span'); badge.className = 'shape-badge'; badge.textContent = shape;
      const shapeCell = document.createElement('td'); shapeCell.append(badge);
      const help = document.createElement('td'); help.className = 'phoneme-hint'; help.textContent = C.SHAPE_HELP[shape];
      const select = document.createElement('select'); select.setAttribute('aria-label', `口形${shape}の画像`); select.disabled = state.busy;
      for (const slot of C.SLOTS[state.mode]) { const option = document.createElement('option'); option.value = slot; option.textContent = C.slotLabel(slot); select.append(option); }
      select.value = state.mapping[shape];
      select.addEventListener('change', () => { state.mapping[shape] = select.value; invalidateOutput(); renderMapping(); drawPreview(); drawTimeline(); updateReady(); });
      const selectCell = document.createElement('td'); selectCell.append(select);
      const imageCell = document.createElement('td');
      const image = state.images[state.mapping[shape]];
      if (image) { const img = document.createElement('img'); img.src = image.url; img.className = 'mapping-thumb'; img.alt = C.slotLabel(state.mapping[shape]); imageCell.append(img); }
      else { imageCell.textContent = '—'; imageCell.style.color = '#b1bac3'; }
      row.append(shapeCell, help, selectCell, imageCell); host.append(row);
    }
  }
  function setMode(mode) {
    if (state.busy || state.loading) return;
    pause(); state.mode = mode; state.mapping = C.defaultMapping(mode); invalidateOutput();
    for (const button of document.querySelectorAll('[data-mode]')) { const selected = Number(button.dataset.mode) === mode; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); }
    imageSlots(); renderMapping(); drawPreview(); drawTimeline(); updateReady(); message('');
  }
  async function loadImage(slot, file) {
    if (state.busy) return;
    if (!/\.(png|webp)$/i.test(file.name)) throw new Error('立ち絵は透過PNG / WebPを指定してください。');
    const version = (state.imageVersions[slot] || 0) + 1; state.imageVersions[slot] = version;
    pause(); state.loading++; updateReady();
    try {
      const image = await bitmap(file, file.name);
      if (state.imageVersions[slot] !== version) { disposeImage(image); return; }
      disposeImage(state.images[slot]); state.images[slot] = image; delete state.expected[slot];
      invalidateOutput(); imageSlots(); renderMapping(); drawPreview(); message(assetError().startsWith('画像サイズ') ? assetError() : '');
    } finally { state.loading--; updateReady(); }
  }
  async function loadAudio(file) {
    if (state.busy) return;
    const version = ++state.audioVersion;
    pause(); state.position = 0; state.audio = null; state.audioFile = null; state.loading++;
    $('audio-name').textContent = '読み込み中…'; $('audio-drop').classList.remove('loaded'); updateReady(); invalidateOutput(); drawTimeline(); drawPreview();
    try {
      const audio = await decodeAudio(file);
      if (version !== state.audioVersion) return;
      state.audio = audio; state.audioFile = file;
      $('audio-name').textContent = file.name; $('audio-name').title = file.name;
      $('audio-detail').textContent = `${C.formatTime(audio.duration)} · ${audio.sampleRate / 1000} kHz · ${audio.numberOfChannels === 1 ? 'モノラル' : 'ステレオ'}`;
      $('audio-drop').classList.add('loaded'); $('output-name').value = C.stem(file.name);
      message(''); drawTimeline(); drawPreview();
    } catch (error) { if (version === state.audioVersion) { $('audio-name').textContent = 'クリックまたはドロップ'; $('audio-detail').textContent = 'WAV / MP3 / FLAC / M4A など'; } throw error; }
    finally { state.loading--; updateReady(); }
  }
  async function loadLabel(file) {
    if (state.busy) return;
    const version = ++state.labelVersion;
    pause(); state.position = 0; state.sheet = null; state.labelFile = null; state.loading++; invalidateOutput(); updateReady();
    $('label-drop').classList.remove('loaded'); $('label-name').textContent = '読み込み中…';
    try {
      const sheet = await C.readLabels(file);
      if (version !== state.labelVersion) return;
      state.sheet = sheet; state.labelFile = file;
      $('label-name').textContent = file.name; $('label-name').title = file.name;
      $('label-detail').textContent = `${sheet.cues.length} 区間 · ${C.formatTime(sheet.duration)}`;
      $('label-drop').classList.add('loaded'); message('');
    } catch (error) { if (version === state.labelVersion) { $('label-name').textContent = 'クリックまたはドロップ'; $('label-detail').textContent = '.lab · UTF-8 · 時刻は100 ns単位'; } throw error; }
    finally { state.loading--; drawTimeline(); drawPreview(); updateReady(); }
  }
  function drawPreview() {
    const shape = C.shapeAt(state.sheet, state.position), slot = state.mapping[shape];
    const image = state.images[slot] || state.images[C.SLOTS[state.mode].find(s => state.images[s])];
    const canvas = $('preview-canvas'), ctx = canvas.getContext('2d');
    if (image) {
      if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height; }
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image.bitmap, 0, 0);
    } else ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('preview-empty').hidden = !!image; $('current-shape').hidden = !image;
    $('current-shape').textContent = `${shape} · ${C.slotLabel(slot)}`;
    $('current-time').textContent = C.formatTime(state.position);
    $('seek').value = state.position;
    $('playhead').style.left = `${duration() ? state.position / duration() * 100 : 0}%`;
  }
  function drawTimeline() {
    const canvas = $('waveform'), ctx = canvas.getContext('2d'), {width, height} = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#c4d7dc'; ctx.lineWidth = 1;
    const total = duration();
    if (state.audio && total) {
      const samples = state.audio.getChannelData(0), bars = 200, audioRatio = state.audio.duration / total;
      for (let i = 0; i < bars * audioRatio; i++) {
        const start = Math.floor(i / (bars * audioRatio) * samples.length), end = Math.min(samples.length, Math.floor((i + 1) / (bars * audioRatio) * samples.length));
        let peak = 0;
        const stride = Math.max(1, Math.floor((end - start) / 100));
        for (let j = start; j < end; j += stride) peak = Math.max(peak, Math.abs(samples[j]));
        const amp = Math.max(1.2, peak * height * .46);
        ctx.beginPath(); ctx.moveTo(i / bars * width + 2, height / 2 - amp); ctx.lineTo(i / bars * width + 2, height / 2 + amp); ctx.stroke();
      }
    } else { ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke(); }
    const track = $('cue-track'); track.replaceChildren();
    const colors = ['#7bc9ba', '#9fcacb', '#8cb9d0', '#87ccaf', '#c4c6db', '#a2d1b4', '#b6d5de', '#a6c1ca', '#dfe8ed'];
    if (state.sheet && total) for (const cue of state.sheet.cues) {
      const block = document.createElement('span'); block.className = 'cue-block';
      block.style.left = `${cue.start / total * 100}%`; block.style.width = `${(cue.end - cue.start) / total * 100}%`;
      block.style.background = colors[C.SHAPES.indexOf(cue.value)]; track.append(block);
    }
    drawPreview();
  }
  function pause() {
    state.playVersion++; state.starting = false; cancelAnimationFrame(state.raf);
    if (state.playing) state.position = Math.min(duration(), context().currentTime - state.startedAt);
    state.playing = false;
    if (state.source) { try { state.source.stop(); } catch {} state.source.disconnect(); state.source = null; }
    $('play').innerHTML = '<svg><use href="#i-play"/></svg>'; $('play').setAttribute('aria-label', '再生');
    drawPreview(); updateReady();
  }
  async function play() {
    if (state.playing) { pause(); return; }
    if (!state.audio || !state.sheet || state.busy || state.loading || state.starting) return;
    const version = ++state.playVersion;
    state.starting = true; updateReady();
    try { await context().resume(); }
    finally { if (version === state.playVersion) { state.starting = false; updateReady(); } }
    if (version !== state.playVersion || state.busy || state.loading) return;
    if (state.position >= duration() - .001) state.position = 0;
    state.startedAt = context().currentTime - state.position; state.playing = true;
    if (state.position < state.audio.duration) {
      state.source = context().createBufferSource(); state.source.buffer = state.audio; state.source.connect(context().destination); state.source.start(0, state.position);
    }
    $('play').innerHTML = '<svg><use href="#i-pause"/></svg>'; $('play').setAttribute('aria-label', '一時停止'); updateReady();
    state.raf = requestAnimationFrame(tick);
  }
  function tick() {
    if (!state.playing) return;
    state.position = Math.min(duration(), context().currentTime - state.startedAt);
    drawPreview();
    if (state.position >= duration()) { pause(); return; }
    state.raf = requestAnimationFrame(tick);
  }
  function fileDrop(element, handler) {
    element.addEventListener('dragover', event => { event.preventDefault(); if (!state.busy) element.classList.add('drag-over'); });
    element.addEventListener('dragleave', () => element.classList.remove('drag-over'));
    element.addEventListener('drop', guard(async event => { event.preventDefault(); element.classList.remove('drag-over'); if (!state.busy && event.dataTransfer.files[0]) await handler(event.dataTransfer.files[0]); }));
  }
  function folderDrop(element) {
    element.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = state.busy ? 'none' : 'copy';
      if (!state.busy) element.classList.add('drag-over');
    });
    element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over'); });
    element.addEventListener('drop', guard(event => {
      element.classList.remove('drag-over');
      if (state.busy) { event.preventDefault(); return; }
      const items = [...event.dataTransfer.items].filter(item => item.kind === 'file');
      const entry = items.length === 1 ? items[0].webkitGetAsEntry?.() : null;
      if (!entry?.isDirectory) { event.preventDefault(); throw new Error('フォルダーを1つだけドロップしてください。'); }
      state.droppedFolderName = entry.name;
      // Keep the native file-input drop action. It enumerates directories for file:// too.
      return loadFolder([], entry.name);
    }));
  }
  function setBusy(busy) {
    state.busy = busy; document.body.classList.toggle('busy', busy); $('progress-panel').hidden = !busy;
    for (const input of document.querySelectorAll('input:not(#seek), select, button:not(#cancel)')) input.disabled = busy || state.loading > 0;
    if (busy) { message(''); status('処理中', 'working'); $('cancel').disabled = false; }
    else updateReady();
  }
  function progress(value, label) {
    $('progress').value = value; $('progress-percent').textContent = `${Math.round(value * 100)}%`; $('progress-label').textContent = label;
  }
  function resultLink(id, key, blob, filename) {
    if (state.urls[key]) URL.revokeObjectURL(state.urls[key]);
    const url = URL.createObjectURL(blob); state.urls[key] = url;
    const link = $(id); link.href = url; link.download = filename; link.lastElementChild.textContent = `${filename} をダウンロード (${(blob.size / 1024 / 1024).toFixed(1)} MB)`; link.hidden = false;
    link.click();
  }
  async function exportSingle() {
    if (!singleReady() || state.loading || state.busy) return;
    pause(); invalidateOutput(); state.controller = new AbortController(); setBusy(true); progress(0, '透過MOVを準備中…');
    try {
      const movie = await M.renderMovie({images: state.images, config: settings(), sheet: state.sheet, audio: state.audio, signal: state.controller.signal, onProgress: progress});
      resultLink('movie-download', 'movie', movie, `${C.safeOutputName($('output-name').value)}.mov`);
      message('透過MOVを作成しました。下のリンクから再ダウンロードできます。', true);
    } catch (error) { if (error.name === 'AbortError') message('書き出しをキャンセルしました。', true); else throw error; }
    finally { setBusy(false); state.controller = null; }
  }
  function renderJobs() {
    const body = $('batch-body'); body.replaceChildren();
    const labels = {ready: '準備完了', skipped: 'スキップ', error: '失敗', working: '処理中', done: '完了'};
    for (const job of state.jobs) {
      const row = document.createElement('tr'), audio = document.createElement('td'), label = document.createElement('td'), result = document.createElement('td');
      audio.textContent = job.audio.name; label.textContent = job.label?.name || '同名の.labなし';
      const badge = document.createElement('span'); badge.className = `job-status ${job.status}`; badge.textContent = labels[job.status]; result.append(badge);
      if (job.error) { const error = document.createElement('span'); error.className = 'job-error'; error.textContent = job.error; result.append(error); }
      row.append(audio, label, result); body.append(row);
    }
    if (!state.jobs.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 3; cell.className = 'empty-table'; cell.textContent = 'フォルダー直下に対応する音声ファイルがありません'; }
    const available = state.jobs.filter(job => job.label && !job.error).length;
    $('batch-summary').textContent = `${state.jobs.length} 件の音声 · ${available} 件を処理可能 · ${state.jobs.length - available} 件を除外`;
  }
  async function loadFolder(files, name) {
    if (state.busy) return;
    state.jobs = C.discoverJobs(files); state.folderName = name || files[0]?.webkitRelativePath?.split('/')[0] || 'voices';
    $('folder-name').textContent = state.folderName; $('zip-download').hidden = true;
    $('folder-input').value = '';
    if (state.urls.zip) { URL.revokeObjectURL(state.urls.zip); delete state.urls.zip; }
    message(''); renderJobs(); updateReady();
  }
  async function exportBatch() {
    const invalid = assetError(); if (invalid) throw new Error(invalid);
    if (state.busy || state.loading) return;
    pause(); $('zip-download').hidden = true; setBusy(true); state.controller = new AbortController();
    const signal = state.controller.signal, entries = [], report = [];
    const jobs = state.jobs.filter(job => job.label && !job.error);
    let cancelled = false;
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (signal.aborted) { cancelled = true; break; }
        job.status = 'working'; renderJobs(); progress(i / jobs.length * .85, `${i + 1} / ${jobs.length} · ${job.audio.name}`);
        try {
          const sheet = await C.readLabels(job.label), audio = await decodeAudio(job.audio);
          M.checkCancelled(signal);
          const movie = await M.renderMovie({images: state.images, config: settings(), sheet, audio, signal, onProgress: value => progress((i + value) / jobs.length * .85, `${i + 1} / ${jobs.length} · ${job.audio.name}`)});
          entries.push({name: job.output, blob: movie}); job.status = 'done'; report.push(`${job.audio.name}\t完了\t${job.output}`);
        } catch (error) {
          if (error.name === 'AbortError') { job.status = 'ready'; cancelled = true; renderJobs(); break; }
          job.status = 'error'; job.error = error.message; report.push(`${job.audio.name}\t失敗\t${error.message}`);
        }
        renderJobs();
      }
      for (const job of state.jobs.filter(job => job.status === 'skipped' || (job.status === 'error' && !jobs.includes(job)))) report.push(`${job.audio.name}\t${job.status === 'skipped' ? 'スキップ' : '失敗'}\t${job.error}`);
      if (signal.aborted) cancelled = true;
      if (!entries.length) {
        message(cancelled ? '一括処理をキャンセルしました。' : 'MOVを作成できませんでした。一覧のエラーを確認してください。', cancelled);
        return;
      }
      if (state.jobs.some(job => job.status === 'error' || job.status === 'skipped') || cancelled) entries.push({name: '処理結果.txt', blob: new Blob(['\uFEFF音声\t状態\t詳細\n', report.join('\n'), cancelled ? '\nキャンセルされたため、完了した動画のみを収録しました。\n' : '\n'], {type: 'text/plain;charset=utf-8'})});
      // Cancellation retains finished movies. Packaging them is a separate operation.
      state.controller = new AbortController();
      $('cancel').disabled = true;
      progress(.85, '完了した動画をZIPにまとめています…');
      const zip = await M.createZip(entries, {onProgress: value => progress(.85 + value * .15, '完了した動画をZIPにまとめています…')});
      resultLink('zip-download', 'zip', zip, `${C.safeOutputName(state.folderName)}_lipsync.zip`);
      const completed = state.jobs.filter(job => job.status === 'done').length;
      message(`${cancelled ? '処理をキャンセルしました。' : ''}${completed} 件の透過MOVをZIPにまとめました。`, true);
    } finally { setBusy(false); state.controller = null; renderJobs(); }
  }
  function blobDataURL(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('プリセット画像の読み込みに失敗しました。')); reader.readAsDataURL(blob); });
  }
  async function savePreset() {
    if (state.busy || state.loading) return;
    C.validateSettings(settings());
    state.loading++; updateReady();
    try {
      const embedded = {}, images = {};
      for (const slot of C.SLOTS[state.mode]) if (state.images[slot]) { embedded[slot] = await blobDataURL(state.images[slot].blob); images[slot] = state.images[slot].name; }
      const preset = {format_version: 1, application: 'lip_sync_web', ...settings(), images, embedded_images: embedded, audio_path: state.audioFile?.name || '', label_path: state.labelFile?.name || ''};
      const url = URL.createObjectURL(new Blob([JSON.stringify(preset, null, 2) + '\n'], {type: 'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = 'lipsync-preset.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      message('画像と設定をプリセットに保存しました。音声・ラベルは保存対象に含まれません。', true);
    } finally { state.loading--; updateReady(); }
  }
  async function loadPreset(file) {
    if (state.busy || state.loading) return;
    if (file.size > 150_000_000) throw new Error('プリセットは150 MB以下にしてください。');
    const preset = C.normalizePreset(JSON.parse(await file.text()));
    const prepared = {}; state.loading++; updateReady(); pause();
    try {
      // Validate every embedded image before replacing the current project.
      for (const slot of C.SLOTS[preset.mode]) if (preset.embedded_images[slot]) {
        const data = preset.embedded_images[slot].split(',')[1], binary = atob(data), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        prepared[slot] = await bitmap(new Blob([bytes]), C.basename(preset.images[slot] || `${slot}.png`));
      }
      state.mode = preset.mode; state.mapping = preset.mapping; $('fps').value = preset.fps; state.expected = {};
      for (const slot of C.SLOTS[state.mode]) {
        const name = C.basename(preset.images[slot] || '');
        if (prepared[slot]) { disposeImage(state.images[slot]); state.images[slot] = prepared[slot]; }
        else if (!name || state.images[slot]?.name !== name) { disposeImage(state.images[slot]); delete state.images[slot]; if (name) state.expected[slot] = name; }
      }
      for (const button of document.querySelectorAll('[data-mode]')) { const selected = Number(button.dataset.mode) === state.mode; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); }
      invalidateOutput(); imageSlots(); renderMapping(); drawTimeline();
      message(Object.keys(state.expected).length ? '設定を読み込みました。プリセットで指定されている画像を選択してください。' : '画像と設定を読み込みました。', true);
    } catch (error) { for (const image of Object.values(prepared)) disposeImage(image); throw error; }
    finally { state.loading--; updateReady(); }
  }
  for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => {
    if (state.busy) return;
    for (const nav of document.querySelectorAll('[data-page]')) { const active = nav === button; nav.classList.toggle('active', active); if (active) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); }
    for (const name of ['single', 'mapping', 'batch']) $(`${name}-page`).hidden = name !== button.dataset.page;
    $('page-title').textContent = button.textContent.trim(); message('');
  });
  for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => setMode(Number(button.dataset.mode)));
  for (const button of document.querySelectorAll('[data-background]')) button.addEventListener('click', () => {
    for (const option of document.querySelectorAll('[data-background]')) { const selected = option === button; option.classList.toggle('selected', selected); option.setAttribute('aria-pressed', String(selected)); }
    $('preview-stage').className = `preview-stage ${button.dataset.background}`;
  });
  $('audio-input').addEventListener('change', guard(event => event.target.files[0] && loadAudio(event.target.files[0])));
  $('label-input').addEventListener('change', guard(event => event.target.files[0] && loadLabel(event.target.files[0])));
  $('folder-input').addEventListener('click', () => { state.droppedFolderName = ''; });
  $('folder-input').addEventListener('change', guard(event => {
    const name = state.droppedFolderName; state.droppedFolderName = '';
    return loadFolder(event.target.files, name);
  }));
  fileDrop($('audio-drop'), loadAudio); fileDrop($('label-drop'), loadLabel);
  folderDrop($('folder-drop'));
  $('fps').addEventListener('input', () => { invalidateOutput(); updateReady(); });
  $('fps').addEventListener('change', guard(() => C.validateSettings(settings())));
  $('output-name').addEventListener('change', () => { $('output-name').value = C.safeOutputName($('output-name').value); invalidateOutput(); });
  $('reset-mapping').addEventListener('click', () => { state.mapping = C.defaultMapping(state.mode); renderMapping(); drawTimeline(); invalidateOutput(); updateReady(); });
  $('play').addEventListener('click', guard(play));
  $('restart').addEventListener('click', () => { pause(); state.position = 0; drawPreview(); });
  $('seek').addEventListener('input', guard(async () => { const resume = state.playing, time = Number($('seek').value); pause(); state.position = time; drawPreview(); if (resume) await play(); }));
  $('export').addEventListener('click', guard(exportSingle)); $('batch-export').addEventListener('click', guard(exportBatch));
  $('cancel').addEventListener('click', () => { state.controller?.abort(); $('cancel').disabled = true; progress($('progress').value, 'キャンセル中…'); });
  $('save-preset').addEventListener('click', guard(savePreset)); $('load-preset').addEventListener('click', () => $('preset-input').click());
  $('preset-input').addEventListener('change', guard(async event => { if (event.target.files[0]) await loadPreset(event.target.files[0]); event.target.value = ''; }));
  window.addEventListener('beforeunload', event => { if (state.busy) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) pause(); });
  imageSlots(); renderMapping(); drawTimeline(); updateReady();
  if (!window.AudioContext || !window.createImageBitmap) message('このアプリには最新のChromeを使用してください。');
})();
