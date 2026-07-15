import { Redis } from '@upstash/redis';
const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;
let redis = null;
if (REDIS_ENABLED) {
  try {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
  } catch (e) { console.error('Redis init:', e); }
}
const AB_KEY   = 'album:albums';
const LIB_KEY  = 'album:pics';
const MAX_AB   = 5000;
const MAX_PICS = 200;
async function getAll() {
  if (!redis) return [];
  try {
    const d = await redis.get(AB_KEY);
    if (!d) return [];
    const a = typeof d === 'string' ? JSON.parse(d) : d;
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
async function saveAll(list) {
  if (!redis) return false;
  try { await redis.set(AB_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }
}
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
  if (req.method === 'GET') {
    try {
      let list = await getAll();
      const liveIds = await getLiveIds();
      let dirty = false;
      if (liveIds) {
        list = list.map(ab => {
          const before = (ab.pics || []).length;
          ab.pics = (ab.pics || []).filter(s => liveIds.has(String(s.id || s.i || '')));
          if (ab.pics.length !== before) dirty = true;
          return ab;
        });
        if (dirty) saveAll(list); // lưu lại không cần await
      }
      return res.status(200).json({ success: true, albums: list, total: list.length });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
  if (req.method === 'POST') {
    const body = req.body || {};
    const { action, userId, albumId, adminKey } = body;
    const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;
    if (!isAdmin && (!userId || !String(userId).startsWith('user_')))
      return res.status(400).json({ success: false, error: 'userId không hợp lệ' });
    if (action === 'create') {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ success: false, error: 'Thiếu tên album' });
      const list = await getAll();
      if (list.length >= MAX_AB)
        return res.status(429).json({ success: false, error: `Hệ thống đạt giới hạn ${MAX_AB} album` });
      const userAbCount = list.filter(p => p.userId === String(userId)).length;
      if (!isAdmin && userAbCount >= 50)
        return res.status(429).json({ success: false, error: 'Bạn đã tạo tối đa 50 album' });
      const dup = list.some(p => p.userId === userId && p.name.toLowerCase() === name.toLowerCase());
      if (dup) return res.status(400).json({ success: false, error: 'Bạn đã có album tên này' });
      const ab = {
        id:    'ab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name:  name.substring(0, 100),
        userId: String(userId),
        pics:  [],
        date:  Math.floor(Date.now() / 1000),
      };
      list.unshift(ab);
      await saveAll(list);
      return res.status(200).json({ success: true, album: ab });
    }
    if (action === 'add') {
      const { pic } = body; // pic = { id, name, size, ... }
      if (!albumId || !pic || !pic.id)
        return res.status(400).json({ success: false, error: 'Thiếu albumId hoặc pic' });
      const list = await getAll();
      const ab = list.find(p => p.id === albumId);
      if (!ab) return res.status(404).json({ success: false, error: 'Album không tồn tại' });
      if (!isAdmin && ab.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ album mới được thêm ảnh' });
      if (!ab.pics) ab.pics = [];
      if (ab.pics.some(s => String(s.id) === String(pic.id)))
        return res.status(200).json({ success: true, duplicate: true });
      if (ab.pics.length >= MAX_PICS)
        return res.status(429).json({ success: false, error: `Album đã đầy (${MAX_PICS} ảnh)` });
      ab.pics.push({ id: String(pic.id), name: String(pic.name || '').substring(0, 200), size: parseInt(pic.size) || 0 });
      await saveAll(list);
      return res.status(200).json({ success: true, total: ab.pics.length });
    }
    if (action === 'addMany') {
      const { pics } = body;
      if (!albumId || !Array.isArray(pics))
        return res.status(400).json({ success: false, error: 'Thiếu albumId hoặc pics[]' });
      const list = await getAll();
      const ab = list.find(p => p.id === albumId);
      if (!ab) return res.status(404).json({ success: false, error: 'Album không tồn tại' });
      if (!isAdmin && ab.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ album mới được thêm ảnh' });
      if (!ab.pics) ab.pics = [];
      let added = 0;
      for (const pic of pics) {
        if (!pic || !pic.id) continue;
        if (ab.pics.some(s => String(s.id) === String(pic.id))) continue;
        if (ab.pics.length >= MAX_PICS) break;
        ab.pics.push({ id: String(pic.id), name: String(pic.name || '').substring(0, 200), size: parseInt(pic.size) || 0 });
        added++;
      }
      await saveAll(list);
      return res.status(200).json({ success: true, added, total: ab.pics.length });
    }
    if (action === 'removePic') {
      const { picId } = body;
      if (!albumId || !picId)
        return res.status(400).json({ success: false, error: 'Thiếu albumId hoặc picId' });
      const list = await getAll();
      const ab = list.find(p => p.id === albumId);
      if (!ab) return res.status(404).json({ success: false, error: 'Album không tồn tại' });
      if (!isAdmin && ab.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ album mới được xóa ảnh' });
      ab.pics = (ab.pics || []).filter(s => String(s.id) !== String(picId));
      await saveAll(list);
      return res.status(200).json({ success: true, total: ab.pics.length });
    }
    if (action === 'rename') {
      const { name } = body;
      if (!albumId || !name || !String(name).trim())
        return res.status(400).json({ success: false, error: 'Thiếu albumId hoặc name' });
      const list = await getAll();
      const ab = list.find(p => p.id === albumId);
      if (!ab) return res.status(404).json({ success: false, error: 'Album không tồn tại' });
      if (!isAdmin && ab.userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ album mới được đổi tên' });
      ab.name = String(name).trim().substring(0, 100);
      await saveAll(list);
      return res.status(200).json({ success: true, name: ab.name });
    }
    return res.status(400).json({ success: false, error: `action không hợp lệ: ${action}` });
  }
  if (req.method === 'DELETE') {
    try {
      const { userId, albumId, adminKey } = req.body || {};
      const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;
      if (!albumId) return res.status(400).json({ success: false, error: 'Thiếu albumId' });
      if (!isAdmin && (!userId || !String(userId).startsWith('user_')))
        return res.status(400).json({ success: false, error: 'Thiếu userId hoặc adminKey' });
      const list = await getAll();
      const idx = list.findIndex(p => p.id === albumId);
      if (idx < 0) return res.status(200).json({ success: true, notFound: true });
      if (!isAdmin && list[idx].userId !== String(userId))
        return res.status(403).json({ success: false, error: 'Chỉ chủ album hoặc admin mới được xóa' });
      const deleted = list.splice(idx, 1)[0];
      await saveAll(list);
      console.log(`🗑 Xóa ALBUM "${deleted.name}" — ảnh gốc KHÔNG bị xóa`);
      return res.status(200).json({ success: true, note: 'Đã xóa album. Ảnh gốc không bị ảnh hưởng.' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
