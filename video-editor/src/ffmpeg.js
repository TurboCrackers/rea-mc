'use strict';

// Everything that knows about ffmpeg's command line and output format lives here,
// so main.js only deals with files, dialogs and processes.

const path = require('node:path');
const { spawn } = require('node:child_process');

const SAMPLE_RATE = 48000;

function ffmpegPath() {
  const bundled = require('ffmpeg-static');
  if (!bundled) throw new Error('No bundled ffmpeg for this platform.');
  // Inside a packaged app the binary is unpacked next to the asar archive.
  return bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

// Seconds with millisecond precision, the way ffmpeg options expect them.
function sec(value) {
  return Number(value).toFixed(3);
}

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

// Reads `ffmpeg -i file` output (stderr). ffmpeg exits with an error because no
// output is given, but it prints everything we need about the input first.
function parseProbe(text) {
  if (!/Input #0/.test(text)) {
    const reason = text.trim().split(/\r?\n/).pop() || 'unknown error';
    throw new Error(`Not a video ffmpeg can read (${reason}).`);
  }
  const duration = text.match(/Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!duration) throw new Error("Couldn't read the video's length.");
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  if (seconds < 0.1) throw new Error('This file has no length (is it a picture?).');

  const lines = text.split(/\r?\n/);
  const videoLine = lines.findIndex(
    (line) => /Stream #\d+:\d+.*?: Video: /.test(line) && !line.includes('(attached pic)'),
  );
  if (videoLine === -1) throw new Error('This file has no video track.');
  const stream = lines[videoLine];
  const size = stream.match(/,\s(\d{2,5})x(\d{2,5})[\s,]/);
  if (!size) throw new Error("Couldn't read the video's resolution.");
  const fps = stream.match(/(\d+(?:\.\d+)?) fps/) || stream.match(/(\d+(?:\.\d+)?) tbr/);

  // Rotation is reported in the lines that belong to this stream.
  let rotation = 0;
  for (let i = videoLine + 1; i < lines.length && !/Stream #/.test(lines[i]); i++) {
    const match = lines[i].match(/rotation of (-?\d+(?:\.\d+)?) degrees/) || lines[i].match(/rotate\s*:\s*(-?\d+)/);
    if (match) rotation = Number(match[1]);
  }
  const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const width = Number(size[1]);
  const height = Number(size[2]);

  return {
    duration: seconds,
    width: sideways ? height : width,
    height: sideways ? width : height,
    fps: fps ? Number(fps[1]) : 30,
    hasAudio: lines.some((line) => /Stream #\d+:\d+.*?: Audio: /.test(line)),
  };
}

const QUALITY = {
  high: { crf: 18, audio: '256k' },
  standard: { crf: 21, audio: '192k' },
  small: { crf: 27, audio: '128k' },
};

// Output frame size: the first clip's shape, optionally scaled so the short side
// matches the chosen preset (1080, 720, ...).
function outputFormat(firstMedia, resolution) {
  let { width, height } = firstMedia;
  if (resolution !== 'source') {
    const scale = Number(resolution) / Math.min(width, height);
    width *= scale;
    height *= scale;
  }
  const fps = Math.min(60, Math.max(1, Math.round(firstMedia.fps * 1000) / 1000));
  return { width: even(width), height: even(height), fps };
}

// segments: [{ type: 'clip', path, in, out, hasAudio } | { type: 'gap', duration }]
function buildExportArgs(segments, format, outPath) {
  const { width: w, height: h, fps } = format;
  const quality = QUALITY[format.quality] || QUALITY.standard;
  const audioFormat = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
  const silence = (d) => `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${d},${audioFormat}`;
  const args = ['-hide_banner', '-nostdin', '-y'];
  const graph = [];
  let input = 0;

  segments.forEach((segment, i) => {
    if (segment.type === 'clip') {
      const d = sec(segment.out - segment.in);
      // Seeking on the input is fast and frame accurate when re-encoding.
      args.push('-ss', sec(segment.in), '-t', d, '-i', segment.path);
      graph.push(
        `[${input}:v:0]setpts=PTS-STARTPTS,fps=${fps},` +
          `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
          `tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d}[v${i}]`,
      );
      // Pad audio to the exact clip length so later clips stay in sync.
      graph.push(
        segment.hasAudio
          ? `[${input}:a:0]asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE},${audioFormat},apad,atrim=duration=${d}[a${i}]`
          : `${silence(d)}[a${i}]`,
      );
      input++;
    } else {
      const d = sec(segment.duration);
      graph.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${d},setsar=1,format=yuv420p[v${i}]`);
      graph.push(`${silence(d)}[a${i}]`);
    }
  });

  const pads = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  graph.push(`${pads}concat=n=${segments.length}:v=1:a=1[outv][outa]`);

  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', quality.audio,
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outPath,
  );
  return args;
}

// A small H.264 copy used only for previewing formats the player can't decode
// (AVI, WMV, ...). Exports always read the original file.
function buildProxyArgs(inputPath, outPath) {
  return [
    '-hide_banner', '-nostdin', '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=-2:'min(720,ih)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats',
    outPath,
  ];
}

function buildThumbnailArgs(inputPath, atSeconds) {
  return [
    '-hide_banner', '-nostdin', '-ss', sec(atSeconds), '-i', inputPath,
    '-frames:v', '1', '-vf', 'scale=-2:90', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2', 'pipe:1',
  ];
}

// `-progress pipe:1` writes key=value lines; out_time_us is the encoded position.
function progressSeconds(text) {
  const matches = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) / 1e6 : null;
}

// Runs ffmpeg and collects its output. `onSeconds` receives encoding progress.
function run(args, { onSeconds, track } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    track?.(child);
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (onSeconds) {
        const seconds = progressSeconds(chunk.toString());
        if (seconds !== null) onSeconds(seconds);
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      // Keep only the tail; long encodes can print a lot.
      stderr = (stderr + chunk.toString()).slice(-20000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr }));
  });
}

function lastLines(text, count = 6) {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

module.exports = {
  ffmpegPath,
  parseProbe,
  outputFormat,
  buildExportArgs,
  buildProxyArgs,
  buildThumbnailArgs,
  progressSeconds,
  run,
  lastLines,
};
