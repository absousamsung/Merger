// merge.js — the quality-first merge engine: probe -> normalize+concat in ONE
// filter_complex pass (CRF 18 / 30 fps / largest resolution capped 1080p).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { probeFile, ffmpegPath } = require('./probe');
const { LIMITS } = require('./util');

function evenUp(n) {
  const v = Math.ceil(Number(n) || 0);
  return v % 2 === 0 ? v : v + 1;
}

async function probeAll(files) {
  const probes = [];
  for (const f of files) probes.push(await probeFile(f));
  return probes;
}

function computeTarget(probes) {
  // Largest input resolution, capped at 1920x1080, even dimensions.
  const w = Math.min(1920, evenUp(Math.max(...probes.map((p) => p.width || 0))));
  const h = Math.min(1080, evenUp(Math.max(...probes.map((p) => p.height || 0))));
  return { width: Math.max(2, w), height: Math.max(2, h) };
}

// Builds the ffmpeg argv for the single-pass normalize+concat encode.
function buildEncodeArgs({ files, probes, target, preset, outFile }) {
  const args = ['-hide_banner', '-y'];
  const silentInputIdx = [];
  const n = files.length;
  // Primary inputs (one per source)
  for (const f of files) args.push('-i', f);
  // Silent audio generator inputs, in source order
  for (let i = 0; i < n; i++) {
    if (!probes[i].hasAudio) {
      args.push('-f', 'lavfi', '-t', String(Math.max(0.1, probes[i].duration)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      silentInputIdx.push(i);
    }
  }
  const parts = [];
  let silentCursor = 0;
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]fps=30,scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`
    );
    if (probes[i].hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      const idx = n + silentCursor++;
      parts.push(`[${idx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  }
  const pairs = [];
  for (let i = 0; i < n; i++) pairs.push(`[v${i}][a${i}]`);
  parts.push(`${pairs.join('')}concat=n=${n}:v=1:a=1[vout][aout]`);
  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', preset, '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outFile
  );
  return args;
}

// Runs ffmpeg, parses `out_time_us` progress lines, resolves on success.
function runEncode(args, totalDurationSec, onEncodingProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let lastReported = 0;
    const totalUs = Math.max(1, totalDurationSec) * 1e6;
    proc.stdout.on('data', (d) => {
      const text = d.toString();
      const m = /out_time_us=(\d+)/g;
      let match;
      while ((match = m.exec(text)) !== null) {
        const us = Number(match[1]);
        const pct = Math.min(90, Math.floor(40 + 50 * Math.min(1, us / totalUs)));
        if (pct > lastReported) {
          lastReported = pct;
          try { onEncodingProgress && onEncodingProgress(pct); } catch (_) { /* progress write must never kill the encode */ }
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`فشل ترميز الفيديو (${code}): ${stderrTail.slice(-300)}`));
    });
  });
}

// Full engine: probe -> validate -> encode -> verify. Files must exist locally.
// onProgress(0..90) is called during fetching mapping and encoding.
async function runMergeEngine({ files, probesHint, onProgress }) {
  const probes = probesHint || (await probeAll(files));
  const totalDuration = probes.reduce((s, p) => s + (p.duration || 0), 0);
  for (const p of probes) {
    if (!p.hasVideo) throw new Error('ملف المصدر ليس فيديو صالحًا');
  }
  if (totalDuration > LIMITS.maxTotalDurationSec) {
    throw new Error(`المدة الإجمالية للمصادر تتجاوز الحد المسموح (${LIMITS.maxTotalDurationSec} ثانية)`);
  }
  const target = computeTarget(probes);
  // Adaptive preset keeps long merges inside the serverless time ceiling.
  const preset = LIMITS.ffmpegPreset || (totalDuration > 240 ? 'faster' : 'medium');
  const outFile = path.join(os.tmpdir(), `merge-out-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
  const args = buildEncodeArgs({ files, probes, target, preset, outFile });
  await runEncode(args, totalDuration, (p) => onProgress && onProgress(p));
  const st = fs.statSync(outFile);
  if (st.size > LIMITS.outputMaxBytes) {
    fs.unlink(outFile, () => {});
    throw new Error(`حجم المخرجات يتجاوز الحد المسموح (${Math.floor(LIMITS.outputMaxBytes / (1024 * 1024))} MB)`);
  }
  const verify = await probeFile(outFile);
  if (!verify.hasVideo || verify.width !== target.width || verify.height !== target.height) {
    fs.unlink(outFile, () => {});
    throw new Error('تعذر التحقق من صحة الملف الناتج');
  }
  return {
    outPath: outFile,
    size: st.size,
    duration: verify.duration,
    resolution: `${verify.width}x${verify.height}`,
    totalDuration,
  };
}

module.exports = { probeAll, computeTarget, runMergeEngine, evenUp };
