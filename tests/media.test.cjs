'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const C = require('../js/core.js'), M = require('../js/media.js');
const {pixels, audio} = require('./helpers.cjs');
const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function findAtom(data, ...types) {
  const type = types.shift();
  for (let offset = 0; offset < data.length;) {
    const size = data.readUInt32BE(offset);
    assert.ok(size >= 8 && offset + size <= data.length, 'valid MOV atom');
    if (data.toString('ascii', offset + 4, offset + 8) === type) {
      const payload = data.subarray(offset + 8, offset + size);
      return types.length ? findAtom(payload, ...types) : payload;
    }
    offset += size;
  }
  assert.fail(`missing MOV atom: ${type}`);
}
async function videoPackets(movie) {
  const data = Buffer.from(await movie.arrayBuffer());
  const table = findAtom(data, 'moov', 'trak', 'mdia', 'minf', 'stbl');
  const sizes = findAtom(table, 'stsz'), offsets = findAtom(table, 'stco'), sync = findAtom(table, 'stss');
  const frames = Array.from({length: sizes.readUInt32BE(8)}, (_, i) => {
    const offset = offsets.readUInt32BE(8 + i * 4), size = sizes.readUInt32BE(12 + i * 4);
    const frame = data.subarray(offset, offset + size);
    assert.equal(frame.readUInt32BE(0), size, 'valid Animation packet size');
    return frame;
  });
  return {frames, keys: Array.from({length: sync.readUInt32BE(4)}, (_, i) => sync.readUInt32BE(8 + i * 4))};
}

test('only the first frame is a keyframe, including across two-second boundaries and identical mouth images', async () => {
  const width = 384, height = 16, image = {width, height, rgba: pixels(width, height)};
  const movie = await M.renderMovie({images: {closed: image, open: image}, config: {mode: 2, fps: 23.976, mapping: C.defaultMapping(2)}, sheet: C.parseLabels('1250000 35000000 a\n40000000 51000000 pau'), audio: audio(1, 48000, 1)});
  const {frames, keys} = await videoPackets(movie);
  assert.deepEqual(keys, [1]); assert.equal(frames.length, 123);
  assert.ok(frames[0].length > 7);
  for (const frame of frames.slice(1)) assert.deepEqual(frame, Buffer.from([0, 0, 0, 7, 0, 0, 0]));
});

test('mouth transitions omit unchanged leading, trailing and interior rows, including alpha-only differences', async () => {
  const width = 384, height = 16, closed = pixels(width, height), open = closed.slice();
  open[(2 * width + 130) * 4 + 3] = 0; // Only alpha changes on this row.
  open[(12 * width + 383) * 4] ^= 255;
  const movie = await M.renderMovie({images: {closed: {width, height, rgba: closed}, open: {width, height, rgba: open}}, config: {mode: 2, fps: 4, mapping: C.defaultMapping(2)}, sheet: C.parseLabels('2500000 5000000 a\n7500000 10000000 a'), audio: audio(1, 48000, 1)});
  const {frames, keys} = await videoPackets(movie);
  assert.deepEqual(keys, [1]); assert.equal(frames.length, 4);
  assert.deepEqual(frames[1], frames[3], 'the same directional transition is reused');
  for (const frame of frames.slice(1)) {
    assert.equal(frame.readUInt16BE(4), 8);
    assert.equal(frame.readUInt16BE(6), 2, 'unchanged leading rows are omitted');
    assert.equal(frame.readUInt16BE(10), 11, 'unchanged trailing rows are omitted');
    assert.ok(frame.length < frames[0].length / 4, 'only two rows carry pixel data');
    const skipped = Buffer.from(Array.from({length: 18}, (_, i) => i % 2 ? 255 : 1));
    assert.ok(frame.includes(skipped), 'nine unchanged interior rows carry no pixel data');
  }
});

test('MOV externally decodes exact alpha/color, repeated frames, gaps, audio and FPS', {skip: !ffmpegAvailable}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-mov-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const width = 384, height = 16, closed = pixels(width, height), open = pixels(width, height, true), sound = audio();
  const movie = await M.renderMovie({images: {closed: {width, height, rgba: closed}, open: {width, height, rgba: open}}, config: {mode: 2, fps: 12, mapping: C.defaultMapping(2)}, sheet: C.parseLabels('1250000 3750000 a\n5000000 7500000 u\n11000000 15000000 a'), audio: sound});
  const file = path.join(dir, 'alpha.mov'); fs.writeFileSync(file, Buffer.from(await movie.arrayBuffer()));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout), video = metadata.streams.find(s => s.codec_type === 'video'), pcm = metadata.streams.find(s => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'qtrle'); assert.equal(video.pix_fmt, 'argb'); assert.equal(video.nb_frames, '18'); assert.equal(video.avg_frame_rate, '12/1'); assert.equal(Number(video.duration), 1.5);
  assert.equal(pcm.codec_name, 'pcm_s16le'); assert.equal(pcm.sample_rate, '48000'); assert.equal(pcm.channels, 2); assert.equal(Number(pcm.duration), 1);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {maxBuffer: 20_000_000});
  assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.equal(decoded.stderr.length, 0);
  const expectedOpen = new Set([2, 3, 4, 6, 7, 8, 14, 15, 16, 17]), frameBytes = width * height * 4;
  assert.equal(decoded.stdout.length, frameBytes * 18);
  for (let frame = 0; frame < 18; frame++) assert.deepEqual(decoded.stdout.subarray(frame * frameBytes, (frame + 1) * frameBytes), Buffer.from(expectedOpen.has(frame) ? open : closed), `frame ${frame}`);
  const samples = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 's16le', '-']);
  assert.equal(samples.status, 0, samples.stderr.toString()); assert.equal(samples.stdout.length, sound.length * 4);
  for (let i = 0; i < sound.length; i += 97) for (let c = 0; c < 2; c++) {
    const value = sound.getChannelData(c)[i], expected = Math.round(value * (value < 0 ? 32768 : 32767));
    assert.equal(samples.stdout.readInt16LE((i * 2 + c) * 2), expected);
  }
});
test('fractional FPS and a single initial keyframe support external seeking through mouth transitions', {skip: !ffmpegAvailable}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-seek-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const width = 384, height = 16, rgba = pixels(width, height), open = rgba.slice();
  open[(8 * width + 130) * 4 + 3] = 0;
  const movie = await M.renderMovie({images: {closed: {width, height, rgba}, open: {width, height, rgba: open}}, config: {mode: 2, fps: 23.976, mapping: C.defaultMapping(2)}, sheet: C.parseLabels('0 5000000 a\n10000000 20000000 a\n24000000 31000000 a'), audio: audio(148800, 48000, 1)});
  const file = path.join(dir, 'fractional.mov'); fs.writeFileSync(file, Buffer.from(await movie.arrayBuffer()));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=avg_frame_rate,nb_frames', '-of', 'json', file], {encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr); const video = JSON.parse(probe.stdout).streams[0];
  assert.equal(video.avg_frame_rate, '2997/125'); assert.equal(video.nb_frames, '75');
  const frame = spawnSync('ffmpeg', ['-v', 'error', '-ss', '2.5', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  assert.equal(frame.status, 0, frame.stderr.toString()); assert.equal(frame.stdout.length, open.length); assert.deepEqual(frame.stdout, Buffer.from(open));
});

for (const mode of [2, 3, 9]) test(`all directed mouth pairs decode losslessly in ${mode}-image mode`, {skip: !ffmpegAvailable}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-pairs-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const width = 131, height = 17, slots = C.SLOTS[mode], mapping = C.defaultMapping(mode);
  const images = Object.fromEntries(slots.map((slot, index) => {
    const rgba = pixels(width, height), variant = mode === 9 && index === 7 ? 0 : index;
    for (const [bit, y] of [0, 3, 8, 16].entries()) if (variant & (1 << bit)) {
      for (let x = 0; x < width; x++) rgba.set([x, 255 - x, 80 + bit, x % 2 ? 0 : 128], (y * width + x) * 4);
    }
    return [slot, {width, height, rgba}];
  }));
  const sequence = slots.flatMap(from => slots.flatMap(to => [from, to]));
  const cues = sequence.map((slot, i) => ({start: i / 4, end: (i + 1) / 4, value: C.SHAPES.find(shape => mapping[shape] === slot)}));
  const movie = await M.renderMovie({images, config: {mode, fps: 4, mapping}, sheet: {cues, duration: sequence.length / 4}, audio: audio(1, 48000, 1)});
  assert.deepEqual((await videoPackets(movie)).keys, [1]);
  const file = path.join(dir, 'pairs.mov'); fs.writeFileSync(file, Buffer.from(await movie.arrayBuffer()));
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {maxBuffer: 20_000_000});
  assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.equal(decoded.stderr.length, 0);
  const frameBytes = width * height * 4;
  assert.equal(decoded.stdout.length, frameBytes * sequence.length);
  sequence.forEach((slot, i) => assert.deepEqual(decoded.stdout.subarray(i * frameBytes, (i + 1) * frameBytes), Buffer.from(images[slot].rgba), `frame ${i}: ${slot}`));
});
test('cancellation aborts video encoding', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(M.encodeAnimation(new Uint8Array(4), 1, 1, controller.signal), {name: 'AbortError'});
});

test('cancellation during mouth-pair preparation aborts movie generation', async () => {
  const controller = new AbortController(), image = {width: 8, height: 128, rgba: pixels(8, 128)};
  await assert.rejects(M.renderMovie({images: {closed: image, medium: image, wide: image}, config: {mode: 3, fps: 4, mapping: C.defaultMapping(3)}, sheet: C.parseLabels('0 10000000 pau'), audio: audio(1, 48000, 1), signal: controller.signal, onProgress: value => { if (value > .15) controller.abort(); }}), {name: 'AbortError'});
});
test('ZIP CRC agrees with standard test vector and Japanese entries extract externally', async t => {
  assert.equal(await M.crc32(new Blob(['123456789'])), 0xcbf43926);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-zip-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const zip = await M.createZip([{name: '声（テスト）.mov', blob: new Blob(['123456789'])}, {name: '処理結果.txt', blob: new Blob(['失敗なし\n'])}]);
  const file = path.join(dir, 'output.zip'); fs.writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
  const verified = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read("声（テスト）.mov") == b"123456789"; assert z.read("処理結果.txt").decode("utf8") == "失敗なし\\n"', file], {encoding: 'utf8'});
  if (verified.error?.code === 'ENOENT') t.skip('python3 is unavailable'); else assert.equal(verified.status, 0, verified.stderr);
});
