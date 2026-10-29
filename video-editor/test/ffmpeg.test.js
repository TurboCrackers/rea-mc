'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const ffmpeg = require('../src/ffmpeg');

const phoneVideo = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:\\Users\\me\\Videos\\IMG_0001.MOV':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 7900 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 96 kb/s (default)
  Stream #0:2[0x3](und): Data: none (mebx / 0x7862656D), 0 kb/s (default)
At least one output file must be specified`;

test('reads length, size, frame rate and audio from ffmpeg output', () => {
  assert.deepEqual(ffmpeg.parseProbe(phoneVideo), { duration: 62.5, width: 1080, height: 1920, fps: 29.97, hasAudio: true });
});

test('ignores cover art and notices missing audio', () => {
  const text = `Input #0, mov,mp4, from 'clip.mp4':
  Duration: 00:00:04.00, start: 0.000000, bitrate: 60 kb/s
  Stream #0:0[0x1](und): Video: mjpeg (Baseline), yuvj420p(pc), 600x600, 90k tbr, 90k tbn (attached pic)
  Stream #0:1[0x2](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x480 [SAR 1:1 DAR 4:3], 52 kb/s, 25 fps, 25 tbr, 12800 tbn (default)
At least one output file must be specified`;
  assert.deepEqual(ffmpeg.parseProbe(text), { duration: 4, width: 640, height: 480, fps: 25, hasAudio: false });
});

test('explains files that are not videos', () => {
  assert.throws(() => ffmpeg.parseProbe('notes.txt: Invalid data found when processing input'), /Not a video.*Invalid data/);
  const audioOnly = `Input #0, mp3, from 'song.mp3':
  Duration: 00:03:00.00, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 128 kb/s`;
  assert.throws(() => ffmpeg.parseProbe(audioOnly), /no video track/);
});

test('output keeps the first clip shape and even dimensions', () => {
  const phone = { width: 1080, height: 1920, fps: 29.97 };
  assert.deepEqual(ffmpeg.outputFormat(phone, 'source'), { width: 1080, height: 1920, fps: 29.97 });
  assert.deepEqual(ffmpeg.outputFormat(phone, '720'), { width: 720, height: 1280, fps: 29.97 });
  assert.deepEqual(ffmpeg.outputFormat({ width: 853, height: 480, fps: 120 }, '480'), { width: 854, height: 480, fps: 60 });
});

test('reads encoding progress', () => {
  assert.equal(ffmpeg.progressSeconds('frame=10\nout_time_us=1500000\nprogress=continue\n'), 1.5);
  assert.equal(ffmpeg.progressSeconds('frame=10\n'), null);
});

test('turns away pictures and other files without length', () => {
  const picture = `Input #0, image2, from 'photo.jpg':
  Duration: 00:00:00.04, start: 0.000000, bitrate: 52000 kb/s
  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 4032x3024, 25 fps, 25 tbr, 25 tbn`;
  assert.throws(() => ffmpeg.parseProbe(picture), /no length/);
});
