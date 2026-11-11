// probe.js — real file-type verification via ffprobe (never trust extension/MIME).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FFPROBE_STATIC_PATH = require('ffprobe-static').path;
const FFMPEG_PATH = require('ffmpeg-static');

// Vercel/serverless read-only FS: if the bundled binary lost its exec bit, copy to /tmp.
function ensureExecutable(bin) {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch (_) {
    const tmp = path.join(os.tmpdir(), `bin-${path.basename(bin)}-${process.pid}`);
    fs.copyFileSync(bin, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function ffmpegPath() { return ensureExecutable(FFMPEG_PATH); }
function ffprobePath() { return ensureExecutable(FFPROBE_STATIC_PATH); }

function runFfprobe(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath(), [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe فشل (${code}): ${stderr.slice(-200)}`));
      try { resolve(JSON.parse(stdout)); } catch (_) { reject(new Error('تعذر تحليل نتيجة ffprobe')); }
    });
  });
}

// Returns { hasVideo, hasAudio, width, height, duration, fps }
async function probeFile(file) {
  const info = await runFfprobe(file);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition || s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const out = {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video ? video.width || 0 : 0,
    height: video ? video.height || 0 : 0,
    duration: Number((info.format && info.format.duration) || (video && video.duration) || 0),
    fps: 0,
  };
  if (video) {
    const rate = String(video.avg_frame_rate || video.r_frame_rate || '0/1');
    const [n, d] = rate.split('/').map(Number);
    if (n > 0 && d > 0) out.fps = n / d;
  }
  if (!Number.isFinite(out.duration) || out.duration <= 0) {
    // Some containers miss format.duration; fall back to stream duration.
    for (const s of streams) {
      const d = Number(s.duration);
      if (Number.isFinite(d) && d > out.duration) out.duration = d;
    }
  }
  return out;
}

module.exports = { probeFile, ffmpegPath, ffprobePath, ensureExecutable, runFfprobe };
