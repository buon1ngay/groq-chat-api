// ════════════════════════════════════════════════════════════════════════
//  KAMI MUSIC — pages/api/playlists.js
//  Playlist chỉ lưu danh sách file_id (songIds[])
//  XÓA playlist = xóa danh sách, KHÔNG xóa bài hát gốc trong music:library
// ════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;
let redis = null;
if (REDIS_ENABLED) {
  try {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
  } catch (e) { console.error('Redis init error:', e); }
}

const PL_KEY    = 'music:playlists';
const MAX_PL    = 200;   // tối đa 200 playlist toàn hệ thống
const MAX_SONGS = 500;   // tối đa 500 bài / playlist

// ── Helpers ───────────────────────────────────────────────────────────
async function getAll() {
  if (!redis) return [];
  try {
    const data = await redis.get(PL_KEY);
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.error('getAll error:', e); return []; }
}

async function saveAll(list) {
  if (!redis) return false;
  try { await redis.set(PL_KEY, JSON.stringify(list)); return true; }
  catch (e) { console.error('saveAll error:', e); return false; }
}

function makeId() {
  return 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

// ── Handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  // ── GET: lấy tất cả playlist (public) ────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { id } = req.query;
      const list = await getAll();
      // Lấy 1 playlist cụ thể
      if (id) {
        const pl = list.find(p => p.id === id);
        if (!pl) return res.status(404).json({ success: false, error: 'Không tìm thấy playlist' });
        return res.status(200).json({ success: true, playlist: pl });
      }
      // Trả tất cả, sắp xếp mới nhất trước
      const sorted = [...list].sort((a, b) => (b.date || 0) - (a.date || 0));
      return res.status(200).json({ success: true, playlists: sorted, total: sorted.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST ──────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, userId, playlistId, songId, name } = req.body || {};

    if (!userId || !String(userId).startsWith('user_'))
      return res.status(400).json({ success: false, error: 'userId không hợp lệ' });

    // --- Tạo playlist mới ---
    if (action === 'create') {
      if (!name || !String(name).trim())
        return res.status(400).json({ success: false, error: 'Thiếu tên playlist' });

      const list = await getAll();
      if (list.length >= MAX_PL)
        return res.status(429).json({ success: false, error: `Hệ thống đã đủ ${MAX_PL} playlist` });

      const trimmed = String(name).trim().substring(0, 60);
      // Không cho trùng tên trong cùng userId
      const dup = list.some(p => p.owner === userId && p.name.toLowerCase() === trimmed.toLowerCase());
      if (dup) return res.status(400).json({ success: false, error: 'Bạn đã có playlist tên này' });

      const pl = {
        id:      makeId(),
        name:    trimmed,
        owner:   userId,
        songIds: [],                          // chỉ lưu file_id
        date:    Math.floor(Date.now() / 1000)
      };
      list.unshift(pl);
      await saveAll(list);
      return res.status(200).json({ success: true, playlist: pl });
    }

    // --- Thêm bài vào playlist ---
    if (action === 'add') {
      if (!playlistId || !songId)
        return res.status(400).json({ success: false, error: 'Thiếu playlistId hoặc songId' });

      const list = await getAll();
      const idx  = list.findIndex(p => p.id === playlistId);
      if (idx < 0) return res.status(404).json({ success: false, error: 'Playlist không tồn tại' });

      // Bất kỳ user nào cũng thêm được bài
      if (list[idx].songIds.length >= MAX_SONGS)
        return res.status(429).json({ success: false, error: `Playlist đã đủ ${MAX_SONGS} bài` });

      if (list[idx].songIds.includes(String(songId)))
        return res.status(200).json({ success: true, duplicate: true });

      list[idx].songIds.push(String(songId));
      await saveAll(list);
      return res.status(200).json({ success: true, total: list[idx].songIds.length });
    }

    // --- Xóa bài khỏi playlist ---
    if (action === 'remove') {
      if (!playlistId || !songId)
        return res.status(400).json({ success: false, error: 'Thiếu playlistId hoặc songId' });

      const list = await getAll();
      const idx  = list.findIndex(p => p.id === playlistId);
      if (idx < 0) return res.status(404).json({ success: false, error: 'Playlist không tồn tại' });

      // Chỉ chủ playlist mới xóa bài khỏi playlist
      if (list[idx].owner !== userId)
        return res.status(403).json({ success: false, error: 'Chỉ chủ playlist mới được xóa bài' });

      const before = list[idx].songIds.length;
      list[idx].songIds = list[idx].songIds.filter(id => id !== String(songId));
      if (list[idx].songIds.length === before)
        return res.status(200).json({ success: true, notFound: true });

      await saveAll(list);
      return res.status(200).json({ success: true, total: list[idx].songIds.length });
    }

    // --- Đổi tên playlist ---
    if (action === 'rename') {
      if (!playlistId || !name)
        return res.status(400).json({ success: false, error: 'Thiếu playlistId hoặc name' });

      const list = await getAll();
      const idx  = list.findIndex(p => p.id === playlistId);
      if (idx < 0) return res.status(404).json({ success: false, error: 'Playlist không tồn tại' });
      if (list[idx].owner !== userId)
        return res.status(403).json({ success: false, error: 'Chỉ chủ playlist mới được đổi tên' });

      list[idx].name = String(name).trim().substring(0, 60);
      await saveAll(list);
      return res.status(200).json({ success: true, playlist: list[idx] });
    }

    return res.status(400).json({ success: false, error: 'action không hợp lệ' });
  }

  // ── DELETE: xóa toàn bộ playlist (chỉ chủ) ───────────────────────────
  // ⚠️ CHỈ XÓA DANH SÁCH — bài hát gốc trong music:library KHÔNG bị ảnh hưởng
  if (req.method === 'DELETE') {
    try {
      const { userId, playlistId, adminKey } = req.body || {};

      if (!playlistId)
        return res.status(400).json({ success: false, error: 'Thiếu playlistId' });

      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;

      if (!isAdmin && (!userId || !String(userId).startsWith('user_')))
        return res.status(400).json({ success: false, error: 'Thiếu userId hoặc adminKey' });

      const list = await getAll();
      const idx  = list.findIndex(p => p.id === playlistId);

      if (idx < 0) return res.status(200).json({ success: true, notFound: true });

      if (!isAdmin && list[idx].owner !== userId)
        return res.status(403).json({ success: false, error: 'Chỉ chủ playlist mới được xóa' });

      const deleted = list.splice(idx, 1)[0];
      await saveAll(list);

      // Log rõ ràng để không nhầm với xóa bài hát
      console.log(`🗑 Xóa PLAYLIST "${deleted.name}" (${deleted.songIds.length} bài) bởi ${isAdmin ? 'ADMIN' : userId} — bài hát gốc KHÔNG bị xóa`);

      return res.status(200).json({
        success:  true,
        deleted:  { id: deleted.id, name: deleted.name, songCount: deleted.songIds.length },
        note:     'Đã xóa playlist. Bài hát gốc trong thư viện không bị ảnh hưởng.'
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
