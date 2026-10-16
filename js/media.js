(function (root) {
  'use strict';
  // Buildless, dependency-free QuickTime Animation (32-bit ARGB) and PCM MOV writer.
  // All fields in QuickTime atoms are big endian; the 'sowt' PCM payload is little endian.
  const MAX_BYTES = 2_000_000_000;
  const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
  function checkCancelled(signal) { if (signal?.aborted) throw new DOMException('キャンセルしました。', 'AbortError'); }
  const u16 = n => { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n); return a; };
  const u32 = n => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n); return a; };
  const str = text => Uint8Array.from(text, c => c.charCodeAt(0));
  const zeros = n => new Uint8Array(n);
  function concat(...parts) {
    const result = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
  }
  const atom = (type, ...parts) => concat(u32(8 + parts.reduce((n, part) => n + part.byteLength, 0)), str(type), ...parts);
  const full = (type, flags, ...parts) => atom(type, u32(flags), ...parts);
  const matrix = concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));
  function table32(values) {
    const data = new Uint8Array(values.length * 4), view = new DataView(data.buffer);
    values.forEach((n, i) => view.setUint32(i * 4, n));
    return data;
  }
  async function encodeAnimation(rgba, width, height, signal) {
    checkCancelled(signal);
    if (rgba.length !== width * height * 4) throw new Error('画像のピクセルデータが不正です。');
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    const out = new Uint8Array(7 + height * (2 + width * 4 + Math.ceil(width / 127)));
    let cursor = 6;
    const putPixel = index => {
      const p = index * 4;
      out[cursor++] = rgba[p + 3]; out[cursor++] = rgba[p]; out[cursor++] = rgba[p + 1]; out[cursor++] = rgba[p + 2];
    };
    for (let y = 0; y < height; y++) {
      const end = (y + 1) * width;
      let i = y * width;
      out[cursor++] = 1; // Skip byte: pixel position zero.
      while (i < end) {
        let run = 1;
        while (run < 128 && i + run < end && pixels[i + run] === pixels[i]) run++;
        if (run >= 3) { out[cursor++] = 256 - run; putPixel(i); i += run; }
        else {
          const start = i;
          i += run;
          while (i < end && i - start < 127) {
            if (i + 2 < end && pixels[i] === pixels[i + 1] && pixels[i] === pixels[i + 2]) break;
            i++;
          }
          // The initial two-pixel run can never exceed the literal limit.
          out[cursor++] = i - start;
          for (let p = start; p < i; p++) putPixel(p);
        }
      }
      out[cursor++] = 255; // End of row.
      if (y % 64 === 63) { await yieldTask(); checkCancelled(signal); }
    }
    out[cursor++] = 0;
    new DataView(out.buffer).setUint32(0, cursor);
    return out.slice(0, cursor);
  }
  function videoDescription(width, height) {
    const compressor = zeros(32), label = str('QuickTime Animation');
    compressor[0] = label.length; compressor.set(label, 1);
    return full('stsd', 0, u32(1), atom('rle ', zeros(6), u16(1), u16(0), u16(0), str('appl'), u32(0), u32(0x200), u16(width), u16(height), u32(72 * 65536), u32(72 * 65536), u32(0), u16(1), compressor, u16(32), u16(0xffff)));
  }
  function audioDescription(channels, sampleRate) {
    return full('stsd', 0, u32(1), atom('sowt', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 65536)));
  }
  function track(id, timescale, duration, movieDuration, width, height, sampleTable, audio) {
    const tkhd = full('tkhd', 7, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8), u16(0), u16(audio ? 1 : 0), u16(audio ? 0x100 : 0), u16(0), matrix, u32(width * 65536), u32(height * 65536));
    const mdhd = full('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0), u16(0));
    const handler = full('hdlr', 0, str('mhlr'), str(audio ? 'soun' : 'vide'), zeros(12), str(audio ? '\x0cSoundHandler' : '\x0cVideoHandler'));
    const dataHandler = full('hdlr', 0, str('dhlr'), str('url '), zeros(12), new Uint8Array([0]));
    const dinf = atom('dinf', full('dref', 0, u32(1), full('url ', 1)));
    const mediaHeader = audio ? full('smhd', 0, u16(0), u16(0)) : full('vmhd', 1, u16(0), zeros(6));
    return atom('trak', tkhd, atom('mdia', mdhd, handler, atom('minf', mediaHeader, dataHandler, dinf, sampleTable)));
  }
  async function pcm16(audio, signal) {
    const channels = audio.numberOfChannels;
    if (channels < 1 || channels > 2) throw new Error('音声はモノラルまたはステレオを使用してください。');
    const data = new Uint8Array(audio.length * channels * 2), view = new DataView(data.buffer);
    const planes = Array.from({length: channels}, (_, c) => audio.getChannelData(c));
    for (let i = 0; i < audio.length; i++) {
      for (let c = 0; c < channels; c++) {
        const value = Math.max(-1, Math.min(1, planes[c][i]));
        view.setInt16((i * channels + c) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      if (i % 65536 === 65535) { await yieldTask(); checkCancelled(signal); }
    }
    return data;
  }
  async function renderMovie({images, config, sheet, audio, signal, onProgress = () => {}}) {
    const core = root.LipSyncCore;
    core.validateSettings(config);
    checkCancelled(signal);
    const slots = core.SLOTS[config.mode], first = images[slots[0]];
    if (!first) throw new Error('立ち絵画像を指定してください。');
    const {width, height} = first;
    if (width > 65535 || height > 65535 || width * height > 16_000_000) throw new Error('画像は1600万ピクセル以下にしてください。');
    for (const slot of slots) {
      if (!images[slot]) throw new Error(`画像が未指定です: ${core.slotLabel(slot)}`);
      if (images[slot].width !== width || images[slot].height !== height) throw new Error('立ち絵画像のサイズを揃えてください。');
    }
    const duration = Math.max(audio.duration, sheet.duration);
    const timescale = Math.round(config.fps * 1000), fps = timescale / 1000;
    const count = Math.ceil(duration * fps - 1e-9);
    if (!count || count > 2_000_000 || count * 1000 > 0xffffffff) throw new Error('音声またはラベルが長すぎます。');
    const encoded = {};
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    if (canvas) { canvas.width = width; canvas.height = height; }
    const ctx = canvas?.getContext('2d', {willReadFrequently: true});
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i], image = images[slot];
      let rgba = image.rgba;
      if (!rgba) { ctx.clearRect(0, 0, width, height); ctx.drawImage(image.bitmap, 0, 0); rgba = ctx.getImageData(0, 0, width, height).data; }
      encoded[slot] = new Blob([await encodeAnimation(rgba, width, height, signal)]);
      onProgress(.05 + .25 * (i + 1) / slots.length, '立ち絵をエンコード中…');
    }
    // A seven-byte QuickTime Animation packet repeats the previous frame.
    const repeat = new Blob([new Uint8Array([0, 0, 0, 7, 0, 0, 0])]);
    const ftyp = atom('ftyp', str('qt  '), u32(0), str('qt  '));
    const chunks = [], sizes = [], offsets = [], keys = [];
    let offset = ftyp.length + 8, lastSlot, lastKey = -Infinity, cueIndex = 0;
    for (let i = 0; i < count; i++) {
      const time = i / fps;
      while (cueIndex < sheet.cues.length && sheet.cues[cueIndex].end <= time) cueIndex++;
      const cue = sheet.cues[cueIndex];
      const shape = cue && cue.start <= time && time < cue.end ? cue.value : 'X';
      const slot = config.mapping[shape];
      const keyframe = slot !== lastSlot || i - lastKey >= Math.ceil(fps * 2);
      const frame = keyframe ? encoded[slot] : repeat;
      if (keyframe) { keys.push(i + 1); lastKey = i; }
      offsets.push(offset); sizes.push(frame.size); chunks.push(frame); offset += frame.size; lastSlot = slot;
      if (offset > MAX_BYTES) throw new Error('MOVが 2 GBを超えます。音声の長さを減らすか口だけの画像を使用してください。');
      if (i % 512 === 511) { onProgress(.3 + .35 * i / count, '動画のタイムラインを作成中…'); await yieldTask(); checkCancelled(signal); }
    }
    onProgress(.7, '音声を組み込み中…');
    const pcm = await pcm16(audio, signal), audioOffset = offset;
    chunks.push(pcm); offset += pcm.length;
    if (offset > MAX_BYTES) throw new Error('MOVが 2 GBを超えます。音声の長さを減らすか口だけの画像を使用してください。');
    const movieDuration = Math.ceil(count * 1000 / fps);
    const mvhd = full('mvhd', 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(65536), u16(256), zeros(10), matrix, zeros(24), u32(3));
    const vstbl = atom('stbl', videoDescription(width, height), full('stts', 0, u32(1), u32(count), u32(1000)), full('stss', 0, u32(keys.length), table32(keys)), full('stsc', 0, u32(1), u32(1), u32(1), u32(1)), full('stsz', 0, u32(0), u32(count), table32(sizes)), full('stco', 0, u32(offsets.length), table32(offsets)));
    const astbl = atom('stbl', audioDescription(audio.numberOfChannels, audio.sampleRate), full('stts', 0, u32(1), u32(audio.length), u32(1)), full('stsc', 0, u32(1), u32(1), u32(audio.length), u32(1)), full('stsz', 0, u32(audio.numberOfChannels * 2), u32(audio.length)), full('stco', 0, u32(1), u32(audioOffset)));
    const moov = atom('moov', mvhd, track(1, timescale, count * 1000, movieDuration, width, height, vstbl, false), track(2, audio.sampleRate, audio.length, Math.ceil(audio.duration * 1000), 0, 0, astbl, true));
    checkCancelled(signal);
    const movie = new Blob([ftyp, u32(offset - ftyp.length), str('mdat'), ...chunks, moov], {type: 'video/quicktime'});
    onProgress(1, '透過MOVを作成しました');
    return movie;
  }
  const crcTable = Uint32Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  async function crc32(blob, signal) {
    let crc = 0xffffffff;
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      checkCancelled(signal);
      const data = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
      for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      await yieldTask();
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function zipHeader(size) {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    return {bytes, u16: (offset, n) => view.setUint16(offset, n, true), u32: (offset, n) => view.setUint32(offset, n, true)};
  }
  async function createZip(entries, {signal, onProgress = () => {}} = {}) {
    if (!entries.length) throw new Error('ZIPに含めるファイルがありません。');
    if (entries.length > 65535) throw new Error('ZIPに含めるファイルが多すぎます。');
    const locals = [], central = [], encoder = new TextEncoder();
    let offset = 0, centralSize = 0;
    for (let i = 0; i < entries.length; i++) {
      checkCancelled(signal);
      const {name, blob} = entries[i], filename = encoder.encode(name);
      if (filename.length > 65535 || blob.size >= 0xffffffff) throw new Error('ZIPのファイル名またはファイルサイズが上限を超えています。');
      const crc = await crc32(blob, signal);
      const local = zipHeader(30);
      local.u32(0, 0x04034b50); local.u16(4, 20); local.u16(6, 0x800); local.u16(12, 0x21);
      local.u32(14, crc); local.u32(18, blob.size); local.u32(22, blob.size); local.u16(26, filename.length);
      locals.push(local.bytes, filename, blob);
      const directory = zipHeader(46);
      directory.u32(0, 0x02014b50); directory.u16(4, 20); directory.u16(6, 20); directory.u16(8, 0x800); directory.u16(14, 0x21);
      directory.u32(16, crc); directory.u32(20, blob.size); directory.u32(24, blob.size); directory.u16(28, filename.length); directory.u32(42, offset);
      central.push(directory.bytes, filename); centralSize += 46 + filename.length;
      offset += 30 + filename.length + blob.size;
      if (offset + centralSize + 22 > MAX_BYTES) throw new Error('ZIPが 2 GBを超えます。処理する音声を分けてください。');
      onProgress((i + 1) / entries.length);
    }
    const end = zipHeader(22);
    end.u32(0, 0x06054b50); end.u16(8, entries.length); end.u16(10, entries.length); end.u32(12, centralSize); end.u32(16, offset);
    return new Blob([...locals, ...central, end.bytes], {type: 'application/zip'});
  }
  const api = {encodeAnimation, renderMovie, createZip, crc32, checkCancelled};
  root.LipSyncMedia = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
