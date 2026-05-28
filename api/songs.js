// ════════════════════════════════════════════════════════════════════════
//  KAMI MUSIC API — pages/api/songs.js
//  Thư viện nhạc dùng chung — Upstash Redis
//
//  GET  /api/songs                      → Lấy tất cả bài hát (load khi vào Trang Chủ)
//  GET  /api/songs?q=keyword            → Tìm kiếm bài hát
//  GET  /api/songs?limit=N&offset=M     → Phân trang (nếu cần)
//  POST /api/songs                      → Thêm bài hát mới (gọi sau khi upload Telegram)
//  DELETE /api/songs                    → Xóa bài hát (chỉ chủ sở hữu)
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
    console.error('❌ Redis init error:', e);
  }
}

// Key Redis lưu toàn bộ thư viện nhạc (JSON array)
const MUSIC_KEY = 'music:library';
const MAX_SONGS = 10000;

// ─── Helpers đọc/ghi Redis ───────────────────────────────────────────────────

async function getLibrary() {
  if (!redis) return [];
  try {
    const data = await redis.get(MUSIC_KEY);
    if (!data) return [];
    if (typeof data === 'string') return JSON.parse(data);
    if (Array.isArray(data)) return data;
    return [];
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

// ─── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — cho phép app Android WebView gọi
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis) {
    return res.status(503).json({ success: false, error: 'Redis chưa được cấu hình' });
  }

  // ══════════════════════════════════════════════════════════════════════
  //  GET — Lấy danh sách hoặc Tìm kiếm
  // ══════════════════════════════════════════════════════════════════════
  if (req.method === 'GET') {
    try {
      const { q, limit = '10000', offset = '0', sort = 'newest' } = req.query;
      const songs = await getLibrary();

      // Tìm kiếm theo tên / userId
      if (q && q.trim()) {
        const query = q.trim().toLowerCase();
        const results = songs.filter(s =>
          (s.name || '').toLowerCase().includes(query) ||
          (s.userId || '').toLowerCase().includes(query)
        );
        console.log(`🔍 Search "${q}" → ${results.length} kết quả`);
        return res.status(200).json({
          success: true,
          songs: results.slice(0, parseInt(limit) || 100),
          total: results.length
        });
      }

      // Sắp xếp
      const sorted = [...songs].sort((a, b) => {
        if (sort === 'oldest') return (a.date || 0) - (b.date || 0);
        return (b.date || 0) - (a.date || 0); // newest (mặc định)
      });

      // Phân trang
      const pageOffset = parseInt(offset) || 0;
      const pageLimit  = parseInt(limit)  || 10000;
      const page       = sorted.slice(pageOffset, pageOffset + pageLimit);
      const hasMore    = (pageOffset + pageLimit) < sorted.length;

      // Thống kê
      const uniqueUsers = new Set(songs.map(s => s.userId).filter(Boolean)).size;

      console.log(`📋 Songs: ${page.length}/${songs.length} (offset=${pageOffset})`);

      return res.status(200).json({
        success: true,
        songs: page,
        total: songs.length,
        hasMore,
        stats: {
          totalSongs: songs.length,
          uniqueUsers
        }
      });
    } catch (e) {
      console.error('GET /songs error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  POST — Thêm bài hát mới (gọi ngay sau khi upload lên Telegram)
  // ══════════════════════════════════════════════════════════════════════
  if (req.method === 'POST') {
    try {
      const { id, file_id, name, size, message_id, date, userId, file_url } = req.body;

      if (!id || !name || !userId) {
        return res.status(400).json({
          success: false,
          error: 'Thiếu trường bắt buộc: id, name, userId'
        });
      }

      if (!String(userId).startsWith('user_')) {
        return res.status(400).json({ success: false, error: 'userId không hợp lệ' });
      }

      const songs = await getLibrary();
      const msgId = parseInt(message_id) || 0;

      // Kiểm tra trùng lặp (theo id, file_id hoặc message_id)
      const duplicate = songs.some(s =>
        s.id === String(id) ||
        s.file_id === String(id) ||
        (msgId > 0 && s.message_id === msgId)
      );

      if (duplicate) {
        console.log(`⚠ Duplicate: ${name} (${id})`);
        return res.status(200).json({
          success: true,
          duplicate: true,
          message: 'Bài hát đã tồn tại trên server'
        });
      }

      if (songs.length >= MAX_SONGS) {
        return res.status(429).json({
          success: false,
          error: `Thư viện đầy (tối đa ${MAX_SONGS} bài)`
        });
      }

      const newSong = {
        id:         String(id),
        file_id:    String(file_id || id),
        name:       String(name).substring(0, 200),
        size:       parseInt(size) || 0,
        message_id: msgId,
        date:       parseInt(date) || Math.floor(Date.now() / 1000),
        userId:     String(userId),
        file_url:   file_url || null
      };

      songs.unshift(newSong); // mới nhất lên đầu
      await saveLibrary(songs);

      console.log(`✅ Thêm bài: "${name}" bởi ${userId} (tổng: ${songs.length})`);
      return res.status(200).json({
        success: true,
        song:  newSong,
        total: songs.length
      });

    } catch (e) {
      console.error('POST /songs error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  DELETE — Xóa bài hát (chỉ chủ sở hữu mới được xóa)
  // ══════════════════════════════════════════════════════════════════════
  if (req.method === 'DELETE') {
    try {
      const { id, userId } = req.body;

      if (!id || !userId) {
        return res.status(400).json({ success: false, error: 'Thiếu id hoặc userId' });
      }

      const songs = await getLibrary();
      const idx   = songs.findIndex(s => s.id === String(id));

      if (idx < 0) {
        // Không tìm thấy → coi như đã xóa thành công
        return res.status(200).json({ success: true, ok: true, notFound: true });
      }

      if (songs[idx].userId !== String(userId)) {
        return res.status(403).json({
          success: false,
          error: 'Không có quyền xóa bài này'
        });
      }

      const deleted = songs.splice(idx, 1)[0];
      await saveLibrary(songs);

      console.log(`🗑 Đã xóa: "${deleted.name}" bởi ${userId}`);
      return res.status(200).json({ success: true, ok: true });

    } catch (e) {
      console.error('DELETE /songs error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
