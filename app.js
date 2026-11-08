/* RIFT — نقل ملفات مباشر بين جهازين عبر WebRTC (PeerJS)
 *
 * البروتوكول (القناة الأساسية = JSON نصي):
 *   hello  {name, kind, perm}           تعريف الجهاز
 *   meta   {id, tid, key, name, size, mime, chunk}   بداية ملف
 *   accept {id, offset}                 المستلم جاهز — يبدأ المرسل من offset (للإكمال بعد الانقطاع)
 *   done   {id}                         المستلم حفظ الملف كامل
 *   cancel {id}                         إلغاء من أي طرف
 *   text   {text}                       رسالة نصية
 *   bye    {}                           إغلاق متعمد (بدون إعادة اتصال)
 * البيانات الثنائية تمشي على قنوات متوازية: [u32 tid][u32 chunkIndex][payload]
 */
(() => {
  'use strict';

  // ================= إعدادات =================
  const PREFIX = 'rift-portal-';
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const LANES = 4;
  const LANE_BASE_ID = 100;
  const HIGH_WATER = 2 * 1024 * 1024;   // لكل قناة
  const LOW_WATER = 512 * 1024;
  const BLOCK_CHUNKS = 16;              // نقرأ من الملف 16 قطعة مرة وحدة
  const CONNECT_TIMEOUT = 15000;
  const AUTO_TIMEOUT = 9000;
  const POLL_EVERY = 3500;
  const OFFLINE_WINDOW = 45000;
  const MAX_TRUSTED = 8;
  const ZIP_LIMIT = 4 * 1024 * 1024 * 1024 - 1;
  const STR = window.RIFT_STRINGS || { ar: {}, en: {} };

  const params = new URLSearchParams(location.search);
  // ns: مساحة تخزين منفصلة (للتجربة بجهازين وهميين في نفس المتصفح)
  const NS = (params.get('ns') || '').replace(/\W/g, '').slice(0, 8);
  const K = (k) => (NS ? k + '@' + NS : k);

  const ICONS = {
    phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    tablet: '<svg viewBox="0 0 24 24"><rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
    desktop: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  };

  // ================= تخزين =================
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ممتلئ أو ممنوع */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* تجاهل */ } },
    json(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
    setJson(k, v) { this.set(k, JSON.stringify(v)); },
  };
  const sess = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* تجاهل */ } },
  };
  const idb = {
    db: null,
    open() {
      if (!this.db) {
        this.db = new Promise((res, rej) => {
          const r = indexedDB.open('rift', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      }
      return this.db;
    },
    async op(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', mode);
        const q = fn(tx.objectStore('kv'));
        tx.oncomplete = () => res(q && q.result);
        tx.onerror = () => rej(tx.error);
      });
    },
    async get(k) { try { return await this.op('readonly', (s) => s.get(k)); } catch { return undefined; } },
    async set(k, v) { try { await this.op('readwrite', (s) => s.put(v, k)); } catch { /* تجاهل */ } },
    async del(k) { try { await this.op('readwrite', (s) => s.delete(k)); } catch { /* تجاهل */ } },
  };

  const settings = Object.assign(
    { sound: true, notif: false, img: false, vid: false, lanes: true },
    store.json('rift-settings', {})
  );
  const saveSettings = () => store.setJson('rift-settings', settings);
  let lang = document.documentElement.lang === 'en' ? 'en' : 'ar';
  const isRTL = () => lang === 'ar';

  // ================= ترجمة =================
  function t(key, vars) {
    let s = (STR[lang] && STR[lang][key]) != null ? STR[lang][key] : (STR.ar[key] != null ? STR.ar[key] : key);
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
    return s;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ================= أدوات =================
  const $ = (id) => document.getElementById(id);
  const newCode = () => {
    const a = new Uint32Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, (n) => ALPHA[n % ALPHA.length]).join('');
  };
  const cleanCode = (v) => {
    const m = String(v).match(/[?&]c=([A-Za-z0-9]+)/);
    return (m ? m[1] : String(v)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  // ⁦…⁩ يعزل الرقم والوحدة كنص LTR داخل الواجهة العربية
  function fmtSize(b) {
    b = Math.max(0, b || 0);
    if (b < 1024) return '⁦' + b + ' B⁩';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
    return '⁦' + b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i] + '⁩';
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '';
    s = Math.ceil(s);
    return s < 60 ? s + t('u.s') : Math.floor(s / 60) + t('u.m') + ' ' + (s % 60) + t('u.s');
  }
  function relTime(ts) {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return t('time.now');
    if (d < 3600) return t('time.min', { n: Math.floor(d / 60) });
    if (d < 86400) return t('time.hour', { n: Math.floor(d / 3600) });
    return t('time.day', { n: Math.floor(d / 86400) });
  }
  // cyrb53 — هاش سريع لمفتاح الملف (عشان نعرف نفس الملف لما نكمل)
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const extOf = (name) => {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
    return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
  };
  const mediaType = (mime, name) => {
    if (/^image\//.test(mime) || /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(name)) return 'image';
    if (/^video\//.test(mime) || /\.(mp4|m4v|mov|webm|mkv)$/i.test(name)) return 'video';
    if (/^audio\//.test(mime) || /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(name)) return 'audio';
    return '';
  };
  const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'file';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function deviceInfo() {
    const ua = navigator.userAgent;
    const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    if (/iPhone|iPod/.test(ua)) return { name: 'iPhone', kind: 'phone' };
    if (/iPad/.test(ua) || touchMac) return { name: 'iPad', kind: 'tablet' };
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? { name: 'Android', kind: 'phone' } : { name: 'Android Tablet', kind: 'tablet' };
    if (/Windows/.test(ua)) return { name: 'Windows PC', kind: 'desktop' };
    if (/Macintosh/.test(ua)) return { name: 'Mac', kind: 'desktop' };
    if (/CrOS/.test(ua)) return { name: 'Chromebook', kind: 'desktop' };
    if (/Linux/.test(ua)) return { name: 'Linux PC', kind: 'desktop' };
    return { name: 'Device', kind: 'desktop' };
  }
  const me = deviceInfo();

  // ================= عناصر الواجهة =================
  const ui = {
    intro: $('intro'), introBurst: $('introBurst'),
    status: $('status'), langBtn: $('langBtn'), settingsBtn: $('settingsBtn'),
    pairView: $('pairView'), transferView: $('transferView'),
    trustedBox: $('trustedBox'), trustedList: $('trustedList'),
    qr: $('qr'), myCode: $('myCode'), copyLink: $('copyLink'),
    joinForm: $('joinForm'), joinInput: $('joinInput'),
    meIcon: $('meIcon'), meName: $('meName'), peerIcon: $('peerIcon'), peerName: $('peerName'),
    beam: $('beam'), disconnect: $('disconnect'),
    fileInput: $('fileInput'), fileInput2: $('fileInput2'), camInput: $('camInput'),
    galleryInput: $('galleryInput'), folderInput: $('folderInput'), folderBtn: $('folderBtn'),
    optImg: $('optImg'), optVid: $('optVid'), optLanes: $('optLanes'), vidNote: $('vidNote'),
    textForm: $('textForm'), textInput: $('textInput'), hint: $('hint'),
    tabLog: $('tabLog'), tabGal: $('tabGal'), galCount: $('galCount'),
    logPane: $('logPane'), galPane: $('galPane'), galGrid: $('galGrid'), galEmpty: $('galEmpty'),
    items: $('items'), empty: $('empty'), stats: $('stats'),
    downloadAll: $('downloadAll'), clearLog: $('clearLog'),
    dropOverlay: $('dropOverlay'), toasts: $('toasts'),
    sheet: $('settings'), sheetBackdrop: $('sheetBackdrop'), settingsClose: $('settingsClose'),
    soundToggle: $('soundToggle'), notifToggle: $('notifToggle'),
    saveInfo: $('saveInfo'), pickFolder: $('pickFolder'), regrantFolder: $('regrantFolder'), unpickFolder: $('unpickFolder'),
    setDevices: $('setDevices'),
    lightbox: $('lightbox'), lbStage: $('lbStage'), lbCount: $('lbCount'), lbName: $('lbName'),
    lbDownload: $('lbDownload'), lbClose: $('lbClose'), lbPrev: $('lbPrev'), lbNext: $('lbNext'),
  };

  // ================= الحالة =================
  let peer = null;
  let myCode = '';
  let persistent = true;     // هل الرمز ثابت لهذا الجهاز (يصلح للأجهزة الموثوقة)
  let conn = null;           // اتصال واحد: قيد المحاولة أو مفتوح
  let dc = null;             // القناة الأساسية
  let lanes = [];            // قنوات البيانات المتوازية
  let chunkPayload = 15 * 1024;
  let peerInfo = null;
  let lastPeer = null;
  let manualClose = false;
  let connectTimer = null;
  let offlineTimer = null;
  let pollTimer = null;
  let pollIdx = 0;
  let pollSince = Date.now();
  let pollTicks = 0;
  let wakeLock = null;
  let unread = 0;
  let actx = null;
  let swReg = null;
  let statusState = { key: 'st.preparing', kind: 'wait', vars: null };

  const sendQueue = [];
  let sending = false;
  let current = null;
  let tidSeq = (Math.random() * 1e6) | 0;
  let prepChain = Promise.resolve();
  const waits = new Map();

  let rx = null;
  let rxChain = Promise.resolve();
  const memPartials = new Map();
  let partials = store.json(K('rift-partials'), {});
  const inItemsByKey = new Map();

  const allItems = [];
  const objectUrls = [];
  const received = [];
  const gallery = [];
  const opfsDone = [];
  const stats = { upN: 0, upB: 0, downN: 0, downB: 0 };

  let trusted = store.json(K('rift-trusted'), []).filter((d) => d && /^[A-Z0-9]{6}$/.test(d.id));
  const suppressed = new Set();
  const devState = new Map();

  let saveDir = null;
  let saveDirOk = false;
  let opfsState = null;      // null = لم نفحص، true/false

  const objUrl = (blob) => { const u = URL.createObjectURL(blob); objectUrls.push(u); return u; };
  const isOpen = () => !!(dc && dc.readyState === 'open');
  const linkUp = () => !!(conn && conn._rift && conn._rift.up);
  const peerIdOf = (c) => String((c && c.peer) || '').slice(PREFIX.length);
  const shareLink = () => location.origin + location.pathname + '?c=' + myCode;

  // ================= الدخولية =================
  const intro = {
    start: performance.now(),
    min: sess.get('rift-intro') ? 1300 : 2400,
    done: false,
  };
  if (sess.get('rift-intro')) ui.intro && ui.intro.classList.add('quick');
  sess.set('rift-intro', '1');
  (function buildBurst() {
    if (!ui.introBurst) return;
    const colors = ['#00f0ff', '#7b5cff', '#ff2bd6', '#ffffff'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 22; i++) {
      const p = document.createElement('i');
      const ang = (i / 22) * Math.PI * 2 + Math.random() * 0.3;
      const dist = 18 + Math.random() * 32;
      p.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'vmin');
      p.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'vmin');
      p.style.setProperty('--clr', colors[i % colors.length]);
      if (!ui.intro.classList.contains('quick')) p.style.setProperty('--dl', (0.55 + Math.random() * 0.15).toFixed(2) + 's');
      frag.append(p);
    }
    ui.introBurst.append(frag);
  })();
  function endIntro() {
    if (intro.done) return;
    intro.done = true;
    if (ui.intro) ui.intro.classList.add('out');
    document.body.classList.add('entered');
    document.body.classList.remove('intro-on');
    setTimeout(() => ui.intro && ui.intro.remove(), 900);
  }
  function introReady() {
    const wait = Math.max(0, intro.min - (performance.now() - intro.start));
    setTimeout(endIntro, wait);
  }
  setTimeout(endIntro, 4000);
  if (ui.intro) ui.intro.addEventListener('click', endIntro);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) endIntro();

  // ================= حالة وعرض =================
  function setStatus(key, kind = 'wait', vars = null) {
    statusState = { key, kind, vars };
    renderStatus();
  }
  function renderStatus() {
    ui.status.className = 'status status-' + statusState.kind;
    ui.status.innerHTML = '<span class="status-text"></span>';
    ui.status.firstChild.textContent = t(statusState.key, statusState.vars);
    ui.status.title = ui.status.textContent;
  }
  function idleStatus() {
    if (document.body.classList.contains('offline')) return;
    if (linkUp()) return;
    setStatus(trusted.some((d) => !suppressed.has(d.id)) ? 'st.searching' : 'st.waiting');
  }
  const setBusy = () => document.body.classList.toggle('busy', !!(current && current.state === 'active') || !!rx);
  function showView(connected) {
    ui.pairView.classList.toggle('hidden', connected);
    ui.transferView.classList.toggle('hidden', !connected);
  }
  function setNode(iconEl, nameEl, info, fallbackKey) {
    const kind = info && ICONS[info.kind] ? info.kind : 'desktop';
    iconEl.innerHTML = ICONS[kind];
    nameEl.textContent = (info && info.name) || t(fallbackKey);
  }
  function renderNodes() {
    setNode(ui.meIcon, ui.meName, me, 'node.me');
    setNode(ui.peerIcon, ui.peerName, peerInfo, 'node.peer');
  }

  // ================= تنبيهات =================
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    ui.toasts.append(el);
    while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3000);
  }
  function chime() {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime;
      [660, 990, 1320].forEach((f, i) => {
        const o = actx.createOscillator();
        const g = actx.createGain();
        const s = t0 + i * 0.08;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.09, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.4);
        o.connect(g).connect(actx.destination);
        o.start(s);
        o.stop(s + 0.45);
      });
    } catch { /* الصوت غير متاح */ }
  }
  async function sysNotify(body) {
    if (!settings.notif || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body, icon: 'favicon.svg', badge: 'favicon.svg', tag: 'rift', renotify: true, lang };
    try {
      const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
      if (reg && reg.showNotification) await reg.showNotification(t('notif.title'), opts);
      else new Notification(t('notif.title'), opts);
    } catch { /* غير مدعوم */ }
  }
  function notifyArrival(msg) {
    toast(msg, 'ok');
    chime();
    try { if (navigator.vibrate) navigator.vibrate([25, 40, 25]); } catch { /* تجاهل */ }
    sysNotify(msg);
    if (document.hidden) {
      unread++;
      document.title = '(' + unread + ') ' + t('doc.title');
    }
  }

  // ================= الأجهزة الموثوقة =================
  const saveTrusted = () => store.setJson(K('rift-trusted'), trusted);
  const isTrusted = (id) => trusted.some((d) => d.id === id);
  function upsertTrusted(id, name, kind) {
    const ex = trusted.find((d) => d.id === id);
    if (ex) Object.assign(ex, { name, kind, last: Date.now() });
    else trusted.unshift({ id, name, kind, last: Date.now() });
    trusted.sort((a, b) => b.last - a.last);
    trusted = trusted.slice(0, MAX_TRUSTED);
    saveTrusted();
    renderTrusted();
    return !ex;
  }
  function forgetTrusted(id) {
    trusted = trusted.filter((d) => d.id !== id);
    saveTrusted();
    suppressed.add(id);
    if (conn && !conn.open && peerIdOf(conn) === id) dropPending();
    renderTrusted();
    idleStatus();
  }
  function setDevState(id, st) {
    if (!id) return;
    if (st) devState.set(id, st); else devState.delete(id);
    renderTrusted();
  }
  function renderTrusted() {
    for (const [list, compact] of [[ui.trustedList, false], [ui.setDevices, true]]) {
      list.replaceChildren();
      if (!trusted.length) {
        if (compact) {
          const li = document.createElement('li');
          li.className = 'none';
          li.textContent = t('trusted.none');
          list.append(li);
        }
        continue;
      }
      for (const d of trusted) {
        const st = devState.get(d.id) || '';
        const li = document.createElement('li');
        li.className = 'dev ' + st;
        const ic = document.createElement('span');
        ic.className = 'dev-ic';
        ic.innerHTML = ICONS[d.kind] || ICONS.desktop;
        const main = document.createElement('div');
        main.className = 'dev-main';
        const nm = document.createElement('div');
        nm.className = 'dev-name';
        nm.textContent = d.name || t('node.device');
        const meta = document.createElement('div');
        meta.className = 'dev-meta';
        const code = document.createElement('code');
        code.textContent = d.id;
        const seen = document.createElement('span');
        seen.textContent = t('trusted.seen', { t: relTime(d.last) });
        meta.append(code, seen);
        main.append(nm, meta);
        li.append(ic, main);
        if (!compact) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn';
          b.textContent = t('trusted.connect');
          b.onclick = () => connectTo(d.id);
          li.append(b);
        }
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'x-btn';
        x.textContent = '×';
        x.title = t('trusted.forget');
        x.setAttribute('aria-label', t('trusted.forget') + ' ' + (d.name || d.id));
        x.onclick = () => forgetTrusted(d.id);
        li.append(x);
        list.append(li);
      }
    }
    ui.trustedBox.classList.toggle('hidden', !trusted.length);
  }

  // ================= PeerJS والاتصال =================
  function startPeer(code, attempt = 0, isPersistent = true) {
    myCode = code;
    persistent = isPersistent;
    peer = new Peer(PREFIX + code, { debug: 1 });

    peer.on('open', () => {
      if (isPersistent) store.set(K('rift-id'), code);
      ui.myCode.replaceChildren(...[...code].map((ch) => Object.assign(document.createElement('span'), { textContent: ch })));
      renderQR();
      introReady();
      const target = cleanCode(params.get('c') || '');
      if (target && target !== myCode && !conn) connectTo(target);
      else idleStatus();
      startPoller();
      setTimeout(pollTick, 400);
    });

    peer.on('connection', onIncoming);

    peer.on('disconnected', () => {
      // فقدنا سيرفر الربط فقط — الاتصال المباشر يبقى شغال
      if (!peer.destroyed) setTimeout(() => peer && !peer.destroyed && peer.disconnected && peer.reconnect(), 1500);
    });

    peer.on('error', (err) => {
      console.warn('peer error', err.type, err.message);
      switch (err.type) {
        case 'unavailable-id':
          // بعد التحديث يظل الرمز محجوز ثواني — نحاول نسترجعه، وإلا رمز مؤقت (تبويب ثاني مثلاً)
          peer.destroy();
          if (isPersistent && attempt < 2) setTimeout(() => startPeer(code, attempt + 1, true), 1600);
          else startPeer(newCode(), 0, false);
          break;
        case 'peer-unavailable': {
          const id = (String(err.message).match(/rift-portal-([A-Z0-9]{6})/) || [])[1];
          if (conn && !conn.open && (!id || peerIdOf(conn) === id)) {
            const auto = conn._rift && conn._rift.auto;
            const pid = peerIdOf(conn);
            dropPending();
            setDevState(pid, '');
            if (!auto) setStatus('st.peerOffline', 'err');
          }
          break;
        }
        case 'browser-incompatible':
          introReady();
          setStatus('st.noWebrtc', 'err');
          break;
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed':
          introReady();
          if (!conn) setStatus('st.network', 'err');
          break;
        default:
          setStatus('st.error', 'err', { x: err.type });
      }
    });
  }

  function connectTo(code, { auto = false } = {}) {
    if (!peer || !peer.open) { if (!auto) setStatus('st.wait', 'err'); return false; }
    if (code === myCode) { if (!auto) setStatus('st.self', 'err'); return false; }
    if (!/^[A-Z0-9]{6}$/.test(code)) { if (!auto) setStatus('st.codeLen', 'err'); return false; }
    if (conn && conn._rift && conn._rift.up) return false;
    if (conn) dropPending();
    if (!auto) {
      suppressed.delete(code);
      manualClose = false;
      setStatus('st.connecting');
    }
    const fresh = auto && performance.now() < 20000;
    const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw', metadata: { auto, fresh, v: 3 } });
    c._rift = { auto, outgoing: true };
    attach(c);
    setDevState(code, 'trying');
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (conn === c && !c.open) {
        dropPending();
        setDevState(code, '');
        if (!auto) setStatus('st.fail', 'err');
      }
    }, auto ? AUTO_TIMEOUT : CONNECT_TIMEOUT);
    return true;
  }

  function dropPending() {
    const c = conn;
    conn = null;
    clearTimeout(connectTimer);
    if (c) { try { c.close(); } catch { /* تجاهل */ } }
  }

  function rejectConn(c, reason) {
    c.on('open', () => {
      try { c.dataChannel.send(JSON.stringify({ t: 'reject', r: reason })); } catch { /* تجاهل */ }
      setTimeout(() => { try { c.close(); } catch { /* تجاهل */ } }, 400);
    });
  }

  function onIncoming(c) {
    const pid = peerIdOf(c);
    const meta = c.metadata || {};
    if (meta.auto) {
      // "fresh" = الطرف الثاني فتح الموقع للتو — نقبله حتى لو سكّرنا البوابة قبل
      if (suppressed.has(pid)) {
        if (meta.fresh) suppressed.delete(pid);
        else return rejectConn(c, 'suppressed');
      }
      if (!isTrusted(pid) && pid !== lastPeer) return rejectConn(c, 'untrusted');
    }
    if (conn && conn._rift && conn._rift.up) return rejectConn(c, 'busy');
    if (conn) {
      // محاولتين بنفس الوقت: يفوز اتصال صاحب الرمز الأصغر
      if (peerIdOf(conn) === pid && myCode < pid) return rejectConn(c, 'dup');
      dropPending();
    }
    if (!meta.auto) { suppressed.delete(pid); manualClose = false; }
    c._rift = { auto: !!meta.auto, outgoing: false };
    attach(c);
  }

  function attach(c) {
    conn = c;
    c.on('open', () => onOpen(c));
    c.on('data', (d) => onControl(c, d));
    c.on('close', () => onClose(c));
    c.on('error', (e) => console.warn('conn error', e && e.type));
  }

  function setupLanes(c) {
    lanes = [];
    const pc = c.peerConnection;
    if (!pc || !pc.createDataChannel) return;
    for (let i = 0; i < LANES; i++) {
      try {
        const ch = pc.createDataChannel('rift-lane-' + i, { negotiated: true, id: LANE_BASE_ID + i, ordered: true });
        ch.binaryType = 'arraybuffer';
        ch.bufferedAmountLowThreshold = LOW_WATER;
        ch.onmessage = (e) => onChunk(e.data);
        lanes.push(ch);
      } catch (e) {
        console.warn('lane', e);
        break;
      }
    }
  }

  // القناة انفتحت — نرسل hello ونستنى hello الطرف الثاني قبل ما نعتبر الاتصال قائم
  function onOpen(c) {
    if (c !== conn) { try { c.close(); } catch { /* تجاهل */ } return; }
    clearTimeout(connectTimer);
    dc = c.dataChannel;
    dc.binaryType = 'arraybuffer';
    const max = c.peerConnection && c.peerConnection.sctp && c.peerConnection.sctp.maxMessageSize;
    const cap = max ? Math.min(64 * 1024, max) : 16 * 1024;
    chunkPayload = Math.max(4096, Math.floor((cap - 8) / 1024) * 1024);
    setupLanes(c);
    lastRx = Date.now();
    dc.send(JSON.stringify({ t: 'hello', v: 3, name: me.name, kind: me.kind, perm: persistent }));
    connectTimer = setTimeout(() => {
      if (conn === c && !(c._rift && c._rift.up)) dropPending();
    }, 8000);
  }

  function establish(c, m) {
    clearTimeout(connectTimer);
    clearTimeout(offlineTimer);
    c._rift = Object.assign(c._rift || {}, { up: true });
    const wasOffline = document.body.classList.contains('offline');
    document.body.classList.remove('offline');
    const pid = peerIdOf(c);
    lastPeer = pid;
    suppressed.delete(pid);
    peerInfo = {
      name: String(m.name || '').slice(0, 24) || t('node.device'),
      kind: ICONS[m.kind] ? m.kind : 'desktop',
    };
    renderNodes();
    setDevState(pid, 'online');
    if (m.perm) {
      const isNew = upsertTrusted(pid, peerInfo.name, peerInfo.kind);
      if (isNew) toast(t('toast.trusted', { n: peerInfo.name }), 'ok');
    }
    setStatus('st.connected', 'ok');
    showView(true);
    if (wasOffline) toast(t('toast.back'), 'ok');
    requestWakeLock();
    startHeartbeat(c);
    pump();
  }

  // نبضة كل 4 ثواني: إذا الطرف الثاني سكت 15 ثانية نعتبر الاتصال مات ونعيد
  let hbTimer = null;
  let lastRx = 0;
  function startHeartbeat(c) {
    clearInterval(hbTimer);
    lastRx = Date.now();
    hbTimer = setInterval(() => {
      if (conn !== c) { clearInterval(hbTimer); return; }
      try { if (isOpen()) dc.send('{"t":"ping"}'); } catch { /* تجاهل */ }
      if (Date.now() - lastRx > 15000) {
        console.warn('heartbeat timeout');
        clearInterval(hbTimer);
        try { c.close(); } catch { /* تجاهل */ }
        if (conn === c) onClose(c);
      }
    }, 4000);
  }

  function onClose(c) {
    if (c !== conn) return;
    const wasUp = !!(c._rift && c._rift.up);
    conn = null;
    dc = null;
    lanes = [];
    clearInterval(hbTimer);
    const pid = peerIdOf(c);
    setDevState(pid, '');
    if (!wasUp) return; // محاولة ما نجحت
    rejectAllWaits(new Error('closed'));
    pauseIncoming();
    setBusy();
    releaseWakeLock();

    if (manualClose) {
      manualClose = false;
      suppressed.add(pid);
      document.body.classList.remove('offline');
      showView(false);
      idleStatus();
      toast(t('toast.closed'));
      try { if (location.search && !NS) history.replaceState(null, '', location.pathname); } catch { /* تجاهل */ }
      return;
    }
    // انقطاع مفاجئ: نبقى في شاشة النقل ونحاول نرجع
    document.body.classList.add('offline');
    setStatus('st.reconnecting', 'wait');
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(giveUp, OFFLINE_WINDOW);
    pollSince = Date.now();
    setTimeout(pollTick, 700);
  }

  function giveUp() {
    if (linkUp()) return;
    document.body.classList.remove('offline');
    showView(false);
    setStatus('st.lost', 'err');
    setTimeout(idleStatus, 4000);
  }

  function closePortal() {
    if (!conn) return;
    manualClose = true;
    try { if (isOpen()) dc.send(JSON.stringify({ t: 'bye' })); } catch { /* تجاهل */ }
    const c = conn;
    setTimeout(() => { try { c.close(); } catch { /* تجاهل */ } }, 200);
  }

  // اتصال تلقائي بالأجهزة الموثوقة (وبآخر جهاز إذا انقطع)
  function startPoller() {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollTick, POLL_EVERY);
  }
  function pollTick() {
    if (!peer || !peer.open || peer.disconnected || document.hidden) return;
    if (conn) return;
    pollTicks++;
    const offline = document.body.classList.contains('offline');
    // بعد دقيقتين نخفف المحاولات
    if (!offline && Date.now() - pollSince > 120000 && pollTicks % 3) return;
    let cands = trusted.map((d) => d.id);
    if (offline && lastPeer) cands = [lastPeer, ...cands.filter((x) => x !== lastPeer)];
    cands = cands.filter((id) => id !== myCode && !suppressed.has(id));
    if (!cands.length) return;
    let id;
    if (offline && cands[0] === lastPeer && pollIdx % 2 === 0) id = lastPeer;
    else id = cands[pollIdx % cands.length];
    pollIdx++;
    connectTo(id, { auto: true });
  }

  // ================= رسائل التحكم =================
  function onControl(c, d) {
    if (c !== conn) return;
    lastRx = Date.now();
    if (typeof d !== 'string') { onChunk(d); return; }
    let m;
    try { m = JSON.parse(d); } catch { return; }
    switch (m.t) {
      case 'ping':
        break;
      case 'hello':
        if (!(c._rift && c._rift.up)) establish(c, m);
        break;
      case 'reject': {
        // الطرف الثاني رفض (مشغول أو أغلق البوابة قبل شوي)
        const pid = peerIdOf(c);
        const auto = c._rift && c._rift.auto;
        if (m.r === 'suppressed' || m.r === 'untrusted') suppressed.add(pid);
        dropPending();
        setDevState(pid, '');
        if (!auto) setStatus(m.r === 'busy' ? 'st.busy' : 'st.fail', 'err');
        else idleStatus();
        break;
      }
      case 'bye':
        manualClose = true;
        break;
      case 'meta':
        rxChain = rxChain.then(() => handleMeta(m)).catch((e) => console.error(e));
        break;
      case 'accept':
        resolveWait('accept:' + m.id, Math.max(0, Number(m.offset) || 0));
        break;
      case 'done':
        resolveWait('done:' + m.id, true);
        break;
      case 'cancel':
        onRemoteCancel(String(m.id));
        break;
      case 'text':
        if (typeof m.text === 'string') {
          addTextItem('in', m.text.slice(0, 100000));
          notifyArrival(t('toast.text'));
        }
        break;
    }
  }

  function waitFor(key, timeout = 0) {
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { waits.delete(key); reject(new Error('timeout')); }, timeout) : null;
      waits.set(key, {
        resolve: (v) => { clearTimeout(timer); waits.delete(key); resolve(v); },
        reject: (e) => { clearTimeout(timer); waits.delete(key); reject(e); },
      });
    });
  }
  const resolveWait = (key, v) => { const w = waits.get(key); if (w) w.resolve(v); };
  const rejectWait = (key, e) => { const w = waits.get(key); if (w) w.reject(e); };
  const rejectAllWaits = (e) => { for (const w of [...waits.values()]) w.reject(e); };

  // ================= الإرسال =================
  function makeJob(kind, src, name, size, mime) {
    const job = {
      id: uid(), kind, src, name, file: null, key: '', state: 'prep',
      cancelled: false, reasonKey: '', paused: false, prog: 0, prepKind: '',
    };
    job.item = createFileItem('out', { name, size, mime, onCancel: () => cancelJob(job, 'it.cancelled') });
    job.item.model.state = 'prep';
    job.item.update();
    sendQueue.push(job);
    prepChain = prepChain.then(() => prepare(job)).catch((e) => console.error(e));
    return job;
  }

  function queueFiles(files) {
    files = Array.from(files || []).filter(Boolean);
    if (!files.length) return;
    for (const f of files) makeJob('file', f, f.name, f.size, f.type);
    if (!isOpen()) toast(t('toast.queued'));
  }

  function queueZip(folderName, entries) {
    if (!entries.length) return;
    const total = entries.reduce((a, e) => a + e.file.size, 0);
    const job = makeJob('zip', { entries, total }, safeName(folderName) + '.zip', total, 'application/zip');
    job.item.model.filesCount = entries.length;
    job.item.update();
    if (!isOpen()) toast(t('toast.queued'));
  }

  function queueFolderInput(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const entries = files.map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    const top = (entries[0].path.split('/')[0]) || 'folder';
    queueZip(top, entries);
  }

  async function prepare(job) {
    if (job.cancelled) return;
    const m = job.item.model;
    try {
      if (job.kind === 'zip') {
        if (job.src.total > ZIP_LIMIT) throw Object.assign(new Error('zipBig'), { reasonKey: 'it.zipBig' });
        job.prepKind = 'zip';
        m.prepKind = 'zip';
        const blob = await buildZip(job);
        job.file = new File([blob], job.name, { type: 'application/zip', lastModified: Date.now() });
        job.key = 'z' + hash(job.id);
      } else {
        const f = job.src;
        let out = null;
        let mode = '';
        const mt = mediaType(f.type, f.name);
        if (settings.img && mt === 'image') {
          job.prepKind = m.prepKind = 'compress';
          out = await compressImage(f);
          if (out) mode = 'ci';
        } else if (settings.vid && mt === 'video') {
          job.prepKind = m.prepKind = 'compress';
          job.item.update();
          out = await compressVideo(f, job);
          if (out) mode = 'cv-' + job.id;
        }
        job.file = out || f;
        if (out) { m.origSize = f.size; job.name = out.name; }
        job.key = hash(`${f.name}|${f.size}|${f.lastModified}|${mode}`);
      }
      if (job.cancelled) return;
      Object.assign(m, { name: job.name, size: job.file.size, mime: job.file.type, prepKind: '' });
      job.state = 'queued';
      m.state = 'queued';
      job.item.update();
      pump();
    } catch (e) {
      if (job.cancelled) return;
      console.error(e);
      job.state = 'failed';
      m.state = 'failed';
      m.reasonKey = e.reasonKey || 'it.failed';
      job.item.update();
      removeJob(job);
    }
  }

  function removeJob(job) {
    const i = sendQueue.indexOf(job);
    if (i >= 0) sendQueue.splice(i, 1);
  }

  function cancelJob(job, reasonKey, fromRemote = false) {
    if (job.cancelled || job.state === 'done') return;
    job.cancelled = true;
    job.reasonKey = reasonKey;
    if (job.state === 'active') {
      if (!fromRemote && isOpen()) { try { dc.send(JSON.stringify({ t: 'cancel', id: job.id })); } catch { /* تجاهل */ } }
      rejectWait('accept:' + job.id, new Error('cancelled'));
      rejectWait('done:' + job.id, new Error('cancelled'));
    } else {
      job.state = 'cancelled';
      Object.assign(job.item.model, { state: 'cancelled', reasonKey });
      job.item.update();
      removeJob(job);
    }
  }

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (isOpen()) {
        const job = sendQueue.find((j) => j.state === 'queued');
        if (!job) break;
        job.state = 'active';
        current = job;
        setBusy();
        try {
          await sendFile(job);
          job.state = 'done';
        } catch (e) {
          if (job.cancelled) {
            job.state = 'cancelled';
            Object.assign(job.item.model, { state: 'cancelled', reasonKey: job.reasonKey || 'it.cancelled' });
          } else if (!isOpen()) {
            // انقطع: نرجع الملف للطابور ويكمل من نفس المكان بعد الاتصال
            job.state = 'queued';
            job.item.model.state = 'paused';
          } else {
            console.error(e);
            job.state = 'failed';
            Object.assign(job.item.model, { state: 'failed', reasonKey: 'it.failed' });
          }
          job.item.update();
        }
        current = null;
        setBusy();
        if (job.state !== 'queued') removeJob(job);
      }
    } finally {
      sending = false;
      current = null;
      setBusy();
    }
  }

  function drain(ch) {
    if (ch.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { ch.removeEventListener('bufferedamountlow', done); clearInterval(iv); resolve(); };
      const iv = setInterval(() => {
        if (ch.readyState !== 'open') {
          ch.removeEventListener('bufferedamountlow', done);
          clearInterval(iv);
          reject(new Error('closed'));
        } else if (ch.bufferedAmount <= LOW_WATER) done();
      }, 200);
      ch.addEventListener('bufferedamountlow', done);
    });
  }

  async function sendFile(job) {
    const f = job.file;
    const m = job.item.model;
    const tid = (tidSeq = (tidSeq + 1) >>> 0);
    const chunk = chunkPayload;
    const ctrl = dc;
    Object.assign(m, { state: 'active', bytes: 0, total: f.size, start: performance.now(), base: 0, resumedFrom: 0 });
    job.item.update();
    ctrl.send(JSON.stringify({ t: 'meta', id: job.id, tid, key: job.key, name: job.name, size: f.size, mime: f.type, chunk }));
    const offset = Math.min(f.size, await waitFor('accept:' + job.id, 30000));
    if (job.cancelled) throw new Error('cancelled');
    Object.assign(m, { bytes: offset, base: offset, resumedFrom: offset, start: performance.now() });
    job.item.update();
    spawnFly('out', extOf(job.name), false);

    const open = settings.lanes ? lanes.filter((l) => l.readyState === 'open') : [];
    const pipes = open.length > 1 ? open : [ctrl];
    const n = Math.ceil((f.size - offset) / chunk);
    let block = null;
    let blockIdx = -1;
    let sent = offset;
    for (let k = 0; k < n; k++) {
      if (job.cancelled) throw new Error('cancelled');
      const bi = Math.floor(k / BLOCK_CHUNKS);
      if (bi !== blockIdx) {
        const s = offset + bi * BLOCK_CHUNKS * chunk;
        const e = Math.min(f.size, s + BLOCK_CHUNKS * chunk);
        block = new Uint8Array(await f.slice(s, e).arrayBuffer());
        blockIdx = bi;
        if (job.cancelled) throw new Error('cancelled');
      }
      const within = (k % BLOCK_CHUNKS) * chunk;
      const payload = block.subarray(within, Math.min(within + chunk, block.length));
      const pipe = pipes[k % pipes.length];
      if (pipe.bufferedAmount > HIGH_WATER) await drain(pipe);
      if (pipe.readyState !== 'open') throw new Error('closed');
      const msg = new Uint8Array(8 + payload.length);
      const dv = new DataView(msg.buffer);
      dv.setUint32(0, tid);
      dv.setUint32(4, k);
      msg.set(payload, 8);
      pipe.send(msg);
      sent += payload.length;
      job.item.progress(sent);
    }
    await waitFor('done:' + job.id);
    stats.upN++;
    stats.upB += f.size;
    renderStats();
    Object.assign(m, { state: 'done', url: objUrl(f) });
    job.item.update();
  }

  function sendText(text) {
    if (!isOpen()) return toast(t('toast.noConn'), 'err');
    dc.send(JSON.stringify({ t: 'text', text }));
    addTextItem('out', text);
  }

  // ================= تجهيز: ZIP وضغط =================
  function buildZip(job) {
    const { entries, total } = job.src;
    const m = job.item.model;
    if (typeof fflate === 'undefined') return Promise.reject(new Error('fflate missing'));
    return new Promise((resolve, reject) => {
      const parts = [];
      let done = 0;
      let lastPct = -1;
      const zip = new fflate.Zip((err, dat, final) => {
        if (err) return reject(err);
        parts.push(dat);
        if (final) resolve(new Blob(parts, { type: 'application/zip' }));
      });
      (async () => {
        for (const e of entries) {
          if (job.cancelled) { try { zip.terminate(); } catch { /* تجاهل */ } return reject(new Error('cancelled')); }
          const ent = new fflate.ZipPassThrough(e.path);
          zip.add(ent);
          if (!e.file.size) { ent.push(new Uint8Array(0), true); continue; }
          const STEP = 4 * 1024 * 1024;
          for (let off = 0; off < e.file.size; off += STEP) {
            const end = Math.min(e.file.size, off + STEP);
            const buf = new Uint8Array(await e.file.slice(off, end).arrayBuffer());
            ent.push(buf, end === e.file.size);
            done += buf.length;
            const pct = total ? Math.floor((done / total) * 100) : 100;
            if (pct !== lastPct) { lastPct = pct; m.prog = pct / 100; job.item.update(); }
            if (job.cancelled) { try { zip.terminate(); } catch { /* تجاهل */ } return reject(new Error('cancelled')); }
          }
        }
        zip.end();
      })().catch(reject);
    });
  }

  async function compressImage(file) {
    if (!/^image\/(jpeg|png|webp|bmp|heic|heif|avif)$/i.test(file.type)) return null;
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { try { bmp = await createImageBitmap(file); } catch { return null; } }
    const MAX = 2560;
    const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const png = /png/i.test(file.type);
    const blob = await new Promise((r) => cv.toBlob(r, png ? 'image/webp' : 'image/jpeg', 0.82));
    if (!blob || (png && blob.type !== 'image/webp')) return null;
    if (blob.size >= file.size * 0.92) return null;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type: blob.type, lastModified: file.lastModified });
  }

  let vidWarned = false;
  async function compressVideo(file, job) {
    const v = document.createElement('video');
    const cap = v.captureStream || v.mozCaptureStream;
    const mime = typeof MediaRecorder !== 'undefined' && ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((x) => MediaRecorder.isTypeSupported(x));
    if (!cap || !mime) {
      if (!vidWarned) { vidWarned = true; toast(t('toast.vidNo'), 'err'); }
      return null;
    }
    const m = job.item.model;
    const url = URL.createObjectURL(file);
    try {
      v.src = url;
      v.playsInline = true;
      v.preload = 'auto';
      v.volume = 0;
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('decode')); });
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0 || dur > 900) return null;
      const hgt = v.videoHeight || 720;
      const vbps = hgt >= 1080 ? 4.5e6 : hgt >= 720 ? 2.5e6 : 1.2e6;
      if ((file.size * 8) / dur < vbps * 1.4) return null; // الفيديو أصلاً خفيف
      const stream = cap.call(v);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 128000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { rec.onstop = r; });
      let lastPct = -1;
      v.ontimeupdate = () => {
        const pct = Math.floor(Math.min(1, v.currentTime / dur) * 100);
        if (pct !== lastPct) { lastPct = pct; m.prog = pct / 100; job.item.update(); }
      };
      const ended = new Promise((r) => { v.onended = r; });
      rec.start(1000);
      try { await v.play(); } catch { v.muted = true; await v.play(); }
      await Promise.race([ended, new Promise((r) => { const iv = setInterval(() => { if (job.cancelled) { clearInterval(iv); r(); } }, 300); })]);
      v.pause();
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      stream.getTracks().forEach((tr) => tr.stop());
      if (job.cancelled) return null;
      const type = mime.split(';')[0];
      const blob = new Blob(chunks, { type });
      if (!blob.size || blob.size >= file.size * 0.9) return null;
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type, lastModified: file.lastModified });
    } catch (e) {
      console.warn('video compress', e);
      return null;
    } finally {
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      try { v.load(); } catch { /* تجاهل */ }
    }
  }

  // ================= الاستقبال: أماكن الحفظ =================
  const opfsDirName = 'rift-in' + (NS ? '-' + NS : '');
  async function opfsOk() {
    if (opfsState !== null) return opfsState;
    try {
      if (!navigator.storage || !navigator.storage.getDirectory || typeof FileSystemFileHandle === 'undefined' ||
          !('createWritable' in FileSystemFileHandle.prototype)) return (opfsState = false);
      const d = await opfsDir();
      const h = await d.getFileHandle('.probe', { create: true });
      const w = await h.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
      await d.removeEntry('.probe');
      return (opfsState = true);
    } catch {
      return (opfsState = false);
    }
  }
  async function opfsDir() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(opfsDirName, { create: true });
  }
  const savePartials = () => store.setJson(K('rift-partials'), partials);

  async function uniqueName(dir, name) {
    name = safeName(name);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 0; i < 100; i++) {
      const cand = i ? `${base} (${i})${ext}` : name;
      try { await dir.getFileHandle(cand); } catch { return cand; }
    }
    return `${base}-${Date.now()}${ext}`;
  }

  async function fileSink(dir, fname, store_, want) {
    const fh = await dir.getFileHandle(fname, { create: true });
    let offset = 0;
    if (want > 0) {
      const f = await fh.getFile();
      offset = Math.min(want, f.size);
    }
    const w = await fh.createWritable({ keepExistingData: offset > 0 });
    if (offset > 0) await w.truncate(offset);
    return {
      store: store_, fname, offset,
      write: (pos, buf) => w.write({ type: 'write', position: pos, data: buf }),
      async finish() { await w.close(); return fh.getFile(); },
      async pause() { try { await w.close(); } catch { /* تجاهل */ } },
      async abort() {
        try { await w.abort(); } catch { /* تجاهل */ }
        try { await dir.removeEntry(fname); } catch { /* تجاهل */ }
      },
    };
  }

  function memSink(key) {
    const st = memPartials.get(key) || { parts: [], contig: 0 };
    memPartials.set(key, st);
    st.parts = st.parts.filter((p) => p.pos + p.buf.length <= st.contig);
    return {
      store: 'mem', fname: '', offset: st.contig,
      write(pos, buf) { st.parts.push({ pos, buf }); return Promise.resolve(); },
      async finish(r) {
        st.parts.sort((a, b) => a.pos - b.pos);
        memPartials.delete(key);
        return new Blob(st.parts.map((p) => p.buf), { type: r.mime || 'application/octet-stream' });
      },
      setContig(c) { st.contig = c; st.parts = st.parts.filter((p) => p.pos + p.buf.length <= c); },
      async pause() { /* يبقى في الذاكرة */ },
      async abort() { memPartials.delete(key); },
    };
  }

  async function openSink(meta, partial) {
    if (saveDir && saveDirOk) {
      try {
        const usePartial = partial && partial.store === 'dir';
        const fname = usePartial ? partial.fname : await uniqueName(saveDir, meta.name);
        return await fileSink(saveDir, fname, 'dir', usePartial ? partial.contig : 0);
      } catch (e) { console.warn('dir sink', e); }
    } else if (saveDir && !saveDirOk && !openSink.warned) {
      openSink.warned = true;
      toast(t('toast.folderLost'), 'err');
    }
    if (await opfsOk()) {
      try {
        const usePartial = partial && partial.store === 'opfs';
        if (!usePartial && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          if (est.quota && est.quota - est.usage < meta.size + 50 * 1024 * 1024) {
            if (meta.size > 300 * 1024 * 1024) return { noSpace: true };
            return memSink(meta.key);
          }
        }
        const dir = await opfsDir();
        const fname = usePartial ? partial.fname : 'p-' + meta.key + '-' + Math.random().toString(36).slice(2, 8);
        return await fileSink(dir, fname, 'opfs', usePartial ? partial.contig : 0);
      } catch (e) { console.warn('opfs sink', e); }
    }
    return memSink(meta.key);
  }

  async function cleanupOpfs() {
    if (!(await opfsOk())) return;
    try {
      const dir = await opfsDir();
      const keep = new Set();
      const now = Date.now();
      for (const [k, p] of Object.entries(partials)) {
        if (p.store === 'opfs' && now - (p.t || 0) < 7 * 86400000) keep.add(p.fname);
        else if (p.store === 'opfs' || now - (p.t || 0) >= 7 * 86400000) delete partials[k];
      }
      savePartials();
      for await (const name of dir.keys()) {
        if (!keep.has(name)) { try { await dir.removeEntry(name); } catch { /* مستخدم */ } }
      }
    } catch (e) { console.warn('cleanup', e); }
  }

  // ================= الاستقبال =================
  async function handleMeta(m) {
    if (rx) await pauseIncoming();
    const name = safeName(m.name);
    const size = Math.max(0, Number(m.size) || 0);
    const mime = String(m.mime || '').slice(0, 100);
    const key = String(m.key || uid()).replace(/[^\w-]/g, '').slice(0, 60) || uid();
    const chunk = Math.max(1024, Number(m.chunk) || 16384);
    const id = String(m.id);

    let item = inItemsByKey.get(key);
    if (!item || ['done', 'cancelled', 'failed'].includes(item.model.state)) {
      item = createFileItem('in', { name, size, mime, onCancel: () => cancelIncoming(key) });
      inItemsByKey.set(key, item);
    }
    Object.assign(item.model, { state: 'active', bytes: 0, total: size, start: performance.now() });
    item.update();

    const p = partials[key] && partials[key].size === size ? partials[key] : null;
    let sink;
    try { sink = await openSink({ key, name, size, mime }, p); }
    catch (e) { console.error(e); sink = memSink(key); }
    if (!isOpen()) { if (sink.pause) sink.pause(); Object.assign(item.model, { state: 'paused' }); item.update(); return; }
    if (sink.noSpace) {
      dc.send(JSON.stringify({ t: 'cancel', id }));
      Object.assign(item.model, { state: 'failed', reasonKey: 'it.noSpace' });
      item.update();
      return;
    }
    const offset = sink.offset;
    const n = Math.ceil((size - offset) / chunk);
    rx = {
      id, tid: Number(m.tid) >>> 0, key, name, size, mime, chunk, base: offset, n,
      bits: new Uint8Array(n), got: 0, gotBytes: 0, first: 0, sink,
      wchain: Promise.resolve(), item, lastPersist: 0, writeErr: null, finishing: false,
    };
    Object.assign(item.model, { bytes: offset, base: offset, resumedFrom: offset, start: performance.now() });
    item.update();
    if (sink.store !== 'mem') {
      partials[key] = { name, size, mime, store: sink.store, fname: sink.fname, contig: offset, t: Date.now() };
      savePartials();
    }
    setBusy();
    spawnFly('in', extOf(name), false);
    dc.send(JSON.stringify({ t: 'accept', id, offset }));
    if (n === 0) finalizeRx();
  }

  function onChunk(data) {
    if (!(data instanceof ArrayBuffer)) {
      if (data && data.buffer instanceof ArrayBuffer) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      else return;
    }
    lastRx = Date.now();
    const r = rx;
    if (!r || r.finishing || data.byteLength < 8) return;
    const dv = new DataView(data);
    const tid = dv.getUint32(0);
    const k = dv.getUint32(4);
    if (tid !== r.tid || k >= r.n || r.bits[k]) return;
    r.bits[k] = 1;
    r.got++;
    const payload = new Uint8Array(data, 8);
    r.gotBytes += payload.length;
    const pos = r.base + k * r.chunk;
    r.wchain = r.wchain.then(() => r.sink.write(pos, payload)).catch((e) => { r.writeErr = r.writeErr || e; });
    while (r.first < r.n && r.bits[r.first]) r.first++;
    r.item.progress(r.base + r.gotBytes);
    const now = performance.now();
    if (r.sink.store !== 'mem' && now - r.lastPersist > 2000 && partials[r.key]) {
      r.lastPersist = now;
      partials[r.key].contig = Math.min(r.size, r.base + r.first * r.chunk);
      partials[r.key].t = Date.now();
      savePartials();
    }
    if (r.got === r.n) finalizeRx();
  }

  async function finalizeRx() {
    const r = rx;
    if (!r || r.finishing) return;
    r.finishing = true;
    await r.wchain;
    if (rx !== r) return;
    let file = null;
    if (!r.writeErr) {
      try { file = await r.sink.finish(r); } catch (e) { r.writeErr = e; }
    }
    rx = null;
    setBusy();
    if (r.writeErr || !file) {
      console.error(r.writeErr);
      try { await r.sink.abort(); } catch { /* تجاهل */ }
      delete partials[r.key];
      savePartials();
      if (isOpen()) dc.send(JSON.stringify({ t: 'cancel', id: r.id }));
      Object.assign(r.item.model, { state: 'failed', reasonKey: 'it.failed' });
      r.item.update();
      return;
    }
    delete partials[r.key];
    savePartials();
    if (r.sink.store === 'opfs') opfsDone.push(r.sink.fname);
    if (isOpen()) dc.send(JSON.stringify({ t: 'done', id: r.id }));
    const url = objUrl(file);
    const mime = r.mime || file.type || '';
    Object.assign(r.item.model, { state: 'done', url, savedDir: r.sink.store === 'dir', mime, bytes: r.size });
    r.item.update();
    received.push({ url, name: r.name });
    const mt = mediaType(mime, r.name);
    if (mt === 'image' || mt === 'video') addToGallery({ url, name: r.name, type: mt });
    stats.downN++;
    stats.downB += r.size;
    renderStats();
    refreshListActions();
    notifyArrival(t('toast.arrived', { n: r.name }));
  }

  // الاتصال انقطع وسط ملف: نحفظ وين وقفنا
  async function pauseIncoming() {
    const r = rx;
    if (!r) return;
    rx = null;
    setBusy();
    const contig = Math.min(r.size, r.base + r.first * r.chunk);
    Object.assign(r.item.model, { state: 'paused', bytes: contig });
    r.item.update();
    if (r.sink.store === 'mem') r.sink.setContig(contig);
    else if (partials[r.key]) {
      partials[r.key].contig = contig;
      partials[r.key].t = Date.now();
      savePartials();
    }
    try { await r.wchain; } catch { /* تجاهل */ }
    await r.sink.pause();
  }

  async function dropIncoming(r, reasonKey) {
    if (rx === r) rx = null;
    setBusy();
    Object.assign(r.item.model, { state: 'cancelled', reasonKey });
    r.item.update();
    try { await r.wchain; } catch { /* تجاهل */ }
    await r.sink.abort();
    delete partials[r.key];
    savePartials();
  }

  async function cancelIncoming(key) {
    const r = rx;
    if (r && r.key === key) {
      if (isOpen()) { try { dc.send(JSON.stringify({ t: 'cancel', id: r.id })); } catch { /* تجاهل */ } }
      dropIncoming(r, 'it.cancelled');
      return;
    }
    // ملف متوقف (ينتظر الإكمال): نحذف الجزء المحفوظ
    const item = inItemsByKey.get(key);
    if (!item || item.model.state !== 'paused') return;
    Object.assign(item.model, { state: 'cancelled', reasonKey: 'it.cancelled' });
    item.update();
    inItemsByKey.delete(key);
    memPartials.delete(key);
    const p = partials[key];
    if (!p) return;
    delete partials[key];
    savePartials();
    try {
      if (p.store === 'opfs' && (await opfsOk())) await (await opfsDir()).removeEntry(p.fname);
      else if (p.store === 'dir' && saveDir && saveDirOk) await saveDir.removeEntry(p.fname);
    } catch { /* تجاهل */ }
  }

  function onRemoteCancel(id) {
    if (rx && rx.id === id) dropIncoming(rx, 'it.cancelledSender');
    if (current && current.id === id) cancelJob(current, 'it.cancelledReceiver', true);
  }

  // ================= عناصر السجل =================
  function createFileItem(dir, { name, size, mime, onCancel }) {
    const model = {
      kind: 'file', dir, name, size, mime, state: 'queued', reasonKey: '', prog: 0, prepKind: '',
      bytes: 0, total: size, start: 0, base: 0, resumedFrom: 0, url: '', savedDir: false,
      origSize: 0, filesCount: 0, onCancel,
    };
    const li = document.createElement('li');
    li.className = 'item';
    const row = document.createElement('div');
    row.className = 'item-row';
    const badge = document.createElement('span');
    badge.className = 'item-dir ' + dir;
    const main = document.createElement('div');
    main.className = 'item-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'item-name';
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    main.append(nameEl, meta);
    const acts = document.createElement('div');
    acts.className = 'item-acts';
    row.append(badge, main, acts);
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    bar.append(fill);
    li.append(row, bar);
    ui.items.prepend(li);

    let lastRender = 0;
    let lastPct = -1;
    let previewDone = false;

    const item = {
      model,
      progress(bytes) {
        model.bytes = bytes;
        const pct = model.total ? Math.floor((bytes / model.total) * 100) : 100;
        const now = performance.now();
        if (pct === lastPct && now - lastRender < 400) return;
        lastPct = pct;
        lastRender = now;
        render();
      },
      update: () => render(),
    };

    function render() {
      const s = model.state;
      li.classList.toggle('paused', s === 'paused' || (s === 'queued' && dir === 'out' && model.bytes > 0));
      badge.textContent = extOf(model.name);
      badge.title = dir === 'in' ? '↓' : '↑';
      nameEl.textContent = model.name;
      nameEl.title = model.name;
      meta.className = 'item-meta';
      let txt = '';
      const sz = fmtSize(model.size);
      if (s === 'prep') {
        const p = Math.round((model.prog || 0) * 100);
        txt = model.prepKind === 'zip' ? t('it.zip', { p }) : model.prepKind === 'compress' ? t('it.compress', { p }) : t('it.prep');
        if (model.filesCount) txt += ' · ' + t('it.files', { n: model.filesCount });
      } else if (s === 'queued') {
        txt = sz + ' · ' + t('it.queued');
      } else if (s === 'active') {
        const secs = (performance.now() - model.start) / 1000;
        txt = fmtSize(model.bytes) + ' ' + t('it.of') + ' ' + fmtSize(model.total);
        const moved = model.bytes - model.base;
        if (secs > 0.4 && moved > 0) {
          const speed = moved / secs;
          txt += ' · ' + fmtSize(speed) + t('it.ps');
          const left = fmtTime((model.total - model.bytes) / speed);
          if (left && model.bytes < model.total) txt += ' · ' + t('it.left', { t: left });
        } else if (dir === 'in' && !model.bytes) {
          txt = sz + ' · ' + t('it.receiving');
        }
        if (model.resumedFrom > 0 && secs < 4) txt += ' · ' + t('it.resumed', { p: fmtSize(model.resumedFrom) });
      } else if (s === 'paused') {
        txt = fmtSize(model.bytes) + ' ' + t('it.of') + ' ' + fmtSize(model.total) + ' · ' + t('it.paused');
        meta.classList.add('warn');
      } else if (s === 'done') {
        txt = sz + ' · ' + t(model.savedDir ? 'it.savedDir' : dir === 'out' ? 'it.sent' : 'it.received');
        if (model.origSize) txt += ' · ' + t('it.compressed', { a: fmtSize(model.origSize) });
        if (model.filesCount) txt += ' · ' + t('it.files', { n: model.filesCount });
      } else {
        txt = sz + ' · ' + t(model.reasonKey || 'it.failed');
        meta.classList.add('bad');
      }
      if (dir === 'out' && s === 'queued' && model.bytes > 0) {
        txt = fmtSize(model.bytes) + ' ' + t('it.of') + ' ' + fmtSize(model.total) + ' · ' + t('it.paused');
        meta.classList.add('warn');
      }
      meta.textContent = txt;

      // شريط التقدم
      const showBar = s === 'prep' || s === 'active' || s === 'paused' || (s === 'queued' && model.bytes > 0);
      bar.hidden = !showBar;
      if (showBar) {
        const pct = s === 'prep' ? (model.prog || 0) * 100 : model.total ? (model.bytes / model.total) * 100 : 0;
        fill.style.width = Math.min(100, pct).toFixed(1) + '%';
      }

      // الأزرار
      acts.replaceChildren();
      if (['prep', 'queued', 'active', 'paused'].includes(s) && model.onCancel) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'x-btn';
        x.textContent = '×';
        x.title = t('it.cancel');
        x.setAttribute('aria-label', t('it.cancel') + ' ' + model.name);
        x.onclick = () => model.onCancel();
        acts.append(x);
      }
      if (s === 'done' && dir === 'in' && model.url) {
        const a = document.createElement('a');
        a.className = 'btn';
        a.href = model.url;
        a.download = model.name;
        a.textContent = t('it.download');
        acts.append(a);
      }

      // المعاينة
      if (s === 'done' && model.url && !previewDone) {
        previewDone = true;
        const type = mediaType(model.mime, model.name);
        if (type) {
          const box = document.createElement('div');
          box.className = 'preview';
          const el = document.createElement(type === 'image' ? 'img' : type);
          el.src = model.url;
          if (type === 'image') { el.alt = model.name; el.loading = 'lazy'; }
          else { el.controls = true; el.setAttribute('playsinline', ''); el.preload = 'metadata'; }
          box.append(el);
          if (dir === 'in' && type === 'image') {
            box.onclick = () => { const i = gallery.findIndex((g) => g.url === model.url); if (i >= 0) openLb(i); };
          } else {
            box.style.cursor = 'default';
          }
          li.append(box);
        }
      }
    }

    allItems.push(item);
    render();
    refreshListActions();
    return item;
  }

  function addTextItem(dir, text) {
    const li = document.createElement('li');
    li.className = 'item';
    const row = document.createElement('div');
    row.className = 'item-row';
    const badge = document.createElement('span');
    badge.className = 'item-dir ' + dir;
    badge.textContent = 'TXT';
    const main = document.createElement('div');
    main.className = 'item-main';
    const label = document.createElement('div');
    label.className = 'item-meta';
    main.append(label);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn-ghost sm';
    copy.onclick = () => copyText(text, copy);
    row.append(badge, main, copy);
    const body = document.createElement('div');
    body.className = 'text-body';
    body.dir = 'auto';
    const tr = text.trim();
    if (/^https?:\/\/\S+$/i.test(tr)) {
      const a = document.createElement('a');
      a.href = tr;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = tr;
      body.append(a);
    } else {
      body.textContent = text;
    }
    li.append(row, body);
    ui.items.prepend(li);
    const item = {
      model: { kind: 'text' },
      update() { label.textContent = t(dir === 'in' ? 'it.textIn' : 'it.textOut'); copy.textContent = t('it.copy'); },
      progress() {},
    };
    item.update();
    allItems.push(item);
    refreshListActions();
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const o = btn.textContent; btn.textContent = t('it.copied'); setTimeout(() => (btn.textContent = o), 1200); }
      else toast(t('toast.copied'), 'ok');
    } catch {
      window.prompt('', text);
    }
  }

  function renderStats() {
    ui.stats.innerHTML = '';
    if (!stats.upN && !stats.downN) return;
    const up = document.createElement('span');
    up.className = 'up';
    up.textContent = '↑ ' + stats.upN + ' · ' + fmtSize(stats.upB);
    const down = document.createElement('span');
    down.className = 'down';
    down.textContent = '↓ ' + stats.downN + ' · ' + fmtSize(stats.downB);
    ui.stats.append(up, down);
  }

  function refreshListActions() {
    const has = ui.items.children.length > 0;
    ui.empty.classList.toggle('hidden', has);
    ui.clearLog.classList.toggle('hidden', !has);
    ui.downloadAll.classList.toggle('hidden', received.length < 2);
    ui.galCount.textContent = gallery.length;
    ui.galEmpty.classList.toggle('hidden', gallery.length > 0);
  }

  async function downloadAll() {
    for (const f of received) {
      const a = document.createElement('a');
      a.href = f.url;
      a.download = f.name;
      document.body.append(a);
      a.click();
      a.remove();
      await sleep(350);
    }
  }

  async function clearLog() {
    if (sending || rx || sendQueue.length) return toast(t('toast.busy'), 'err');
    ui.items.replaceChildren();
    ui.galGrid.replaceChildren();
    allItems.length = 0;
    inItemsByKey.clear();
    gallery.length = 0;
    received.length = 0;
    objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    Object.assign(stats, { upN: 0, upB: 0, downN: 0, downB: 0 });
    renderStats();
    refreshListActions();
    if (opfsDone.length && (await opfsOk())) {
      const dir = await opfsDir();
      for (const f of opfsDone.splice(0)) { try { await dir.removeEntry(f); } catch { /* تجاهل */ } }
    }
  }

  // ================= المعرض والعارض =================
  function addToGallery(g) {
    gallery.unshift(g);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gal-cell';
    b.setAttribute('aria-label', g.name);
    const el = document.createElement(g.type === 'image' ? 'img' : 'video');
    el.src = g.url;
    if (g.type === 'image') { el.alt = ''; el.loading = 'lazy'; el.decoding = 'async'; }
    else { el.muted = true; el.preload = 'metadata'; el.setAttribute('playsinline', ''); }
    b.append(el);
    if (g.type === 'video') { const p = document.createElement('span'); p.className = 'play'; b.append(p); }
    b.onclick = () => openLb(gallery.indexOf(g));
    ui.galGrid.prepend(b);
    refreshListActions();
  }

  let lbIndex = -1;
  function openLb(i) {
    if (i < 0 || i >= gallery.length) return;
    lbIndex = i;
    ui.lightbox.hidden = false;
    renderLb();
    document.addEventListener('keydown', lbKeys);
    ui.lbClose.focus();
  }
  function closeLb() {
    ui.lightbox.hidden = true;
    ui.lbStage.replaceChildren();
    document.removeEventListener('keydown', lbKeys);
  }
  function renderLb() {
    const g = gallery[lbIndex];
    if (!g) return closeLb();
    const el = document.createElement(g.type === 'image' ? 'img' : 'video');
    el.src = g.url;
    if (g.type === 'video') { el.controls = true; el.autoplay = true; el.setAttribute('playsinline', ''); }
    else { el.alt = g.name; el.draggable = false; }
    ui.lbStage.replaceChildren(el);
    ui.lbCount.textContent = lbIndex + 1 + ' / ' + gallery.length;
    ui.lbName.textContent = g.name;
    ui.lbDownload.href = g.url;
    ui.lbDownload.download = g.name;
    const multi = gallery.length > 1;
    ui.lbPrev.hidden = !multi;
    ui.lbNext.hidden = !multi;
  }
  function lbGo(d) {
    if (gallery.length < 2) return;
    lbIndex = (lbIndex + d + gallery.length) % gallery.length;
    renderLb();
  }
  function lbKeys(e) {
    if (e.key === 'Escape') closeLb();
    else if (e.key === 'ArrowRight') lbGo(isRTL() ? -1 : 1);
    else if (e.key === 'ArrowLeft') lbGo(isRTL() ? 1 : -1);
  }
  (function lbSwipe() {
    let x0 = null;
    let y0 = 0;
    ui.lbStage.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; });
    ui.lbStage.addEventListener('pointermove', (e) => {
      if (x0 == null) return;
      const el = ui.lbStage.firstChild;
      if (el && e.pointerType !== 'mouse') el.style.transform = `translateX(${e.clientX - x0}px)`;
    });
    const end = (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      x0 = null;
      const el = ui.lbStage.firstChild;
      if (el) el.style.transform = '';
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        // بالعربي: السحب لليمين يجيب التالي
        lbGo((dx > 0) === isRTL() ? 1 : -1);
      } else if (dy > 120 && Math.abs(dy) > Math.abs(dx)) closeLb();
    };
    ui.lbStage.addEventListener('pointerup', end);
    ui.lbStage.addEventListener('pointercancel', () => { x0 = null; const el = ui.lbStage.firstChild; if (el) el.style.transform = ''; });
  })();

  // ================= الملف الطاير =================
  let flyTicks = 0;
  function spawnFly(dir, label, mini) {
    if (document.hidden || ui.transferView.classList.contains('hidden')) return;
    if (ui.beam.querySelectorAll('.fly').length > 12) return;
    const el = document.createElement('span');
    el.className = 'fly ' + dir + (mini ? ' mini' : '');
    el.textContent = label;
    ui.beam.append(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }
  setInterval(() => {
    flyTicks++;
    const big = flyTicks % 6 === 0;
    if (current && current.state === 'active') spawnFly('out', extOf(current.name), !big);
    if (rx) spawnFly('in', extOf(rx.name), !big);
  }, 420);

  // ================= QR =================
  function renderQR() {
    ui.qr.innerHTML = '';
    if (typeof QRCode === 'undefined') { ui.qr.textContent = 'QR ✕'; return; }
    new QRCode(ui.qr, {
      text: shareLink(), width: 256, height: 256,
      colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // ================= منع نوم الشاشة =================
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch { /* غير مدعوم */ }
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // ================= الإعدادات =================
  function openSettings() {
    renderSettings();
    ui.sheet.hidden = false;
    ui.sheetBackdrop.hidden = false;
    ui.settingsClose.focus();
  }
  function closeSettings() {
    ui.sheet.hidden = true;
    ui.sheetBackdrop.hidden = true;
    ui.settingsBtn.focus();
  }
  function renderSettings() {
    ui.sheet.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
    ui.soundToggle.setAttribute('aria-checked', String(!!settings.sound));
    const notifOn = settings.notif && 'Notification' in window && Notification.permission === 'granted';
    ui.notifToggle.setAttribute('aria-checked', String(!!notifOn));
    renderSaveInfo();
    renderTrusted();
  }
  async function renderSaveInfo() {
    const canPick = typeof window.showDirectoryPicker === 'function';
    ui.pickFolder.classList.toggle('hidden', !canPick || !!saveDir);
    ui.regrantFolder.classList.toggle('hidden', !(saveDir && !saveDirOk));
    ui.unpickFolder.classList.toggle('hidden', !saveDir);
    if (saveDir) ui.saveInfo.textContent = t('set.folder', { n: saveDir.name });
    else ui.saveInfo.textContent = (await opfsOk()) ? t('set.saveOpfs') : t('set.saveMem');
  }
  async function loadSaveDir() {
    if (typeof window.showDirectoryPicker !== 'function') return;
    const h = await idb.get(K('saveDir'));
    if (!h) return;
    saveDir = h;
    try { saveDirOk = (await h.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { saveDirOk = false; }
  }
  function renderChips() {
    ui.optImg.setAttribute('aria-pressed', String(!!settings.img));
    ui.optVid.setAttribute('aria-pressed', String(!!settings.vid));
    ui.optLanes.setAttribute('aria-pressed', String(!!settings.lanes));
    ui.vidNote.classList.toggle('hidden', !settings.vid);
  }

  // ================= اللغة =================
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    const k1 = '<span class="kbd-combo"><kbd>Ctrl</kbd>+<kbd>V</kbd></span>';
    const k2 = '<span class="kbd-combo"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>';
    ui.hint.innerHTML = esc(t('tr.hint')).replace('{k1}', k1).replace('{k2}', k2);
    document.title = unread ? '(' + unread + ') ' + t('doc.title') : t('doc.title');
  }
  function setLang(l) {
    if (l !== 'ar' && l !== 'en') return;
    lang = l;
    store.set('rift-lang', l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    applyI18n();
    renderStatus();
    renderNodes();
    renderTrusted();
    allItems.forEach((it) => it.update());
    renderStats();
    if (!ui.sheet.hidden) renderSettings();
  }

  // ================= الأحداث =================
  ui.joinInput.addEventListener('input', () => {
    const v = cleanCode(ui.joinInput.value);
    if (v !== ui.joinInput.value) ui.joinInput.value = v;
  });
  ui.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    connectTo(cleanCode(ui.joinInput.value));
  });
  ui.copyLink.addEventListener('click', () => copyText(shareLink(), ui.copyLink));

  for (const input of [ui.fileInput, ui.fileInput2, ui.camInput, ui.galleryInput]) {
    input.addEventListener('change', () => { queueFiles(input.files); input.value = ''; });
  }
  ui.folderInput.addEventListener('change', () => { queueFolderInput(ui.folderInput.files); ui.folderInput.value = ''; });
  if (!('webkitdirectory' in document.createElement('input'))) ui.folderBtn.classList.add('hidden');

  ui.optImg.addEventListener('click', () => { settings.img = !settings.img; saveSettings(); renderChips(); });
  ui.optVid.addEventListener('click', () => { settings.vid = !settings.vid; saveSettings(); renderChips(); });
  ui.optLanes.addEventListener('click', () => { settings.lanes = !settings.lanes; saveSettings(); renderChips(); });

  // السحب والإفلات (ملفات ومجلدات) على كامل الصفحة
  let dragDepth = 0;
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  const canSend = () => !ui.transferView.classList.contains('hidden');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (canSend()) ui.dropOverlay.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropOverlay.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    ui.dropOverlay.classList.remove('show');
    if (!hasFiles(e)) return;
    if (!canSend()) return toast(t('toast.pairFirst'), 'err');
    const items = Array.from(e.dataTransfer.items || []);
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.some((en) => en.isDirectory)) {
      (async () => {
        const plain = [];
        for (const en of entries) {
          if (en.isDirectory) queueZip(en.name, await walkEntry(en, ''));
          else plain.push(await new Promise((res) => en.file(res, () => res(null))));
        }
        queueFiles(plain.filter(Boolean));
      })();
    } else {
      queueFiles(e.dataTransfer.files);
    }
  });
  async function walkEntry(entry, prefix) {
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      return f ? [{ file: f, path: prefix + entry.name }] : [];
    }
    const reader = entry.createReader();
    const all = [];
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      all.push(...batch);
    }
    const out = [];
    for (const en of all) out.push(...(await walkEntry(en, prefix + entry.name + '/')));
    return out;
  }

  document.addEventListener('paste', (e) => {
    if (!canSend()) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (files.length) { e.preventDefault(); queueFiles(files); }
  });

  ui.textForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = ui.textInput.value;
    if (!v.trim()) return;
    sendText(v);
    ui.textInput.value = '';
  });
  ui.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ui.textForm.requestSubmit();
  });

  ui.disconnect.addEventListener('click', closePortal);
  ui.downloadAll.addEventListener('click', downloadAll);
  ui.clearLog.addEventListener('click', clearLog);

  function selectTab(gal) {
    ui.tabLog.classList.toggle('active', !gal);
    ui.tabGal.classList.toggle('active', gal);
    ui.tabLog.setAttribute('aria-selected', String(!gal));
    ui.tabGal.setAttribute('aria-selected', String(gal));
    ui.logPane.classList.toggle('hidden', gal);
    ui.galPane.classList.toggle('hidden', !gal);
  }
  ui.tabLog.addEventListener('click', () => selectTab(false));
  ui.tabGal.addEventListener('click', () => selectTab(true));

  ui.lbClose.addEventListener('click', closeLb);
  ui.lbPrev.addEventListener('click', () => lbGo(-1));
  ui.lbNext.addEventListener('click', () => lbGo(1));

  ui.langBtn.addEventListener('click', () => setLang(lang === 'ar' ? 'en' : 'ar'));
  ui.settingsBtn.addEventListener('click', () => (ui.sheet.hidden ? openSettings() : closeSettings()));
  ui.settingsClose.addEventListener('click', closeSettings);
  ui.sheetBackdrop.addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ui.sheet.hidden) closeSettings(); });
  ui.sheet.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { setLang(b.dataset.lang); renderSettings(); }));
  ui.soundToggle.addEventListener('click', () => {
    settings.sound = !settings.sound;
    saveSettings();
    renderSettings();
    if (settings.sound) chime();
  });
  ui.notifToggle.addEventListener('click', async () => {
    if (!('Notification' in window)) {
      settings.notif = false;
      toast(t('toast.notifDenied'), 'err');
    } else if (settings.notif && Notification.permission === 'granted') {
      settings.notif = false;
    } else if (Notification.permission === 'denied') {
      settings.notif = false;
      toast(t('toast.notifDenied'), 'err');
    } else {
      const p = await Notification.requestPermission();
      settings.notif = p === 'granted';
      if (!settings.notif) toast(t('toast.notifDenied'), 'err');
    }
    saveSettings();
    renderSettings();
  });
  ui.pickFolder.addEventListener('click', async () => {
    try {
      const h = await window.showDirectoryPicker({ id: 'rift', mode: 'readwrite' });
      saveDir = h;
      saveDirOk = true;
      await idb.set(K('saveDir'), h);
    } catch { /* ألغى الاختيار */ }
    renderSaveInfo();
  });
  ui.regrantFolder.addEventListener('click', async () => {
    try { saveDirOk = (await saveDir.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { saveDirOk = false; }
    renderSaveInfo();
  });
  ui.unpickFolder.addEventListener('click', async () => {
    saveDir = null;
    saveDirOk = false;
    await idb.del(K('saveDir'));
    renderSaveInfo();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    unread = 0;
    document.title = t('doc.title');
    if (linkUp()) requestWakeLock();
    pollSince = Date.now();
    pollTick();
  });
  window.addEventListener('beforeunload', (e) => {
    if ((current && current.state === 'active') || rx) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    // نحفظ وين وقفنا لو انقفلت الصفحة وسط استلام
    if (rx && partials[rx.key]) {
      partials[rx.key].contig = Math.min(rx.size, rx.base + rx.first * rx.chunk);
      savePartials();
      try { rx.sink.pause(); } catch { /* تجاهل */ }
    }
  });
  setInterval(() => { if (!ui.pairView.classList.contains('hidden')) renderTrusted(); }, 60000);

  // للتجربة فقط: ?ns=x يفعّل أدوات فحص
  if (NS) {
    window.__rift = {
      drop: () => conn && conn.close(),
      queueFiles, queueZip,
      state: () => ({
        myCode, persistent, open: isOpen(), lanes: lanes.map((l) => l.readyState), chunkPayload,
        partials, trusted: trusted.map((d) => d.id), opfs: opfsState, rx: rx && { got: rx.got, n: rx.n, base: rx.base, store: rx.sink.store },
        queue: sendQueue.map((j) => j.state),
      }),
    };
  }

  // ================= البدء =================
  applyI18n();
  renderStatus();
  renderNodes();
  renderTrusted();
  renderChips();
  renderStats();
  refreshListActions();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
  }
  loadSaveDir().then(renderSaveInfo);
  cleanupOpfs();

  if (typeof Peer === 'undefined') {
    introReady();
    setStatus('st.libFail', 'err');
    return;
  }
  const saved = cleanCode(store.get(K('rift-id')) || '');
  startPeer(saved.length === 6 ? saved : newCode());
})();
