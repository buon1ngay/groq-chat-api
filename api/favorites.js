// api/favorites.js
// KamiMaps - Favorites API (Vercel + Redis/Upstash)
// Actions: list | add | remove | update
//
// Redis key: kamimaps:favorites:{userId}  -> JSON array of favorite objects
// Favorite object: { id, name, address, lat, lon, note, createdAt }

const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function key(userId) {
  return `kamimaps:favorites:${userId}`;
}

function json(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  // CORS (WebView loadDataWithBaseURL origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.method !== 'POST') {
    return json(res, 405, { success: false, message: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const { action, userId } = body;

  if (!userId) {
    return json(res, 400, { success: false, message: 'Thiếu userId' });
  }

  try {
    if (action === 'list') {
      const raw = await redis.get(key(userId));
      const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      return json(res, 200, { success: true, favorites: list });
    }

    if (action === 'add') {
      const { name, address, lat, lon, note } = body;
      if (!name || lat === undefined || lon === undefined) {
        return json(res, 400, { success: false, message: 'Thiếu name/lat/lon' });
      }
      const raw = await redis.get(key(userId));
      const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];

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
      // Giới hạn 200 địa điểm/user để tránh phình Redis
      const trimmed = list.slice(0, 200);
      await redis.set(key(userId), JSON.stringify(trimmed));
      return json(res, 200, { success: true, favorite: item });
    }

    if (action === 'remove') {
      const { id } = body;
      if (!id) return json(res, 400, { success: false, message: 'Thiếu id' });
      const raw = await redis.get(key(userId));
      const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      const next = list.filter(function (it) { return it.id !== id; });
      await redis.set(key(userId), JSON.stringify(next));
      return json(res, 200, { success: true });
    }

    if (action === 'update') {
      const { id, name, note } = body;
      if (!id) return json(res, 400, { success: false, message: 'Thiếu id' });
      const raw = await redis.get(key(userId));
      const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      const next = list.map(function (it) {
        if (it.id !== id) return it;
        return Object.assign({}, it, {
          name: name !== undefined ? String(name).slice(0, 200) : it.name,
          note: note !== undefined ? String(note).slice(0, 300) : it.note,
        });
      });
      await redis.set(key(userId), JSON.stringify(next));
      return json(res, 200, { success: true });
    }

    return json(res, 400, { success: false, message: 'Action không hợp lệ' });
  } catch (e) {
    return json(res, 500, { success: false, message: 'Lỗi server: ' + e.message });
  }
};
