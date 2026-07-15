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

const QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100GB
const MAX_FILES = 5000;

// ── KamiCloud: dữ liệu RIÊNG TƯ theo từng userId ───────────────────────
// Mỗi user có 1 key files + 1 key prefs, không ai xem được của người khác.
const filesKey = (userId) => `kamicloud:files:${userId}`;
const prefsKey = (userId) => `kamicloud:prefs:${userId}`;

async function getFiles(userId) {
  if (!redis) return [];
  try {
    const data = await redis.get(filesKey(userId));
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getFiles error:', e);
    return [];
  }
}

async function saveFiles(userId, list) {
  if (!redis) return false;
  try {
    await redis.set(filesKey(userId), JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('saveFiles error:', e);
    return false;
  }
}

async function getPrefs(userId) {
  if (!redis) return {};
  try {
    const data = await redis.get(prefsKey(userId));
    if (!data) return {};
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    console.error('getPrefs error:', e);
    return {};
  }
}

async function savePrefs(userId, prefs) {
  if (!redis) return false;
  try {
    await redis.set(prefsKey(userId), JSON.stringify(prefs));
    return true;
  } catch (e) {
    console.error('savePrefs error:', e);
    return false;
  }
}

function toPublicFile(it) {
  return {
    id: it.id,
    file_id: it.file_id,
    name: it.name,
    size: it.size,
    message_id: it.message_id,
    date: it.date,
    canEdit: true, // riêng tư -> chủ file luôn được sửa/xoá/tải
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

    // ── Danh sách file ────────────────────────────────────────────────
    if (action === 'list') {
      const [files, prefs] = await Promise.all([getFiles(userId), getPrefs(userId)]);
      return res.status(200).json({
        success: true,
        files: files.map(toPublicFile),
        prefs,
        quota: QUOTA_BYTES,
        maxFiles: MAX_FILES,
      });
    }

    // ── Ghi đè toàn bộ danh sách (client giữ logic thêm/xoá/sửa, server chỉ lưu) ──
    if (action === 'save') {
      const { files } = body;
      if (!Array.isArray(files)) {
        return res.status(400).json({ success: false, error: 'Thiếu files (phải là mảng)' });
      }
      if (files.length > MAX_FILES) {
        return res.status(400).json({ success: false, error: 'Vượt quá giới hạn 5000 file' });
      }
      const totalSize = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      if (totalSize > QUOTA_BYTES) {
        return res.status(400).json({ success: false, error: 'Vượt quá quota 100GB' });
      }
      // Chỉ giữ các field hợp lệ, gắn ownerId để chống lẫn dữ liệu
      const clean = files.map((f) => ({
        id: f.id,
        file_id: f.file_id || f.id,
        name: f.name ? String(f.name).slice(0, 300) : 'Unknown',
        size: Number(f.size) || 0,
        message_id: Number(f.message_id) || 0,
        date: Number(f.date) || Math.floor(Date.now() / 1000),
        ownerId: userId,
      }));
      const ok = await saveFiles(userId, clean);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, count: clean.length });
    }

    // ── Thêm 1 file (dùng sau khi upload xong 1 file lên Telegram) ─────
    if (action === 'add') {
      const { id, file_id, name, size, message_id } = body;
      if (!id && !file_id) {
        return res.status(400).json({ success: false, error: 'Thiếu id/file_id' });
      }
      const list = await getFiles(userId);
      const fid = file_id || id;
      if (list.some((f) => f.file_id === fid)) {
        return res.status(200).json({ success: true, duplicate: true });
      }
      if (list.length >= MAX_FILES) {
        return res.status(400).json({ success: false, error: 'Đã đạt giới hạn 5000 file' });
      }
      const totalSize = list.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      const fsize = Number(size) || 0;
      if (totalSize + fsize > QUOTA_BYTES) {
        return res.status(400).json({ success: false, error: 'Vượt quá quota 100GB' });
      }
      const item = {
        id: fid,
        file_id: fid,
        name: name ? String(name).slice(0, 300) : 'Unknown',
        size: fsize,
        message_id: Number(message_id) || 0,
        date: Math.floor(Date.now() / 1000),
        ownerId: userId,
      };
      list.unshift(item);
      const ok = await saveFiles(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, file: toPublicFile(item) });
    }

    // ── Xoá 1 file ───────────────────────────────────────────────────
    if (action === 'remove') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getFiles(userId);
      const next = list.filter((f) => f.file_id !== id && f.id !== id);
      await saveFiles(userId, next);
      return res.status(200).json({ success: true });
    }

    // ── Đổi tên 1 file ───────────────────────────────────────────────
    if (action === 'rename') {
      const { id, name } = body;
      if (!id || !name) return res.status(400).json({ success: false, error: 'Thiếu id/name' });
      const list = await getFiles(userId);
      const target = list.find((f) => f.file_id === id || f.id === id);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy file' });
      target.name = String(name).slice(0, 300);
      await saveFiles(userId, list);
      return res.status(200).json({ success: true });
    }

    // ── Lưu/đọc tuỳ chọn hiển thị (view mode, sort...) ─────────────────
    if (action === 'setPref') {
      const { key, value } = body;
      if (!key) return res.status(400).json({ success: false, error: 'Thiếu key' });
      const prefs = await getPrefs(userId);
      prefs[key] = value !== undefined ? String(value) : '';
      const ok = await savePrefs(userId, prefs);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true });
    }

    if (action === 'getPrefs') {
      const prefs = await getPrefs(userId);
      return res.status(200).json({ success: true, prefs });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
