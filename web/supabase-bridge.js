/*
 * 성장노트 ↔ Supabase 연결
 *
 * 성장노트 본체는 claude.ai 아티팩트 DB(window.claude.use('db'))에 저장하도록 만들어져 있다.
 * 이 파일은 같은 모양의 DB를 Supabase로 흉내 내서, 본체 코드를 거의 고치지 않고
 * 저장 위치만 Supabase로 바꾼다. (개발목표.md 5-1: A안 — 상태 S 전체를 planner/main 한 줄에 저장)
 *
 *  - 로그인: 이메일로 받은 6자리 코드(Supabase 이메일 OTP)        → 개발목표 G2
 *  - 저장:   public.planner_docs 표, 본인 줄만 읽고 쓰기(RLS)       → G3, G4
 *  - 동기화: Supabase Realtime + 창으로 돌아올 때 다시 불러오기      → G5
 *  - 로그인 유지: supabase-js가 이 기기에 세션을 보관              → G6
 *
 * config.js에 url/key가 비어 있으면 아무것도 하지 않는다(본체가 localStorage 모드로 동작).
 * claude.ai 아티팩트 안에서 열면(window.claude가 이미 있으면) 아무것도 하지 않는다.
 */
(function () {
  'use strict';
  if (window.claude && window.claude.use) return;
  var cfg = window.SUPABASE_CONFIG || {};
  if (!cfg.url || !cfg.key) return;
  if (!window.supabase || !window.supabase.createClient) {
    showFatal('Supabase 프로그램을 불러오지 못했어요. 인터넷 연결을 확인하고 새로 고쳐 주세요.');
    return;
  }

  var TABLE = 'planner_docs';
  var sb = window.supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'gn-auth' }
  });
  var uid = null, userEmail = '';
  var resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });

  /* ---------- 오류를 본체가 아는 코드로 바꾸기 ---------- */
  function wrapErr(e, status) {
    var err = new Error((e && e.message) || '저장소 오류');
    var c = e && e.code;
    if (status === 401 || c === 'PGRST301' || c === 'PGRST303' || /JWT/i.test(err.message)) err.code = 'unauthenticated';
    else if (status === 403 || c === '42501') err.code = 'permission_denied';
    else if (status === 413) err.code = 'invalid_argument';
    else err.code = 'unavailable';
    return err;
  }
  function chk(res) { if (res.error) throw wrapErr(res.error, res.status); return res.data; }

  /* ---------- Firestore 모양의 작은 DB ---------- */
  function snap(path, row) {
    return {
      id: path.split('/').pop(),
      exists: !!row,
      data: function () { return row ? row.data : undefined; }
    };
  }
  function fetchDoc(path) {
    return sb.from(TABLE).select('data').eq('path', path).maybeSingle()
      .then(function (res) { return snap(path, chk(res)); });
  }
  var listeners = {}; // path -> [{cb, eb}]
  function notify(path) {
    var L = listeners[path];
    if (!L || !L.length) return;
    fetchDoc(path).then(function (s) {
      (listeners[path] || []).forEach(function (l) { try { l.cb(s); } catch (e) { console.error(e); } });
    }, function (e) {
      (listeners[path] || []).forEach(function (l) { if (l.eb) try { l.eb(e); } catch (x) {} });
    });
  }
  function doc(path) {
    return {
      id: path.split('/').pop(),
      get: function () { return fetchDoc(path); },
      set: function (data) {
        var row = {
          user_id: uid,
          path: path,
          kind: (data && typeof data.kind === 'string') ? data.kind : null,
          saved_at: (data && typeof data.savedAt === 'number') ? Math.round(data.savedAt) : null,
          data: data,
          updated_at: new Date().toISOString()
        };
        return sb.from(TABLE).upsert(row, { onConflict: 'user_id,path' }).then(function (res) { chk(res); });
      },
      delete: function () {
        return sb.from(TABLE).delete().eq('path', path).then(function (res) { chk(res); });
      },
      onSnapshot: function (cb, eb) {
        var l = { cb: cb, eb: eb };
        (listeners[path] = listeners[path] || []).push(l);
        fetchDoc(path).then(function (s) { cb(s); }, function (e) { if (eb) eb(e); });
        return function () { listeners[path] = (listeners[path] || []).filter(function (x) { return x !== l; }); };
      }
    };
  }
  function collection(name) {
    function q(st) {
      return {
        where: function (f, op, v) {
          if (f !== 'kind' || op !== '==') throw new Error('지원하지 않는 조건: ' + f + ' ' + op);
          return q(Object.assign({}, st, { kind: v }));
        },
        orderBy: function (f, dir) {
          if (f !== 'savedAt') throw new Error('지원하지 않는 정렬: ' + f);
          return q(Object.assign({}, st, { desc: dir === 'desc', ordered: true }));
        },
        limit: function (n) { return q(Object.assign({}, st, { limit: n })); },
        get: function () {
          var r = sb.from(TABLE).select('path,data').like('path', name + '/%');
          if (st.kind != null) r = r.eq('kind', st.kind);
          if (st.ordered) r = r.order('saved_at', { ascending: !st.desc, nullsFirst: false });
          if (st.limit) r = r.limit(st.limit);
          return r.then(function (res) {
            var docs = (chk(res) || []).map(function (row) { return snap(row.path, row); });
            return { docs: docs, empty: !docs.length, size: docs.length };
          });
        }
      };
    }
    return q({});
  }
  var DB = { doc: doc, collection: collection };

  /* ---------- 실시간 동기화 ---------- */
  var channel = null;
  function startRealtime() {
    try {
      channel = sb.channel('planner-' + uid)
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: 'user_id=eq.' + uid }, function (p) {
          var path = (p.new && p.new.path) || (p.old && p.old.path);
          if (path) notify(path);
        })
        .subscribe();
    } catch (e) { /* 실시간이 안 되면 아래 다시 불러오기로 충분 */ }
    var last = 0;
    function refreshAll() {
      if (document.hidden || Date.now() - last < 5000) return;
      last = Date.now();
      Object.keys(listeners).forEach(notify);
    }
    document.addEventListener('visibilitychange', refreshAll);
    window.addEventListener('focus', refreshAll);
    window.addEventListener('online', refreshAll);
    setInterval(function () { last = 0; refreshAll(); }, 60000);
  }

  /* ---------- 내려받기(.json·.ics): 브라우저 기본 방식 ---------- */
  var DL = {
    save: async function (o) {
      var data = o.data, filename = o.filename;
      var b = data instanceof Blob ? data : new Blob([data], {
        type: /\.json$/.test(filename) ? 'application/json' : /\.ics$/.test(filename) ? 'text/calendar' : 'application/octet-stream'
      });
      var u = URL.createObjectURL(b), a = document.createElement('a');
      a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
    }
  };

  /* ---------- 본체가 부르는 window.claude.use ---------- */
  window.claude = {
    supabase: true,
    use: async function (name) {
      if (name === 'db') { await ready; return DB; }
      if (name === 'downloads') return DL;
      // assets(첨부)·sample(AI 분류)은 아직 없음 → 개발목표 5-1 순서대로 되살릴 예정
      throw new Error('not_available:' + name);
    }
  };
  window.GN_SUPABASE = { client: sb, signOut: signOut, get email() { return userEmail; } };

  /* ---------- 로그인 화면 ---------- */
  var CSS =
    '#gnLogin{position:fixed;inset:0;z-index:2147483000;background:#F6F8FC;display:flex;align-items:center;justify-content:center;padding:16px;font:15px -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#20324B}' +
    '#gnLogin .card{width:100%;max-width:380px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(37,70,111,.12),0 1px 3px rgba(37,70,111,.08);padding:28px 24px}' +
    '#gnLogin h2{margin:0 0 4px;font-size:22px;color:#25466F}#gnLogin p{margin:0 0 18px;color:#5b6b82;font-size:14px;line-height:1.5}' +
    '#gnLogin label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}' +
    '#gnLogin input{width:100%;box-sizing:border-box;height:46px;border:1px solid #cfd8e6;border-radius:10px;padding:0 12px;font-size:16px;color:#20324B;background:#fff}' +
    '#gnLogin input:focus{outline:2px solid #25466F;outline-offset:1px}' +
    '#gnLogin input.code{letter-spacing:8px;font-size:22px;text-align:center;font-variant-numeric:tabular-nums}' +
    '#gnLogin button{width:100%;height:46px;margin-top:12px;border:0;border-radius:10px;background:#25466F;color:#fff;font-size:16px;font-weight:600;cursor:pointer;box-shadow:0 2px 0 #18304f}' +
    '#gnLogin button:disabled{opacity:.6;cursor:default}' +
    '#gnLogin button.link{background:none;color:#25466F;box-shadow:none;height:auto;margin-top:14px;font-size:14px;font-weight:500;text-decoration:underline}' +
    '#gnLogin .msg{min-height:20px;margin-top:10px;font-size:13px;color:#b42318}#gnLogin .msg.ok{color:#1f7a4d}' +
    '#gnAcct{position:fixed;z-index:2147482000;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(37,70,111,.18);padding:12px 14px;font:14px -apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif;color:#20324B;min-width:200px}' +
    '#gnAcct .em{font-size:13px;color:#5b6b82;margin-bottom:8px;word-break:break-all}' +
    '#gnAcct button{width:100%;height:36px;border:1px solid #cfd8e6;border-radius:8px;background:#fff;color:#20324B;font-size:14px;cursor:pointer}';

  function addCss() {
    if (document.getElementById('gnLoginCss')) return;
    var st = document.createElement('style'); st.id = 'gnLoginCss'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  function onBody(fn) {
    if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn);
  }
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function authMsg(e) {
    var m = (e && (e.code || e.message)) || '';
    if (/rate|429|too many|security purposes/i.test(m) || (e && e.status === 429)) return '요청이 너무 잦아요. 1분쯤 기다렸다가 다시 해 보세요.';
    if (/signup|not allowed|otp_disabled/i.test(m)) return '등록된 이메일이 아니에요. 처음 쓰는 이메일이면 Supabase에서 가입 허용을 확인해 주세요.';
    if (/expired|invalid|token/i.test(m)) return '코드가 맞지 않거나 시간이 지났어요. 다시 확인하거나 새 코드를 받아 주세요.';
    if (/fetch|network/i.test(m)) return '인터넷 연결을 확인해 주세요.';
    return '잘 되지 않았어요: ' + m;
  }

  function showLogin() {
    onBody(function () {
      addCss();
      var box = document.createElement('div');
      box.id = 'gnLogin';
      box.innerHTML =
        '<div class="card" role="dialog" aria-labelledby="gnLt">' +
        '<h2 id="gnLt">성장노트</h2>' +
        '<div id="gnS1"><p>이메일로 로그인 코드를 보내 드려요.</p>' +
        '<label for="gnEmail">이메일</label><input id="gnEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com">' +
        '<button id="gnSend" type="button">코드 받기</button></div>' +
        '<div id="gnS2" hidden><p id="gnS2p"></p>' +
        '<label for="gnCode">로그인 코드</label><input id="gnCode" class="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="······">' +
        '<button id="gnVerify" type="button">로그인</button>' +
        '<button id="gnBack" class="link" type="button">이메일 바꾸기 · 코드 다시 받기</button></div>' +
        '<div class="msg" id="gnMsg" role="status"></div></div>';
      document.body.appendChild(box);
      var $ = function (id) { return document.getElementById(id); };
      var email = $('gnEmail'), code = $('gnCode'), msg = $('gnMsg');
      email.value = lsGet('gn-email');
      function say(t, ok) { msg.textContent = t || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
      function step(n) {
        $('gnS1').hidden = n !== 1; $('gnS2').hidden = n !== 2;
        setTimeout(function () { (n === 1 ? email : code).focus(); }, 30);
      }
      async function send() {
        var v = email.value.trim();
        if (!/^\S+@\S+\.\S+$/.test(v)) { say('이메일 주소를 확인해 주세요.'); return; }
        $('gnSend').disabled = true; say('보내는 중…', true);
        try {
          var r = await sb.auth.signInWithOtp({ email: v, options: { emailRedirectTo: location.origin + location.pathname } });
          if (r.error) throw r.error;
          lsSet('gn-email', v);
          $('gnS2p').textContent = v + ' 로 보낸 코드를 입력해 주세요. (메일이 안 보이면 스팸함도 확인)';
          code.value = ''; say(''); step(2);
        } catch (e) { say(authMsg(e)); }
        $('gnSend').disabled = false;
      }
      async function verify() {
        var t = code.value.replace(/\D/g, '');
        if (t.length < 6) { say('코드 6자리를 입력해 주세요.'); return; }
        $('gnVerify').disabled = true; say('확인하는 중…', true);
        try {
          var r = await sb.auth.verifyOtp({ email: email.value.trim(), token: t, type: 'email' });
          if (r.error) throw r.error;
          // 이후 onAuthStateChange가 로그인 처리
        } catch (e) { say(authMsg(e)); $('gnVerify').disabled = false; }
      }
      $('gnSend').onclick = send;
      $('gnVerify').onclick = verify;
      $('gnBack').onclick = function () { say(''); step(1); };
      email.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) send(); });
      code.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) verify(); });
      code.addEventListener('input', function () { if (code.value.replace(/\D/g, '').length === 6 && code.value.replace(/\D/g, '') === code.value) verify(); });
      step(1);
    });
  }
  function hideLogin() { var b = document.getElementById('gnLogin'); if (b) b.remove(); }

  function showFatal(t) {
    function f() {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#F6F8FC;color:#20324B;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:16px sans-serif';
      d.textContent = t; document.body.appendChild(d);
    }
    if (document.body) f(); else document.addEventListener('DOMContentLoaded', f);
  }

  /* ---------- 계정 버튼(로그아웃) ---------- */
  function addAccountButton() {
    onBody(function () {
      if (document.getElementById('gnAcctBtn')) return;
      var save = document.getElementById('savebtn');
      if (!save) return;
      addCss();
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ibtn'; b.id = 'gnAcctBtn';
      b.title = '계정 · 로그아웃'; b.setAttribute('aria-label', '계정 · 로그아웃');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
      save.parentNode.insertBefore(b, save);
      b.onclick = function (ev) {
        ev.stopPropagation();
        var old = document.getElementById('gnAcct'); if (old) { old.remove(); return; }
        var p = document.createElement('div'); p.id = 'gnAcct';
        p.innerHTML = '<div class="em"></div><button type="button">로그아웃</button>';
        p.querySelector('.em').textContent = userEmail + ' 로 로그인됨';
        p.querySelector('button').onclick = function () { signOut(); };
        document.body.appendChild(p);
        var r = b.getBoundingClientRect();
        p.style.top = (r.bottom + 6) + 'px';
        p.style.right = Math.max(8, innerWidth - r.right) + 'px';
        setTimeout(function () {
          document.addEventListener('click', function h(e) { if (!p.contains(e.target)) { p.remove(); document.removeEventListener('click', h); } });
        }, 0);
      };
    });
  }

  async function signOut() {
    try { if (typeof flushNow === 'function') flushNow(); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 600); });
    try { await sb.auth.signOut(); } catch (e) {}
    // 이 기기에 남은 임시본·되돌리기 기록 지우기(다른 사람이 같은 기기를 쓸 수 있으므로)
    ['planner_hist', 'planner_draft'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    location.reload();
  }

  /* ---------- 시작 ---------- */
  function signedIn(session) {
    if (uid) return;
    uid = session.user.id; userEmail = session.user.email || '';
    hideLogin(); addAccountButton(); startRealtime();
    resolveReady();
  }
  sb.auth.onAuthStateChange(function (ev, session) {
    if (session && session.user) signedIn(session);
    else if (ev === 'SIGNED_OUT' && uid) location.reload();
  });
  sb.auth.getSession().then(function (r) {
    var s = r && r.data && r.data.session;
    if (s && s.user) signedIn(s); else showLogin();
  }, function () { showLogin(); });
})();
