import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  loadImageFileAttachment,
  loadImageInputsFile,
  MAX_INPUT_IMAGES,
  normalizeImageInputs
} from '../src/image-inputs.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

// 1x1 transparent PNG
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

const runCli = (args, env) => new Promise((resolve, reject) => {
  const trajectoryStore = join(tmpdir(), `hmcodex-img-test-${randomUUID()}.jsonl`);
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DDA_TRAJECTORY_STORE: trajectoryStore, DDA_JEV_ENABLED: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

test('normalizeImageInputs validates media types, count and canonical data URLs', () => {
  const normalized = normalizeImageInputs([
    { name: '../shot.png', mediaType: 'image/png', dataUrl: TINY_PNG_DATA_URL }
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].name, 'shot.png');
  assert.equal(normalized[0].mediaType, 'image/png');
  assert.ok(normalized[0].byteLength > 0);

  assert.throws(
    () => normalizeImageInputs(Array.from({ length: MAX_INPUT_IMAGES + 1 }, () => ({
      mediaType: 'image/png',
      dataUrl: TINY_PNG_DATA_URL
    }))),
    /TASK_IMAGE_COUNT_EXCEEDED/
  );
  assert.throws(
    () => normalizeImageInputs([{ mediaType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }]),
    /TASK_IMAGE_FORMAT_UNSUPPORTED/
  );
});

test('loads images from --images-file and --image and forwards vision blocks to chat-completions and responses APIs', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-image-e2e-'));
  await writeFile(join(workspace, 'README.md'), '# Image fixture\n');
  const rawPngPath = join(workspace, 'paste.png');
  await writeFile(rawPngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
  const fileLoaded = await loadImageFileAttachment(rawPngPath);
  assert.equal(fileLoaded.mediaType, 'image/png');

  const imagesJsonPath = join(workspace, 'images.json');
  await writeFile(imagesJsonPath, JSON.stringify({
    images: [{ name: 'clip.png', mediaType: 'image/png', dataUrl: TINY_PNG_DATA_URL }]
  }));
  const loadedBatch = await loadImageInputsFile(imagesJsonPath);
  assert.equal(loadedBatch.length, 1);

  let chatRequestBody;
  const chatServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    chatRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '图像只有一个像素，看不到文字。' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => chatServer.close());
  await listenOnFetchablePort(chatServer);
  const chatPort = chatServer.address().port;

  // Image-only submission (--prompt "") with --images-file uses default prompt and sends image_url array.
  const chatResult = await runCli([
    'task',
    '--provider', 'openai-chat',
    '--model', 'mimo-v2.6-pro',
    '--endpoint', `http://127.0.0.1:${chatPort}/chat/completions`,
    '--api-key-env', 'TEST_IMG_CHAT_KEY',
    '--prompt', '',
    '--images-file', imagesJsonPath,
    '--workspace', workspace
  ], { TEST_IMG_CHAT_KEY: 'img-key' });
  assert.equal(chatResult.code, 0, `${chatResult.stderr}\n${chatResult.stdout}`);
  const userWithImage = chatRequestBody.messages.find((msg) => Array.isArray(msg.content));
  assert.ok(userWithImage, 'chat-completions user message carries multimodal content array');
  assert.equal(userWithImage.content.some((part) => part.type === 'image_url' && part.image_url?.url === TINY_PNG_DATA_URL), true);

  let responsesRequestBody;
  const responsesServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    responsesRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"This is a single-pixel image with no visible text."}\r\n\r\n');
    response.write('event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n');
    response.end();
  });
  t.after(() => responsesServer.close());
  await listenOnFetchablePort(responsesServer);
  const responsesPort = responsesServer.address().port;

  const responsesResult = await runCli([
    'task',
    '--provider', 'openai',
    '--model', 'gpt-4.1-mini',
    '--endpoint', `http://127.0.0.1:${responsesPort}/responses`,
    '--api-key-env', 'TEST_IMG_RESP_KEY',
    '--prompt', '分析这张截图',
    '--image', rawPngPath,
    '--workspace', workspace
  ], { TEST_IMG_RESP_KEY: 'resp-key' });
  assert.equal(responsesResult.code, 0, `${responsesResult.stderr}\n${responsesResult.stdout}`);
  const inputWithImage = responsesRequestBody.input.find((item) =>
    Array.isArray(item.content) && item.content.some((part) => part.type === 'input_image'));
  assert.ok(inputWithImage, 'responses API user input carries input_image content part');
});
