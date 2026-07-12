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

const MAX_FAVORITES_TOTAL = 5000;

// ── Favorites giờ dùng CHUNG 1 key cho mọi user ───────────────────────
// (trước đây mỗi user có key riêng kamimaps:favorites:${userId}; đã bỏ
// vì favorites giờ công khai, mọi người đều thấy của nhau)
const FAV_KEY = 'kamimaps:favorites:public';

async function getFavorites() {
  if (!redis) return [];
  try {
    const data = await redis.get(FAV_KEY);
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getFavorites error:', e);
    return [];
  }
}

async function saveFavorites(list) {
  if (!redis) return false;
  try {
    await redis.set(FAV_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('saveFavorites error:', e);
    return false;
  }
}

// Ẩn ownerId thật khỏi response, chỉ trả "isMine" để client biết có được
// xoá/sửa hay không. Việc check quyền thật sự luôn nằm ở server (action remove/update).
function toPublicItem(it, requesterId) {
  return {
    id: it.id,
    name: it.name,
    address: it.address,
    lat: it.lat,
    lon: it.lon,
    note: it.note,
    createdAt: it.createdAt,
    ownerName: it.ownerName || 'Ẩn danh',
    isMine: !!requesterId && it.ownerId === requesterId,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { action, userId } = body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Thiếu userId' });
    }

    if (action === 'list') {
      const list = await getFavorites();
      const publicList = list.map((it) => toPublicItem(it, userId));
      return res.status(200).json({ success: true, favorites: publicList });
    }

    if (action === 'search') {
      const { q } = body;
      const query = q ? String(q).trim().toLowerCase() : '';
      const list = await getFavorites();
      const filtered = query
        ? list.filter((it) => {
            const name = (it.name || '').toLowerCase();
            const addr = (it.address || '').toLowerCase();
            return name.includes(query) || addr.includes(query);
          })
        : list;
      const publicList = filtered.map((it) => toPublicItem(it, userId));
      return res.status(200).json({ success: true, favorites: publicList });
    }

    if (action === 'add') {
      const { name, address, lat, lon, note, ownerName } = body;
      if (!name || lat === undefined || lon === undefined) {
        return res.status(400).json({ success: false, error: 'Thiếu name/lat/lon' });
      }
      const list = await getFavorites();

      const item = {
        id: 'fav_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        name: String(name).slice(0, 200),
        address: address ? String(address).slice(0, 300) : '',
        lat: Number(lat),
        lon: Number(lon),
        note: note ? String(note).slice(0, 300) : '',
        ownerId: userId,
        ownerName: ownerName ? String(ownerName).slice(0, 80) : 'Ẩn danh',
        createdAt: Date.now(),
      };
      list.unshift(item);
      const trimmed = list.slice(0, MAX_FAVORITES_TOTAL);
      const ok = await saveFavorites(trimmed);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, favorite: toPublicItem(item, userId) });
    }

    if (action === 'remove') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getFavorites();
      const target = list.find((it) => it.id === id);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
      if (target.ownerId !== userId) {
        return res.status(403).json({ success: false, error: 'Bạn không có quyền xoá địa điểm này' });
      }
      const next = list.filter((it) => it.id !== id);
      await saveFavorites(next);
      return res.status(200).json({ success: true });
    }

    if (action === 'update') {
      const { id, name, note } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getFavorites();
      const target = list.find((it) => it.id === id);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
      if (target.ownerId !== userId) {
        return res.status(403).json({ success: false, error: 'Bạn không có quyền sửa địa điểm này' });
      }
      const next = list.map((it) => {
        if (it.id !== id) return it;
        return {
          ...it,
          name: name !== undefined ? String(name).slice(0, 200) : it.name,
          note: note !== undefined ? String(note).slice(0, 300) : it.note,
        };
      });
      await saveFavorites(next);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
