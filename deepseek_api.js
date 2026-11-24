(function () {
  'use strict';

  const BASE = 'https://api.deepseek.com';
  const MODEL = 'deepseek-flash';
  const FLASH_MODELS = new Set([MODEL, 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
  const LAYOUT_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/bmp',
    'image/tiff',
  ]);
  const FILE_LIFETIME = 30 * 24 * 60 * 60;
  const MiB = 1024 * 1024;

  function isOfficial(base) {
    try {
      const url = new URL(base);
      return url.origin === BASE && !url.username && !url.password && !url.search && !url.hash
        && ['', '/v1'].includes(url.pathname.replace(/\/+$/, ''));
    } catch (error) {
      return false;
    }
  }

  function supports(provider) {
    return isOfficial(provider?.base) && FLASH_MODELS.has(provider.model);
  }

  function attachmentType(file) {
    const name = file.name || '';
    const type = (file.type || '').toLowerCase();
    if (/\.(jpe?g|png|gif|webp)$/i.test(name) || /^image\/(jpeg|png|gif|webp)$/i.test(type)) {
      return { kind: 'image', purpose: 'user_data', limit: 64 * MiB };
    }
    if (/\.(pdf|docx?|pptx?|bmp|tiff?)$/i.test(name) || LAYOUT_MIME_TYPES.has(type)) {
      const kind = type.startsWith('image/') || /\.(bmp|tiff?)$/i.test(name) ? 'image' : 'file';
      return { kind, purpose: 'rich_layout_recognition', limit: 100 * MiB };
    }
    return { kind: 'file', purpose: 'user_data', limit: 32 * MiB };
  }

  async function upload(file, provider, signal) {
    if (!supports(provider)) throw new Error('官方附件需要使用 deepseek-flash。');
    if (!provider.key) throw new Error('请先在提供商设置中填写 DeepSeek API Key。');
    const { purpose, limit } = attachmentType(file);
    if (!file.size) throw new Error('文件为空。');
    if (file.size > limit) throw new Error('文件超过 ' + (limit / MiB) + ' MiB。');
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('expires_after[anchor]', 'created_at');
    form.append('expires_after[seconds]', String(FILE_LIFETIME));
    form.append('file', file, file.name);

    const res = await fetch(BASE + '/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + provider.key },
      body: form,
      signal,
      redirect: 'error',
    });
    if (!res.ok) throw new Error(await responseError(res));
    const json = await res.json();
    if (!validFileId(json.id)) throw new Error('DeepSeek 未返回有效的文件 ID。');
    return { fileId: json.id, expiresAt: Number(json.expires_at) || Math.floor(Date.now() / 1000) + FILE_LIFETIME };
  }

  async function responseError(res) {
    const body = await res.text();
    let message = body;
    try {
      message = JSON.parse(body)?.error?.message || body;
    } catch (error) {
      // Some compatible gateways return plain text.
    }
    return 'HTTP ' + res.status + (message ? '：' + String(message).slice(0, 300) : '');
  }

  function validFileId(id) {
    return typeof id === 'string' && /^file-api-[\w-]+$/.test(id);
  }

  function isExpired(file) {
    return Number(file.expiresAt) > 0 && file.expiresAt <= Date.now() / 1000;
  }

  function safeWebUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function webSources(message) {
    const sources = new Map();
    function add(source, excerpt = '') {
      const url = safeWebUrl(source?.url);
      if (!url) return;
      const entry = sources.get(url) || { url, title: url, snippet: '', site: '', excerpt: '' };
      if (typeof source.title === 'string' && source.title && source.title !== source.url) entry.title = source.title;
      if (typeof source.snippet === 'string') entry.snippet = source.snippet;
      if (typeof source.site_name === 'string') entry.site = source.site_name;
      if (!entry.excerpt && excerpt) entry.excerpt = excerpt;
      sources.set(url, entry);
    }
    if (message.annotations?.length) {
      const codePoints = Array.from(message.content || '');
      for (const annotation of message.annotations) {
        if (annotation?.type !== 'url_citation' || !annotation.url_citation) continue;
        const citation = annotation.url_citation;
        const { start_index: start, end_index: end } = citation;
        const validRange = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= codePoints.length;
        const excerpt = validRange ? codePoints.slice(start, Math.min(end, start + 100)).join('').trim() : '';
        add(citation, excerpt && end - start > 100 ? excerpt + '…' : excerpt);
      }
    }
    const citedCount = sources.size;
    for (const source of message.importedSources || []) add(source);
    for (const step of message.serverToolCalls || []) {
      for (const call of (Array.isArray(step?.calls) ? step.calls : [])) {
        add(call?.page);
        if (Array.isArray(call?.sources)) call.sources.forEach(add);
      }
    }
    return { citedCount, sources: [...sources.values()] };
  }

  globalThis.LightChatDeepSeek = { BASE, MODEL, isOfficial, supports, attachmentType, upload,
    validFileId, isExpired, webSources };
})();
