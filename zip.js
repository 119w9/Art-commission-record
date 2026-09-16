/* =========================================================
   zip.js — 零依赖极简 ZIP 打包 / 解包
   打包：store 方式（不压缩），兼容所有解压工具
   解包：支持 store(0) 与 deflate(8) 两种方式
   ========================================================= */
(function (global) {
  'use strict';

  var SIG_LOCAL = 0x04034b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_EOCD = 0x06054b50;
  var FLAG_UTF8 = 0x0800;

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    var year = d.getFullYear();
    if (year < 1980) year = 1980;
    return {
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
    };
  }

  var OBJ_TO_STRING = Object.prototype.toString;

  /* 跨 realm 安全：某些环境下 ArrayBuffer 来自别的 realm（如 IndexedDB 实现），
     此时 instanceof 判定会失败，必须改用内部槽 / 标签判定。 */
  function isArrayBufferLike(data) {
    if (!data || typeof data !== 'object') return false;
    var tag = OBJ_TO_STRING.call(data);
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return true;
    // 鸭子类型兜底：非视图、非 Blob，但具备 ArrayBuffer 的形态
    return typeof data.byteLength === 'number' &&
      typeof data.slice === 'function' &&
      data.buffer === undefined;
  }

  function isBlobLike(data) {
    if (!data || typeof data !== 'object') return false;
    var tag = OBJ_TO_STRING.call(data);
    if (tag === '[object Blob]' || tag === '[object File]') return true;
    // 跨 realm / 自定义包装对象的兜底：按 Blob 形态判定
    return typeof data.arrayBuffer === 'function' &&
      typeof data.size === 'number' &&
      typeof data.type === 'string';
  }

  function toBytes(data) {
    if (data === null || data === undefined) return new Uint8Array(0);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (isArrayBufferLike(data)) return new Uint8Array(data.slice(0));
    return new TextEncoder().encode(String(data));
  }

  function toBytesAsync(data) {
    if (isBlobLike(data)) {
      return data.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    }
    return Promise.resolve(toBytes(data));
  }

  /* 打包：entries = [{ name, data }]，data 支持 string / ArrayBuffer / Uint8Array / Blob */
  function create(entries) {
    return Promise.all(entries.map(function (e) {
      return toBytesAsync(e.data).then(function (bytes) {
        return { name: String(e.name), data: bytes };
      });
    })).then(function (files) {
      var enc = new TextEncoder();
      var now = dosDateTime(new Date());
      var parts = [];
      var central = [];
      var offset = 0;

      files.forEach(function (f) {
        var nameBytes = enc.encode(f.name);
        var data = f.data;
        var crc = crc32(data);

        var local = new Uint8Array(30 + nameBytes.length);
        var lv = new DataView(local.buffer);
        lv.setUint32(0, SIG_LOCAL, true);
        lv.setUint16(4, 20, true);           // version needed
        lv.setUint16(6, FLAG_UTF8, true);    // flags: UTF-8 文件名
        lv.setUint16(8, 0, true);            // method: store
        lv.setUint16(10, now.time, true);
        lv.setUint16(12, now.date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        parts.push(local, data);

        var cd = new Uint8Array(46 + nameBytes.length);
        var cv = new DataView(cd.buffer);
        cv.setUint32(0, SIG_CENTRAL, true);
        cv.setUint16(4, 20, true);           // version made by
        cv.setUint16(6, 20, true);           // version needed
        cv.setUint16(8, FLAG_UTF8, true);
        cv.setUint16(10, 0, true);           // method: store
        cv.setUint16(12, now.time, true);
        cv.setUint16(14, now.date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);           // extra len
        cv.setUint16(32, 0, true);           // comment len
        cv.setUint16(34, 0, true);           // disk start
        cv.setUint16(36, 0, true);           // internal attrs
        cv.setUint32(38, 0, true);           // external attrs
        cv.setUint32(42, offset, true);      // local header offset
        cd.set(nameBytes, 46);
        central.push(cd);

        offset += local.length + data.length;
      });

      var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);

      var eocd = new Uint8Array(22);
      var ev = new DataView(eocd.buffer);
      ev.setUint32(0, SIG_EOCD, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, files.length, true);
      ev.setUint16(10, files.length, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, offset, true);
      ev.setUint16(20, 0, true);

      return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
    });
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持解压该备份文件'));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /* 解包：接受 Blob / ArrayBuffer / Uint8Array，返回 [{ name, data(Uint8Array) }] */
  function read(input) {
    var bufferPromise;
    if (isBlobLike(input) && typeof input.arrayBuffer === 'function') {
      bufferPromise = input.arrayBuffer();
    } else if (isArrayBufferLike(input)) {
      bufferPromise = Promise.resolve(input.slice(0));
    } else {
      bufferPromise = Promise.resolve(toBytes(input).buffer.slice(0));
    }

    return bufferPromise.then(function (ab) {
      var buf = new Uint8Array(ab);
      var view = new DataView(ab);

      // 从尾部向前查找 EOCD 签名
      var eocd = -1;
      var minPos = Math.max(0, buf.length - 22 - 65535);
      for (var i = buf.length - 22; i >= minPos; i--) {
        if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
      }
      if (eocd < 0) return Promise.reject(new Error('不是有效的 ZIP 文件'));

      var total = view.getUint16(eocd + 10, true);
      var cdOffset = view.getUint32(eocd + 16, true);
      var dec = new TextDecoder('utf-8');
      var entries = [];
      var p = cdOffset;
      var chain = Promise.resolve();

      for (var n = 0; n < total; n++) {
        if (p + 46 > buf.length || view.getUint32(p, true) !== SIG_CENTRAL) break;

        var method = view.getUint16(p + 10, true);
        var compSize = view.getUint32(p + 20, true);
        var nameLen = view.getUint16(p + 28, true);
        var extraLen = view.getUint16(p + 30, true);
        var commentLen = view.getUint16(p + 32, true);
        var localOff = view.getUint32(p + 42, true);
        var name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

        if (view.getUint32(localOff, true) === SIG_LOCAL) {
          var lNameLen = view.getUint16(localOff + 26, true);
          var lExtraLen = view.getUint16(localOff + 28, true);
          var dataStart = localOff + 30 + lNameLen + lExtraLen;
          var raw = buf.subarray(dataStart, dataStart + compSize);
          var entry = { name: name };

          if (method === 0) {
            entry.data = raw;
            entries.push(entry);
          } else if (method === 8) {
            entries.push(entry);
            (function (target, payload) {
              chain = chain.then(function () {
                return inflateRaw(payload).then(function (out) { target.data = out; });
              });
            })(entry, raw);
          }
          // 其它压缩方式直接跳过
        }

        p += 46 + nameLen + extraLen + commentLen;
      }

      return chain.then(function () {
        return entries.filter(function (e) { return e.data; });
      });
    });
  }

  global.YuegaoZip = { create: create, read: read, crc32: crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
