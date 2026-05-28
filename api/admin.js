export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Kami Music Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{background:#0a0a14;color:#e8e8f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh}
.login{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;gap:16px}
.logo{font-size:48px;margin-bottom:8px}
h1{font-size:22px;font-weight:800;background:linear-gradient(135deg,#a78bfa,#f472b6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
input{width:100%;max-width:320px;background:rgba(255,255,255,0.06);border:1.5px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px 16px;color:#e8e8f0;font-size:16px;outline:none;text-align:center;letter-spacing:4px}
input:focus{border-color:#a78bfa}
.btn{width:100%;max-width:320px;padding:14px;background:linear-gradient(135deg,#a78bfa,#818cf8);border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
.btn:active{opacity:.85}
.btn-del{padding:8px 14px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:8px;color:#ef4444;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}
.btn-del:active{background:rgba(239,68,68,0.3)}
#app{display:none}
.hdr{background:linear-gradient(135deg,#1a0a2e,#0f0f2e);padding:16px;border-bottom:1px solid rgba(167,139,250,0.2);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.hdr-title{font-size:18px;font-weight:800;color:#a78bfa}
.hdr-sub{font-size:12px;color:#555;margin-top:2px}
.btn-logout{padding:8px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#888;font-size:13px;cursor:pointer}
.stats{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.05)}
.stat-box{flex:1;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.15);border-radius:12px;padding:12px;text-align:center}
.stat-num{font-size:24px;font-weight:800;color:#a78bfa}
.stat-lbl{font-size:11px;color:#666;margin-top:2px}
.search-row{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.05)}
.search-row input{width:100%;background:rgba(255,255,255,0.06);border:1.5px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 14px;color:#e8e8f0;font-size:14px;outline:none;letter-spacing:normal}
.search-row input:focus{border-color:#a78bfa}
.list{padding:12px 16px 80px}
.card{display:flex;align-items:center;gap:10px;padding:12px;background:rgba(255,255,255,0.03);border-radius:14px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.05)}
.card-ico{width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,#1a1a3e,#2a1a4e);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.card-meta{flex:1;min-width:0}
.card-name{font-size:13px;font-weight:700;color:#e8e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-uid{font-size:11px;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-info{font-size:11px;color:#555;margin-top:2px}
.empty{text-align:center;padding:60px 20px;color:#444;font-size:15px;line-height:2}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(15,15,46,0.95);color:#a78bfa;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;border:1px solid rgba(167,139,250,0.3);opacity:0;transition:opacity .3s;pointer-events:none;z-index:999;white-space:nowrap}
.toast.on{opacity:1}
.dlg{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:200;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.dlg.on{display:flex}
.db{background:#0f0f2e;border:1px solid rgba(167,139,250,0.3);border-radius:20px;padding:24px;text-align:center;min-width:280px;max-width:88vw}
.dt{font-size:16px;font-weight:700;color:#ef4444;margin-bottom:8px}
.dm{font-size:13px;color:#888;margin-bottom:20px;line-height:1.6;word-break:break-all}
.dbtns{display:flex;gap:10px;justify-content:center}
.dbok{padding:12px 22px;border-radius:10px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;border:none;font-size:14px;font-weight:700;cursor:pointer}
.dbno{padding:12px 22px;border-radius:10px;background:#1a1a3e;color:#a78bfa;border:1px solid rgba(167,139,250,0.3);font-size:14px;cursor:pointer}
.loader{text-align:center;padding:40px;color:#555;font-size:14px}
.spin{width:36px;height:36px;border:3px solid rgba(167,139,250,0.15);border-top-color:#a78bfa;border-radius:50%;animation:sp .8s linear infinite;margin:0 auto 12px}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<!-- Login -->
<div class="login" id="login-screen">
  <div class="logo">🎵</div>
  <h1>Kami Music Admin</h1>
  <p style="color:#555;font-size:13px">Nhập mật khẩu admin để tiếp tục</p>
  <input type="password" id="pw-input" placeholder="Mật khẩu" maxlength="20"
    onkeydown="if(event.key==='Enter')doLogin()">
  <button class="btn" onclick="doLogin()">Đăng nhập</button>
</div>

<!-- App -->
<div id="app">
  <div class="hdr">
    <div>
      <div class="hdr-title">🎵 Admin Panel</div>
      <div class="hdr-sub" id="hdr-sub">Đang tải...</div>
    </div>
    <button class="btn-logout" onclick="logout()">Thoát</button>
  </div>

  <div class="stats">
    <div class="stat-box"><div class="stat-num" id="s-total">-</div><div class="stat-lbl">Bài hát</div></div>
    <div class="stat-box"><div class="stat-num" id="s-users">-</div><div class="stat-lbl">Người dùng</div></div>
  </div>

  <div class="search-row">
    <input id="sq" type="search" placeholder="🔍  Tìm bài hát hoặc userId..."
      oninput="filterList()">
  </div>

  <div class="list" id="song-list">
    <div class="loader"><div class="spin"></div>Đang tải danh sách...</div>
  </div>
</div>

<!-- Confirm dialog -->
<div class="dlg" id="dlg">
  <div class="db">
    <div class="dt">⚠️ Xác nhận xóa</div>
    <div class="dm" id="dlg-msg"></div>
    <div class="dbtns">
      <button class="dbno" onclick="dlgNo()">Hủy</button>
      <button class="dbok" onclick="dlgYes()">Xóa</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = 'https://groq-chat-api.vercel.app/api';
const ADMIN_KEY = '242424';
let ALL_SONGS = [];
let dlgCb = null;

// ── Login ──────────────────────────────────────────────────────────────
function doLogin() {
  const pw = document.getElementById('pw-input').value.trim();
  if (pw !== ADMIN_KEY) { showMsg('Sai mật khẩu!'); return; }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  loadSongs();
}

function logout() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('pw-input').value = '';
}

// ── Load ───────────────────────────────────────────────────────────────
async function loadSongs() {
  try {
    const r = await fetch(API + '/songs?limit=10000&sort=newest');
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    ALL_SONGS = d.songs || [];
    document.getElementById('s-total').textContent = d.stats?.totalSongs ?? ALL_SONGS.length;
    document.getElementById('s-users').textContent = d.stats?.uniqueUsers ?? '?';
    document.getElementById('hdr-sub').textContent =
      (d.stats?.totalSongs ?? ALL_SONGS.length) + ' bài • ' + (d.stats?.uniqueUsers ?? '?') + ' người dùng';
    renderList(ALL_SONGS);
  } catch(e) {
    document.getElementById('song-list').innerHTML =
      '<div class="empty">❌ Lỗi tải dữ liệu:<br>' + e.message + '</div>';
  }
}

// ── Render ─────────────────────────────────────────────────────────────
function renderList(songs) {
  const el = document.getElementById('song-list');
  if (!songs.length) {
    el.innerHTML = '<div class="empty">🎵 Không có bài nào</div>';
    return;
  }
  el.innerHTML = songs.map((s, i) => `
    <div class="card">
      <div class="card-ico">🎵</div>
      <div class="card-meta">
        <div class="card-name">${esc(s.name || 'Unknown')}</div>
        <div class="card-uid">👤 ${esc(s.userId || 'ẩn danh')}</div>
        <div class="card-info">${fmtDate(s.date)} • ${fSz(s.size)}</div>
      </div>
      <button class="btn-del" onclick="confirmDel('${s.id}','${esc(s.name)}','${esc(s.userId)}')">🗑️ Xóa</button>
    </div>
  `).join('');
}

// ── Search filter ──────────────────────────────────────────────────────
function filterList() {
  const q = document.getElementById('sq').value.trim().toLowerCase();
  if (!q) { renderList(ALL_SONGS); return; }
  renderList(ALL_SONGS.filter(s =>
    (s.name || '').toLowerCase().includes(q) ||
    (s.userId || '').toLowerCase().includes(q)
  ));
}

// ── Delete ─────────────────────────────────────────────────────────────
function confirmDel(id, name, userId) {
  document.getElementById('dlg-msg').innerHTML =
    `<b style="color:#e8e8f0">${esc(name)}</b><br><br>` +
    `👤 ${esc(userId)}<br><br>` +
    `<span style="color:#ef4444">Hành động này không thể hoàn tác!</span>`;
  dlgCb = () => doDelete(id, name);
  document.getElementById('dlg').classList.add('on');
}

async function doDelete(id, name) {
  try {
    const r = await fetch(API + '/songs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, adminKey: ADMIN_KEY })
    });
    const d = await r.json();
    if (d.ok || d.notFound) {
      ALL_SONGS = ALL_SONGS.filter(s => s.id !== id);
      document.getElementById('s-total').textContent = ALL_SONGS.length;
      filterList();
      showMsg('✅ Đã xóa: ' + name);
    } else {
      showMsg('❌ Lỗi: ' + (d.error || 'Unknown'));
    }
  } catch(e) {
    showMsg('❌ Lỗi kết nối');
  }
}

function dlgYes() { document.getElementById('dlg').classList.remove('on'); if(dlgCb) dlgCb(); dlgCb=null; }
function dlgNo()  { document.getElementById('dlg').classList.remove('on'); dlgCb=null; }

// ── Utils ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fSz(s) {
  if(!s||s<=0) return '0 B';
  if(s<1024) return s+' B';
  if(s<1048576) return Math.round(s/1024)+' KB';
  return (Math.round(s/1048576*10)/10)+' MB';
}
function fmtDate(ts) {
  if(!ts) return '?';
  const d = new Date(ts * 1000);
  return d.getDate()+'/'+(d.getMonth()+1)+'/'+d.getFullYear();
}
function showMsg(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2500);
}
</script>
</body>
</html>`);
}
