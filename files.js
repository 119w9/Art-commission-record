/* =========================================================
   files.js — 稿件文件本地存储层（IndexedDB）
   说明：稿件图片/PSD 等体积大，localStorage 容量不足，
        因此文件二进制独立存放在 IndexedDB，永久留存。
        记录中的 attachments 只保存文件元数据。
   ========================================================= */
(function (global) {
  'use strict';

  var DB_NAME = 'yuegao_ledger_files';
  var DB_VERSION = 1;
  var STORE = 'files';

  var dbPromise = null;

  function supported() {
    return typeof global.indexedDB !== 'undefined' && global.indexedDB !== null;
  }

  function openDb() {
    if (!supported()) {
      return Promise.reject(new Error('当前浏览器不支持本地稿件存储'));
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('orderId', 'orderId', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打开稿件库失败')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var result;
        var req = fn(store);
        if (req) req.onsuccess = function () { result = req.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error || new Error('稿件库操作失败')); };
        t.onabort = function () { reject(t.error || new Error('稿件库操作被中止')); };
      });
    });
  }

  function uid() {
    return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function extOf(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return m ? '.' + m[1].toLowerCase() : '';
  }

  function metaOf(row) {
    return {
      id: row.id,
      name: row.name,
      size: row.size,
      type: row.type,
      addedAt: row.addedAt
    };
  }

  /* 写入一个文件，返回可直接挂到记录上的元数据 */
  function put(orderId, name, type, arrayBuffer) {
    var row = {
      id: uid(),
      orderId: String(orderId),
      name: String(name || '未命名文件'),
      size: arrayBuffer.byteLength,
      type: String(type || 'application/octet-stream'),
      addedAt: new Date().toISOString(),
      data: arrayBuffer
    };
    return tx('readwrite', function (s) { return s.put(row); }).then(function () {
      return metaOf(row);
    });
  }

  /* 写入浏览器 File / Blob 对象 */
  function putBlob(orderId, file) {
    return file.arrayBuffer().then(function (ab) {
      return put(orderId, file.name, file.type, ab);
    });
  }

  /* 备份还原：按原有 id 写回文件，保证记录与文件仍能对应 */
  function restore(orderId, meta, arrayBuffer) {
    var row = {
      id: String(meta.id),
      orderId: String(orderId),
      name: String(meta.name || '未命名文件'),
      size: arrayBuffer.byteLength,
      type: String(meta.type || 'application/octet-stream'),
      addedAt: String(meta.addedAt || new Date().toISOString()),
      data: arrayBuffer
    };
    return tx('readwrite', function (s) { return s.put(row); }).then(function () {
      return metaOf(row);
    });
  }

  function get(id) {
    return tx('readonly', function (s) { return s.get(String(id)); });
  }

  /* 仅更新某个文件行的 name（不触碰二进制） */
  function rename(id, newName) {
    var sid = String(id);
    return tx('readwrite', function (s) {
      var req = s.get(sid);
      req.onsuccess = function () {
        var row = req.result;
        if (!row) return;
        row.name = String(newName || row.name);
        s.put(row);
      };
    });
  }

  function all() {
    return tx('readonly', function (s) { return s.getAll(); }).then(function (rows) {
      return rows || [];
    });
  }

  function remove(id) {
    return tx('readwrite', function (s) { return s.delete(String(id)); });
  }

  function removeByOrder(orderId) {
    var key = String(orderId);
    return all().then(function (rows) {
      var targets = rows.filter(function (r) { return r.orderId === key; });
      return targets.reduce(function (chain, r) {
        return chain.then(function () { return remove(r.id); });
      }, Promise.resolve()).then(function () { return targets.length; });
    });
  }

  /* 数据一致性校正：
     - 记录里引用了但库里已不存在的文件 → 从元数据中剔除
     - 库里存在但归属订单已被删除的孤儿文件 → 直接清理
     返回需要回写的记录（若有变化）以及清理掉的孤儿文件数 */
  function reconcile(records) {
    return all().then(function (rows) {
      var byId = {};
      rows.forEach(function (r) { byId[r.id] = r; });

      var orderIds = {};
      records.forEach(function (rec) { orderIds[rec.id] = true; });

      var orphans = rows.filter(function (r) { return !orderIds[r.orderId]; });

      var changed = [];
      records.forEach(function (rec) {
        var kept = (rec.attachments || []).filter(function (a) { return !!byId[a.id]; });
        if (kept.length !== (rec.attachments || []).length) {
          changed.push({ id: rec.id, attachments: kept });
        }
      });

      return orphans.reduce(function (chain, o) {
        return chain.then(function () { return remove(o.id); });
      }, Promise.resolve()).then(function () {
        return { changed: changed, orphans: orphans.length };
      });
    });
  }

  function stats() {
    return all().then(function (rows) {
      var size = 0;
      rows.forEach(function (r) { size += Number(r.size) || 0; });
      return { count: rows.length, size: size };
    });
  }

  global.YuegaoFiles = {
    supported: supported,
    put: put,
    putBlob: putBlob,
    restore: restore,
    get: get,
    rename: rename,
    all: all,
    remove: remove,
    removeByOrder: removeByOrder,
    reconcile: reconcile,
    stats: stats,
    extOf: extOf
  };
})(typeof window !== 'undefined' ? window : globalThis);
