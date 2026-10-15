'use strict';
// Optional real-browser QA; does not add a runtime dependency to the app.
// npm install --prefix /tmp/lipsync-qa playwright-core
// PLAYWRIGHT_MODULE=/tmp/lipsync-qa/node_modules/playwright-core node tests/browser.cjs
// CHROMIUM_PATH may select an existing Chrome/Chromium executable.
// BROWSER_ARTIFACT_DIR optionally retains screenshots and downloaded test outputs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {spawnSync} = require('node:child_process');
const http = require('node:http');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const {pixels, audio, wav, png} = require('./helpers.cjs');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-browser-'));
const artifacts = process.env.BROWSER_ARTIFACT_DIR || temporary;
fs.mkdirSync(artifacts, {recursive: true});
const errors = [], external = [], checks = [];
let browser, server;
const fixture = (name, bytes) => { const file = path.join(temporary, name); fs.writeFileSync(file, bytes); return file; };
const ready = async page => page.waitForFunction(() => !document.getElementById('export').disabled);
const download = async (page, selector, name) => {
  const pending = page.waitForEvent('download', {timeout: 60000}); await page.locator(selector).click();
  const result = await pending; const destination = path.join(artifacts, name || result.suggestedFilename());
  await result.saveAs(destination); return destination;
};
async function dropFolder(page, paths) {
  const target = page.locator('#folder-drop'); await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox(), session = await page.context().newCDPSession(page);
  const point = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  const data = {items: [], files: paths, dragOperationsMask: 1};
  try {
    await session.send('Input.dispatchDragEvent', {type: 'dragEnter', ...point, data});
    await session.send('Input.dispatchDragEvent', {type: 'dragOver', ...point, data});
    assert.match(await target.getAttribute('class'), /drag-over/);
    await session.send('Input.dispatchDragEvent', {type: 'drop', ...point, data});
  } finally { await session.detach(); }
}
function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {encoding: 'utf8'});
  if (result.error?.code === 'ENOENT') return null;
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

(async () => {
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage({viewport: {width: 1360, height: 960}, acceptDownloads: true});
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url()); });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href); await page.waitForSelector('[data-slot="closed"]');
  if (await page.locator('#playback-notice').isVisible()) await page.getByRole('button', {name: '確認しました'}).click();
  assert.equal(await page.title(), 'LipSync Web'); assert.equal(await page.locator('#export').isDisabled(), true);
  await page.screenshot({path: path.join(artifacts, 'empty-desktop.png'), fullPage: true}); checks.push('direct file:// startup without remote requests');

  const closed = fixture('closed.png', png(384, 16, pixels())), open = fixture('open.png', png(384, 16, pixels(384, 16, true)));
  const voice = fixture('音声.wav', wav(audio(96000)));
  const label = fixture('音声.lab', '0 1000000 pau\n1000000 6000000 a\n8000000 13000000 i\n14000000 18000000 u\n18000000 20000000 pau\n');
  await page.locator('[data-slot="closed"] input').setInputFiles(closed);
  await page.waitForFunction(() => document.getElementById('image-count').textContent === '1 / 2');
  await page.locator('[data-slot="open"] input').setInputFiles(open);
  await page.locator('#audio-input').setInputFiles(voice); await page.locator('#label-input').setInputFiles(label); await ready(page);
  assert.match(await page.locator('#duration-time').textContent(), /00:02.000/);
  checks.push('audio decoding, label loading, two-image validation');

  await page.locator('#play').click(); await page.waitForFunction(() => document.getElementById('seek').value > .15);
  await page.locator('#play').click(); assert.equal(await page.locator('#play').getAttribute('aria-label'), '再生');
  await page.locator('#seek').evaluate(input => { input.value = .3; input.dispatchEvent(new Event('input')); });
  assert.equal(await page.locator('#current-shape').textContent(), 'D · 開ける');
  await page.locator('[data-background="gray"]').click(); assert.match(await page.locator('#preview-stage').getAttribute('class'), /gray/);
  await page.locator('[data-background="checker"]').click(); checks.push('sound playback, pause, seek and checker preview');

  await page.locator('[data-page="mapping"]').click(); await page.locator('select[aria-label="口形Dの画像"]').selectOption('closed');
  await page.locator('[data-page="single"]').click(); assert.equal(await page.locator('#current-shape').textContent(), 'D · 閉じる');
  await page.locator('[data-page="mapping"]').click(); await page.locator('#reset-mapping').click(); await page.locator('[data-page="single"]').click();
  await page.locator('#fps').fill('0'); assert.equal(await page.locator('#export').isDisabled(), true);
  await page.locator('#fps').fill('23.976'); await ready(page);
  const mov = await download(page, '#export', 'single.mov');
  const metadata = probe(mov);
  if (metadata) { const v = metadata.streams.find(s => s.codec_type === 'video'); assert.equal(v.codec_name, 'qtrle'); assert.equal(v.pix_fmt, 'argb'); assert.equal(v.nb_frames, '48'); assert.equal(v.avg_frame_rate, '2997/125'); assert.equal(metadata.streams.find(s => s.codec_type === 'audio').sample_rate, '48000'); }
  assert.equal(await page.locator('#movie-download').isVisible(), true); checks.push('custom mapping, FPS validation, MOV download with alpha and audio');

  await page.locator('#label-input').setInputFiles({name: 'bad.lab', mimeType: 'text/plain', buffer: Buffer.from('0 1000000 invalid')});
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('bad.lab:1'));
  assert.equal(await page.locator('#export').isDisabled(), true);
  await page.locator('#label-input').setInputFiles(label); await ready(page);
  const wrongSize = fixture('wrong.png', png(385, 16, pixels(385, 16, true)));
  await page.locator('[data-slot="open"] input').setInputFiles(wrongSize);
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('画像サイズ'));
  assert.equal(await page.locator('#export').isDisabled(), true);
  await page.locator('[data-slot="open"] input').setInputFiles(open); await ready(page);
  const opaquePixels = pixels(); for (let i = 3; i < opaquePixels.length; i += 4) opaquePixels[i] = 255;
  await page.locator('[data-slot="open"] input').setInputFiles({name: 'opaque.png', mimeType: 'image/png', buffer: png(384, 16, opaquePixels)});
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('透過部分'));
  checks.push('malformed labels, mismatched sizes and opaque images produce actionable errors');

  await page.locator('[data-mode="3"]').click();
  await page.locator('[data-slot="medium"] input').setInputFiles(open); await page.locator('[data-slot="wide"] input').setInputFiles(open); await ready(page);
  const preset = await download(page, '#save-preset', 'preset.json');
  const stored = JSON.parse(fs.readFileSync(preset, 'utf8')); assert.equal(stored.mode, 3); assert.ok(stored.embedded_images.closed.startsWith('data:image/png;base64,'));
  await page.locator('[data-mode="9"]').click(); assert.equal(await page.locator('.image-slot').count(), 9);
  for (const slot of [...'ABCDEFGHX']) { await page.locator(`[data-slot="${slot}"] input`).setInputFiles(slot === 'X' ? closed : open); await page.waitForFunction(slot => document.querySelector(`[data-slot="${slot}"]`).classList.contains('loaded'), slot); }
  await ready(page); const nine = await download(page, '#export', 'nine.mov'); if (probe(nine)) assert.equal(probe(nine).streams[0].pix_fmt, 'argb');
  await page.locator('#preset-input').setInputFiles(preset); await page.waitForFunction(() => document.getElementById('image-count').textContent === '3 / 3'); await ready(page);
  checks.push('three-image and nine-image modes, embedded preset save/restore');

  const voices = path.join(temporary, 'batch'); fs.mkdirSync(voices); fs.mkdirSync(path.join(voices, 'sub'));
  fs.copyFileSync(voice, path.join(voices, '01_成功.wav')); fs.copyFileSync(label, path.join(voices, '01_成功.lab'));
  fs.copyFileSync(voice, path.join(voices, '02_不正.wav')); fs.writeFileSync(path.join(voices, '02_不正.lab'), '0 1000000 invalid');
  fs.copyFileSync(voice, path.join(voices, '03_ラベルなし.wav'));
  for (const name of ['duplicate.wav', 'duplicate.mp3']) fs.copyFileSync(voice, path.join(voices, name));
  fs.copyFileSync(label, path.join(voices, 'duplicate.lab')); fs.copyFileSync(voice, path.join(voices, 'sub', 'nested.wav'));
  await page.locator('[data-page="batch"]').click();
  await dropFolder(page, [voices]);
  await page.waitForFunction(() => document.getElementById('folder-name').textContent === 'batch' && document.querySelectorAll('#batch-body tr').length === 5);
  assert.equal(await page.locator('#batch-body tr').count(), 5);
  const droppedRows = await page.locator('#batch-body').innerText();
  await page.locator('#folder-input').setInputFiles(voices);
  assert.equal(await page.locator('#batch-body').innerText(), droppedRows);
  const emptyFolder = path.join(temporary, 'empty-folder'); fs.mkdirSync(emptyFolder);
  await dropFolder(page, [emptyFolder]);
  await page.waitForFunction(() => document.getElementById('folder-name').textContent === 'empty-folder');
  assert.match(await page.locator('#batch-body').innerText(), /対応する音声ファイルがありません/);
  assert.equal(await page.locator('#batch-export').isDisabled(), true);
  const manyFiles = path.join(temporary, 'many-files'); fs.mkdirSync(manyFiles);
  const briefAudio = wav(audio(48, 48000, 1));
  for (let i = 0; i < 105; i++) {
    fs.writeFileSync(path.join(manyFiles, `声${i}.wav`), briefAudio);
    fs.writeFileSync(path.join(manyFiles, `声${i}.lab`), '0 10000 pau');
  }
  await dropFolder(page, [manyFiles]);
  await page.waitForFunction(() => document.getElementById('folder-name').textContent === 'many-files' && document.querySelectorAll('#batch-body tr').length === 105);
  assert.equal(await page.locator('#batch-body tr').count(), 105);
  assert.equal(await page.locator('.job-status.ready').count(), 105);
  await dropFolder(page, [voices]);
  await page.waitForFunction(() => document.getElementById('folder-name').textContent === 'batch' && document.querySelectorAll('#batch-body tr').length === 5);
  assert.equal(await page.locator('#batch-body').innerText(), droppedRows);
  checks.push('native folder drops match picker selection, read over 100 files and handle empty folders');
  assert.equal(await page.locator('#batch-body tr').count(), 5); assert.equal(await page.locator('#batch-export').isDisabled(), false);
  const zip = await download(page, '#batch-export', 'batch.zip');
  await page.waitForFunction(() => document.getElementById('progress-panel').hidden);
  assert.equal(await page.locator('.job-status.done').count(), 1); assert.equal(await page.locator('.job-status.error').count(), 3); assert.equal(await page.locator('.job-status.skipped').count(), 1);
  const extraction = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert set(z.namelist()) == {"01_成功.mov", "処理結果.txt"}; assert "不正.lab:1" in z.read("処理結果.txt").decode("utf8")', zip], {encoding: 'utf8'});
  if (!extraction.error) assert.equal(extraction.status, 0, extraction.stderr);
  checks.push('batch ZIP, Japanese names, missing labels, collisions, nested exclusion and continued processing');

  const cancelFolder = path.join(temporary, 'cancel-batch'); fs.mkdirSync(cancelFolder);
  fs.copyFileSync(voice, path.join(cancelFolder, '01_done.wav')); fs.copyFileSync(label, path.join(cancelFolder, '01_done.lab'));
  fs.copyFileSync(voice, path.join(cancelFolder, '02_long.wav')); fs.writeFileSync(path.join(cancelFolder, '02_long.lab'), '0 60000000000 pau');
  await page.locator('#folder-input').setInputFiles(cancelFolder);
  const cancelDownload = page.waitForEvent('download', {timeout: 60000}); await page.locator('#batch-export').click();
  await page.waitForFunction(() => document.querySelectorAll('.job-status.done').length === 1 && document.querySelectorAll('.job-status.working').length === 1);
  await page.locator('#cancel').click();
  const partial = await cancelDownload, partialZip = path.join(artifacts, 'cancelled.zip'); await partial.saveAs(partialZip);
  await page.waitForFunction(() => document.getElementById('progress-panel').hidden);
  const partialCheck = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert set(z.namelist()) == {"01_done.mov", "処理結果.txt"}; assert "キャンセル" in z.read("処理結果.txt").decode("utf8")', partialZip], {encoding: 'utf8'});
  if (!partialCheck.error) assert.equal(partialCheck.status, 0, partialCheck.stderr);
  checks.push('batch cancellation retains completed movies in a valid ZIP');

  const provided = path.join(root, 'tests/testdata/zundamon');
  if (fs.existsSync(provided)) {
    await page.locator('#folder-input').setInputFiles(provided); assert.equal(await page.locator('#batch-body tr').count(), 8);
    const originalZip = await download(page, '#batch-export', 'zundamon.zip');
    await page.waitForFunction(() => document.getElementById('progress-panel').hidden);
    assert.equal(await page.locator('.job-status.done').count(), 8);
    const extraction = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert len(z.namelist()) == 8; assert all(n.endswith(".mov") for n in z.namelist()); z.extractall(sys.argv[2])', originalZip, path.join(temporary, 'real-output')], {encoding: 'utf8'});
    if (!extraction.error) { assert.equal(extraction.status, 0, extraction.stderr); for (const name of fs.readdirSync(path.join(temporary, 'real-output'))) { const data = probe(path.join(temporary, 'real-output', name)); if (data) assert.equal(data.streams[0].pix_fmt, 'argb'); } }
    checks.push('all eight provided WAV/lab pairs exported as valid transparent MOVs');
  }

  await page.locator('[data-page="single"]').click();
  const longLabel = fixture('long.lab', '0 60000000000 pau');
  await page.locator('#label-input').setInputFiles(longLabel); await ready(page);
  await page.locator('#export').click(); await page.waitForFunction(() => !document.getElementById('progress-panel').hidden);
  await page.locator('#cancel').click(); await page.waitForFunction(() => document.getElementById('progress-panel').hidden);
  assert.match(await page.locator('#message').textContent(), /キャンセル/);
  await page.locator('#label-input').setInputFiles(label); await ready(page); checks.push('cancel stops encoding and restores editable controls');
  await page.screenshot({path: path.join(artifacts, 'loaded-desktop.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844}); await page.screenshot({path: path.join(artifacts, 'mobile.png'), fullPage: true});
  assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.locator('#export').isVisible(), true); checks.push('responsive mobile layout without page overflow');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/preview\/lip_sync_web\//, '');
    const file = path.resolve(root, relative || 'index.html');
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    const contentTypes = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};
    response.writeHead(200, {'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream'}); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await page.goto(`http://127.0.0.1:${server.address().port}/preview/lip_sync_web/index.html`);
  await page.waitForSelector('[data-slot="closed"]'); assert.equal(await page.locator('.image-slot').count(), 2);
  if (await page.locator('#playback-notice').isVisible()) await page.getByRole('button', {name: '確認しました'}).click();
  assert.equal(await page.locator('.sidebar').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  await page.locator('[data-page="batch"]').click(); await dropFolder(page, [voices]);
  await page.waitForFunction(() => document.getElementById('folder-name').textContent === 'batch' && document.querySelectorAll('#batch-body tr').length === 5);
  assert.equal(await page.locator('#batch-body').innerText(), droppedRows);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); checks.push('HTTP hosting beneath a GitHub Pages-style subdirectory');
  process.stdout.write(JSON.stringify({checks, browserErrors: errors, externalRequests: external, artifacts: process.env.BROWSER_ARTIFACT_DIR || 'temporary (removed)'}, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, {recursive: true, force: true}); });
