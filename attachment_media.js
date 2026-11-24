(function () {
  'use strict';

  let database;
  function openDatabase() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open('lightchat-media', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('images');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        database = null;
        throw error;
      });
    }
    return database;
  }

  async function operation(mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('images', mode);
      const request = action(transaction.objectStore('images'));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onabort = () => reject(transaction.error || new Error('浏览器图片存储失败。'));
    });
  }

  async function imageType(blob) {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const ascii = String.fromCharCode(...head);
    if (head.length >= 8 && head[0] === 137 && ascii.slice(1, 8) === 'PNG\r\n\x1a\n') return 'image/png';
    if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
    if (/^GIF8[79]a/.test(ascii)) return 'image/gif';
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
    if (ascii.startsWith('BM')) return 'image/bmp';
    return '';
  }

  async function makeThumbnail(original) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(original);
      if (Math.max(bitmap.width, bitmap.height) <= 320) return original;
      const scale = 320 / Math.max(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82)) || original;
    } catch (error) {
      return original;
    } finally {
      bitmap?.close();
    }
  }

  async function save(id, blob) {
    const type = await imageType(blob);
    if (!type) return '';
    const original = blob.slice(0, blob.size, type);
    const thumbnail = await makeThumbnail(original);
    await operation('readwrite', (store) => store.put({ original, thumbnail }, id));
    return id;
  }

  const get = (id) => operation('readonly', (store) => store.get(id));
  async function remove(ids) {
    if (!ids.length) return;
    await operation('readwrite', (store) => ids.forEach((id) => store.delete(id)));
  }

  globalThis.LightChatMedia = { imageType, save, get, remove };
})();
