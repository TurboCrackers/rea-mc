'use strict';

// Exports a real timeline with the bundled ffmpeg: two sources (one silent),
// a gap, and clips cut from the middle of a video.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ffmpeg = require('../src/ffmpeg');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-video-editor-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function make(name, args) {
  const file = path.join(dir, name);
  const result = await ffmpeg.run(['-hide_banner', '-nostdin', '-y', ...args, file]);
  assert.equal(result.code, 0, result.stderr);
  return file;
}

async function probe(file) {
  return ffmpeg.parseProbe((await ffmpeg.run(['-hide_banner', '-nostdin', '-i', file])).stderr);
}

async function meanVolume(file, from, to) {
  const args = ['-hide_banner', '-nostdin', '-ss', String(from), '-to', String(to), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'];
  return Number((await ffmpeg.run(args)).stderr.match(/mean_volume: (-?[\d.]+) dB/)[1]);
}

test('exports clips and gaps back to back with sound in sync', async () => {
  const withSound = await make('with sound.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ]);
  const silent = await make('silent.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const [loud, quiet] = [await probe(withSound), await probe(silent)];

  const segments = [
    { type: 'clip', path: withSound, in: 1, out: 2.5, hasAudio: loud.hasAudio },
    { type: 'gap', duration: 1 },
    { type: 'clip', path: silent, in: 0.5, out: 2, hasAudio: quiet.hasAudio },
    { type: 'clip', path: withSound, in: 4, out: 6, hasAudio: loud.hasAudio },
  ];
  const output = path.join(dir, 'exported video.mp4');
  let progress = 0;
  const format = { ...ffmpeg.outputFormat(loud, '480'), quality: 'small' };
  const result = await ffmpeg.run(ffmpeg.buildExportArgs(segments, format, output), {
    onSeconds: (seconds) => (progress = seconds),
  });
  assert.equal(result.code, 0, result.stderr);

  const exported = await probe(output);
  assert.equal(exported.width, 854);
  assert.equal(exported.height, 480);
  assert.ok(Math.abs(exported.duration - 6) < 0.1, `duration ${exported.duration}`);
  assert.ok(exported.hasAudio);
  assert.ok(progress > 5, `progress reached ${progress}`);
  assert.ok((await meanVolume(output, 0.2, 1.3)) > -40, 'first clip has sound');
  assert.ok((await meanVolume(output, 1.6, 2.4)) < -80, 'gap is silent');
  assert.ok((await meanVolume(output, 2.6, 3.9)) < -80, 'silent clip stays silent');
  assert.ok((await meanVolume(output, 4.2, 5.8)) > -40, 'last clip has sound');
});
