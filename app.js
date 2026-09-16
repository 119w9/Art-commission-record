/* =========================================================
   app.js — 约稿记录 交互层
   模块一：约稿信息完整记录（新增 / 编辑 / 删除）
   模块二：星标收藏（点亮 / 取消 / 筛选）
   模块三：订单台账管理（倒序列表 / 检索 / 统计 / 导出）
   模块四：稿件文件板块（上传 / 预览 / 下载 / 打包 / 稿件库）
   ========================================================= */
(function () {
  'use strict';

  var Y = window.Yuegao;
  var YF = window.YuegaoFiles;
  var Z = window.YuegaoZip;

  var CUSTOM = '__custom__';
  var MAX_FILE_SIZE = 50 * 1024 * 1024;
  var THUMB_CACHE_LIMIT = 300;

  /* 进度状态 → 标签配色 */
  var PROGRESS_CLASS = {
    '草稿阶段': 'p-draft',
    '线稿绘制': 'p-line',
    '上色阶段': 'p-color',
    '细化调整': 'p-refine',
    '修改返图': 'p-revise',
    '定稿完成': 'p-final',
    '交付收货': 'p-deliver',
    '售后修改': 'p-after',
    '订单取消': 'p-cancel'
  };

  var state = {
    view: 'ledger',
    search: '',
    starOnly: false,
    progress: '',
    sort: 'date-desc',
    fileSearch: '',
    fileType: '',
    fileSort: 'added-desc',
    editingId: null,
    pendingDeleteId: null,
    previewFileId: null,
    quickUploadOrderId: null,
    saving: false
  };

  /* 订单弹窗内的稿件暂存区：保存时才真正写入 */
  var stage = { kept: [], added: [], removed: [] };
  /* 稿件库上传弹窗的暂存文件 */
  var uploadStage = { files: [] };

  var $ = function (id) { return document.getElementById(id); };
  var dom = {};

  /* ================= 通用工具 ================= */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(n) {
    return (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function pad2(x) { return String(x).padStart(2, '0'); }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function toast(message, type) {
    var node = document.createElement('div');
    node.className = 'toast ' + (type || '');
    node.textContent = message;
    dom.toastWrap.appendChild(node);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 240);
    }, 2600);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function downloadText(filename, content, mime) {
    downloadBlob(new Blob([content], { type: mime || 'application/json;charset=utf-8' }), filename);
  }

  function isImage(type) {
    return String(type || '').indexOf('image/') === 0;
  }

  /* PSD / 设计源文件常被标为 image/*，需先于通用图片判断 */
  function isPsd(type, name) {
    return /photoshop|psd/.test(String(type || '')) || /\.psd$/i.test(String(name || ''));
  }

  function fileIcon(type, name) {
    if (isPsd(type, name)) return '🎨';
    if (isImage(type)) return '🖼';
    if (String(type) === 'application/pdf') return '📕';
    if (/zip|compressed|rar|7z|tar/.test(type) || /\.(zip|rar|7z|tar|gz)$/i.test(name)) return '🗜';
    if (/video\//.test(type)) return '🎬';
    if (/audio\//.test(type)) return '🎵';
    if (/text\/|json|xml|word|excel|presentation/.test(type)) return '📄';
    return '📎';
  }

  function kindLabel(type, name) {
    if (isPsd(type, name)) return 'PSD 源文件';
    if (isImage(type)) return '图片';
    if (String(type) === 'application/pdf') return 'PDF';
    if (/zip|compressed|rar|7z|tar/.test(type) || /\.(zip|rar|7z|tar|gz)$/i.test(name)) return '压缩包';
    if (/video\//.test(type)) return '视频';
    if (/audio\//.test(type)) return '音频';
    if (/text\/|json|xml/.test(type)) return '文本';
    return '文件';
  }

  function toArrayBuffer(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  /* ================= 缩略图缓存 ================= */

  var thumbCache = new Map();

  function clearThumbCache() {
    thumbCache.forEach(function (url) { URL.revokeObjectURL(url); });
    thumbCache.clear();
  }

  function invalidateThumb(id) {
    if (thumbCache.has(id)) {
      URL.revokeObjectURL(thumbCache.get(id));
      thumbCache.delete(id);
    }
  }

  function ensureThumb(id) {
    if (thumbCache.has(id)) return Promise.resolve(thumbCache.get(id));
    if (!YF || !YF.supported()) return Promise.resolve(null);
    return YF.get(id).then(function (row) {
      if (!row) return null;
      if (thumbCache.size >= THUMB_CACHE_LIMIT) clearThumbCache();
      var url = URL.createObjectURL(new Blob([row.data], { type: row.type }));
      thumbCache.set(id, url);
      return url;
    }).catch(function () { return null; });
  }

  /* 给渲染出的占位元素补上真实缩略图 */
  function hydrateThumbs(root) {
    var nodes = root.querySelectorAll('[data-thumb]');
    if (!nodes.length) return Promise.resolve();
    var jobs = [];
    Array.prototype.forEach.call(nodes, function (node) {
      var id = node.getAttribute('data-thumb');
      if (!id) return;
      var local = node.getAttribute('data-thumb-src');
      if (local) {
        node.textContent = '';
        var img0 = document.createElement('img');
        img0.src = local;
        img0.alt = '';
        node.appendChild(img0);
        return;
      }
      if (!isImage(node.getAttribute('data-thumb-type'))) return;
      jobs.push(ensureThumb(id).then(function (url) {
        if (!url || !node.isConnected) return;
        node.textContent = '';
        var img = document.createElement('img');
        img.src = url;
        img.alt = '';
        node.appendChild(img);
      }));
    });
    return Promise.all(jobs);
  }

  /* ================= 初始化 ================= */

  function cacheDom() {
    [
      'statCount', 'statTotal', 'statStar', 'statDoing',
      'searchInput', 'searchClear', 'starFilter', 'progressFilter', 'sortSelect',
      'listSummary', 'list', 'viewNav', 'viewLedger', 'viewFiles', 'navFileCount',
      'fileStatCount', 'fileStatSize', 'fileStatStar', 'fileStatOrders',
      'fileSearchInput', 'fileSearchClear', 'fileTypeFilter', 'fileSortSelect',
      'fileSummary', 'filesGrid', 'btnUploadPick', 'btnZipDownload',
      'btnAdd', 'btnExport', 'btnExportCsv', 'btnImport', 'fileInput',
      'modalMask', 'modalTitle', 'modalClose', 'modalCancel', 'modalSubmit',
      'orderForm', 'formError',
      'fArtistName', 'fArtistId', 'fArtistHome',
      'fPlatform', 'fPlatformCustomWrap', 'fPlatformCustom',
      'fPrice', 'fDate', 'fProgress', 'fProgressCustomWrap', 'fProgressCustom',
      'fNotes', 'fStarred', 'dropzone', 'fFiles', 'fileList',
      'uploadMask', 'uploadClose', 'uploadCancel', 'uploadSubmit',
      'uploadOrder', 'uploadDrop', 'uploadFiles', 'uploadList', 'uploadError',
      'previewMask', 'previewTitle', 'previewClose', 'previewBody', 'previewMeta',
      'previewLocate', 'previewDownload',
      'confirmMask', 'confirmTitle', 'confirmText', 'confirmCancel', 'confirmOk',
      'toastWrap', 'quickFileInput', 'stageDownloadAll'
    ].forEach(function (id) { dom[id] = $(id); });
  }

  function fillSelects() {
    var platformHtml = ['<option value="">请选择约稿平台</option>'];
    Y.PLATFORMS.forEach(function (p) {
      platformHtml.push('<option value="' + esc(p) + '">' + esc(p) + '</option>');
    });
    platformHtml.push('<option value="' + CUSTOM + '">其他（自定义输入）</option>');
    dom.fPlatform.innerHTML = platformHtml.join('');

    var progressHtml = ['<option value="">请选择稿件进度</option>'];
    Y.PROGRESS.forEach(function (p) {
      progressHtml.push('<option value="' + esc(p) + '">' + esc(p) + '</option>');
    });
    progressHtml.push('<option value="' + CUSTOM + '">其他（自定义输入）</option>');
    dom.fProgress.innerHTML = progressHtml.join('');

    refreshProgressFilter();
  }

  function refreshProgressFilter() {
    var options = Y.progressOptions();
    var current = dom.progressFilter.value;
    var html = ['<option value="">全部进度</option>'];
    options.forEach(function (p) {
      html.push('<option value="' + esc(p) + '">' + esc(p) + '</option>');
    });
    dom.progressFilter.innerHTML = html.join('');
    if (options.indexOf(current) !== -1) {
      dom.progressFilter.value = current;
      state.progress = current;
    } else {
      state.progress = '';
      dom.progressFilter.value = '';
    }
  }

  function refreshUploadOrderSelect() {
    var list = Y.query({ sort: 'date-desc' });
    var keep = dom.uploadOrder.value;
    var html = ['<option value="">请选择要关联的约稿记录</option>'];
    list.forEach(function (r) {
      var label = (r.artistName || r.artistId || '未命名画手') + ' · ' + (r.date || '无日期') + ' · ' + (r.platform || '未知平台');
      html.push('<option value="' + esc(r.id) + '">' + esc(label) + '</option>');
    });
    dom.uploadOrder.innerHTML = html.join('');
    if (keep && Y.getById(keep)) dom.uploadOrder.value = keep;
  }

  /* ================= 渲染：订单台账 ================= */

  function render() {
    renderStats();
    renderList();
    renderFileStats();
    renderFilesGrid();
    refreshProgressFilter();
    refreshUploadOrderSelect();
    hydrateThumbs(document);
  }

  function renderStats() {
    var s = Y.stats();
    dom.statCount.textContent = s.count;
    dom.statTotal.textContent = '¥' + money(s.total);
    dom.statStar.textContent = s.starred;
    dom.statDoing.textContent = s.doing;
  }

  function tagClass(progress) {
    return PROGRESS_CLASS[progress] || 'tag-progress';
  }

  /* 订单卡片上的稿件条 */
  function cardFilesHtml(r) {
    var files = r.attachments || [];
    var thumbs = files.slice(0, 4).map(function (a) {
      return '<button class="mini-thumb" data-act="preview" data-file="' + esc(a.id) + '" ' +
        'title="' + esc(a.name) + '" aria-label="预览 ' + esc(a.name) + '">' +
        '<span class="mini-thumb" data-thumb="' + esc(a.id) + '" data-thumb-type="' + esc(a.type) + '">' + fileIcon(a.type, a.name) + '</span>' +
        '</button>';
    }).join('');

    var more = files.length > 4 ? '<span class="mini-more">+' + (files.length - 4) + '</span>' : '';

    var actions = '<button class="btn btn-xs btn-ghost" data-act="upload">⬆ 上传</button>';
    if (files.length) {
      actions += '<button class="btn btn-xs btn-ghost" data-act="download-all">⬇ 下载全部</button>';
    }

    return '' +
      '<div class="card-files">' +
        '<span class="files-label">📎 稿件' + (files.length ? ' <b>' + files.length + '</b>' : '') + '</span>' +
        '<span class="files-strip">' + (files.length ? (thumbs + more) : '<span class="file-sub">暂未上传稿件文件</span>') + '</span>' +
        '<span class="files-actions">' + actions + '</span>' +
      '</div>';
  }

  function cardHtml(r) {
    var avatarChar = (r.artistName || r.artistId || '?').slice(0, 1);
    var home = r.artistHome
      ? '<a class="artist-home" href="' + esc(r.artistHome) + '" target="_blank" rel="noopener noreferrer">🔗 ' + esc(r.artistHome) + '</a>'
      : '';

    var notes = r.notes ? '<p class="card-notes">' + esc(r.notes) + '</p>' : '';

    return '' +
      '<article class="card' + (r.starred ? ' is-starred' : '') + '" data-id="' + esc(r.id) + '">' +
        '<div class="card-head">' +
          '<div class="artist">' +
            '<span class="artist-avatar">' + esc(avatarChar) + '</span>' +
            '<div class="artist-info">' +
              '<h3 class="artist-name">' +
                esc(r.artistName || '未命名画手') +
                (r.artistId ? '<span class="artist-id">ID: ' + esc(r.artistId) + '</span>' : '') +
              '</h3>' + home +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<span class="card-price"><span class="price-unit">¥</span>' + money(r.price) + '</span>' +
            '<button class="star-btn' + (r.starred ? ' active' : '') + '" data-act="star" ' +
              'title="' + (r.starred ? '取消星标' : '点亮星标收藏') + '" ' +
              'aria-pressed="' + (r.starred ? 'true' : 'false') + '" ' +
              'aria-label="' + (r.starred ? '取消星标' : '点亮星标') + '">' + (r.starred ? '★' : '☆') + '</button>' +
          '</div>' +
        '</div>' +

        '<div class="card-tags">' +
          (r.platform ? '<span class="tag tag-platform">' + esc(r.platform) + '</span>' : '') +
          '<span class="tag ' + tagClass(r.progress) + '">' + esc(r.progress || '未设置进度') + '</span>' +
          '<span class="tag tag-date">' + esc(r.date || '—') + '</span>' +
        '</div>' +

        cardFilesHtml(r) + notes +

        '<div class="card-foot">' +
          '<span class="card-time">录入 ' + esc(fmtDateTime(r.createdAt)) + ' ｜ 更新 ' + esc(fmtDateTime(r.updatedAt)) + '</span>' +
          '<div class="card-actions">' +
            '<button class="btn btn-sm btn-ghost" data-act="edit">编辑</button>' +
            '<button class="btn btn-sm btn-soft-danger" data-act="delete">删除</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderList() {
    var list = Y.query({
      search: state.search,
      starOnly: state.starOnly,
      progress: state.progress,
      sort: state.sort
    });

    var total = Y.all().length;
    dom.listSummary.textContent = (list.length === total)
      ? '共 ' + total + ' 条记录'
      : '筛选出 ' + list.length + ' 条 / 共 ' + total + ' 条记录';

    dom.list.innerHTML = list.length ? list.map(cardHtml).join('') : emptyLedgerHtml(total);
    hydrateThumbs(dom.list);
  }

  function emptyLedgerHtml(total) {
    if (total === 0) {
      return '' +
        '<div class="empty">' +
          '<div class="empty-icon">🎨</div>' +
          '<h3>还没有任何约稿记录</h3>' +
          '<p>点击右上角「新增约稿」，开始建立你的专属约稿台账吧。</p>' +
          '<button class="btn btn-primary" data-act="empty-add"><span class="btn-plus">＋</span> 新增第一条约稿</button>' +
        '</div>';
    }
    return '' +
      '<div class="empty">' +
        '<div class="empty-icon">🔍</div>' +
        '<h3>没有符合条件的记录</h3>' +
        '<p>换个关键词，或清空筛选条件再试试。</p>' +
        '<button class="btn btn-ghost" data-act="reset-filter">清空筛选条件</button>' +
      '</div>';
  }

  /* ================= 渲染：稿件库 ================= */

  function renderFileStats() {
    var flat = Y.allAttachments();
    var orderSet = {};
    var starred = 0;
    flat.forEach(function (x) {
      orderSet[x.record.id] = true;
      if (x.record.starred) starred++;
    });

    dom.fileStatCount.textContent = flat.length;
    dom.fileStatStar.textContent = starred;
    dom.fileStatOrders.textContent = Object.keys(orderSet).length;
    dom.navFileCount.textContent = flat.length;

    if (YF && YF.supported()) {
      YF.stats().then(function (s) {
        dom.fileStatSize.textContent = formatBytes(s.size);
      }).catch(function () { dom.fileStatSize.textContent = '—'; });
    } else {
      dom.fileStatSize.textContent = '—';
    }
  }

  function filteredFiles() {
    var kw = state.fileSearch.trim().toLowerCase();
    var list = Y.allAttachments().filter(function (x) {
      var a = x.attachment, r = x.record;
      if (state.fileType === 'image' && !isImage(a.type)) return false;
      if (state.fileType === 'other' && isImage(a.type)) return false;
      if (!kw) return true;
      return [a.name, r.artistName, r.artistId, r.platform, r.progress, r.date]
        .join(' ').toLowerCase().indexOf(kw) !== -1;
    });

    list.sort(function (x, y) {
      var a = x.attachment, b = y.attachment;
      switch (state.fileSort) {
        case 'added-asc': return (a.addedAt || '') < (b.addedAt || '') ? -1 : 1;
        case 'size-desc': return (b.size || 0) - (a.size || 0);
        case 'name-asc': return String(a.name).localeCompare(String(b.name), 'zh-CN');
        case 'added-desc':
        default: return (a.addedAt || '') > (b.addedAt || '') ? -1 : 1;
      }
    });
    return list;
  }

  function fileCardHtml(item) {
    var a = item.attachment, r = item.record;
    var star = r.starred ? '<span class="fc-star">★ 星标订单</span>' : '';

    return '' +
      '<article class="file-card' + (r.starred ? ' is-starred' : '') + '" data-file="' + esc(a.id) + '" data-order="' + esc(r.id) + '">' +
        '<div class="fc-preview" data-act="preview" data-file="' + esc(a.id) + '" title="点击预览">' +
          star +
          '<span class="fc-icon" data-thumb="' + esc(a.id) + '" data-thumb-type="' + esc(a.type) + '">' + fileIcon(a.type, a.name) + '</span>' +
        '</div>' +
        '<div class="fc-body">' +
          '<div class="fc-name" title="' + esc(a.name) + '">' + esc(a.name) + '</div>' +
          '<div class="fc-meta">' +
            '<span>' + esc(r.artistName || r.artistId || '未命名画手') + '</span>' +
            (r.platform ? '<span class="dot">·</span><span>' + esc(r.platform) + '</span>' : '') +
          '</div>' +
          '<div class="fc-meta">' +
            '<span>' + esc(kindLabel(a.type, a.name)) + '</span>' +
            '<span class="dot">·</span><span>' + esc(formatBytes(a.size)) + '</span>' +
            '<span class="dot">·</span><span>' + esc((a.addedAt || '').slice(0, 10)) + '</span>' +
          '</div>' +
          '<div class="fc-actions">' +
            '<button class="btn btn-xs btn-ghost" data-act="preview" data-file="' + esc(a.id) + '">预览</button>' +
            '<button class="btn btn-xs btn-ghost" data-act="download-file" data-file="' + esc(a.id) + '">下载</button>' +
            '<button class="btn btn-xs btn-soft-danger" data-act="delete-file" data-file="' + esc(a.id) + '">删除</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderFilesGrid() {
    var list = filteredFiles();
    var totalFiles = Y.attachmentCount();

    dom.fileSummary.textContent = (list.length === totalFiles)
      ? '共 ' + totalFiles + ' 个稿件'
      : '筛选出 ' + list.length + ' 个 / 共 ' + totalFiles + ' 个稿件';

    if (!list.length) {
      dom.filesGrid.innerHTML = emptyFilesHtml(totalFiles);
      return;
    }
    dom.filesGrid.innerHTML = list.map(fileCardHtml).join('');
    hydrateThumbs(dom.filesGrid);
  }

  function emptyFilesHtml(totalFiles) {
    if (totalFiles === 0) {
      return '' +
        '<div class="empty">' +
          '<div class="empty-icon">📁</div>' +
          '<h3>稿件库还是空的</h3>' +
          '<p>可以在订单卡片上点「⬆ 上传」，或直接在这里上传稿件文件。</p>' +
          '<button class="btn btn-primary" data-act="open-upload"><span class="btn-plus">＋</span> 上传稿件</button>' +
        '</div>';
    }
    return '' +
      '<div class="empty">' +
        '<div class="empty-icon">🔍</div>' +
        '<h3>没有符合条件的稿件</h3>' +
        '<p>换个关键词或文件类型再试试。</p>' +
        '<button class="btn btn-ghost" data-act="reset-file-filter">清空筛选条件</button>' +
      '</div>';
  }

  /* ================= 板块切换 ================= */

  function switchView(view) {
    state.view = view;
    dom.viewLedger.hidden = view !== 'ledger';
    dom.viewFiles.hidden = view !== 'files';
    Array.prototype.forEach.call(dom.viewNav.querySelectorAll('.view-tab'), function (tab) {
      var on = tab.getAttribute('data-view') === view;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (view === 'files') renderFilesGrid();
  }

  /* ================= 弹窗：新增 / 编辑 ================= */

  function resetStage() {
    stage.added.forEach(function (item) { URL.revokeObjectURL(item.url); });
    stage = { kept: [], added: [], removed: [] };
  }

  function openModal(id) {
    state.editingId = id || null;
    dom.formError.hidden = true;
    clearInvalid();
    resetStage();

    if (id) {
      var r = Y.getById(id);
      if (!r) { toast('记录不存在', 'error'); return; }
      dom.modalTitle.textContent = '编辑约稿记录';
      stage.kept = (r.attachments || []).map(function (a) { return Object.assign({}, a); });
      fillForm(r);
    } else {
      dom.modalTitle.textContent = '新增约稿记录';
      fillForm(null);
    }

    renderStageFiles();
    dom.modalMask.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { dom.fArtistName.focus(); }, 40);
  }

  function closeModal() {
    dom.modalMask.hidden = true;
    document.body.style.overflow = '';
    state.editingId = null;
    resetStage();
  }

  function fillForm(r) {
    if (r) {
      dom.fArtistName.value = r.artistName;
      dom.fArtistId.value = r.artistId;
      dom.fArtistHome.value = r.artistHome;

      if (r.platform && Y.PLATFORMS.indexOf(r.platform) === -1) {
        dom.fPlatform.value = CUSTOM;
        dom.fPlatformCustom.value = r.platform;
      } else {
        dom.fPlatform.value = r.platform || '';
        dom.fPlatformCustom.value = '';
      }

      dom.fPrice.value = r.price;
      dom.fDate.value = r.date || todayStr();

      if (r.progress && Y.PROGRESS.indexOf(r.progress) === -1) {
        dom.fProgress.value = CUSTOM;
        dom.fProgressCustom.value = r.progress;
      } else {
        dom.fProgress.value = r.progress || '';
        dom.fProgressCustom.value = '';
      }

      dom.fNotes.value = r.notes;
      dom.fStarred.checked = !!r.starred;
    } else {
      dom.orderForm.reset();
      dom.fDate.value = todayStr();
      dom.fPlatform.value = '';
      dom.fProgress.value = '';
      dom.fPlatformCustom.value = '';
      dom.fProgressCustom.value = '';
      dom.fStarred.checked = false;
    }
    syncCustomVisibility();
  }

  function syncCustomVisibility() {
    dom.fPlatformCustomWrap.hidden = dom.fPlatform.value !== CUSTOM;
    dom.fProgressCustomWrap.hidden = dom.fProgress.value !== CUSTOM;
  }

  function clearInvalid() {
    [dom.fArtistName, dom.fArtistId, dom.fArtistHome, dom.fPlatform, dom.fPlatformCustom,
      dom.fPrice, dom.fDate, dom.fProgress, dom.fProgressCustom, dom.fNotes
    ].forEach(function (el) { el.classList.remove('invalid'); });
  }

  function showError(msg, el) {
    dom.formError.textContent = msg;
    dom.formError.hidden = false;
    if (el) { el.classList.add('invalid'); el.focus(); }
  }

  function collectForm() {
    var platform = dom.fPlatform.value === CUSTOM ? dom.fPlatformCustom.value.trim() : dom.fPlatform.value;
    var progress = dom.fProgress.value === CUSTOM ? dom.fProgressCustom.value.trim() : dom.fProgress.value;
    return {
      artistName: dom.fArtistName.value.trim(),
      artistId: dom.fArtistId.value.trim(),
      artistHome: dom.fArtistHome.value.trim(),
      platform: platform,
      price: Y.num(dom.fPrice.value),
      date: dom.fDate.value,
      progress: progress,
      notes: dom.fNotes.value.trim(),
      starred: dom.fStarred.checked
    };
  }

  function validate(data) {
    if (!data.artistName && !data.artistId) {
      return { msg: '请至少填写画手昵称或画手 ID，用于精准对应合作画师。', el: dom.fArtistName };
    }
    if (dom.fPlatform.value === CUSTOM && !data.platform) {
      return { msg: '请填写自定义平台名称。', el: dom.fPlatformCustom };
    }
    if (!data.platform) return { msg: '请选择约稿平台。', el: dom.fPlatform };
    if (dom.fPrice.value === '' || dom.fPrice.value === null) {
      return { msg: '请填写约稿价格（可填 0）。', el: dom.fPrice };
    }
    if (Number(dom.fPrice.value) < 0 || isNaN(Number(dom.fPrice.value))) {
      return { msg: '约稿价格需为不小于 0 的数字。', el: dom.fPrice };
    }
    if (!data.date) return { msg: '请选择约稿时间。', el: dom.fDate };
    if (dom.fProgress.value === CUSTOM && !data.progress) {
      return { msg: '请填写自定义稿件进度。', el: dom.fProgressCustom };
    }
    if (!data.progress) return { msg: '请选择稿件当前进度。', el: dom.fProgress };
    return null;
  }

  async function submitForm() {
    if (state.saving) return;
    clearInvalid();
    dom.formError.hidden = true;

    var data = collectForm();
    var err = validate(data);
    if (err) { showError(err.msg, err.el); return; }

    if (!YF.supported()) {
      showError('当前浏览器不支持本地稿件存储，无法保存稿件文件（约稿记录仍可正常保存）。');
      return;
    }

    state.saving = true;
    dom.modalSubmit.disabled = true;

    try {
      var targetId = state.editingId;
      var editing = !!targetId;

      if (editing) {
        Y.update(targetId, data);
      } else {
        targetId = Y.add(data).id;
      }

      // 删除被移除的稿件
      for (var i = 0; i < stage.removed.length; i++) {
        try { await YF.remove(stage.removed[i]); } catch (e) { /* 忽略单个失败 */ }
        invalidateThumb(stage.removed[i]);
      }

      // 写入新增的稿件
      var metas = [];
      for (var j = 0; j < stage.added.length; j++) {
        var meta = await YF.putBlob(targetId, stage.added[j].file);
        metas.push(meta);
      }

      var allMetas = stage.kept.concat(metas);
      Y.update(targetId, { attachments: allMetas });

      var fileCount = allMetas.length;
      var added = stage.added.length;
      var removed = stage.removed.length;

      closeModal();
      clearThumbCache();
      render();

      var parts = [];
      if (added) parts.push('新增 ' + added + ' 个稿件');
      if (removed) parts.push('移除 ' + removed + ' 个稿件');
      var tail = parts.length ? '（' + parts.join('，') + '）' : (fileCount ? '（现有 ' + fileCount + ' 个稿件）' : '');
      toast((editing ? '记录已更新' : '已新增约稿记录') + tail, 'ok');
    } catch (e) {
      console.error(e);
      showError('保存失败：' + (e && e.message ? e.message : '未知错误'));
    } finally {
      state.saving = false;
      dom.modalSubmit.disabled = false;
    }
  }

  /* ================= 弹窗内稿件暂存区 ================= */

  function acceptFiles(files, target) {
    var accepted = 0;
    Array.prototype.forEach.call(files, function (file) {
      if (file.size > MAX_FILE_SIZE) {
        toast('「' + file.name + '」超过 50MB，已跳过', 'warn');
        return;
      }
      if (target === 'stage') {
        stage.added.push({ key: 'a_' + Math.random().toString(36).slice(2, 9), file: file, url: URL.createObjectURL(file) });
      } else {
        uploadStage.files.push({ key: 'u_' + Math.random().toString(36).slice(2, 9), file: file, url: URL.createObjectURL(file) });
      }
      accepted++;
    });
    return accepted;
  }

  function fileItemHtml(opt) {
    var isNew = !!opt.isNew;
    var thumbAttr = opt.thumbId
      ? 'data-thumb="' + esc(opt.thumbId) + '" data-thumb-type="' + esc(opt.type) + '"'
      : 'data-thumb-src="' + esc(opt.url || '') + '" data-thumb-type="' + esc(opt.type) + '"';
    return '' +
      '<li class="file-item">' +
        '<span class="file-thumb" ' + thumbAttr + '>' + fileIcon(opt.type, opt.name) + '</span>' +
        '<span class="file-info">' +
          '<span class="file-name">' + esc(opt.name) + (isNew ? '<span class="file-tag-new">待上传</span>' : '') + '</span>' +
          '<span class="file-sub">' + esc(formatBytes(opt.size)) + ' · ' + esc(kindLabel(opt.type, opt.name)) + '</span>' +
        '</span>' +
        '<button type="button" class="file-dl" data-download="' + esc(opt.key) + '" title="下载该稿件" aria-label="下载该稿件">↓</button>' +
        '<button type="button" class="file-remove" data-remove="' + esc(opt.key) + '" title="移除" aria-label="移除文件">✕</button>' +
      '</li>';
  }

  function renderStageFiles() {
    var html = '';
    stage.kept.forEach(function (a) {
      html += fileItemHtml({ key: 'k_' + a.id, thumbId: a.id, name: a.name, size: a.size, type: a.type });
    });
    stage.added.forEach(function (item) {
      html += fileItemHtml({ key: item.key, url: item.url, name: item.file.name, size: item.file.size, type: item.file.type, isNew: true });
    });
    dom.fileList.innerHTML = html;
    hydrateThumbs(dom.fileList);
    if (dom.stageDownloadAll) {
      dom.stageDownloadAll.hidden = !(stage.kept.length || stage.added.length);
    }
  }

  function handleStageRemove(key) {
    if (key.indexOf('k_') === 0) {
      var id = key.slice(2);
      stage.kept = stage.kept.filter(function (a) { return a.id !== id; });
      if (stage.removed.indexOf(id) === -1) stage.removed.push(id);
    } else {
      stage.added = stage.added.filter(function (item) {
        if (item.key !== key) return true;
        URL.revokeObjectURL(item.url);
        return false;
      });
    }
    renderStageFiles();
  }

  /* ---------- 弹窗内稿件下载：已保存的取自 IndexedDB，待上传的直接用本地文件 ---------- */

  async function collectStageEntries() {
    var entries = [];
    var used = {};
    var i;
    var base;

    for (i = 0; i < stage.kept.length; i++) {
      var a = stage.kept[i];
      var row = await YF.get(a.id);
      if (!row) continue;
      base = safeName(a.name);
      if (used[base]) base = (i + 1) + '_' + base;
      used[base] = true;
      entries.push({ name: base, data: row.data });
    }

    for (i = 0; i < stage.added.length; i++) {
      var item = stage.added[i];
      base = safeName(item.file.name);
      if (used[base]) base = 'new_' + (i + 1) + '_' + base;
      used[base] = true;
      entries.push({ name: base, data: item.file });
    }

    return entries;
  }

  function downloadStageFile(key) {
    if (key.indexOf('k_') === 0) {
      downloadFile(key.slice(2));
      return;
    }
    var item = null;
    stage.added.forEach(function (x) { if (x.key === key) item = x; });
    if (!item) { toast('稿件不存在', 'error'); return; }
    downloadBlob(item.file, item.file.name);
    toast('已开始下载「' + item.file.name + '」', 'ok');
  }

  async function downloadStageAll() {
    if (!stage.kept.length && !stage.added.length) { toast('暂无稿件可下载', 'warn'); return; }
    toast('正在打包稿件…');
    try {
      var entries = await collectStageEntries();
      if (!entries.length) { toast('文件已丢失，无法打包', 'error'); return; }
      var blob = await Z.create(entries);
      var who = dom.fArtistName.value || dom.fArtistId.value || '未命名画手';
      downloadBlob(blob, '稿件_' + safeName(who) + '_' + stamp() + '.zip');
      toast('已打包下载 ' + entries.length + ' 个稿件', 'ok');
    } catch (e) {
      console.error(e);
      toast('打包失败：' + (e && e.message ? e.message : '未知错误'), 'error');
    }
  }

  /* ================= 删除确认 ================= */

  function askDelete(id) {
    var r = Y.getById(id);
    if (!r) return;
    state.pendingDeleteId = id;
    dom.confirmTitle.textContent = '确认删除该条约稿记录？';
    dom.confirmOk.dataset.mode = '';
    var fileCount = (r.attachments || []).length;
    dom.confirmText.textContent = '「' + (r.artistName || r.artistId || '未命名画手') + '」'
      + (r.date ? '（' + r.date + '）' : '') + ' 的约稿记录将被永久删除，无法恢复。'
      + (fileCount ? ' 该订单下的 ' + fileCount + ' 个稿件文件也会一并清理。' : '');
    dom.confirmMask.hidden = false;
  }

  function closeConfirm() {
    dom.confirmMask.hidden = true;
    state.pendingDeleteId = null;
  }

  async function doDelete() {
    var id = state.pendingDeleteId;
    if (!id) { closeConfirm(); return; }

    var removed = Y.remove(id);
    closeConfirm();

    if (!removed) { toast('删除失败', 'error'); return; }

    var fs = removed.attachments || [];
    fs.forEach(function (a) { invalidateThumb(a.id); });
    clearThumbCache();

    var cleaned = 0;
    if (YF.supported()) {
      try { cleaned = await YF.removeByOrder(id); } catch (e) { console.error(e); }
    }

    render();
    toast(cleaned ? '记录已删除，同时清理了 ' + cleaned + ' 个稿件文件' : '记录已删除', 'ok');
  }

  /* ================= 稿件：上传 / 预览 / 下载 ================= */

  function quickUpload(orderId, files) {
    var r = Y.getById(orderId);
    if (!r) { toast('订单不存在', 'error'); return; }
    if (!YF.supported()) { toast('当前浏览器不支持本地稿件存储', 'error'); return; }

    var list = Array.prototype.slice.call(files).filter(function (f) {
      if (f.size > MAX_FILE_SIZE) { toast('「' + f.name + '」超过 50MB，已跳过', 'warn'); return false; }
      return true;
    });
    if (!list.length) return;

    toast('正在上传 ' + list.length + ' 个稿件…');

    var chain = Promise.resolve();
    var metas = [];
    list.forEach(function (file) {
      chain = chain.then(function () {
        return YF.putBlob(orderId, file).then(function (m) { metas.push(m); });
      });
    });

    chain.then(function () {
      Y.update(orderId, { attachments: (Y.getById(orderId).attachments || []).concat(metas) });
      render();
      toast('已上传 ' + metas.length + ' 个稿件', 'ok');
    }).catch(function (e) {
      console.error(e);
      toast('上传失败：' + (e && e.message ? e.message : '未知错误'), 'error');
    });
  }

  function openPreview(fileId) {
    var found = findFile(fileId);
    if (!found) { toast('稿件不存在', 'error'); return; }

    state.previewFileId = fileId;
    dom.previewTitle.textContent = found.attachment.name;
    dom.previewMeta.innerHTML =
      '<span>画手：' + esc(found.record.artistName || found.record.artistId || '未命名画手') + '</span>' +
      '<span>平台：' + esc(found.record.platform || '—') + '</span>' +
      '<span>约稿日期：' + esc(found.record.date || '—') + '</span>' +
      '<span>大小：' + esc(formatBytes(found.attachment.size)) + '</span>' +
      '<span>上传：' + esc(fmtDateTime(found.attachment.addedAt)) + '</span>';

    dom.previewBody.innerHTML = '<div class="preview-fallback"><div class="pf-icon">⏳</div><p>正在载入预览…</p></div>';
    dom.previewMask.hidden = false;
    document.body.style.overflow = 'hidden';

    var type = found.attachment.type;
    var name = found.attachment.name;

    YF.get(fileId).then(function (row) {
      if (!row) {
        dom.previewBody.innerHTML = '<div class="preview-fallback"><div class="pf-icon">⚠️</div><p>文件已丢失，无法预览</p></div>';
        return;
      }
      var url = URL.createObjectURL(new Blob([row.data], { type: row.type }));
      var node = document.createElement('img');
      node.alt = name;
      node.onload = function () { URL.revokeObjectURL(url); };
      node.onerror = function () {
        URL.revokeObjectURL(url);
        dom.previewBody.innerHTML = '<div class="preview-fallback"><div class="pf-icon">' + fileIcon(type, name) +
          '</div><p>该类型文件不支持在线预览</p><p>请下载后查看</p></div>';
      };
      node.src = url;
      dom.previewBody.innerHTML = '';
      dom.previewBody.appendChild(node);
    }).catch(function () {
      dom.previewBody.innerHTML = '<div class="preview-fallback"><div class="pf-icon">⚠️</div><p>读取失败</p></div>';
    });
  }

  function closePreview() {
    dom.previewMask.hidden = true;
    dom.previewBody.innerHTML = '';
    document.body.style.overflow = '';
    state.previewFileId = null;
  }

  function findFile(fileId) {
    var flat = Y.allAttachments();
    for (var i = 0; i < flat.length; i++) {
      if (flat[i].attachment.id === fileId) return flat[i];
    }
    return null;
  }

  function downloadFile(fileId) {
    var found = findFile(fileId);
    if (!found) { toast('稿件不存在', 'error'); return; }
    YF.get(fileId).then(function (row) {
      if (!row) { toast('文件已丢失', 'error'); return; }
      downloadBlob(new Blob([row.data], { type: row.type }), row.name);
      toast('已开始下载「' + row.name + '」', 'ok');
    }).catch(function (e) {
      toast('下载失败：' + (e && e.message ? e.message : '未知错误'), 'error');
    });
  }

  function safeName(s) {
    return String(s || 'file').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  }

  async function downloadOrderFiles(orderId) {
    var r = Y.getById(orderId);
    if (!r) return;
    var files = r.attachments || [];
    if (!files.length) { toast('该订单暂无稿件文件', 'warn'); return; }

    toast('正在打包 ' + files.length + ' 个稿件…');
    try {
      var entries = [];
      var used = {};
      for (var i = 0; i < files.length; i++) {
        var row = await YF.get(files[i].id);
        if (!row) continue;
        var name = safeName(files[i].name);
        if (used[name]) name = i + '_' + name;
        used[name] = true;
        entries.push({ name: name, data: row.data });
      }
      if (!entries.length) { toast('文件已丢失，无法打包', 'error'); return; }
      var blob = await Z.create(entries);
      downloadBlob(blob, '稿件_' + safeName(r.artistName || r.artistId) + '_' + stamp() + '.zip');
      toast('已打包下载 ' + entries.length + ' 个稿件', 'ok');
    } catch (e) {
      console.error(e);
      toast('打包失败：' + (e && e.message ? e.message : '未知错误'), 'error');
    }
  }

  async function downloadFilteredFiles() {
    var list = filteredFiles();
    if (!list.length) { toast('暂无稿件可下载', 'warn'); return; }

    toast('正在打包 ' + list.length + ' 个稿件…');
    try {
      var entries = [];
      var used = {};
      for (var i = 0; i < list.length; i++) {
        var a = list[i].attachment;
        var row = await YF.get(a.id);
        if (!row) continue;
        var base = safeName(a.name);
        var path = '稿件/' + safeName(list[i].record.artistName || list[i].record.artistId || '未命名画手') + '/' + base;
        if (used[path]) path = '稿件/' + i + '_' + base;
        used[path] = true;
        entries.push({ name: path, data: row.data });
      }
      if (!entries.length) { toast('文件已丢失，无法打包', 'error'); return; }
      var blob = await Z.create(entries);
      downloadBlob(blob, '约稿记录_稿件库_' + stamp() + '.zip');
      toast('已打包下载 ' + entries.length + ' 个稿件', 'ok');
    } catch (e) {
      console.error(e);
      toast('打包失败：' + (e && e.message ? e.message : '未知错误'), 'error');
    }
  }

  function askDeleteFile(fileId) {
    var found = findFile(fileId);
    if (!found) return;
    state.pendingDeleteId = null;
    dom.confirmTitle.textContent = '确认删除该稿件？';
    dom.confirmText.textContent = '「' + found.attachment.name + '」将从本机永久删除，所属约稿记录仍会保留。';
    dom.confirmMask.hidden = false;
    dom.confirmOk.dataset.mode = 'file';
    dom.confirmOk.dataset.fileId = fileId;
    dom.confirmOk.dataset.orderId = found.record.id;
  }

  async function deleteFile(fileId, orderId) {
    try {
      await YF.remove(fileId);
    } catch (e) { console.error(e); }
    Y.detachFile(orderId, fileId);
    invalidateThumb(fileId);
    closeConfirm();
    render();
    if (state.previewFileId === fileId) closePreview();
    toast('稿件已删除', 'ok');
  }

  function locateOrder(recordId) {
    var r = Y.getById(recordId);
    if (!r) { toast('所属订单已不存在', 'warn'); return; }

    closePreview();
    switchView('ledger');

    state.search = r.artistId || r.artistName || '';
    state.starOnly = false;
    state.progress = '';
    state.sort = 'date-desc';
    dom.searchInput.value = state.search;
    dom.searchClear.hidden = !state.search;
    dom.sortSelect.value = state.sort;
    syncChips();
    render();

    var card = dom.list.querySelector('.card[data-id="' + recordId + '"]');
    if (card) {
      if (typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      card.classList.add('flash');
      setTimeout(function () { card.classList.remove('flash'); }, 1400);
    }
  }

  /* ================= 稿件库：上传弹窗 ================= */

  function openUploadModal(orderId) {
    if (!YF.supported()) { toast('当前浏览器不支持本地稿件存储', 'error'); return; }
    if (!Y.all().length) { toast('请先新增一条约稿记录，再上传稿件', 'warn'); return; }

    refreshUploadOrderSelect();
    uploadStage.files.forEach(function (f) { URL.revokeObjectURL(f.url); });
    uploadStage.files = [];
    dom.uploadError.hidden = true;

    if (orderId) dom.uploadOrder.value = orderId;

    renderUploadFiles();
    dom.uploadMask.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeUploadModal() {
    dom.uploadMask.hidden = true;
    document.body.style.overflow = '';
    uploadStage.files.forEach(function (f) { URL.revokeObjectURL(f.url); });
    uploadStage.files = [];
  }

  function renderUploadFiles() {
    dom.uploadList.innerHTML = uploadStage.files.map(function (item) {
      return fileItemHtml({
        key: item.key, url: item.url, name: item.file.name,
        size: item.file.size, type: item.file.type, isNew: true
      });
    }).join('');
    hydrateThumbs(dom.uploadList);
  }

  async function submitUpload() {
    var orderId = dom.uploadOrder.value;
    if (!orderId) {
      dom.uploadError.textContent = '请选择要关联的约稿记录。';
      dom.uploadError.hidden = false;
      return;
    }
    if (!uploadStage.files.length) {
      dom.uploadError.textContent = '请先选择要上传的稿件文件。';
      dom.uploadError.hidden = false;
      return;
    }

    dom.uploadSubmit.disabled = true;
    try {
      var metas = [];
      for (var i = 0; i < uploadStage.files.length; i++) {
        metas.push(await YF.putBlob(orderId, uploadStage.files[i].file));
      }
      Y.attachFiles(orderId, metas);
      var n = metas.length;
      closeUploadModal();
      render();
      toast('已上传 ' + n + ' 个稿件', 'ok');
    } catch (e) {
      console.error(e);
      dom.uploadError.textContent = '上传失败：' + (e && e.message ? e.message : '未知错误');
      dom.uploadError.hidden = false;
    } finally {
      dom.uploadSubmit.disabled = false;
    }
  }

  /* ================= 导入 / 导出 ================= */

  async function doExport() {
    var payload = Y.exportPayload();
    var fileCount = Y.attachmentCount();
    if (!payload.count && !fileCount) { toast('暂无可备份的数据', 'warn'); return; }

    toast('正在打包完整备份…');
    try {
      var entries = [{ name: 'yuegao-backup.json', data: JSON.stringify(payload, null, 2) }];
      var flat = Y.allAttachments();
      var packed = 0;

      for (var i = 0; i < flat.length; i++) {
        var a = flat[i].attachment;
        var row = await YF.get(a.id);
        if (!row) continue;
        entries.push({ name: 'files/' + a.id + YF.extOf(a.name), data: row.data });
        packed++;
      }

      var blob = await Z.create(entries);
      downloadBlob(blob, '约稿记录_完整备份_' + stamp() + '.zip');
      toast('已导出完整备份：' + payload.count + ' 条记录、' + packed + ' 个稿件', 'ok');
    } catch (e) {
      console.error(e);
      toast('导出失败：' + (e && e.message ? e.message : '未知错误'), 'error');
    }
  }

  function doExportCsv() {
    if (!Y.all().length) { toast('暂无记录可导出', 'warn'); return; }
    downloadText('约稿记录_台账_' + stamp() + '.csv', '\uFEFF' + Y.toCsv(), 'text/csv;charset=utf-8');
    toast('已导出 CSV 台账', 'ok');
  }

  async function applyPayload(payload) {
    var records = Array.isArray(payload) ? payload : ((payload && payload.records) || []);
    var result = Y.importPayload(payload);

    // 还原记录中挂载的稿件文件（按附件 id 精确匹配）
    var restored = 0, missing = 0;
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec || !rec.id) continue;
      var list = Array.isArray(rec.attachments) ? rec.attachments : [];
      for (var j = 0; j < list.length; j++) {
        var att = list[j];
        if (!att || !att.id) continue;
        var entry = fileCache['files/' + att.id + YF.extOf(att.name)];
        if (!entry) { missing++; continue; }
        await YF.restore(rec.id, att, toArrayBuffer(entry.data));
        restored++;
      }
    }
    return { result: result, restored: restored, missing: missing };
  }

  var fileCache = {};

  async function doImport(file) {
    if (!file) return;
    var isZip = /\.zip$/i.test(file.name);

    try {
      if (isZip) {
        toast('正在解析备份包…');
        fileCache = {};
        var entries = await Z.read(file);
        var jsonEntry = null;
        entries.forEach(function (e) {
          fileCache[e.name] = e;
          if (!jsonEntry && /\.json$/i.test(e.name)) jsonEntry = e;
        });
        if (!jsonEntry) throw new Error('备份包中缺少数据文件');

        var text = new TextDecoder('utf-8').decode(jsonEntry.data);
        var payload = JSON.parse(text);
        var res = await applyPayload(payload);

        render();
        toast('导入完成：记录新增 ' + res.result.added + ' 条、更新 ' + res.result.updated +
          ' 条；稿件还原 ' + res.restored + ' 个' + (res.missing ? '，' + res.missing + ' 个缺失' : ''), 'ok');
      } else {
        var raw = await file.text();
        if (!YF.supported()) {
          var r0 = Y.importPayload(JSON.parse(raw));
          render();
          toast('导入完成（当前环境不支持还原稿件文件）：新增 ' + r0.added + ' 条', 'ok');
          return;
        }
        fileCache = {};
        var res2 = await applyPayload(JSON.parse(raw));
        render();
        toast('导入完成：新增 ' + res2.result.added + ' 条、更新 ' + res2.result.updated + ' 条', 'ok');
      }
    } catch (e) {
      console.error(e);
      toast('导入失败：' + (e && e.message ? e.message : '文件解析异常'), 'error');
    }
  }

  /* ================= 事件绑定 ================= */

  function bindDropzone(zone, input, listEl, target) {
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', function () { zone.classList.remove('dragover'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        acceptFiles(e.dataTransfer.files, target);
        if (target === 'stage') renderStageFiles(); else renderUploadFiles();
      }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files.length) {
        acceptFiles(input.files, target);
        if (target === 'stage') renderStageFiles(); else renderUploadFiles();
      }
      input.value = '';
    });
  }

  function bindEvents() {
    // 板块切换
    dom.viewNav.addEventListener('click', function (e) {
      var tab = e.target.closest('.view-tab');
      if (tab) switchView(tab.getAttribute('data-view'));
    });

    dom.btnAdd.addEventListener('click', function () { openModal(null); });

    // ------- 订单列表事件委托 -------
    dom.list.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-act]');
      if (!actionEl) return;
      var act = actionEl.getAttribute('data-act');

      if (act === 'empty-add') { openModal(null); return; }
      if (act === 'reset-filter') {
        state.search = ''; state.starOnly = false; state.progress = '';
        dom.searchInput.value = ''; dom.searchClear.hidden = true;
        syncChips();
        renderList();
        return;
      }

      var card = actionEl.closest('.card');
      if (!card) return;
      var id = card.getAttribute('data-id');

      if (act === 'preview') {
        openPreview(actionEl.getAttribute('data-file'));
        return;
      }

      if (act === 'upload') {
        state.quickUploadOrderId = id;
        dom.quickFileInput.click();
        return;
      }

      if (act === 'download-all') { downloadOrderFiles(id); return; }
      if (act === 'edit') { openModal(id); return; }
      if (act === 'delete') { askDelete(id); return; }

      if (act === 'star') {
        var nowStarred = Y.toggleStar(id);
        if (nowStarred === null) { toast('记录不存在', 'error'); return; }
        var card2 = dom.list.querySelector('.card[data-id="' + id + '"]');
        if (card2) {
          card2.classList.toggle('is-starred', nowStarred);
          var btn = card2.querySelector('.star-btn');
          btn.classList.toggle('active', nowStarred);
          btn.classList.add('pop');
          setTimeout(function () { btn.classList.remove('pop'); }, 460);
          btn.textContent = nowStarred ? '★' : '☆';
          btn.title = nowStarred ? '取消星标' : '点亮星标收藏';
          btn.setAttribute('aria-pressed', nowStarred ? 'true' : 'false');
          btn.setAttribute('aria-label', nowStarred ? '取消星标' : '点亮星标');
        }
        toast(nowStarred ? '已加入星标收藏 ⭐' : '已取消星标', nowStarred ? 'ok' : '');
        renderStats();
        renderFileStats();
        if (state.starOnly && !nowStarred) setTimeout(renderList, 240);
        return;
      }
    });

    // ------- 稿件库事件委托 -------
    dom.filesGrid.addEventListener('click', function (e) {
      var actionEl = e.target.closest('[data-act]');
      if (!actionEl) return;
      var act = actionEl.getAttribute('data-act');

      if (act === 'open-upload') { openUploadModal(null); return; }
      if (act === 'reset-file-filter') {
        state.fileSearch = ''; state.fileType = '';
        dom.fileSearchInput.value = '';
        dom.fileSearchClear.hidden = true;
        dom.fileTypeFilter.value = '';
        renderFilesGrid();
        return;
      }

      var card = actionEl.closest('.file-card');
      var fileId = actionEl.getAttribute('data-file') || (card && card.getAttribute('data-file'));
      if (!fileId) return;

      if (act === 'preview') { openPreview(fileId); return; }
      if (act === 'download-file') { downloadFile(fileId); return; }
      if (act === 'delete-file') { askDeleteFile(fileId); return; }
    });

    // ------- 台账筛选 -------
    dom.searchInput.addEventListener('input', function () {
      state.search = dom.searchInput.value;
      dom.searchClear.hidden = !state.search;
      renderList();
    });
    dom.searchClear.addEventListener('click', function () {
      state.search = '';
      dom.searchInput.value = '';
      dom.searchClear.hidden = true;
      renderList();
      dom.searchInput.focus();
    });

    dom.starFilter.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.starOnly = chip.getAttribute('data-filter') === 'starred';
      syncChips();
      renderList();
    });

    dom.progressFilter.addEventListener('change', function () {
      state.progress = dom.progressFilter.value;
      renderList();
    });

    dom.sortSelect.addEventListener('change', function () {
      state.sort = dom.sortSelect.value;
      renderList();
    });

    // ------- 稿件库筛选 -------
    dom.fileSearchInput.addEventListener('input', function () {
      state.fileSearch = dom.fileSearchInput.value;
      dom.fileSearchClear.hidden = !state.fileSearch;
      renderFilesGrid();
    });
    dom.fileSearchClear.addEventListener('click', function () {
      state.fileSearch = '';
      dom.fileSearchInput.value = '';
      dom.fileSearchClear.hidden = true;
      renderFilesGrid();
      dom.fileSearchInput.focus();
    });
    dom.fileTypeFilter.addEventListener('change', function () {
      state.fileType = dom.fileTypeFilter.value;
      renderFilesGrid();
    });
    dom.fileSortSelect.addEventListener('change', function () {
      state.fileSort = dom.fileSortSelect.value;
      renderFilesGrid();
    });

    dom.btnUploadPick.addEventListener('click', function () { openUploadModal(null); });
    dom.btnZipDownload.addEventListener('click', downloadFilteredFiles);

    // ------- 订单弹窗 -------
    dom.modalClose.addEventListener('click', closeModal);
    dom.modalCancel.addEventListener('click', closeModal);
    dom.modalSubmit.addEventListener('click', submitForm);
    dom.modalMask.addEventListener('mousedown', function (e) {
      if (e.target === dom.modalMask) closeModal();
    });

    dom.fPlatform.addEventListener('change', syncCustomVisibility);
    dom.fProgress.addEventListener('change', syncCustomVisibility);

    dom.fileList.addEventListener('click', function (e) {
      var dl = e.target.closest('[data-download]');
      if (dl) { downloadStageFile(dl.getAttribute('data-download')); return; }
      var btn = e.target.closest('[data-remove]');
      if (btn) handleStageRemove(btn.getAttribute('data-remove'));
    });

    dom.stageDownloadAll.addEventListener('click', downloadStageAll);

    bindDropzone(dom.dropzone, dom.fFiles, dom.fileList, 'stage');

    // 表单内回车快捷提交（文本域用 Ctrl / Cmd + Enter）
    dom.orderForm.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var tag = e.target.tagName;
      if (tag === 'TEXTAREA') {
        if (!(e.metaKey || e.ctrlKey)) return;
      } else if (tag !== 'INPUT' && tag !== 'SELECT') {
        return;
      }
      e.preventDefault();
      submitForm();
    });

    // ------- 稿件库上传弹窗 -------
    dom.uploadClose.addEventListener('click', closeUploadModal);
    dom.uploadCancel.addEventListener('click', closeUploadModal);
    dom.uploadSubmit.addEventListener('click', submitUpload);
    dom.uploadMask.addEventListener('mousedown', function (e) {
      if (e.target === dom.uploadMask) closeUploadModal();
    });
    dom.uploadList.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove]');
      if (!btn) return;
      var key = btn.getAttribute('data-remove');
      uploadStage.files = uploadStage.files.filter(function (item) {
        if (item.key !== key) return true;
        URL.revokeObjectURL(item.url);
        return false;
      });
      renderUploadFiles();
    });

    bindDropzone(dom.uploadDrop, dom.uploadFiles, dom.uploadList, 'upload');

    // ------- 预览弹窗 -------
    dom.previewClose.addEventListener('click', closePreview);
    dom.previewMask.addEventListener('mousedown', function (e) {
      if (e.target === dom.previewMask) closePreview();
    });
    dom.previewDownload.addEventListener('click', function () {
      if (state.previewFileId) downloadFile(state.previewFileId);
    });
    dom.previewLocate.addEventListener('click', function () {
      var found = state.previewFileId ? findFile(state.previewFileId) : null;
      if (found) locateOrder(found.record.id);
    });

    // ------- 确认弹窗 -------
    dom.confirmCancel.addEventListener('click', function () {
      dom.confirmOk.dataset.mode = '';
      closeConfirm();
    });
    dom.confirmOk.addEventListener('click', function () {
      var mode = dom.confirmOk.dataset.mode;
      dom.confirmOk.dataset.mode = '';
      if (mode === 'file') {
        deleteFile(dom.confirmOk.dataset.fileId, dom.confirmOk.dataset.orderId);
      } else {
        doDelete();
      }
    });
    dom.confirmMask.addEventListener('mousedown', function (e) {
      if (e.target === dom.confirmMask) { dom.confirmOk.dataset.mode = ''; closeConfirm(); }
    });

    // ------- 快捷上传 -------
    dom.quickFileInput.addEventListener('change', function () {
      var orderId = state.quickUploadOrderId;
      state.quickUploadOrderId = null;
      if (orderId && dom.quickFileInput.files && dom.quickFileInput.files.length) {
        quickUpload(orderId, dom.quickFileInput.files);
      }
      dom.quickFileInput.value = '';
    });

    // ------- Esc 关闭 -------
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!dom.confirmMask.hidden) { dom.confirmOk.dataset.mode = ''; closeConfirm(); return; }
      if (!dom.previewMask.hidden) { closePreview(); return; }
      if (!dom.uploadMask.hidden) { closeUploadModal(); return; }
      if (!dom.modalMask.hidden) { closeModal(); }
    });

    // ------- 导入导出 -------
    dom.btnExport.addEventListener('click', doExport);
    dom.btnExportCsv.addEventListener('click', doExportCsv);
    dom.btnImport.addEventListener('click', function () { dom.fileInput.click(); });
    dom.fileInput.addEventListener('change', async function () {
      var files = Array.prototype.slice.call(dom.fileInput.files || []);
      dom.fileInput.value = '';
      for (var i = 0; i < files.length; i++) {
        await doImport(files[i]);
      }
    });

    // 防止拖拽文件到页面其它地方时浏览器直接打开文件
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });

    // 多标签页同步
    window.addEventListener('storage', function (e) {
      if (e.key !== Y.RECORDS_KEY) return;
      Y.load();
      clearThumbCache();
      render();
    });
  }

  function syncChips() {
    Array.prototype.forEach.call(dom.starFilter.querySelectorAll('.chip'), function (chip) {
      var isStar = chip.getAttribute('data-filter') === 'starred';
      chip.classList.toggle('active', isStar === state.starOnly);
    });
  }

  /* ================= 启动 ================= */

  function bootFiles() {
    if (!YF || !YF.supported()) {
      console.warn('[约稿记录] 当前环境不支持 IndexedDB，稿件文件功能不可用');
      return Promise.resolve();
    }
    // 校正记录与实际文件的一致性，并清理孤儿文件
    return YF.reconcile(Y.all()).then(function (res) {
      res.changed.forEach(function (c) {
        var rec = Y.getById(c.id);
        if (rec) Y.update(c.id, { attachments: c.attachments });
      });
      if (res.changed.length || res.orphans) {
        console.info('[约稿记录] 稿件数据校正：修正 ' + res.changed.length + ' 条记录，清理 ' + res.orphans + ' 个孤儿文件');
      }
    }).catch(function (e) {
      console.error('[约稿记录] 稿件库校正失败：', e);
    });
  }

  function init() {
    cacheDom();
    Y.load();
    fillSelects();
    bindEvents();
    syncChips();
    dom.sortSelect.value = state.sort;
    dom.fileSortSelect.value = state.fileSort;
    render();
    bootFiles().then(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
