(function () {
  'use strict';

  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open('lightchat-history', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('settings');
          db.createObjectStore('sessions', { keyPath: 'id' });
          db.createObjectStore('messages');
          db.createObjectStore('pending');
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => {
            request.result.close();
            opening = null;
          };
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        opening = null;
        throw error;
      });
    }
    return opening;
  }

  async function transact(names, mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
      let reason;
      const abort = (message) => {
        reason = new Error(message);
        tx.abort();
      };
      tx.onabort = () => reject(reason || tx.error || new Error('会话数据库操作中断。'));
      try {
        const result = operation(stores, abort);
        tx.oncomplete = () => resolve(typeof result === 'function' ? result() : undefined);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  const read = () => transact(['settings', 'sessions'], 'readonly', (stores) => {
    const settings = stores.settings.get('app');
    const sessions = stores.sessions.getAll();
    return () => settings.result ? { ...settings.result, chats: sessions.result } : null;
  });

  const readMessages = (id) => transact(['messages'], 'readonly', ({ messages }) => {
    const request = messages.get(id);
    return () => request.result || [];
  });

  function write(settings, entries = [], options = {}) {
    return transact(['settings', 'sessions', 'messages', 'pending'], 'readwrite', (stores, abort) => {
      const commit = () => {
        for (const { chat, messages, staged } of entries) {
          stores.sessions.put(chat);
          if (messages !== undefined) stores.messages.put(messages, chat.id);
          if (staged) {
            const request = stores.pending.get(chat.id);
            request.onsuccess = () => {
              if (request.result === undefined) stores.sessions.transaction.abort();
              else stores.pending.delete(chat.id);
            };
          }
        }
        stores.settings.put(settings, 'app');
      };
      if (options.initialize) {
        const request = stores.settings.get('app');
        request.onsuccess = () => { if (request.result === undefined) commit(); };
      } else if (options.importBaseline) {
        const { chats, providers } = options.importBaseline;
        const baseline = new Map(chats.map((chat) => [chat.id, chat]));
        const settingsRequest = stores.settings.get('app');
        const sessionsRequest = stores.sessions.getAll();
        sessionsRequest.onsuccess = () => {
          // A second tab may have published its import while this tab was staging messages.
          const unchanged = sessionsRequest.result.length === baseline.size && sessionsRequest.result.every((chat) => {
            const previous = baseline.get(chat.id);
            return previous && previous.updatedAt === chat.updatedAt && previous.messageCount === chat.messageCount
              && previous.historyFingerprint === chat.historyFingerprint;
          });
          if (unchanged && JSON.stringify(settingsRequest.result?.providers) === JSON.stringify(providers)) commit();
          else abort('导入期间另一标签页修改了本地记录，请重新导入。');
        };
      } else {
        commit();
      }
    });
  }

  function stage(id, messages) {
    return transact(['messages', 'pending'], 'readwrite', (stores) => {
      stores.messages.add(messages, id);
      stores.pending.add(Date.now(), id);
    });
  }

  function remove(id, settings, replacement) {
    return transact(['settings', 'sessions', 'messages'], 'readwrite', ({ settings: config, sessions, messages }) => {
      sessions.delete(id);
      messages.delete(id);
      if (replacement) sessions.add(replacement);
      config.put(settings, 'app');
    });
  }

  function discard(ids) {
    if (!ids.length) return Promise.resolve();
    return transact(['messages', 'pending'], 'readwrite', (stores) => {
      for (const id of ids) {
        const request = stores.pending.get(id);
        request.onsuccess = () => {
          if (request.result === undefined) return;
          stores.messages.delete(id);
          stores.pending.delete(id);
        };
      }
    });
  }

  function discardStale() {
    const deadline = Date.now() - 24 * 60 * 60 * 1000;
    return transact(['messages', 'pending'], 'readwrite', (stores) => {
      const request = stores.pending.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.value < deadline) {
          stores.messages.delete(cursor.key);
          cursor.delete();
        }
        cursor.continue();
      };
    });
  }

  globalThis.LightChatStorage = { read, readMessages, write, remove, stage, discard, discardStale };
})();
