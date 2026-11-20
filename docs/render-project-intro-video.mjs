#!/usr/bin/env node
/**
 * 把 docs/artifacts/dda-project-intro-video.html 渲染成真实视频文件。
 *
 * 本机没有 ffmpeg，也没有下载 Playwright 自带浏览器，所以这里复用系统
 * Chrome / Edge：把 16:9 舞台逐帧截取到 canvas，再用 canvas.captureStream()
 * + MediaRecorder 直接编码成 webm / mp4。
 *
 * 用法：
 *   node docs/render-project-intro-video.mjs
 *   node docs/render-project-intro-video.mjs --chrome "C:\path\chrome.exe"
 *
 * 产物（docs/artifacts/）：
 *   dda-project-intro-video.webm
 *   dda-project-intro-video.mp4
 *   dda-project-intro-video.render.json  渲染实测事实
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DOCS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DOCS, '..');
const ARTIFACTS = path.join(DOCS, 'artifacts');
const SOURCE_HTML = path.join(ARTIFACTS, 'dda-project-intro-video.html');
const EVIDENCE = path.join(ARTIFACTS, 'dda-project-intro-video.render.json');

const WIDTH = 1280;
const HEIGHT = 720;
const BITRATE = 3_500_000;
const CAPTURE_GUARD_MS = 150_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;

// webm 优先（VP9 最稳），同时录制一个通用 mp4。
const ENCODERS = [
  { mime: 'video/webm;codecs=vp9', file: 'dda-project-intro-video.webm' },
  { mime: 'video/mp4;codecs=avc1.42E01E', file: 'dda-project-intro-video.mp4' },
];

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
  // Node 在 Windows 上对环境变量的键名大小写不敏感，但不同宿主注入的键名
  // 并不统一，所以这里同时用字面默认路径和环境变量推导值做候选。
  const envDirs = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/^programfiles(x86)?$/i.test(key)) envDirs.push(value);
  }
  const roots = [...envDirs, 'C:/Program Files', 'C:/Program Files (x86)'];
  const relatives = [
    'Google/Chrome/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe',
  ];
  const candidates = [];
  for (const root of roots) {
    for (const rel of relatives) candidates.push(path.join(root, rel));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  throw new Error('未找到 Chrome / Edge，请用 --chrome 指定可执行文件路径');
}

function loadPlaywright() {
  const requireFromDesktop = createRequire(path.join(ROOT, 'desktop', 'package.json'));
  return requireFromDesktop('playwright-core');
}

/** 在页面里装上 canvas 录制器，返回浏览器实际支持的编码列表。 */
async function installHarness(page, encoders) {
  return page.evaluate(
    ({ width, height, bitrate, list }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px`;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#070b16';
      ctx.fillRect(0, 0, width, height);

      // 低成本帧签名（64x36 缩略图散列），用来证明画面确实在推进。
      const probe = document.createElement('canvas');
      probe.width = 64;
      probe.height = 36;
      const probeCtx = probe.getContext('2d', { alpha: false });

      const stream = canvas.captureStream(30);
      const active = [];
      const skipped = [];
      for (const item of list) {
        if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(item.mime)) {
          skipped.push(item.mime);
          continue;
        }
        const rec = new MediaRecorder(stream, {
          mimeType: item.mime,
          videoBitsPerSecond: bitrate,
        });
        const chunks = [];
        rec.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        active.push({ mime: item.mime, file: item.file, rec, chunks });
      }

      let previousSignature = null;
      const signatures = [];

      window.__harness = {
        async draw(dataUrl) {
          const img = new Image();
          img.src = dataUrl;
          await img.decode();
          ctx.drawImage(img, 0, 0, width, height);

          probeCtx.drawImage(canvas, 0, 0, 64, 36);
          const data = probeCtx.getImageData(0, 0, 64, 36).data;
          let signature = 0;
          for (let i = 0; i < data.length; i += 4) {
            signature = (signature * 31 + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7) % 2147483647;
          }
          const changed = signature !== previousSignature;
          previousSignature = signature;
          signatures.push(signature);

          return {
            playing: document.getElementById('play').textContent,
            time: document.getElementById('time').textContent,
            changed,
          };
        },
        start() {
          active.forEach((enc) => enc.rec.start(1000));
          return active.map((enc) => enc.mime);
        },
        stop() {
          return Promise.all(
            active.map(
              (enc) =>
                new Promise((resolve) => {
                  if (enc.rec.state === 'inactive') {
                    resolve();
                    return;
                  }
                  enc.rec.addEventListener('stop', () => resolve(), { once: true });
                  enc.rec.stop();
                })
            )
          );
        },
        exportFiles() {
          return active.map((enc) => {
            const blob = new Blob(enc.chunks, { type: enc.mime });
            const anchor = document.createElement('a');
            anchor.href = URL.createObjectURL(blob);
            anchor.download = enc.file;
            document.body.appendChild(anchor);
            anchor.click();
            return { file: enc.file, bytes: blob.size, mime: enc.mime };
          });
        },
        stats() {
          return { frames: signatures.length, uniqueFrames: new Set(signatures).size };
        },
      };

      return { supported: active.map((enc) => enc.mime), skipped };
    },
    { width: WIDTH, height: HEIGHT, bitrate: BITRATE, list: encoders }
  );
}

/** 用独立页面打开视频文件，读取解码出来的时长与分辨率。 */
async function measureVideo(context, filePath) {
  const probe = await context.newPage();
  try {
    await probe.goto(pathToFileURL(filePath).href, { waitUntil: 'load', timeout: 30_000 });
    await probe.waitForFunction(
      () => {
        const video = document.querySelector('video');
        return Boolean(video && video.readyState >= 1);
      },
      null,
      { timeout: 25_000 }
    );
    return await probe.evaluate(async () => {
      const video = document.querySelector('video');
      let duration = video.duration;
      if (!Number.isFinite(duration)) {
        // MediaRecorder 产出的 WebM 通常缺少时长元数据，duration 会报 Infinity。
        // seek 到极大时间点后浏览器按实际可解码范围回填真实时长。
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          video.addEventListener('durationchange', () => {
            if (Number.isFinite(video.duration)) finish();
          });
          video.addEventListener('seeked', finish, { once: true });
          video.currentTime = 1e6;
          setTimeout(finish, 8000);
        });
        duration = video.duration;
      }
      return {
        duration: Number.isFinite(duration) ? Number(duration.toFixed(2)) : String(duration),
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState,
      };
    });
  } finally {
    await probe.close();
  }
}

async function main() {
  if (!exists(SOURCE_HTML)) throw new Error(`缺少分镜源文件：${SOURCE_HTML}`);

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

  const context = await browser.newContext({
    viewport: { width: 1320, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });

  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(SOURCE_HTML).href, { waitUntil: 'load' });

    const declared = await page.evaluate(() => ({
      scenes: document.getElementById('dots').children.length,
      total: document.getElementById('time').textContent,
    }));

    // 页面加载即自动播放；先暂停，等录制器就位后从 0 秒重放。
    await page.click('#play');

    const stage = await page.$('.stage-wrap');
    if (!stage) throw new Error('页面中找不到 .stage-wrap 舞台元素');
    const box = await stage.boundingBox();
    if (!box) throw new Error('无法获取舞台元素位置');
    const clip = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };

    const info = await installHarness(page, ENCODERS);
    if (!info.supported.length) {
      throw new Error(`浏览器不支持任何目标编码格式；skipped=${info.skipped.join(',')}`);
    }

    const downloads = [];
    page.on('download', (download) => downloads.push(download));

    const started = await page.evaluate(() => window.__harness.start());
    await page.click('#replay');

    const t0 = Date.now();
    let frames = 0;
    let lastChange = 0;
    let endedBy = 'playback-complete';
    for (;;) {
      const shot = await page.screenshot({ type: 'jpeg', quality: 82, clip });
      const state = await page.evaluate(
        (base64) => window.__harness.draw(`data:image/jpeg;base64,${base64}`),
        shot.toString('base64')
      );
      frames += 1;
      if (state.changed) lastChange = frames;
      if (state.playing !== '❚❚') break;
      if (Date.now() - t0 > CAPTURE_GUARD_MS) {
        endedBy = 'guard-timeout';
        break;
      }
    }
    const captureMs = Date.now() - t0;

    await page.evaluate(() => window.__harness.stop());
    const stats = await page.evaluate(() => window.__harness.stats());
    const declaredFiles = await page.evaluate(() => window.__harness.exportFiles());

    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    while (downloads.length < declaredFiles.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const saved = [];
    for (const item of declaredFiles) {
      const download = downloads.find((d) => d.suggestedFilename() === item.file);
      if (!download) {
        saved.push({ file: item.file, error: 'DOWNLOAD_MISSING' });
        continue;
      }
      const target = path.join(ARTIFACTS, item.file);
      await download.saveAs(target);
      saved.push({ file: item.file, path: target, bytes: fs.statSync(target).size, mime: item.mime });
    }

    const outputs = [];
    for (const item of saved) {
      if (item.error) {
        outputs.push({ file: item.file, error: item.error });
        continue;
      }
      let measured;
      try {
        measured = await measureVideo(context, item.path);
      } catch (error) {
        measured = { measureError: String((error && error.message) || error) };
      }
      outputs.push({
        file: path.relative(ROOT, item.path).replace(/\\/g, '/'),
        bytes: item.bytes,
        ...measured,
      });
    }

    const evidence = {
      generatedAt: new Date().toISOString(),
      source: path.relative(ROOT, SOURCE_HTML).replace(/\\/g, '/'),
      browser: browserPath,
      canvas: { width: WIDTH, height: HEIGHT, bitrate: BITRATE },
      pageDeclared: declared,
      encodedMimes: started,
      skippedMimes: info.skipped,
      frames,
      uniqueFrames: stats.uniqueFrames,
      lastChangedFrame: lastChange,
      captureMs,
      framesPerSecond: Number((frames / (captureMs / 1000)).toFixed(2)),
      endedBy,
      outputs,
    };

    if (endedBy !== 'playback-complete') {
      fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      throw new Error(`录制被看门狗中断（${endedBy}），产物不可用于交付`);
    }

    fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`渲染失败：${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
