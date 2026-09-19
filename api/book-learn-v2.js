const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

// v2 namespace: deliberately different from the old 'book:learn:' prefix so
// this endpoint can NEVER read or mix with data written by the old app build,
// even if the old serverless function is still deployed somewhere by mistake.
const SCHEMA = 'kx-learn-v2';
const PREFIX = 'book:learn:v2:';
const VERSION_KEY = 'book:learn:v2:version';
const RL_PREFIX = 'book:learn:v2:rl:';
const EVENT_PREFIX = 'book:learn-event:v2:';
const EVENT_TTL = 31536000;
const MAX_BATCH = 500;
const MAX_KEY = 231; // 77 plies * 3 chars
const MOVE_RE = /^[A-Za-z0-9_-]{3}$/;
const KEY_RE = /^(?:[A-Za-z0-9_-]{3})*$/;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, body) {
  cors(res);
  res.status(code).json(body);
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
}

function clientIp(req) {
  const x = req.headers['x-forwarded-for'];
  return String(x || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
}

// A move code is 3 chars over a 64-symbol alphabet, but only src(0..89)*90+dst(0..89)
// (max 8099) is ever valid. Reject codes that decode outside board range - these can
// only come from a corrupted/foreign encoding and have no business being stored.
function decodeMoveRange(mv) {
  const n = (B64.indexOf(mv[0]) << 12) | (B64.indexOf(mv[1]) << 6) | B64.indexOf(mv[2]);
  if (n < 0 || n > 8099) return false;
  const src = Math.floor(n / 90), dst = n % 90;
  return src >= 0 && src < 90 && dst >= 0 && dst < 90 && src !== dst;
}

async function rateLimit(req) {
  const k = RL_PREFIX + clientIp(req) + ':' + Math.floor(Date.now() / 60000);
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 70);
  return n <= 120;
}

async function getAllLearned() {
  const out = {};
  let cursor = '0';
  do {
    const r = await redis.scan(cursor, { match: PREFIX + '*', count: 100 });
    cursor = String(r[0]);
    const keys = r[1] || [];
    for (const key of keys) {
      if (key === VERSION_KEY || key.startsWith(RL_PREFIX)) continue;
      const pos = key.slice(PREFIX.length);
      if (!KEY_RE.test(pos)) continue;
      const h = await redis.hgetall(key);
      const moves = {};
      if (h) {
        for (const field of Object.keys(h)) {
          if (!field.endsWith(':s')) continue;
          const mv = field.slice(0, -2);
          if (!MOVE_RE.test(mv)) continue;
          const score = Number(h[field]) || 0;
          const count = Number(h[mv + ':n']) || 0;
          if (score !== 0 || count > 0) moves[mv] = [score, count];
        }
      }
      if (Object.keys(moves).length) out[pos] = moves;
    }
  } while (cursor !== '0');
  return out;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (req.method === 'GET') {
      const current = Number(await redis.get(VERSION_KEY) || 0);
      const since = Number(req.query?.version || 0);
      if (since === current && since > 0) return json(res, 200, { ok: true, changed: false, version: current, schema: SCHEMA });
      const positions = await getAllLearned();
      return json(res, 200, { ok: true, changed: true, version: current, schema: SCHEMA, positions });
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

    const body = bodyOf(req);
    // Any client not sending the current schema tag is an old/foreign build.
    // Accept the request (so its UI doesn't show an error) but write nothing.
    if (body.schema !== SCHEMA) {
      return json(res, 200, { ok: true, accepted: 0, version: Number(await redis.get(VERSION_KEY) || 0) });
    }
    if (!(await rateLimit(req))) return json(res, 429, { ok: false, error: 'Rate limit' });

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > MAX_BATCH) return json(res, 400, { ok: false, error: 'items 1..500' });

    let accepted = 0;
    for (const it of items) {
      const key = String(it?.key || '');
      const move = String(it?.move || '');
      const id = String(it?.id || '');
      let delta = Number(it?.delta);
      if (!KEY_RE.test(key) || key.length > MAX_KEY || !MOVE_RE.test(move) || !Number.isInteger(delta)) continue;
      if (!decodeMoveRange(move)) continue;
      if (id && !/^[A-Za-z0-9_-]{8,120}$/.test(id)) continue;
      delta = Math.max(-3, Math.min(3, delta));
      if (delta === 0) continue;
      if (id) {
        const fresh = await redis.set(EVENT_PREFIX + id, '1', { nx: true, ex: EVENT_TTL });
        if (fresh !== 'OK') continue;
      }
      const redisKey = PREFIX + key;
      await redis.hincrby(redisKey, move + ':s', delta);
      await redis.hincrby(redisKey, move + ':n', 1);
      accepted++;
    }

    const version = accepted ? Number(await redis.incr(VERSION_KEY)) : Number(await redis.get(VERSION_KEY) || 0);
    return json(res, 200, { ok: true, accepted, version });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Server error' });
  }
};
