// ════════════════════════════════════════════════════════════════════
//  KAMI MUSIC API — pages/api/playlists.js
//  Lưu playlist vào Redis Upstash
//  Endpoint phụ: /api/playlists/songs (POST/DELETE thêm/xóa bài)
// ════════════════════════════════════════════════════════════════════

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

const PL_KEY = 'music:playlists';
const MAX_PL = 500;
const MAX_SONGS_PER_PL = 200;

async function getAll() {
  if (!redis) return [];
  try {
    const data = await redis.get(PL_KEY);
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getAll error:', e);
    return [];
  }
}

async function saveAll(list) {
  if (!redis) return false;
  try {
    await redis.set(PL_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('saveAll error:', e);
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  // Phân biệt endpoint /playlists vs /playlists/songs
  const isSongsEndpoint = (req.url || '').includes('/songs');

  // ── GET: lấy danh sách tất cả playlist ────────────────────────────
  if (req.method === 'GET') {
    try {
      const list = await getAll();
      const { limit = '500', offset = '0' } = req.query;
      const off = parseInt(offset) || 0;
      const lim = parseInt(limit) || 500;
      return res.status(200).json({
        success: true,
        playlists: list.slice(off, off + lim),
        total: list.length,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST /playlists: tạo playlist mới ─────────────────────────────
  if (req.method === 'POST' && !isSongsEndpoint) {
    try {
      const { id, name, userId, ownerName } = req.body;

      if (!id || !name || !userId)
        return res.status(400).json({ success: false, error: 'Thiếu id/name/userId' });
      if (!String(userId).startsWith('user_'))
        return res.status(400).json({ success: false, error: 'userId không hợp lệ' });

      const list = await getAll();

      if (list.some(p => p.id === String(id)))
        return res.status(200).json({ success: true, duplicate: true });

      if (list.length >= MAX_PL)
        return res.status(429).json({ success: false, error: `Đã đạt giới hạn ${MAX_PL} playlist` });

      const pl = {
        id: String(id),
        name: String(name).substring(0, 100),
        userId: String(userId),
        ownerName: String(ownerName || userId).substring(0, 50),
        songs: [],
        date: Math.floor(Date.now() / 1000),
      };

      list.unshift(pl);
      await saveAll(list);

      console.log(`✅ Tạo playlist: "${pl.name}" bởi ${userId}`);
      return res.status(200).json({ success: true, playlist: pl, total: list.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST /playlists/songs: thêm bài vào playlist ───────────────────
  if (req.method === 'POST' && isSongsEndpoint) {
    try {
      const { id, song, userId } = req.body;

      if (!id || !song || !userId)
        return res.status(400).json({ success: false, error: 'Thiếu id/song/userId' });

      const list = await getAll();
      const pl = list.find(p => p.id === String(id));
      if (!pl)
        return res.status(404).json({ success: false, error: 'Không tìm thấy playlist' });

      const isAdmin = req.body.adminKey && req.body.adminKey === process.env.ADMIN_KEY;
      if (!isAdmin && pl.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Không có quyền chỉnh sửa' });

      if (!pl.songs) pl.songs = [];

      if (pl.songs.some(s => s.id === song.id))
        return res.status(200).json({ success: true, duplicate: true });

      if (pl.songs.length >= MAX_SONGS_PER_PL)
        return res.status(429).json({ success: false, error: `Playlist đã đầy (${MAX_SONGS_PER_PL} bài)` });

      pl.songs.push({
        id: song.id,
        name: String(song.name || '').substring(0, 200),
        size: parseInt(song.size) || 0,
        userId: song.userId || '',
        date: parseInt(song.date) || 0,
      });

      await saveAll(list);
      return res.status(200).json({ success: true, total: pl.songs.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── DELETE /playlists/songs: xóa bài khỏi playlist ────────────────
  if (req.method === 'DELETE' && isSongsEndpoint) {
    try {
      const { id, idx, userId, adminKey } = req.body;

      if (!id || idx === undefined || !userId)
        return res.status(400).json({ success: false, error: 'Thiếu id/idx/userId' });

      const list = await getAll();
      const pl = list.find(p => p.id === String(id));
      if (!pl)
        return res.status(404).json({ success: false, error: 'Không tìm thấy playlist' });

      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;
      if (!isAdmin && pl.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Không có quyền' });

      const i = parseInt(idx);
      if (isNaN(i) || i < 0 || i >= (pl.songs || []).length)
        return res.status(400).json({ success: false, error: 'Index không hợp lệ' });

      pl.songs.splice(i, 1);
      await saveAll(list);
      return res.status(200).json({ success: true, total: pl.songs.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── DELETE /playlists: xóa cả playlist ────────────────────────────
  if (req.method === 'DELETE' && !isSongsEndpoint) {
    try {
      const { id, userId, adminKey } = req.body;

      if (!id)
        return res.status(400).json({ success: false, error: 'Thiếu id' });

      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;

      if (!isAdmin && !userId)
        return res.status(400).json({ success: false, error: 'Thiếu userId hoặc adminKey' });

      const list = await getAll();
      const idx = list.findIndex(p => p.id === String(id));

      if (idx < 0)
        return res.status(200).json({ success: true, notFound: true });

      if (!isAdmin && list[idx].userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Không có quyền xóa' });

      const deleted = list.splice(idx, 1)[0];
      await saveAll(list);

      console.log(`🗑 Xóa playlist: "${deleted.name}" bởi ${isAdmin ? 'ADMIN' : userId}`);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
