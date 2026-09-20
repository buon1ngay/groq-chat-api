const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

const SCHEMA_FORMAT = 'kami-xiangqi-learn-v2';
const PREFIX = 'book:learn:v2:';
const VERSION_KEY = 'book:learn:v2:version';
const RL_PREFIX = 'book:learn:v2:rl:';
const ADMIN_KEY = process.env.BOOK_ADMIN_KEY || '';
const KEY_RE = /^(?:[A-Za-z0-9_-]{3})*$/;
const MOVE_RE = /^[A-Za-z0-9_-]{3}$/;
const SCAN_COUNT = 500;
const PIPE_CHUNK = 200;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Book-Admin-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function json(res, code, body) {
  cors(res);
  res.status(code).json(body);
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// If BOOK_ADMIN_KEY is not configured the export is now CLOSED (it used to be open to everyone),
// the same way import already behaved.
function authorized(req) {
  if (!ADMIN_KEY) return false;
  return safeEqual(req.headers['x-book-admin-key'] || '', ADMIN_KEY);
}

function movesOf(h) {
  const moves = {};
  if (!h) return moves;
  const seen = new Set();
  for (const f of Object.keys(h)) {
    if (!f.endsWith(':s') && !f.endsWith(':n')) continue;
    const mv = f.slice(0, -2);
    if (seen.has(mv) || !MOVE_RE.test(mv)) continue;
    seen.add(mv);
    moves[mv] = [Number(h[mv + ':s']) || 0, Number(h[mv + ':n']) || 0];
  }
  return moves;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized - set BOOK_ADMIN_KEY' });
  try {
    const keys = [];
    let cursor = '0';
    do {
      const r = await redis.scan(cursor, { match: PREFIX + '*', count: SCAN_COUNT });
      cursor = String(r[0]);
      for (const key of (r[1] || [])) {
        // Skip the version counter and the rate-limit counters (they are STRING keys:
        // HGETALL on them throws WRONGTYPE and used to make the whole export fail with 500).
        if (key === VERSION_KEY || key.startsWith(RL_PREFIX)) continue;
        if (KEY_RE.test(key.slice(PREFIX.length))) keys.push(key);
      }
    } while (cursor !== '0');

    const uniq = [...new Set(keys)];
    const positions = {};
    for (let i = 0; i < uniq.length; i += PIPE_CHUNK) {
      const chunk = uniq.slice(i, i + PIPE_CHUNK);
      const p = redis.pipeline();
      for (const k of chunk) p.hgetall(k);
      const rows = await p.exec();
      chunk.forEach((k, j) => {
        const moves = movesOf(rows[j]);
        if (Object.keys(moves).length) positions[k.slice(PREFIX.length)] = moves;
      });
    }

    const version = Number(await redis.get(VERSION_KEY) || 0);
    return json(res, 200, {
      ok: true,
      format: SCHEMA_FORMAT,
      exportedAt: new Date().toISOString(),
      version,
      positions
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Export failed' });
  }
};
