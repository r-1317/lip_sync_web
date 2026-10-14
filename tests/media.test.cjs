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
test('fractional FPS and periodic keyframes support external seeking', {skip: !ffmpegAvailable}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-seek-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const width = 384, height = 16, rgba = pixels(width, height), image = {width, height, rgba};
  const movie = await M.renderMovie({images: {closed: image, open: image}, config: {mode: 2, fps: 23.976, mapping: C.defaultMapping(2)}, sheet: C.parseLabels('0 31000000 pau'), audio: audio(148800, 48000, 1)});
  const file = path.join(dir, 'fractional.mov'); fs.writeFileSync(file, Buffer.from(await movie.arrayBuffer()));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=avg_frame_rate,nb_frames', '-of', 'json', file], {encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr); const video = JSON.parse(probe.stdout).streams[0];
  assert.equal(video.avg_frame_rate, '2997/125'); assert.equal(video.nb_frames, '75');
  const frame = spawnSync('ffmpeg', ['-v', 'error', '-ss', '2.5', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  assert.equal(frame.status, 0, frame.stderr.toString()); assert.deepEqual(frame.stdout, Buffer.from(rgba));
});
test('cancellation aborts video encoding', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(M.encodeAnimation(new Uint8Array(4), 1, 1, controller.signal), {name: 'AbortError'});
});
test('ZIP CRC agrees with standard test vector and Japanese entries extract externally', async t => {
  assert.equal(await M.crc32(new Blob(['123456789'])), 0xcbf43926);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-zip-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const zip = await M.createZip([{name: '声（テスト）.mov', blob: new Blob(['123456789'])}, {name: '処理結果.txt', blob: new Blob(['失敗なし\n'])}]);
  const file = path.join(dir, 'output.zip'); fs.writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
  const verified = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read("声（テスト）.mov") == b"123456789"; assert z.read("処理結果.txt").decode("utf8") == "失敗なし\\n"', file], {encoding: 'utf8'});
  if (verified.error?.code === 'ENOENT') t.skip('python3 is unavailable'); else assert.equal(verified.status, 0, verified.stderr);
});
