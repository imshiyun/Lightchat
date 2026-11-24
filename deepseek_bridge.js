#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error('无法加载 Playwright。请在项目目录运行 npm ci，再通过 start_bridge.cmd 启动。');
  console.error(error.message);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOST = args.host || process.env.DEEPSEEK_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(args.port || process.env.DEEPSEEK_BRIDGE_PORT || 17888);
const CHAT_URL = args['chat-url'] || process.env.DEEPSEEK_CHAT_URL || 'https://chat.deepseek.com/';
const PROFILE_DIR = args.profile || process.env.DEEPSEEK_PROFILE_DIR || path.join(PROJECT_ROOT, '.browser-profile', 'deepseek');
const STARTUP_SYSTEM_PROMPT = args['system-prompt'] || process.env.DEEPSEEK_SYSTEM_PROMPT || '';
const BROWSER_CHANNEL = args.channel || process.env.DEEPSEEK_BROWSER_CHANNEL || '';
const RESPONSE_TIMEOUT = Number(args.timeout || process.env.DEEPSEEK_RESPONSE_TIMEOUT || 180000);
const STABLE_MS = Number(args['stable-ms'] || process.env.DEEPSEEK_STABLE_MS || 3500);

const COMPOSER_SELECTORS = [
  'textarea:not([readonly])',
  '[contenteditable="true"]',
  'div[role="textbox"]',
  '.ProseMirror',
  '[data-testid*="chat-input"]',
  '[class*="input"] textarea',
];

const SEND_SELECTORS = [
  'button[type="submit"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
  'button[data-testid*="send"]',
  '[role="button"][aria-label*="发送"]',
  '[role="button"][aria-label*="Send"]',
  'button:has-text("发送")',
  'button:has-text("Send")',
];

const ATTACH_SELECTORS = [
  'button[aria-label*="附件"]',
  'button[aria-label*="上传"]',
  'button[aria-label*="文件"]',
  'button[aria-label*="Attach"]',
  'button[aria-label*="Upload"]',
  'button:has-text("上传")',
  'button:has-text("附件")',
  'button:has-text("+")',
  '[data-testid*="attach"]',
  '[data-testid*="upload"]',
];

let context = null;
let page = null;
let appliedSystemPromptHash = '';
let taskQueue = Promise.resolve();

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function enqueue(fn) {
  const next = taskQueue.catch(() => {}).then(fn);
  taskQueue = next.catch(() => {});
  return next;
}

function corsHeaders(type = 'application/json; charset=utf-8') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': type,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, corsHeaders('text/plain; charset=utf-8'));
  res.end(text);
}

function sanitizeFileName(name) {
  const clean = String(name || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  return clean || 'attachment';
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readFormData(req) {
  const request = new Request('http://127.0.0.1' + req.url, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half',
  });
  return request.formData();
}

async function launchContext() {
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  const options = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  const channels = [];
  if (BROWSER_CHANNEL) channels.push(BROWSER_CHANNEL);
  channels.push('msedge', 'chrome', '');

  let lastError = null;
  for (const channel of channels) {
    try {
      const launchOptions = channel ? { ...options, channel } : options;
      console.log('正在启动浏览器' + (channel ? '：' + channel : '') + ' ...');
      return await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
    } catch (error) {
      lastError = error;
      console.warn('浏览器启动方式不可用' + (channel ? '：' + channel : '：Playwright 默认浏览器'));
    }
  }
  throw lastError;
}

async function ensurePage() {
  if (!context) context = await launchContext();
  if (!page || page.isClosed()) page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(12000);
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank' || !/deepseek/i.test(currentUrl)) {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((error) => {
      console.warn('DeepSeek 页面加载未完全完成：' + error.message);
    });
  }
  await page.bringToFront().catch(() => {});
  return page;
}

async function firstVisible(selectors, timeoutMs = 5000) {
  const p = await ensurePage();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = p.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i -= 1) {
        const item = locator.nth(i);
        if (await item.isVisible({ timeout: 150 }).catch(() => false)) return item;
      }
    }
    await p.waitForTimeout(250);
  }
  return null;
}

async function latestAssistantText() {
  const p = await ensurePage();
  return p.evaluate(() => {
    const selectors = [
      '.ds-markdown',
      '[class*="markdown"]',
      '[data-message-author-role="assistant"]',
      '[data-testid*="assistant"]',
      'article',
      '[class*="message"]',
    ];
    const seen = new Set();
    const items = [];
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const text = (el.innerText || el.textContent || '').trim();
        if (text.length >= 2) items.push(text);
      }
    }
    return items[items.length - 1] || '';
  }).catch(() => '');
}

async function fillComposer(text) {
  const p = await ensurePage();
  const editor = await firstVisible(COMPOSER_SELECTORS, 30000);
  if (!editor) throw new Error('找不到 DeepSeek 网页端输入框。请确认已登录并停留在聊天页面。');
  await editor.click({ timeout: 10000 });
  const tag = await editor.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  const editable = await editor.evaluate((el) => el.isContentEditable).catch(() => false);
  if (tag === 'textarea' || tag === 'input') {
    await editor.fill(text);
  } else if (editable) {
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await p.keyboard.insertText(text);
  } else {
    await p.keyboard.insertText(text);
  }
}

async function submitComposer() {
  const p = await ensurePage();
  await p.waitForTimeout(300);
  const button = await firstVisible(SEND_SELECTORS, 1500);
  if (button) {
    await button.click().catch(async () => {
      await p.keyboard.press('Enter');
    });
  } else {
    await p.keyboard.press('Enter');
  }
}

async function waitForNewAnswer(previousText, timeoutMs = RESPONSE_TIMEOUT) {
  const p = await ensurePage();
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let changedAt = Date.now();
  while (Date.now() < deadline) {
    const current = await latestAssistantText();
    if (current && current !== previousText && current !== last) {
      last = current;
      changedAt = Date.now();
    }
    if (last && Date.now() - changedAt >= STABLE_MS) return last.trim();
    await p.waitForTimeout(700);
  }
  if (last) return last.trim();
  throw new Error('等待 DeepSeek 网页端输出超时。');
}

async function sendMessageAndWait(text, timeoutMs) {
  const previous = await latestAssistantText();
  await fillComposer(text);
  await submitComposer();
  return waitForNewAnswer(previous, timeoutMs);
}

async function syncSystemPrompt(systemPrompt) {
  const prompt = String(systemPrompt || '').trim();
  if (!prompt) return { applied: false, reason: 'empty' };
  const nextHash = hashText(prompt);
  if (nextHash === appliedSystemPromptHash) return { applied: false, reason: 'unchanged' };
  await ensurePage();
  const message = [
    '[lightchat 系统提示词]',
    '请把下面内容作为后续文件转写任务的系统提示词执行。不要改写提示词，只回复“系统提示词已应用”。',
    '',
    prompt,
  ].join('\n');
  const answer = await sendMessageAndWait(message, 90000);
  appliedSystemPromptHash = nextHash;
  return { applied: true, answer };
}

async function attachFile(filePath) {
  const p = await ensurePage();
  const fileInputs = p.locator('input[type="file"]');
  const inputCount = await fileInputs.count().catch(() => 0);
  if (inputCount > 0) {
    await fileInputs.nth(inputCount - 1).setInputFiles(filePath);
    await p.waitForTimeout(1800);
    return;
  }

  const attachButton = await firstVisible(ATTACH_SELECTORS, 5000);
  if (!attachButton) throw new Error('找不到 DeepSeek 网页端附件上传入口。');
  const chooserPromise = p.waitForEvent('filechooser', { timeout: 8000 });
  await attachButton.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(filePath);
  await p.waitForTimeout(1800);
}

async function transcribeFile(filePath, filename, prompt, systemPrompt) {
  await ensurePage();
  await syncSystemPrompt(systemPrompt);
  const previous = await latestAssistantText();
  await attachFile(filePath);
  const taskPrompt = [
    String(prompt || '').trim() || '请将这个附件完整转写为 Markdown，保留标题、列表、表格、公式、代码块和图片说明。只输出 Markdown 转写内容。',
    '',
    '文件名：' + filename,
    '输出要求：只输出 Markdown 转写结果，不要解释流程。',
  ].join('\n');
  await fillComposer(taskPrompt);
  await submitComposer();
  return waitForNewAnswer(previous, RESPONSE_TIMEOUT);
}

async function handleTranscribe(req, res) {
  const form = await readFormData(req);
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    sendJson(res, 400, { error: 'missing file' });
    return;
  }

  const filename = sanitizeFileName(form.get('filename') || file.name || 'attachment');
  const prompt = String(form.get('prompt') || '');
  const systemPrompt = String(form.get('systemPrompt') || STARTUP_SYSTEM_PROMPT || '');
  const tempDir = path.join(os.tmpdir(), 'lightchat-deepseek-bridge');
  await fsp.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + filename);
  await fsp.writeFile(tempPath, Buffer.from(await file.arrayBuffer()));

  try {
    const markdown = await enqueue(() => transcribeFile(tempPath, filename, prompt, systemPrompt));
    sendJson(res, 200, { markdown, filename, source: 'deepseek-web' });
  } finally {
    fsp.unlink(tempPath).catch(() => {});
  }
}

async function handleSystemPrompt(req, res) {
  const body = await readJsonBody(req);
  const result = await enqueue(() => syncSystemPrompt(body.systemPrompt || ''));
  sendJson(res, 200, { ok: true, ...result });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, bridge: 'lightchat-deepseek-web', chatUrl: CHAT_URL, profileDir: PROFILE_DIR });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/system-prompt') {
      await handleSystemPrompt(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/transcribe') {
      await handleTranscribe(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      sendText(res, 200, 'lightchat DeepSeek bridge is running. Use /health and /transcribe.');
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, async () => {
  console.log('lightchat DeepSeek 桥接已启动：http://' + HOST + ':' + PORT);
  console.log('DeepSeek 网页端：' + CHAT_URL);
  console.log('浏览器资料目录：' + PROFILE_DIR);
  console.log('如果浏览器要求登录，请先在打开的 DeepSeek 页面完成登录，然后回到 lightchat 重试。');
  try {
    await ensurePage();
    if (STARTUP_SYSTEM_PROMPT) await enqueue(() => syncSystemPrompt(STARTUP_SYSTEM_PROMPT));
  } catch (error) {
    console.warn('DeepSeek 页面尚未准备好：' + error.message);
  }
});

process.on('SIGINT', async () => {
  console.log('\n正在关闭桥接...');
  await context?.close().catch(() => {});
  process.exit(0);
});
