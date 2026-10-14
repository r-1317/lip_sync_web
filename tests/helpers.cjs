'use strict';
const {deflateSync} = require('node:zlib');

function pixels(width = 384, height = 16, open = false) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (x < 129 || y === 0) continue;
    data[i] = open ? 50 : 170;
    data[i + 1] = x < 258 ? 120 : (x + y) % 256;
    data[i + 2] = (open ? 200 : 90) + y;
    data[i + 3] = x < 258 ? 128 : 255;
  }
  return data;
}
function audio(length = 48000, sampleRate = 48000, channels = 2) {
  const planes = Array.from({length: channels}, (_, c) => Float32Array.from({length}, (_, i) => .5 * Math.sin(i / sampleRate * 2 * Math.PI * (c ? 660 : 440))));
  return {length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: c => planes[c]};
}
function wav(sound) {
  const {length, numberOfChannels: channels, sampleRate} = sound;
  const data = Buffer.alloc(44 + length * channels * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22); data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * channels * 2, 28); data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(sound.getChannelData(c)[i] * 32767), 44 + (i * channels + c) * 2);
  return data;
}
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function png(width, height, rgba) {
  const chunk = (name, bytes) => {
    const payload = Buffer.concat([Buffer.from(name), bytes]), out = Buffer.alloc(payload.length + 8);
    out.writeUInt32BE(bytes.length); payload.copy(out, 4); out.writeUInt32BE(crc(payload), out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = {pixels, audio, wav, png};
