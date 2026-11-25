#!/usr/bin/env node
/**
 * 只读校验 docs/artifacts/dda-project-intro-video.* 成片。
 *
 * 不重新渲染、不修改成片：只读文件摘要、解析容器结构，再用系统 Chrome/Edge
 * 解码播放、seek 与像素取样，最后把量化阈值判定写入
 * docs/artifacts/dda-project-intro-video.verify.json。
 *
 * 阈值取自 docs/dda-project-intro-video-script.md 第 3 节。
 *
 * 用法：
 *   node docs/verify-project-intro-video.mjs
 *   node docs/verify-project-intro-video.mjs --chrome "C:\path\chrome.exe"
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DOCS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DOCS, '..');
const ARTIFACTS = path.join(DOCS, 'artifacts');
const EVIDENCE = path.join(ARTIFACTS, 'dda-project-intro-video.verify.json');

const FILES = {
  mp4: path.join(ARTIFACTS, 'dda-project-intro-video.mp4'),
  webm: path.join(ARTIFACTS, 'dda-project-intro-video.webm'),
  html: path.join(ARTIFACTS, 'dda-project-intro-video.html'),
  render: path.join(ARTIFACTS, 'dda-project-intro-video.render.json'),
};

const THRESHOLDS = {
  durationSecRange: [85, 90],
  width: 1280,
  height: 720,
  readyState: 4,
  seekPointsSec: [5, 30, 60, 84],
  seekToleranceSec: 0.5,
  sceneBoundariesSec: [9, 20, 33, 49, 65, 77],
  sceneCutToleranceSec: 1.5,
  minLumaMean: 10,
  darkFramesAllowed: 1,
  captionWindowSec: [10, 19.5],
  captionSampleFps: 4,
  captionMinGrowth: 2,
  captionMonotonicShare: 0.6,
  lumaSampleFps: 1,
  // 取样分辨率：80x45 这类缩略图会把字幕笔画和卡片边界平均掉，
  // 实测字幕带亮像素占比会恒为 0，必须用 320x180 才能分辨。
  sampleWidth: 320,
  sampleHeight: 180,
  expectedScenes: 7,
  // 幕转换用逐帧像素平均绝对差（mad）：本片为深色背景，亮度直方图对卡片
  // 重排几乎不敏感（实测只找到 1 个切点），像素差才分得出整幕重排。
  // 峰判定：局部极大值，且不低于中位数的 2 倍与绝对值下限 0.5。
  sceneCutMadPeakRatio: 2,
  sceneCutMadMin: 0.5,
  sceneCutPeakWindow: 1,
};

const KEYWORDS = ['dda', '可审计', '本地优先', 'READ_ONLY', 'ActionIntent', 'PolicyLease', 'Verifier', 'Tauri', 'Cordis', 'JSON Schema'];

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveBrowser() {
  const explicit = argValue('--chrome') || process.env.DDA_CHROME_PATH;
  if (explicit) {
    if (!exists(explicit)) throw new Error(`找不到指定的浏览器：${explicit}`);
    return explicit;
  }
  const envDirs = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/^programfiles(x86)?$/i.test(key)) envDirs.push(value);
  }
  const roots = [...envDirs, 'C:/Program Files', 'C:/Program Files (x86)'];
  const relatives = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'];
  for (const root of roots) {
    for (const rel of relatives) {
      const candidate = path.join(root, rel);
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error('未找到 Chrome / Edge，请用 --chrome 指定可执行文件路径');
}

function loadPlaywright() {
  const requireFromDesktop = createRequire(path.join(ROOT, 'desktop', 'package.json'));
  return requireFromDesktop('playwright-core');
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function describeFile(p) {
  const buf = fs.readFileSync(p);
  return { file: rel(p), bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** 拉丁字符串在 buffer 指定区间内的首次出现位置。 */
function indexIn(buf, token, from = 0, to = buf.length) {
  return buf.indexOf(Buffer.from(token, 'latin1'), from) >= 0 &&
    buf.indexOf(Buffer.from(token, 'latin1'), from) < to
    ? buf.indexOf(Buffer.from(token, 'latin1'), from)
    : -1;
}

/** 解析 mp4 顶层 box 与 moov 内的关键结构。 */
function parseMp4(filePath) {
  const buf = fs.readFileSync(filePath);
  const topLevel = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = buf.length - offset;
    }
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < headerSize) break;
    topLevel.push({ type, size, offset });
    offset += size;
  }

  const moov = topLevel.find((b) => b.type === 'moov');
  const moovEnd = moov ? moov.offset + moov.size : 0;
  let mvhd = null;
  if (moov) {
    const at = indexIn(buf, 'mvhd', moov.offset + 8, moovEnd);
    if (at >= 0) {
      const payload = at + 4;
      const version = buf[payload];
      if (version === 1) {
        mvhd = {
          version,
          timescale: buf.readUInt32BE(payload + 24),
          duration: Number(buf.readBigUInt64BE(payload + 28)),
        };
      } else {
        mvhd = {
          version,
          timescale: buf.readUInt32BE(payload + 16),
          duration: buf.readUInt32BE(payload + 20),
        };
      }
    }
  }

  const fragments = topLevel.filter((b) => b.type === 'moof' || b.type === 'mdat').length;
  return {
    topLevel: topLevel.map((b) => b.type),
    fragmented: topLevel.some((b) => b.type === 'moof'),
    fragmentBoxes: fragments,
    mvhd,
    mvhdDurationSec:
      mvhd && mvhd.timescale > 0 && mvhd.duration > 0
        ? Number((mvhd.duration / mvhd.timescale).toFixed(3))
        : null,
    videoSampleEntry: {
      avc1: indexIn(buf, 'avc1', moov ? moov.offset : 0, moovEnd || buf.length) >= 0,
      avcC: indexIn(buf, 'avcC', moov ? moov.offset : 0, moovEnd || buf.length) >= 0,
    },
    audio: {
      mp4a: indexIn(buf, 'mp4a') >= 0,
      sounHandler: indexIn(buf, 'soun') >= 0,
    },
  };
}

/** 解析 webm 的 EBML 头部与关键元素。 */
function parseWebm(filePath) {
  const buf = fs.readFileSync(filePath);
  const magic = buf.subarray(0, 4).toString('hex');
  const has = (hexId) => buf.indexOf(Buffer.from(hexId, 'hex')) >= 0;
  return {
    ebmlMagic: magic,
    ebmlValid: magic === '1a45dfa3',
    videoCodec: {
      vp9: indexIn(buf, 'V_VP9') >= 0,
      vp8: indexIn(buf, 'V_VP8') >= 0,
    },
    audio: {
      aOpus: indexIn(buf, 'A_OPUS') >= 0,
      opusHead: indexIn(buf, 'OpusHead') >= 0,
      aVorbis: indexIn(buf, 'A_VORBIS') >= 0,
    },
    index: { cues: has('1c53bb6b'), seekHead: has('114d9b74') },
    durationElement: has('4489'),
  };
}

const MIME_BY_EXT = { '.mp4': 'video/mp4', '.webm': 'video/webm' };

/**
 * 在浏览器里解码、seek 并逐秒取样。
 *
 * 视频以 blob: URL 载入而不是直接打开 file://：file:// 页面里的 <video> 会污染
 * canvas，导致 getImageData 抛 SecurityError，无法做像素统计。
 */
async function analyzePlayback(context, filePath, fallbackDurationSec) {
  const page = await context.newPage();
  try {
    const base64 = fs.readFileSync(filePath).toString('base64');
    const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'video/mp4';
    await page.goto('about:blank', { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(
      async ({ base64Data, mimeType }) => {
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType });
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.src = URL.createObjectURL(blob);
        video.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px';
        document.body.appendChild(video);
        await new Promise((resolve, reject) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true });
          video.addEventListener(
            'error',
            () => reject(new Error(`VIDEO_ERROR_${video.error ? video.error.code : 'unknown'}`)),
            { once: true }
          );
          setTimeout(() => reject(new Error('VIDEO_LOAD_TIMEOUT')), 20_000);
        });
      },
      { base64Data: base64, mimeType: mime }
    );
    // 等缓冲填满到 HAVE_ENOUGH_DATA(4) 再取样：blob 载入的 mp4 在 readyState=3 时
    // 就能 seek，但阈值以 4 为准，不等会拿到抖动值。超时则继续，记录实际值。
    await page
      .waitForFunction(
        () => {
          const v = document.querySelector('video');
          return Boolean(v && v.readyState >= 4);
        },
        null,
        { timeout: 30_000 }
      )
      .catch(() => {});
    return await page.evaluate(
      async ({ seekPoints, fallback, captionWindow, captionFps, lumaFps, sampleWidth, sampleHeight }) => {
        const video = document.querySelector('video');
        const seekTo = (t) =>
          new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              video.removeEventListener('seeked', finish);
              resolve();
            };
            video.addEventListener('seeked', finish);
            video.currentTime = t;
            setTimeout(finish, 5000);
          });

        const info = {
          duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : String(video.duration),
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
          error: video.error ? String(video.error.code) : null,
        };

        if (!Number.isFinite(info.duration)) {
          await seekTo(1e6);
          if (Number.isFinite(video.duration)) info.durationAfterSeek = Number(video.duration.toFixed(3));
        }
        const duration = Number.isFinite(video.duration) ? video.duration : fallback;

        const seekChecks = [];
        for (const target of seekPoints) {
          await seekTo(target);
          seekChecks.push({ target, currentTime: Number(video.currentTime.toFixed(3)) });
        }

        const W = sampleWidth;
        const H = sampleHeight;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { alpha: false });

        const grab = () => {
          ctx.drawImage(video, 0, 0, W, H);
          return ctx.getImageData(0, 0, W, H).data;
        };
        const lumaMean = (data) => {
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          }
          return Number((sum / (W * H)).toFixed(2));
        };
        const lumaSeries = [];
        const step = 1 / lumaFps;
        let previousData = null;
        for (let t = 0; t <= Math.max(0, duration - 0.2) + 1e-6; t += step) {
          await seekTo(Math.min(t, Math.max(0, duration - 0.2)));
          const data = grab();
          let mad = null;
          if (previousData) {
            let sum = 0;
            let count = 0;
            for (let i = 0; i < data.length; i += 4) {
              sum += Math.abs(data[i] - previousData[i]);
              sum += Math.abs(data[i + 1] - previousData[i + 1]);
              sum += Math.abs(data[i + 2] - previousData[i + 2]);
              count += 3;
            }
            mad = Number((sum / count).toFixed(3));
          }
          previousData = Uint8ClampedArray.from(data);
          lumaSeries.push({ t: Number(t.toFixed(2)), luma: lumaMean(data), mad });
        }

        // 字幕带：画面下方 30% 区域内的亮像素占比。
        const series = [];
        for (let t = captionWindow[0]; t <= captionWindow[1] - 1e-6; t += 1 / captionFps) {
          await seekTo(t);
          const data = grab();
          const yStart = Math.floor(H * 0.7);
          let bright = 0;
          let total = 0;
          for (let y = yStart; y < H; y += 1) {
            for (let x = 0; x < W; x += 1) {
              const i = (y * W + x) * 4;
              const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
              total += 1;
              if (luma > 140) bright += 1;
            }
          }
          series.push({ t: Number(t.toFixed(2)), ratio: Number((bright / total).toFixed(5)) });
        }

        return { info, seekChecks, lumaSeries, captionSeries: series };
      },
      {
        seekPoints: THRESHOLDS.seekPointsSec,
        fallback: fallbackDurationSec,
        captionWindow: THRESHOLDS.captionWindowSec,
        captionFps: THRESHOLDS.captionSampleFps,
        lumaFps: THRESHOLDS.lumaSampleFps,
        sampleWidth: THRESHOLDS.sampleWidth,
        sampleHeight: THRESHOLDS.sampleHeight,
      }
    );
  } finally {
    await page.close();
  }
}

function detectSceneCuts(lumaSeries) {
  // 逐帧像素平均绝对差（mad）的局部极大值即幕转换候选：
  // 渐变转场会在多帧持续小幅变化，只有整幕重排才出现孤立的大峰。
  const points = lumaSeries.filter((s) => typeof s.mad === 'number');
  if (!points.length) return [];
  const sorted = points.map((s) => s.mad).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const floor = Math.max(median * THRESHOLDS.sceneCutMadPeakRatio, THRESHOLDS.sceneCutMadMin);
  const peaks = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point.mad < floor) continue;
    const before = points[i - 1] ? points[i - 1].mad : -1;
    const after = points[i + 1] ? points[i + 1].mad : -1;
    if (point.mad >= before && point.mad >= after) {
      peaks.push({ t: point.t, delta: point.mad });
    }
  }
  const merged = [];
  for (const peak of peaks) {
    const last = merged[merged.length - 1];
    if (last && peak.t - last.t <= THRESHOLDS.sceneCutPeakWindow) {
      if (peak.delta > last.delta) {
        last.t = peak.t;
        last.delta = peak.delta;
      }
      continue;
    }
    merged.push({ ...peak });
  }
  return merged;
}

function checkSubtitle(captionSeries) {
  if (!captionSeries.length) return { ok: false, reason: 'EMPTY_SERIES' };
  const values = captionSeries.map((s) => s.ratio);
  const first = values[0];
  const last = values[values.length - 1];
  let nonDecreasing = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] >= values[i - 1] - 0.0005) nonDecreasing += 1;
  }
  const share = Number((nonDecreasing / (values.length - 1)).toFixed(3));
  const growthOk = first === 0 ? last > 0.01 : last >= first * THRESHOLDS.captionMinGrowth;
  return {
    ok: growthOk && share >= THRESHOLDS.captionMonotonicShare,
    firstRatio: first,
    lastRatio: last,
    nonDecreasingShare: share,
    growthOk,
    samples: values.length,
  };
}

/** 母版页面：外部请求、页面错误、分镜数与关键字。 */
async function inspectSourcePage(context) {
  const page = await context.newPage();
  const externalRequests = [];
  const pageErrors = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/i.test(url)) externalRequests.push(url);
  });
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  try {
    await page.goto(pathToFileURL(FILES.html).href, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(500);
    const facts = await page.evaluate((keywords) => {
      const stage = document.querySelector('.stage-wrap');
      const text = document.body ? document.body.innerText : '';
      const presence = {};
      for (const keyword of keywords) presence[keyword] = text.includes(keyword);
      return {
        title: document.title,
        sceneDots: document.getElementById('dots') ? document.getElementById('dots').children.length : 0,
        declaredTotal: document.getElementById('time') ? document.getElementById('time').textContent : null,
        stageBox: stage
          ? { width: Math.round(stage.getBoundingClientRect().width), height: Math.round(stage.getBoundingClientRect().height) }
          : null,
        embeddedMedia: {
          img: document.querySelectorAll('img').length,
          video: document.querySelectorAll('video').length,
          audio: document.querySelectorAll('audio').length,
          scriptSrc: document.querySelectorAll('script[src]').length,
          linkHref: document.querySelectorAll('link[href]').length,
        },
        keywordPresence: presence,
      };
    }, KEYWORDS);
    return { ...facts, externalRequests: externalRequests.length, externalRequestUrls: externalRequests.slice(0, 5), pageErrors: pageErrors.length };
  } finally {
    await page.close();
  }
}

function evaluate(mp4, webm, mp4Playback, webmPlayback, mp4Cuts, subtitle, sourcePage, renderEvidence) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  const mp4Duration = mp4Playback.info.durationAfterSeek || mp4Playback.info.duration;
  add(
    'duration',
    typeof mp4Duration === 'number' &&
      mp4Duration >= THRESHOLDS.durationSecRange[0] &&
      mp4Duration <= THRESHOLDS.durationSecRange[1],
    { value: mp4Duration, range: THRESHOLDS.durationSecRange }
  );
  add(
    'resolution',
    mp4Playback.info.width === THRESHOLDS.width && mp4Playback.info.height === THRESHOLDS.height,
    { width: mp4Playback.info.width, height: mp4Playback.info.height }
  );
  add('decodable', mp4Playback.info.readyState === THRESHOLDS.readyState && mp4Playback.info.error === null, {
    readyState: mp4Playback.info.readyState,
    error: mp4Playback.info.error,
  });
  const seekMax = Math.max(
    ...mp4Playback.seekChecks.map((c) => Math.abs(c.currentTime - c.target)),
    0
  );
  add('seek', seekMax <= THRESHOLDS.seekToleranceSec, {
    points: mp4Playback.seekChecks,
    maxDeviation: Number(seekMax.toFixed(3)),
    tolerance: THRESHOLDS.seekToleranceSec,
  });
  add('container-mp4', mp4.videoSampleEntry.avc1 && mp4.videoSampleEntry.avcC, mp4.videoSampleEntry);
  add('container-webm', webm.ebmlValid && webm.videoCodec.vp9, {
    magic: webm.ebmlMagic,
    vp9: webm.videoCodec.vp9,
  });
  add('no-audio-track', !mp4.audio.mp4a && !mp4.audio.sounHandler && !webm.audio.aOpus && !webm.audio.opusHead, {
    mp4: mp4.audio,
    webm: webm.audio,
  });

  const boundaryMatches = THRESHOLDS.sceneBoundariesSec.map((boundary) => {
    const nearest = mp4Cuts.reduce(
      (best, cut) => {
        const diff = Math.abs(cut.t - boundary);
        return !best || diff < best.diff ? { t: cut.t, delta: cut.delta, diff: Number(diff.toFixed(2)) } : best;
      },
      null
    );
    return {
      boundary,
      nearest: nearest ? nearest.t : null,
      delta: nearest ? nearest.delta : null,
      diff: nearest ? nearest.diff : null,
      matched: Boolean(nearest) && nearest.diff <= THRESHOLDS.sceneCutToleranceSec,
    };
  });
  add('scene-cuts', boundaryMatches.every((b) => b.matched), {
    detected: mp4Cuts,
    boundaries: boundaryMatches,
    tolerance: THRESHOLDS.sceneCutToleranceSec,
  });

  const darkFrames = mp4Playback.lumaSeries.filter((s) => s.luma < THRESHOLDS.minLumaMean);
  const lumaValues = mp4Playback.lumaSeries.map((s) => s.luma);
  add(
    'no-black-screen',
    darkFrames.length <= THRESHOLDS.darkFramesAllowed && (!darkFrames.length || darkFrames[0].t === 0),
    { darkFrames, minLuma: Math.min(...lumaValues), maxLuma: Math.max(...lumaValues), samples: lumaValues.length }
  );
  add('subtitle-typing', subtitle.ok, subtitle);

  add('source-self-contained', sourcePage.externalRequests === 0 && sourcePage.pageErrors === 0, {
    externalRequests: sourcePage.externalRequests,
    pageErrors: sourcePage.pageErrors,
  });
  add('source-scenes', sourcePage.sceneDots === THRESHOLDS.expectedScenes, {
    sceneDots: sourcePage.sceneDots,
    expected: THRESHOLDS.expectedScenes,
  });
  add('render-completed', renderEvidence && renderEvidence.endedBy === 'playback-complete', {
    endedBy: renderEvidence ? renderEvidence.endedBy : null,
    captureMs: renderEvidence ? renderEvidence.captureMs : null,
    frames: renderEvidence ? renderEvidence.frames : null,
  });

  return checks;
}

async function main() {
  for (const key of ['mp4', 'webm', 'html']) {
    if (!exists(FILES[key])) throw new Error(`缺少成片或母版：${rel(FILES[key])}`);
  }

  const artifacts = {
    mp4: describeFile(FILES.mp4),
    webm: describeFile(FILES.webm),
    html: describeFile(FILES.html),
  };
  if (exists(FILES.render)) artifacts.render = describeFile(FILES.render);

  const renderEvidence = exists(FILES.render) ? JSON.parse(fs.readFileSync(FILES.render, 'utf8')) : null;
  const mp4 = parseMp4(FILES.mp4);
  const webm = parseWebm(FILES.webm);

  const browserPath = resolveBrowser();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--mute-audio',
    ],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1320, height: 1000 }, deviceScaleFactor: 1 });
    const mp4Playback = await analyzePlayback(context, FILES.mp4, 87);
    const webmPlayback = await analyzePlayback(context, FILES.webm, 87);
    const sourcePage = await inspectSourcePage(context);
    const mp4Cuts = detectSceneCuts(mp4Playback.lumaSeries);
    const subtitle = checkSubtitle(mp4Playback.captionSeries);
    const checks = evaluate(mp4, webm, mp4Playback, webmPlayback, mp4Cuts, subtitle, sourcePage, renderEvidence);
    const failed = checks.filter((c) => !c.ok);

    const evidence = {
      verifiedAt: new Date().toISOString(),
      method: 'read-only: 文件摘要 + 容器结构解析 + Chrome(headless) 解码播放/seek + 1fps 与 4fps 取样像素统计',
      browser: browserPath,
      thresholds: THRESHOLDS,
      artifacts: Object.values(artifacts),
      container: { mp4, webm },
      playback: {
        mp4: { info: mp4Playback.info, seekChecks: mp4Playback.seekChecks },
        webm: { info: webmPlayback.info, seekChecks: webmPlayback.seekChecks },
      },
      content: {
        sampling: `${THRESHOLDS.lumaSampleFps} fps 80x45 灰度均值`,
        lumaSeries: mp4Playback.lumaSeries,
        detectedSceneCuts: mp4Cuts,
        subtitle,
      },
      sourcePage,
      checks,
      verdict: { ok: failed.length === 0, failed: failed.map((c) => c.name), total: checks.length },
    };

    fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `${JSON.stringify(
        {
          verdict: evidence.verdict,
          artifacts: evidence.artifacts,
          mp4Duration: mp4Playback.info.durationAfterSeek || mp4Playback.info.duration,
          detectedSceneCuts: mp4Cuts,
          madSeries: mp4Playback.lumaSeries,
          subtitle,
          checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
        },
        null,
        2
      )}\n`
    );
    return evidence;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`校验失败：${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
