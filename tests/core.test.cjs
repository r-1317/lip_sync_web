'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../js/core.js');

test('100 ns labels map all nine shapes and close gaps', () => {
  const sheet = C.parseLabels('\ufeff\n1000000 2000000 m\n2000000 3000000 i\n3000000 4000000 e\n4000000 5000000 a\n5000000 6000000 o\n6000000 7000000 u\n7000000 8000000 f\n8000000 9000000 r\n9000000 10000000 pau');
  assert.equal(sheet.duration, 1);
  assert.deepEqual(sheet.cues.map(c => c.value), [...'ABCDEFGHX']);
  assert.equal(C.shapeAt(sheet, 0), 'X');
  assert.equal(C.shapeAt(sheet, .4), 'D');
  assert.equal(C.shapeAt(sheet, 1), 'X');
  const gapped = C.parseLabels('1000000 3000000 a\n5000000 7000000 u');
  assert.equal(C.shapeAt(gapped, .3), 'X');
  assert.equal(C.shapeAt(gapped, .5), 'F');
});
test('all 45 VOICEVOX phonemes and compatibility symbols are accepted', () => {
  const phones = ['pau','A','E','I','N','O','U','a','b','by','ch','cl','d','dy','e','f','g','gw','gy','h','hy','i','j','k','kw','ky','m','my','n','ny','o','p','py','r','ry','s','sh','t','ts','ty','u','v','w','y','z','l','ng','sil','sp'];
  const expected = ['X','D','C','B','B','E','F','D','A','A','B','X','B','B','C','G','B','B','B','B','B','B','B','B','B','B','A','A','B','B','E','A','A','H','H','B','B','B','B','B','F','G','F','B','B','H','B','X','X'];
  const sheet = C.parseLabels(phones.map((p, i) => `${i * 1000000}\t${(i + 1) * 1000000}\t${p}`).join('\n'));
  assert.deepEqual(sheet.cues.map(c => c.value), expected);
});
test('invalid labels report a filename and line number', () => {
  const cases = [['0 1', /voice.lab:1:.*3列/], ['0.0 0.1 a', /整数/], ['-1 1 a', /開始・終了/], ['0 0 a', /開始・終了/], ['0 2 a\n1 3 u', /voice.lab:2:.*重複/], ['0 1 toString', /未対応/], ['0 9007199254740992 a', /大きすぎ/], ['', /有効な区間/]];
  for (const [text, pattern] of cases) assert.throws(() => C.parseLabels(text, 'voice.lab'), pattern);
});
test('strict UTF-8 validation rejects corrupted input', async () => {
  await assert.rejects(C.readLabels({name: 'bad.lab', arrayBuffer: async () => new Uint8Array([255]).buffer}), /UTF-8/);
});
test('presets restore settings and reject invalid assignments and image URLs', () => {
  const preset = C.normalizePreset({format_version: 1, mode: 3, fps: 23.976, mapping: {D: 'medium'}, images: {closed: '/tmp/閉じる.png'}});
  assert.equal(preset.mapping.D, 'medium'); assert.equal(preset.mapping.X, 'closed'); assert.equal(preset.fps, 23.976);
  assert.throws(() => C.normalizePreset({format_version: 1, mode: 2, mapping: {D: 'wide'}}), /割り当て/);
  assert.throws(() => C.normalizePreset({format_version: 1, embedded_images: {closed: 'https://example.com/image.png'}}), /データ/);
  assert.throws(() => C.validateSettings({mode: 2, fps: 0, mapping: C.defaultMapping(2)}), /フレームレート/);
});
test('batch discovery matches same-name labels, excludes nested files and flags collisions', () => {
  const files = ['声.wav', '声.lab', 'missing.mp3', 'same.wav', 'same.mp3', 'same.lab'].map(name => ({name, webkitRelativePath: `voices/${name}`}));
  files.push({name: 'nested.wav', webkitRelativePath: 'voices/sub/nested.wav'});
  const jobs = C.discoverJobs(files);
  assert.equal(jobs.length, 4);
  assert.equal(jobs.find(j => j.audio.name === '声.wav').label.name, '声.lab');
  assert.equal(jobs.find(j => j.audio.name === 'missing.mp3').status, 'skipped');
  assert.equal(jobs.filter(j => j.error.includes('重複')).length, 2);
});
test('provided Japanese labels can be read without modifying testdata', {skip: !fs.existsSync(path.join(__dirname, 'testdata/zundamon'))}, () => {
  const directory = path.join(__dirname, 'testdata/zundamon');
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.lab'))) {
    const sheet = C.parseLabels(fs.readFileSync(path.join(directory, name), 'utf8'), name);
    assert.ok(sheet.cues.length > 0); assert.ok(sheet.duration > 0);
  }
});
