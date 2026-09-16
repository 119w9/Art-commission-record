/* =========================================================
   store.js — 约稿记录数据层
   职责：本地持久化（localStorage）+ 增删改查 + 导入导出
   说明：本文件不操作 DOM，仅负责数据安全与规范化
   ========================================================= */
(function (global) {
  'use strict';

  var RECORDS_KEY = 'yuegao_ledger_records_v1';
  var BACKUP_KEY = 'yuegao_ledger_backup_v1';
  var SCHEMA_VERSION = 1;

  /* 预设平台（支持自定义输入） */
  var PLATFORMS = ['B站', '小红书', '微博', '闲鱼', '米画师', '淘宝', '专属社群'];

  /* 预设进度状态（支持自定义输入） */
  var PROGRESS = [
    '草稿阶段', '线稿绘制', '上色阶段', '细化调整', '修改返图',
    '定稿完成', '交付收货', '售后修改', '订单取消'
  ];

  /* 视为「已完成」的进度 */
  var DONE_PROGRESS = ['定稿完成', '交付收货'];
  /* 视为「已取消」的进度（不计入消费统计） */
  var CANCEL_PROGRESS = ['订单取消'];

  var records = [];

  /* --------------------- 工具函数 --------------------- */

  function uid() {
    return 'yg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function num(v) {
    if (v === '' || v === null || v === undefined) return 0;
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
  }

  function today() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /* 稿件文件元数据（二进制存在 IndexedDB，此处仅保存索引信息） */
  function normalizeAttachment(a) {
    if (!a || typeof a !== 'object') return null;
    var id = str(a.id);
    if (!id) return null;
    return {
      id: id,
      name: str(a.name) || '未命名文件',
      size: num(a.size),
      type: str(a.type) || 'application/octet-stream',
      addedAt: str(a.addedAt) || new Date().toISOString()
    };
  }

  function normalizeAttachments(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (a) {
      var item = normalizeAttachment(a);
      if (item && !out.some(function (x) { return x.id === item.id; })) out.push(item);
    });
    return out;
  }

  /* 把任意来源的数据规范化为标准字段结构，保证格式统一 */
  function normalize(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var legacyArtist = (r.artist && typeof r.artist === 'object') ? r.artist : {};
    var now = new Date().toISOString();
    var created = str(r.createdAt) || now;

    return {
      id: str(r.id) || uid(),
      artistName: str(r.artistName || legacyArtist.nickname || legacyArtist.name),
      artistId: str(r.artistId || legacyArtist.platformId || legacyArtist.account),
      artistHome: str(r.artistHome || legacyArtist.homepage || legacyArtist.home),
      platform: str(r.platform),
      price: num(r.price),
      date: str(r.date) || today(),
      progress: str(r.progress) || PROGRESS[0],
      notes: str(r.notes),
      starred: r.starred === true || r.starred === 'true',
      attachments: normalizeAttachments(r.attachments),
      createdAt: created,
      updatedAt: str(r.updatedAt) || created
    };
  }

  /* --------------------- 持久化 --------------------- */

  function persist() {
    try {
      global.localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
      return true;
    } catch (e) {
      console.error('[约稿记录] 保存失败：', e);
      return false;
    }
  }

  function load() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(RECORDS_KEY);
    } catch (e) {
      console.error('[约稿记录] 读取本地存储失败：', e);
      records = [];
      return records;
    }

    if (!raw) {
      records = [];
      return records;
    }

    try {
      var parsed = JSON.parse(raw);
      var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.records) ? parsed.records : []);
      records = list.map(normalize);
      // 读取成功后留一份快照备份，避免意外损坏导致数据丢失
      try { global.localStorage.setItem(BACKUP_KEY, raw); } catch (e2) { /* 忽略配额问题 */ }
    } catch (e) {
      console.error('[约稿记录] 数据解析失败，尝试使用备份：', e);
      records = restoreFromBackup();
    }
    return records;
  }

  function restoreFromBackup() {
    try {
      var raw = global.localStorage.getItem(BACKUP_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.records) ? parsed.records : []);
      return list.map(normalize);
    } catch (e) {
      return [];
    }
  }

  /* --------------------- 增删改 --------------------- */

  function add(data) {
    var item = normalize(data);
    item.id = uid();
    item.createdAt = new Date().toISOString();
    item.updatedAt = item.createdAt;
    records.push(item);
    persist();
    return item;
  }

  function update(id, data) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id) {
        var merged = normalize(Object.assign({}, records[i], data, {
          id: records[i].id,
          createdAt: records[i].createdAt
        }));
        merged.updatedAt = new Date().toISOString();
        records[i] = merged;
        persist();
        return merged;
      }
    }
    return null;
  }

  /* 删除记录；返回被删除的记录本身（供调用方清理其稿件文件） */
  function remove(id) {
    var removed = getById(id);
    if (!removed) return null;
    records = records.filter(function (r) { return r.id !== id; });
    persist();
    return removed;
  }

  /* 星标开关：作为独立字段保存，编辑其它字段不会影响星标状态 */
  function toggleStar(id) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id) {
        records[i].starred = !records[i].starred;
        records[i].updatedAt = new Date().toISOString();
        persist();
        return records[i].starred;
      }
    }
    return null;
  }

  function setStar(id, value) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id) {
        records[i].starred = !!value;
        persist();
        return true;
      }
    }
    return false;
  }

  function getById(id) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id) return records[i];
    }
    return null;
  }

  /* --------------------- 查询 --------------------- */

  function matches(r, keyword) {
    var hay = [
      r.artistName, r.artistId, r.artistHome, r.platform,
      r.progress, r.notes, r.date, String(r.price)
    ].join(' ').toLowerCase();
    return hay.indexOf(keyword) !== -1;
  }

  function query(opts) {
    opts = opts || {};
    var list = records.slice();

    if (opts.starOnly) {
      list = list.filter(function (r) { return r.starred; });
    }

    if (opts.progress) {
      list = list.filter(function (r) { return r.progress === opts.progress; });
    }

    var keyword = str(opts.search).toLowerCase();
    if (keyword) {
      list = list.filter(function (r) { return matches(r, keyword); });
    }

    var sort = opts.sort || 'date-desc';
    function byDate(r) { return (r.date || '') + ' ' + (r.createdAt || ''); }

    list.sort(function (a, b) {
      switch (sort) {
        case 'date-asc': return byDate(a) < byDate(b) ? -1 : (byDate(a) > byDate(b) ? 1 : 0);
        case 'price-desc': return b.price - a.price || (byDate(a) < byDate(b) ? 1 : -1);
        case 'price-asc': return a.price - b.price || (byDate(a) < byDate(b) ? 1 : -1);
        case 'created-desc': return (b.createdAt || '') < (a.createdAt || '') ? -1 : 1;
        case 'date-desc':
        default: return byDate(a) > byDate(b) ? -1 : (byDate(a) < byDate(b) ? 1 : 0);
      }
    });

    return list;
  }

  /* --------------------- 统计 --------------------- */

  function stats() {
    var total = 0;
    var starCount = 0;
    var doing = 0;

    records.forEach(function (r) {
      if (CANCEL_PROGRESS.indexOf(r.progress) === -1) total += r.price;
      if (r.starred) starCount++;
      if (DONE_PROGRESS.indexOf(r.progress) === -1 && CANCEL_PROGRESS.indexOf(r.progress) === -1) doing++;
    });

    return {
      count: records.length,
      total: Math.round(total * 100) / 100,
      starred: starCount,
      doing: doing
    };
  }

  /* 收集当前数据中出现的全部进度状态（含自定义），用于筛选下拉 */
  function progressOptions() {
    var set = PROGRESS.slice();
    records.forEach(function (r) {
      if (r.progress && set.indexOf(r.progress) === -1) set.push(r.progress);
    });
    return set;
  }

  function all() { return records.slice(); }

  /* 展平所有稿件文件，附带其归属记录，供「稿件库」板块使用 */
  function allAttachments() {
    var out = [];
    records.forEach(function (r) {
      (r.attachments || []).forEach(function (a) {
        out.push({ attachment: a, record: r });
      });
    });
    return out;
  }

  function attachmentCount() {
    return records.reduce(function (n, r) { return n + (r.attachments ? r.attachments.length : 0); }, 0);
  }

  /* 从记录的附件列表中移除某个文件（仅改元数据，文件本体由调用方清理） */
  function detachFile(recordId, fileId) {
    var rec = getById(recordId);
    if (!rec) return false;
    var before = rec.attachments.length;
    rec.attachments = rec.attachments.filter(function (a) { return a.id !== fileId; });
    if (rec.attachments.length === before) return false;
    rec.updatedAt = new Date().toISOString();
    persist();
    return true;
  }

  /* 把若干文件元数据挂到记录上（不重复） */
  function attachFiles(recordId, metas) {
    var rec = getById(recordId);
    if (!rec || !metas || !metas.length) return null;
    var exist = {};
    rec.attachments.forEach(function (a) { exist[a.id] = true; });
    metas.forEach(function (m) {
      if (m && m.id && !exist[m.id]) {
        rec.attachments.push(m);
        exist[m.id] = true;
      }
    });
    rec.updatedAt = new Date().toISOString();
    persist();
    return rec;
  }

  /* --------------------- 导入 / 导出 --------------------- */

  function exportPayload() {
    return {
      app: '约稿记录',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      count: records.length,
      records: records.slice()
    };
  }

  /* 导入策略：以 id 合并，绝不覆盖已有记录，尽力避免数据丢失 */
  function importPayload(payload) {
    var incoming;

    if (Array.isArray(payload)) {
      incoming = payload;
    } else if (payload && Array.isArray(payload.records)) {
      incoming = payload.records;
    } else if (typeof payload === 'string') {
      incoming = JSON.parse(payload);
      if (!Array.isArray(incoming)) incoming = incoming && incoming.records;
    } else {
      throw new Error('文件格式不正确');
    }

    if (!Array.isArray(incoming)) throw new Error('文件中未找到约稿记录');

    var added = 0, updated = 0, skipped = 0;

    incoming.map(normalize).forEach(function (item) {
      var exist = getById(item.id);
      if (!exist) {
        records.push(item);
        added++;
      } else if (str(item.updatedAt) > str(exist.updatedAt)) {
        var idx = records.indexOf(exist);
        records[idx] = item;
        updated++;
      } else {
        skipped++;
      }
    });

    persist();
    return { added: added, updated: updated, skipped: skipped, total: records.length };
  }

  function csvEscape(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv() {
    var header = ['画手昵称', '画手ID', '账号主页', '约稿平台', '约稿价格(元)', '约稿时间', '稿件进度', '星标收藏', '稿件数量', '稿件文件名', '补充备注', '创建时间', '最近更新'];
    var rows = [header.map(csvEscape).join(',')];

    query({ sort: 'date-desc' }).forEach(function (r) {
      rows.push([
        r.artistName, r.artistId, r.artistHome, r.platform,
        r.price.toFixed(2), r.date, r.progress, r.starred ? '是' : '否',
        r.attachments.length,
        r.attachments.map(function (a) { return a.name; }).join(' / '),
        r.notes, r.createdAt, r.updatedAt
      ].map(csvEscape).join(','));
    });

    return rows.join('\r\n');
  }

  global.Yuegao = {
    // 常量
    PLATFORMS: PLATFORMS,
    PROGRESS: PROGRESS,
    DONE_PROGRESS: DONE_PROGRESS,
    CANCEL_PROGRESS: CANCEL_PROGRESS,
    SCHEMA_VERSION: SCHEMA_VERSION,
    RECORDS_KEY: RECORDS_KEY,
    // 数据操作
    load: load,
    all: all,
    add: add,
    update: update,
    remove: remove,
    toggleStar: toggleStar,
    setStar: setStar,
    getById: getById,
    query: query,
    stats: stats,
    progressOptions: progressOptions,
    // 稿件文件
    allAttachments: allAttachments,
    attachmentCount: attachmentCount,
    detachFile: detachFile,
    attachFiles: attachFiles,
    // 备份
    exportPayload: exportPayload,
    importPayload: importPayload,
    toCsv: toCsv,
    // 工具
    uid: uid,
    num: num
  };
})(window);
