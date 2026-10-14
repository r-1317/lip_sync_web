(function (root) {
  'use strict';
  const SHAPES = [...'ABCDEFGHX'];
  const SLOTS = {2: ['closed', 'open'], 3: ['closed', 'medium', 'wide'], 9: SHAPES};
  const SLOT_LABELS = {closed: '閉じる', open: '開ける', medium: '中', wide: '大'};
  const SHAPE_HELP = {
    A: 'p / b / m · 唇を閉じる', B: 'i / 子音 · 歯を見せる', C: 'e · 口を開く',
    D: 'a · 大きく開く', E: 'o · 丸く開く', F: 'u / w · すぼめる',
    G: 'f / v · 下唇に歯を当てる', H: 'r / l · 舌を上げる', X: 'pau / sil / cl · 休止',
  };
  const PHONEMES = Object.create(null);
  const groups = {
    A: ['p', 'py', 'b', 'by', 'm', 'my'],
    B: ['i', 'I', 'k', 'ky', 'kw', 'g', 'gy', 'gw', 's', 'sh', 'z', 'j', 't', 'ty', 'ts', 'ch', 'd', 'dy', 'n', 'ny', 'N', 'ng', 'h', 'hy', 'y'],
    C: ['e', 'E'], D: ['a', 'A'], E: ['o', 'O'], F: ['u', 'U', 'w'],
    G: ['f', 'v'], H: ['r', 'ry', 'l'], X: ['pau', 'sil', 'sp', 'cl'],
  };
  for (const [shape, phonemes] of Object.entries(groups)) for (const phoneme of phonemes) PHONEMES[phoneme] = shape;
  const AUDIO_EXTENSIONS = new Set(['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wave', 'webm', 'mp4']);
  const basename = path => String(path).split(/[\\/]/).pop();
  const stem = path => basename(path).replace(/\.[^.]+$/, '');
  const slotLabel = slot => SLOT_LABELS[slot] || slot;
  function defaultMapping(mode) {
    if (mode === 9) return Object.fromEntries(SHAPES.map(s => [s, s]));
    if (mode === 2) return {A: 'closed', B: 'open', C: 'open', D: 'open', E: 'open', F: 'open', G: 'open', H: 'open', X: 'closed'};
    if (mode === 3) return {A: 'closed', B: 'medium', C: 'medium', D: 'wide', E: 'wide', F: 'wide', G: 'medium', H: 'medium', X: 'closed'};
    throw new Error('画像の枚数は2・3・9枚のいずれかを指定してください。');
  }
  function parseLabels(text, name = 'label.lab') {
    let previousEnd = 0;
    const cues = [];
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = line.split(/\s+/);
      const fail = message => { throw new Error(`${name}:${i + 1}: ${message}`); };
      if (fields.length !== 3) fail('ラベルは「開始時刻 終了時刻 音素」の3列で指定してください。');
      if (!fields.slice(0, 2).every(v => /^[+-]?\d+$/.test(v))) fail('時刻は100 ns単位の整数で指定してください。');
      const [start, end] = fields.slice(0, 2).map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) fail('時刻が大きすぎます。');
      if (start < 0 || end <= start) fail('ラベル区間の開始・終了時刻が不正です。');
      if (start < previousEnd) fail('ラベル区間が重複しているか、時刻順に並んでいません。');
      if (!Object.hasOwn(PHONEMES, fields[2])) fail(`未対応の音素です: ${fields[2]}`);
      cues.push({start: start / 1e7, end: end / 1e7, value: PHONEMES[fields[2]], phoneme: fields[2]});
      previousEnd = end;
    }
    if (!cues.length) throw new Error(`${name}: ラベルファイルに有効な区間がありません。`);
    return {duration: cues[cues.length - 1].end, cues};
  }
  async function readLabels(file) {
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer()); }
    catch { throw new Error(`${file.name}: ラベルファイルはUTF-8で保存してください。`); }
    return parseLabels(text, file.name);
  }
  function shapeAt(sheet, time) {
    if (!sheet) return 'X';
    let low = 0, high = sheet.cues.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1, cue = sheet.cues[mid];
      if (time < cue.start) high = mid - 1;
      else if (time >= cue.end) low = mid + 1;
      else return cue.value;
    }
    return 'X';
  }
  function validateSettings(config) {
    if (!Object.hasOwn(SLOTS, config.mode)) throw new Error('画像の枚数は2・3・9枚のいずれかを指定してください。');
    if (!Number.isFinite(config.fps) || config.fps < 1 || config.fps > 120) throw new Error('フレームレートは1〜120 fpsで指定してください。');
    for (const shape of SHAPES) if (!SLOTS[config.mode].includes(config.mapping[shape])) throw new Error(`口形${shape}の割り当てが不正です。`);
  }
  function discoverJobs(files) {
    // Match the original tool: only files directly in the selected directory.
    const direct = [...files].filter(file => !file.webkitRelativePath || file.webkitRelativePath.split('/').length === 2);
    const byName = new Map(direct.map(file => [file.name, file]));
    const labels = direct.filter(file => /\.lab$/i.test(file.name));
    const jobs = direct.filter(file => AUDIO_EXTENSIONS.has(file.name.split('.').pop().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, 'ja', {numeric: true})).map(audio => {
      const labelName = `${stem(audio.name)}.lab`;
      const matches = labels.filter(file => stem(file.name) === stem(audio.name));
      const label = byName.get(labelName) || (matches.length === 1 ? matches[0] : null);
      return {audio, label, output: `${stem(audio.name)}.mov`, status: label ? 'ready' : 'skipped', error: label ? '' : '同名の.labがありません。'};
    });
    const outputs = new Map();
    for (const job of jobs) {
      const key = job.output.normalize('NFC').toLowerCase();
      if (outputs.has(key)) {
        const other = outputs.get(key);
        for (const duplicate of [job, other]) { duplicate.status = 'error'; duplicate.error = '拡張子を.movに変えると出力名が重複します。音声ファイル名を変更してください。'; }
      } else outputs.set(key, job);
    }
    return jobs;
  }
  function normalizePreset(raw) {
    if (!raw || raw.format_version !== 1) throw new Error('対応していないプリセット形式です。');
    const mode = Number(raw.mode ?? 2), fps = Number(raw.fps ?? 24);
    const mapping = {...defaultMapping(mode), ...raw.mapping};
    validateSettings({mode, fps, mapping});
    const embedded = {};
    for (const slot of SLOTS[mode]) {
      const data = raw.embedded_images?.[slot];
      if (data !== undefined && (typeof data !== 'string' || !/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/.test(data))) throw new Error(`画像${slotLabel(slot)}のプリセットデータが不正です。`);
      if (data) embedded[slot] = data;
    }
    return {mode, fps, mapping, images: raw.images || {}, embedded_images: embedded};
  }
  function safeOutputName(value) {
    const name = String(value).trim().replace(/\.mov$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
    return name || 'output';
  }
  function formatTime(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }
  const api = {SHAPES, SLOTS, SLOT_LABELS, SHAPE_HELP, PHONEMES, AUDIO_EXTENSIONS, basename, stem, slotLabel, defaultMapping, parseLabels, readLabels, shapeAt, validateSettings, discoverJobs, normalizePreset, safeOutputName, formatTime};
  root.LipSyncCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
