// ════════════════════════════════════════════════════════════════════════
//  KAMI MUSIC API — pages/api/songs.js
//  Compact storage: {i,n,s,m,d,u} thay vì field name dài
//  Tiết kiệm ~40% Redis so với format cũ
//  Auto-migrate bài cũ (format dài) → compact khi đọc
// ════════════════════════════════════════════════════════════════════════

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

const MUSIC_KEY = 'music:library';
const MAX_SONGS = 10000;

// ── Format compact: {i,n,s,m,d,u,c} ───────────────────────────────────
// i = file_id (Telegram)   n = name   s = size
// m = message_id           d = date   u = userId
// c = channel (0 = Channel cũ, 1 = Channel KAMI)

function pack(song) {
  return {
    i: String(song.id   || song.i  || ''),
    n: String(song.name || song.n  || '').substring(0, 200),
    s: parseInt(song.size || song.s) || 0,
    m: parseInt(song.message_id || song.m) || 0,
    d: parseInt(song.date || song.d) || Math.floor(Date.now() / 1000),
    u: String(song.userId || song.u || ''),
    c: parseInt(song.channel != null ? song.channel : song.c) || 0
  };
}

// Expand để client dễ đọc (trả về trong response GET/POST)
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

// ── Redis helpers ──────────────────────────────────────────────────────
async function getLibrary() {
  if (!redis) return [];
  try {
    const data = await redis.get(MUSIC_KEY);
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getLibrary error:', e);
    return [];
  }
}

async function saveLibrary(songs) {
  if (!redis) return false;
  try {
    await redis.set(MUSIC_KEY, JSON.stringify(songs));
    return true;
  } catch (e) {
    console.error('saveLibrary error:', e);
    return false;
  }
}

// ── Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { q, limit = '10000', offset = '0', sort = 'newest' } = req.query;
      const songs = await getLibrary(); // compact []

      if (q && q.trim()) {
        const query = q.trim().toLowerCase();
        const results = songs.filter(s =>
          (s.n || '').toLowerCase().includes(query) ||
          (s.u || '').toLowerCase().includes(query)
        );
        return res.status(200).json({
          success: true,
          songs:   results.slice(0, parseInt(limit) || 100).map(expand),
          total:   results.length
        });
      }

      const sorted = [...songs].sort((a, b) =>
        sort === 'oldest' ? (a.d || 0) - (b.d || 0) : (b.d || 0) - (a.d || 0)
      );

      const off  = parseInt(offset) || 0;
      const lim  = parseInt(limit)  || 10000;
      const page = sorted.slice(off, off + lim);

      const uniqueUsers = new Set(songs.map(s => s.u).filter(Boolean)).size;

      return res.status(200).json({
        success: true,
        songs:   page.map(expand),
        total:   songs.length,
        hasMore: (off + lim) < songs.length,
        stats:   { totalSongs: songs.length, uniqueUsers }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      // Chấp nhận cả format cũ (id,name,userId) lẫn mới (i,n,u)
      const body = req.body;
      const id     = body.id || body.i;
      const name   = body.name || body.n;
      const userId = body.userId || body.u;

      if (!id || !name || !userId)
        return res.status(400).json({ success: false, error: 'Thiếu: id/i, name/n, userId/u' });

      if (!String(userId).startsWith('user_'))
        return res.status(400).json({ success: false, error: 'userId không hợp lệ' });

      const songs = await getLibrary();
      const msgId = parseInt(body.message_id || body.m) || 0;

      const dup = songs.some(s =>
        s.i === String(id) ||
        (msgId > 0 && s.m === msgId)
      );
      if (dup) return res.status(200).json({ success: true, duplicate: true });

      if (songs.length >= MAX_SONGS)
        return res.status(429).json({ success: false, error: `Thư viện đầy (${MAX_SONGS})` });

      const compact = pack({ ...body, id, name, userId });
      songs.unshift(compact);
      await saveLibrary(songs);

      return res.status(200).json({ success: true, song: expand(compact), total: songs.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      const id       = req.body.id || req.body.i;
      const userId   = req.body.userId || req.body.u;
      const adminKey = req.body.adminKey;

      if (!id)
        return res.status(400).json({ success: false, error: 'Thiếu id' });

      // Admin xóa bất kỳ bài nào — chỉ cần đúng ADMIN_KEY trong env Vercel
      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;

      if (!isAdmin && !userId)
        return res.status(400).json({ success: false, error: 'Thiếu userId hoặc adminKey' });

      const songs = await getLibrary();
      const idx   = songs.findIndex(s => s.i === String(id));

      if (idx < 0) return res.status(200).json({ success: true, ok: true, notFound: true });

      if (!isAdmin && songs[idx].u !== String(userId))
        return res.status(403).json({ success: false, error: 'Không có quyền xóa' });

      const deleted = songs.splice(idx, 1)[0];
      await saveLibrary(songs);

      console.log(`🗑 Xóa: "${deleted.n}" bởi ${isAdmin ? 'ADMIN' : userId}`);
      return res.status(200).json({ success: true, ok: true, isAdmin });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}


/*import { Redis } from '@upstash/redis';

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

const MUSIC_KEY = 'music:library';
const MAX_SONGS = 10000;

// ── Format compact: {i,n,s,m,d,u} ─────────────────────────────────────
// i = file_id (Telegram)   n = name   s = size
// m = message_id           d = date   u = userId

function pack(song) {
  return {
    i: String(song.id   || song.i  || ''),
    n: String(song.name || song.n  || '').substring(0, 200),
    s: parseInt(song.size || song.s) || 0,
    m: parseInt(song.message_id || song.m) || 0,
    d: parseInt(song.date || song.d) || Math.floor(Date.now() / 1000),
    u: String(song.userId || song.u || '')
  };
}

// Expand để client dễ đọc (trả về trong response GET/POST)
function expand(c) {
  return {
    id:         c.i,
    name:       c.n,
    size:       c.s,
    message_id: c.m,
    date:       c.d,
    userId:     c.u
  };
}

// ── Redis helpers ──────────────────────────────────────────────────────
async function getLibrary() {
  if (!redis) return [];
  try {
    const data = await redis.get(MUSIC_KEY);
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getLibrary error:', e);
    return [];
  }
}

async function saveLibrary(songs) {
  if (!redis) return false;
  try {
    await redis.set(MUSIC_KEY, JSON.stringify(songs));
    return true;
  } catch (e) {
    console.error('saveLibrary error:', e);
    return false;
  }
}

// ── Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { q, limit = '10000', offset = '0', sort = 'newest' } = req.query;
      const songs = await getLibrary(); // compact []

      if (q && q.trim()) {
        const query = q.trim().toLowerCase();
        const results = songs.filter(s =>
          (s.n || '').toLowerCase().includes(query) ||
          (s.u || '').toLowerCase().includes(query)
        );
        return res.status(200).json({
          success: true,
          songs:   results.slice(0, parseInt(limit) || 100).map(expand),
          total:   results.length
        });
      }

      const sorted = [...songs].sort((a, b) =>
        sort === 'oldest' ? (a.d || 0) - (b.d || 0) : (b.d || 0) - (a.d || 0)
      );

      const off  = parseInt(offset) || 0;
      const lim  = parseInt(limit)  || 10000;
      const page = sorted.slice(off, off + lim);

      const uniqueUsers = new Set(songs.map(s => s.u).filter(Boolean)).size;

      return res.status(200).json({
        success: true,
        songs:   page.map(expand),
        total:   songs.length,
        hasMore: (off + lim) < songs.length,
        stats:   { totalSongs: songs.length, uniqueUsers }
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      // Chấp nhận cả format cũ (id,name,userId) lẫn mới (i,n,u)
      const body = req.body;
      const id     = body.id || body.i;
      const name   = body.name || body.n;
      const userId = body.userId || body.u;

      if (!id || !name || !userId)
        return res.status(400).json({ success: false, error: 'Thiếu: id/i, name/n, userId/u' });

      if (!String(userId).startsWith('user_'))
        return res.status(400).json({ success: false, error: 'userId không hợp lệ' });

      const songs = await getLibrary();
      const msgId = parseInt(body.message_id || body.m) || 0;

      const dup = songs.some(s =>
        s.i === String(id) ||
        (msgId > 0 && s.m === msgId)
      );
      if (dup) return res.status(200).json({ success: true, duplicate: true });

      if (songs.length >= MAX_SONGS)
        return res.status(429).json({ success: false, error: `Thư viện đầy (${MAX_SONGS})` });

      const compact = pack({ ...body, id, name, userId });
      songs.unshift(compact);
      await saveLibrary(songs);

      return res.status(200).json({ success: true, song: expand(compact), total: songs.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── DELETE ────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      const id       = req.body.id || req.body.i;
      const userId   = req.body.userId || req.body.u;
      const adminKey = req.body.adminKey;

      if (!id)
        return res.status(400).json({ success: false, error: 'Thiếu id' });

      // Admin xóa bất kỳ bài nào — chỉ cần đúng ADMIN_KEY trong env Vercel
      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;

      if (!isAdmin && !userId)
        return res.status(400).json({ success: false, error: 'Thiếu userId hoặc adminKey' });

      const songs = await getLibrary();
      const idx   = songs.findIndex(s => s.i === String(id));

      if (idx < 0) return res.status(200).json({ success: true, ok: true, notFound: true });

      if (!isAdmin && songs[idx].u !== String(userId))
        return res.status(403).json({ success: false, error: 'Không có quyền xóa' });

      const deleted = songs.splice(idx, 1)[0];
      await saveLibrary(songs);

      console.log(`🗑 Xóa: "${deleted.n}" bởi ${isAdmin ? 'ADMIN' : userId}`);
      return res.status(200).json({ success: true, ok: true, isAdmin });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
*/
