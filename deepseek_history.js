(function () {
  'use strict';

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const MiB = 1024 * 1024;
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    for (let bit = 0; bit < 8; bit++) index = (index >>> 1) ^ (index & 1 ? 0xedb88320 : 0);
    return index;
  });

  const bytes = async (file, start, size) => new Uint8Array(await file.slice(start, start + size).arrayBuffer());
  const view = (data) => new DataView(data.buffer, data.byteOffset, data.byteLength);

  async function openZip(file) {
    const tailStart = Math.max(0, file.size - 65557);
    const tail = view(await bytes(file, tailStart, file.size - tailStart));
    let end = tail.byteLength - 22;
    while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50
      || end + 22 + tail.getUint16(end + 20, true) !== tail.byteLength)) end--;
    if (end < 0) throw new Error('找不到 ZIP 目录，文件可能不完整。');
    const count = tail.getUint16(end + 10, true);
    const size = tail.getUint32(end + 12, true);
    const start = tail.getUint32(end + 16, true);
    if (tail.getUint32(end + 4, true) || tail.getUint16(end + 8, true) !== count || count === 65535
      || size > 16 * MiB || start + size > tailStart + end) throw new Error('需要单卷 ZIP32 导出文件。');

    const directory = await bytes(file, start, size);
    const header = view(directory);
    const entries = new Map();
    let offset = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > size || header.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录损坏。');
      const nameSize = header.getUint16(offset + 28, true);
      const next = offset + 46 + nameSize + header.getUint16(offset + 30, true) + header.getUint16(offset + 32, true);
      if (next > size) throw new Error('ZIP 条目不完整。');
      const name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameSize)).normalize('NFC');
      const entry = {
        flags: header.getUint16(offset + 8, true),
        method: header.getUint16(offset + 10, true),
        crc: header.getUint32(offset + 16, true),
        packed: header.getUint32(offset + 20, true),
        size: header.getUint32(offset + 24, true),
        offset: header.getUint32(offset + 42, true),
      };
      if (!name || entries.has(name) || name.split('/').some((part) => ['..', '.'].includes(part))
        || name.startsWith('/') || /[\\\0]/.test(name)) throw new Error('ZIP 包含无效或重复路径。');
      entries.set(name, entry);
      offset = next;
    }

    async function read(name, limit) {
      const entry = entries.get(name);
      if (!entry) throw new Error('缺少归档文件：' + name);
      if (entry.size > limit || entry.packed > limit + MiB) throw new Error('归档条目过大：' + name);
      if (entry.flags & 1 || ![0, 8].includes(entry.method)) throw new Error('ZIP 条目加密或使用了不支持的压缩格式。');
      const local = view(await bytes(file, entry.offset, 30));
      if (local.byteLength !== 30 || local.getUint32(0, true) !== 0x04034b50
        || local.getUint16(8, true) !== entry.method) throw new Error('ZIP 条目头损坏。');
      const bodyStart = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      if (bodyStart + entry.packed > start) throw new Error('ZIP 条目超出数据范围。');
      const body = file.slice(bodyStart, bodyStart + entry.packed);
      let data;
      if (entry.method === 0) {
        if (entry.packed !== entry.size) throw new Error('ZIP 条目大小不匹配。');
        data = new Uint8Array(await body.arrayBuffer());
      } else {
        const reader = body.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        data = new Uint8Array(entry.size);
        let position = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (position + value.length > data.length) throw new Error('ZIP 解压大小超过声明值。');
            data.set(value, position);
            position += value.length;
          }
          if (position !== data.length) throw new Error('ZIP 解压大小不匹配。');
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      let crc = 0xffffffff;
      for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
      if ((~crc >>> 0) !== entry.crc) throw new Error('ZIP 条目校验失败：' + name);
      return data;
    }

    return { entries, read };
  }

  function activeBranch(session) {
    if (!Array.isArray(session.messages)) throw new Error('会话缺少消息列表。');
    const byId = new Map();
    let newest;
    for (const message of session.messages) {
      if (!Number.isSafeInteger(message?.id) || byId.has(message.id) || !['USER', 'ASSISTANT'].includes(message.role)
        || !Array.isArray(message.fragments)) throw new Error('会话含无效或重复消息。');
      byId.set(message.id, message);
      if (!newest || message.id > newest.id) newest = message;
    }
    const chain = [];
    let current = byId.get(session.current_message_id) || newest;
    while (current) {
      chain.push(current);
      if (current.parent_id === null) {
        if (current.role !== 'USER') throw new Error('会话分支缺少起始提问。');
        break;
      }
      const parent = byId.get(current.parent_id);
      if (!parent || parent.id >= current.id || parent.role === current.role) throw new Error('会话分支不完整。');
      current = parent;
    }
    return chain.reverse();
  }

  const array = (value) => Array.isArray(value) ? value : [];
  const fragmentText = (fragments, type) => fragments
    .filter((item) => item?.type === type && typeof item.content === 'string').map((item) => item.content).join('');
  const timestamp = (value) => Date.parse(value) || 0;

  async function readExport(file, existingIds, { onImage, onChat, onProgress, isDuplicate }) {
    const zip = await openZip(file);
    const json = async (path) => JSON.parse(decoder.decode(await zip.read(path, 16 * MiB)));
    const version = (await json('manifest.json')).export_format_version;
    if (version !== 3) throw new Error('请从 DeepSeek 重新导出数据。当前支持第 3 版归档。');
    const index = await json('chat_session_index.json');
    if (!Array.isArray(index)) throw new Error('会话索引格式有误。');
    let duplicates = 0;
    let missingImages = 0;
    const seen = new Set(existingIds);
    for (const [position, row] of index.entries()) {
      onProgress(position + 1, index.length);
      const id = row?.id;
      if (typeof id !== 'string' || !id || /[/\\\0]/.test(id) || ['.', '..'].includes(id)) throw new Error('会话编号格式有误。');
      if (seen.has(id)) {
        duplicates++;
        continue;
      }
      seen.add(id);
      const session = await json('chat_sessions/' + id.normalize('NFC') + '.json');
      if (session.id !== id) throw new Error('会话编号与索引不匹配。');
      const messages = [];
      const images = [];
      const branch = activeBranch(session);
      for (const message of branch) {
        const fragments = message.fragments;
        if (message.role === 'USER') {
          const attachments = [];
          for (const fragment of fragments.filter((entry) => entry?.type === 'FILE')) {
            for (const fileEntry of array(fragment.files)) {
              if (typeof fileEntry?.file_name !== 'string') continue;
              const image = fileEntry.is_image === true;
              const path = typeof fileEntry.export_path === 'string' ? fileEntry.export_path.normalize('NFC') : '';
              const attachment = { kind: image ? 'image' : 'file', name: fileEntry.file_name,
                size: Number(fileEntry.file_size) || 0, source: 'deepseek-export',
                archiveFileId: typeof fileEntry.id === 'string' ? fileEntry.id : '',
                note: '导出包中没有可用原件' };
              if (image && path.startsWith(('chat_sessions/' + id + '_files/').normalize('NFC'))
                && zip.entries.has(path) && zip.entries.get(path).size <= 64 * MiB) {
                images.push({ path, attachment });
              }
              attachments.push(attachment);
            }
          }
          messages.push({ role: 'user', content: fragmentText(fragments, 'REQUEST'), attachments });
        } else {
          const template = fragmentText(fragments, 'TEMPLATE_RESPONSE');
          const refused = message.status === 'CONTENT_FILTER';
          const importedSources = fragments.flatMap((fragment) => {
            if (fragment?.type === 'TOOL_OPEN') return [fragment];
            if (['TOOL_SEARCH', 'READ_LINK'].includes(fragment?.type)) return array(fragment.results);
            return [];
          }).filter((item) => typeof item?.url === 'string').map(({ url, title, snippet, site_name }) => ({ url, title, snippet, site_name }));
          const apiError = !!template || (message.status && message.status !== 'FINISHED');
          if (apiError && messages.at(-1)?.role === 'user') messages.at(-1).apiError = true;
          messages.push({ role: 'assistant', content: refused ? template : fragmentText(fragments, 'RESPONSE') || template,
            reasoning: refused ? '' : fragmentText(fragments, 'THINK'), importedSources, apiError: !!apiError });
        }
      }
      const latestReply = branch.findLast((message) => message.role === 'ASSISTANT');
      const title = [session.title, row.title].find((value) => typeof value === 'string' && value.trim());
      const chat = { deepseekImportId: id, title: title || 'DeepSeek 对话', messages,
        createdAt: timestamp(session.inserted_at || row.inserted_at), updatedAt: timestamp(session.updated_at || row.updated_at),
        deepThinking: latestReply?.thinking_enabled === true, webSearch: latestReply?.search_enabled === true };
      if (await isDuplicate(chat)) {
        duplicates++;
        continue;
      }
      const imageIds = new Map();
      for (const { path, attachment } of images) {
        if (!imageIds.has(path)) imageIds.set(path, await onImage(await zip.read(path, 64 * MiB)));
        attachment.previewId = imageIds.get(path);
        if (attachment.previewId) attachment.note = '';
      }
      for (const message of messages) {
        missingImages += (message.attachments || []).filter((item) => item.kind === 'image' && !item.previewId).length;
      }
      await onChat(chat);
    }
    return { duplicates, missingImages };
  }

  globalThis.LightChatHistory = { readExport };
})();
