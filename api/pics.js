import { Redis } from '@upstash/redis';
const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;
let redis = null;
if (REDIS_ENABLED) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  } catch (e) {
    console.error('Redis init error:', e);
  }
}
const ALBUM_KEY = 'album:pics';
const MAX_PICS = 50000;
// ── Format compact: {i,n,s,m,d,u,c} ───────────────────────────────────
// i = file_id (Telegram)   n = name   s = size
// m = message_id           d = date   u = userId
// c = channel (0=Kho1, 1=Kho KAMI, 2=Kho3, 3=Kho4, 4=Kho5)
function pack(pic) {
  return {
    i: String(pic.id   || pic.i  || ''),
    n: String(pic.name || pic.n  || '').substring(0, 200),
    s: parseInt(pic.size || pic.s) || 0,
    m: parseInt(pic.message_id || pic.m) || 0,
    d: parseInt(pic.date || pic.d) || Math.floor(Date.now() / 1000),
    u: String(pic.userId || pic.u || ''),
    c: parseInt(pic.channel != null ? pic.channel : pic.c) || 0
  };
}
function expand(c) {
  return {
    id:         c.i,
    name:       c.n,
    size:       c.s,
    message_id: c.m,
    date:       c.d,
    userId:     c.u,
    channel:    c.c || 0
  };
}
async function getLibrary() {
  if (!redis) return [];
  try {
    const data = await redis.get(ALBUM_KEY);
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getLibrary error:', e);
    return [];
  }
}
async function saveLibrary(pics) {
  if (!redis) return false;
  try {
    await redis.set(ALBUM_KEY, JSON.stringify(pics));
    return true;
  } catch (e) {
    console.error('saveLibrary error:', e);
    return false;
  }
}
const LOCK_KEY = 'album:lock';
const LOCK_TTL_MS = 10000;
const LOCK_MAX_WAIT_MS = 8000;
const LOCK_RETRY_MS = 80;
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function acquireLock() {
  if (!redis) return null;
  const token = Math.random().toString(36).slice(2) + Date.now();
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT_MS) {
    try {
      const ok = await redis.set(LOCK_KEY, token, { nx: true, px: LOCK_TTL_MS });
      if (ok) return token;
    } catch (e) {
      console.error('acquireLock error:', e);
    }
    await _sleep(LOCK_RETRY_MS);
  }
  return null;
}
async function releaseLock(token) {
  if (!redis || !token) return;
  try {
    const cur = await redis.get(LOCK_KEY);
    if (cur === token) await redis.del(LOCK_KEY);
  } catch (e) {
    console.error('releaseLock error:', e);
  }
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });
  if (req.method === 'GET') {
    try {
      const { q, limit = '50000', offset = '0', sort = 'newest' } = req.query;
      const pics = await getLibrary(); // compact []
      if (q && q.trim()) {
        const query = q.trim().toLowerCase();
        const results = pics.filter(s =>
          (s.n || '').toLowerCase().includes(query) ||
          (s.u || '').toLowerCase().includes(query)
        );
        return res.status(200).json({
          success: true,
          pics:    results.slice(0, parseInt(limit) || 100).map(expand),
          total:   results.length
        });
      }
      const sorted = [...pics].sort((a, b) =>
        sort === 'oldest' ? (a.d || 0) - (b.d || 0) : (b.d || 0) - (a.d || 0)
      );
      const off  = parseInt(offset) || 0;
      const lim  = parseInt(limit)  || 50000;
      const page = sorted.slice(off, off + lim);
      const uniqueUsers = new Set(pics.map(s => s.u).filter(Boolean)).size;
      return res.status(200).json({
        success: true,
        pics:    page.map(expand),
        total:   pics.length,
        hasMore: (off + lim) < pics.length,
        stats:   { totalPics: pics.length, uniqueUsers }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
  if (req.method === 'POST') {
    let lockToken = null;
    try {
      lockToken = await acquireLock();
      if (!lockToken)
        return res.status(503).json({ success: false, error: 'Server bận, thử lại sau' });
      // Chấp nhận cả format cũ (id,name,userId) lẫn mới (i,n,u)
      const body = req.body;
      const id     = body.id || body.i;
      const name   = body.name || body.n;
      const userId = body.userId || body.u;
      if (!id || !name || !userId)
        return res.status(400).json({ success: false, error: 'Thiếu: id/i, name/n, userId/u' });
      if (!String(userId).startsWith('user_'))
        return res.status(400).json({ success: false, error: 'userId không hợp lệ' });
      const pics = await getLibrary();
      const msgId = parseInt(body.message_id || body.m) || 0;
      const channel = parseInt(body.channel != null ? body.channel : body.c) || 0;
      const norm = (s) => String(s || '')
        .toLowerCase()
        .replace(/\.[a-z0-9]{1,5}$/, '')
        .replace(/[\s_.-]+/g, '');
      const nName = norm(name);
      const dup = pics.some(s =>
        s.i === String(id) ||
        (msgId > 0 && s.m === msgId && (s.c || 0) === channel) ||
        norm(s.n) === nName
      );
      if (dup) return res.status(200).json({ success: true, duplicate: true });
      if (pics.length >= MAX_PICS)
        return res.status(429).json({ success: false, error: `Thư viện đầy (${MAX_PICS})` });
      const compact = pack({ ...body, id, name, userId });
      pics.unshift(compact);
      await saveLibrary(pics);
      return res.status(200).json({ success: true, pic: expand(compact), total: pics.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    } finally {
      await releaseLock(lockToken);
    }
  }
  if (req.method === 'DELETE') {
    let lockToken = null;
    try {
      lockToken = await acquireLock();
      if (!lockToken)
        return res.status(503).json({ success: false, error: 'Server bận, thử lại sau' });
      const id       = req.body.id || req.body.i;
      const userId   = req.body.userId || req.body.u;
      const adminKey = req.body.adminKey;
      if (!id)
        return res.status(400).json({ success: false, error: 'Thiếu id' });
      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;
      if (!isAdmin && !userId)
        return res.status(400).json({ success: false, error: 'Thiếu userId hoặc adminKey' });
      const pics = await getLibrary();
      const idx   = pics.findIndex(s => s.i === String(id));
      if (idx < 0) return res.status(200).json({ success: true, ok: true, notFound: true });
      if (!isAdmin && pics[idx].u !== String(userId))
        return res.status(403).json({ success: false, error: 'Không có quyền xóa' });
      const deleted = pics.splice(idx, 1)[0];
      await saveLibrary(pics);
      console.log(`🗑 Xóa: "${deleted.n}" bởi ${isAdmin ? 'ADMIN' : userId}`);
      return res.status(200).json({ success: true, ok: true, isAdmin });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    } finally {
      await releaseLock(lockToken);
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
