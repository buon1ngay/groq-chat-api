// ════════════════════════════════════════════════════════════════════════
//  KAMI MUSIC — pages/api/playlists.js
//  Single-file handler, action-based (giống songs.js)
//  XÓA playlist = xóa danh sách, KHÔNG xóa bài gốc trong music:library
//  Khi bài hát bị xóa khỏi library → auto-clean khỏi playlist khi GET
// ════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;
let redis = null;
if (REDIS_ENABLED) {
  try {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
  } catch (e) { console.error('Redis init:', e); }
}

const PL_KEY   = 'music:playlists';
const LIB_KEY  = 'music:library';
const MAX_PL   = 500;
const MAX_SONGS = 200;

async function getAll() {
  if (!redis) return [];
  try {
    const d = await redis.get(PL_KEY);
    if (!d) return [];
    const a = typeof d === 'string' ? JSON.parse(d) : d;
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

async function saveAll(list) {
  if (!redis) return false;
  try { await redis.set(PL_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }
}

// Lấy tập hợp id bài hát còn tồn tại trong library
async function getLiveIds() {
  try {
    const d = await redis.get(LIB_KEY);
    if (!d) return null; // null = không kiểm được, bỏ qua
    const a = typeof d === 'string' ? JSON.parse(d) : d;
    if (!Array.isArray(a)) return null;
    return new Set(a.map(s => String(s.i || s.id || '')).filter(Boolean));
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  // ── GET: lấy tất cả playlist, auto-clean bài đã xóa ─────────────────
  if (req.method === 'GET') {
    try {
      let list = await getAll();
      const liveIds = await getLiveIds();
      let dirty = false;

      if (liveIds) {
        list = list.map(pl => {
          const before = (pl.songs || []).length;
          pl.songs = (pl.songs || []).filter(s => liveIds.has(String(s.id || s.i || '')));
          if (pl.songs.length !== before) dirty = true;
          return pl;
        });
        if (dirty) saveAll(list); // lưu lại không cần await
      }

      return res.status(200).json({ success: true, playlists: list, total: list.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST: action-based ────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { action, userId, playlistId, adminKey } = body;
    const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;

    if (!isAdmin && (!userId || !String(userId).startsWith('user_')))
      return res.status(400).json({ success: false, error: 'userId không hợp lệ' });

    // --- Tạo playlist ---
    if (action === 'create') {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ success: false, error: 'Thiếu tên playlist' });

      const list = await getAll();
      if (list.length >= MAX_PL)
        return res.status(429).json({ success: false, error: `Hệ thống đạt giới hạn ${MAX_PL} playlist` });

      const dup = list.some(p => p.userId === userId && p.name.toLowerCase() === name.toLowerCase());
      if (dup) return res.status(400).json({ success: false, error: 'Bạn đã có playlist tên này' });

      const pl = {
        id:    'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name:  name.substring(0, 100),
        userId: String(userId),
        songs: [],
        date:  Math.floor(Date.now() / 1000),
      };
      list.unshift(pl);
      await saveAll(list);
      return res.status(200).json({ success: true, playlist: pl });
    }

    // --- Thêm bài vào playlist ---
    if (action === 'add') {
      const { song } = body; // song = { id, name, size, ... }
      if (!playlistId || !song || !song.id)
        return res.status(400).json({ success: false, error: 'Thiếu playlistId hoặc song' });

      const list = await getAll();
      const pl = list.find(p => p.id === playlistId);
      if (!pl) return res.status(404).json({ success: false, error: 'Playlist không tồn tại' });

      if (!isAdmin && pl.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ playlist mới được thêm bài' });

      if (!pl.songs) pl.songs = [];
      if (pl.songs.some(s => String(s.id) === String(song.id)))
        return res.status(200).json({ success: true, duplicate: true });

      if (pl.songs.length >= MAX_SONGS)
        return res.status(429).json({ success: false, error: `Playlist đã đầy (${MAX_SONGS} bài)` });

      pl.songs.push({ id: String(song.id), name: String(song.name || '').substring(0, 200), size: parseInt(song.size) || 0 });
      await saveAll(list);
      return res.status(200).json({ success: true, total: pl.songs.length });
    }

    // --- Thêm nhiều bài cùng lúc ---
    if (action === 'addMany') {
      const { songs } = body;
      if (!playlistId || !Array.isArray(songs))
        return res.status(400).json({ success: false, error: 'Thiếu playlistId hoặc songs[]' });

      const list = await getAll();
      const pl = list.find(p => p.id === playlistId);
      if (!pl) return res.status(404).json({ success: false, error: 'Playlist không tồn tại' });

      if (!isAdmin && pl.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ playlist mới được thêm bài' });

      if (!pl.songs) pl.songs = [];
      let added = 0;
      for (const song of songs) {
        if (!song || !song.id) continue;
        if (pl.songs.some(s => String(s.id) === String(song.id))) continue;
        if (pl.songs.length >= MAX_SONGS) break;
        pl.songs.push({ id: String(song.id), name: String(song.name || '').substring(0, 200), size: parseInt(song.size) || 0 });
        added++;
      }
      await saveAll(list);
      return res.status(200).json({ success: true, added, total: pl.songs.length });
    }

    // --- Xóa bài khỏi playlist (theo id bài) ---
    if (action === 'removeSong') {
      const { songId } = body;
      if (!playlistId || !songId)
        return res.status(400).json({ success: false, error: 'Thiếu playlistId hoặc songId' });

      const list = await getAll();
      const pl = list.find(p => p.id === playlistId);
      if (!pl) return res.status(404).json({ success: false, error: 'Playlist không tồn tại' });

      if (!isAdmin && pl.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ playlist mới được xóa bài' });

      pl.songs = (pl.songs || []).filter(s => String(s.id) !== String(songId));
      await saveAll(list);
      return res.status(200).json({ success: true, total: pl.songs.length });
    }

    return res.status(400).json({ success: false, error: `action không hợp lệ: ${action}` });
  }

  // ── DELETE: xóa cả playlist (chủ hoặc admin) ─────────────────────────
  // ⚠️ CHỈ XÓA DANH SÁCH — bài gốc trong music:library KHÔNG bị ảnh hưởng
  if (req.method === 'DELETE') {
    try {
      const { userId, playlistId, adminKey } = req.body || {};
      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;

      if (!playlistId) return res.status(400).json({ success: false, error: 'Thiếu playlistId' });
      if (!isAdmin && (!userId || !String(userId).startsWith('user_')))
        return res.status(400).json({ success: false, error: 'Thiếu userId hoặc adminKey' });

      const list = await getAll();
      const idx = list.findIndex(p => p.id === playlistId);
      if (idx < 0) return res.status(200).json({ success: true, notFound: true });

      if (!isAdmin && list[idx].userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ playlist hoặc admin mới được xóa' });

      const deleted = list.splice(idx, 1)[0];
      await saveAll(list);
      console.log(`🗑 Xóa PLAYLIST "${deleted.name}" — bài hát gốc KHÔNG bị xóa`);
      return res.status(200).json({ success: true, note: 'Đã xóa playlist. Bài hát gốc không bị ảnh hưởng.' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
