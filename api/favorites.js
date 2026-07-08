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

const MAX_FAVORITES_PER_USER = 200;

function favKey(userId) {
  return `kamimaps:favorites:${userId}`;
}

async function getFavorites(userId) {
  if (!redis) return [];
  try {
    const data = await redis.get(favKey(userId));
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getFavorites error:', e);
    return [];
  }
}

async function saveFavorites(userId, list) {
  if (!redis) return false;
  try {
    await redis.set(favKey(userId), JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('saveFavorites error:', e);
    return false;
  }
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
      const list = await getFavorites(userId);
      return res.status(200).json({ success: true, favorites: list });
    }

    if (action === 'add') {
      const { name, address, lat, lon, note } = body;
      if (!name || lat === undefined || lon === undefined) {
        return res.status(400).json({ success: false, error: 'Thiếu name/lat/lon' });
      }
      const list = await getFavorites(userId);

      const item = {
        id: 'fav_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        name: String(name).slice(0, 200),
        address: address ? String(address).slice(0, 300) : '',
        lat: Number(lat),
        lon: Number(lon),
        note: note ? String(note).slice(0, 300) : '',
        createdAt: Date.now(),
      };
      list.unshift(item);
      const trimmed = list.slice(0, MAX_FAVORITES_PER_USER);
      const ok = await saveFavorites(userId, trimmed);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, favorite: item });
    }

    if (action === 'remove') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getFavorites(userId);
      const next = list.filter((it) => it.id !== id);
      await saveFavorites(userId, next);
      return res.status(200).json({ success: true });
    }

    if (action === 'update') {
      const { id, name, note } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getFavorites(userId);
      const next = list.map((it) => {
        if (it.id !== id) return it;
        return {
          ...it,
          name: name !== undefined ? String(name).slice(0, 200) : it.name,
          note: note !== undefined ? String(note).slice(0, 300) : it.note,
        };
      });
      await saveFavorites(userId, next);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
