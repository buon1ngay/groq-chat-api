import { Redis } from '@upstash/redis';
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
const INDEX_KEY = 'book:learn:v2:index';
const CHANGES_KEY = 'book:learn:v2:changes';
const CACHE_PREFIX = 'book:learn:v2:cache:';
const RESET_VERSION_KEY = 'book:learn:v2:reset-version';
const RL_PREFIX = 'book:learn:v2:rl:';
const EVENT_PREFIX = 'book:learn-event:v2:';
const EVENT_TTL = 5184000; // 60 days: dedupe only, not learning data
const MAX_BATCH = 500;
const MAX_KEY = 300; // 100 plies * 3 chars
const RL_ITEMS_PER_MIN = 1500; // per IP, counted in ITEMS (not requests)
const SCAN_COUNT = 500;
const PIPE_CHUNK = 200;
const MOVE_RE = /^[A-Za-z0-9_-]{3}$/;
const KEY_RE = /^(?:[A-Za-z0-9_-]{3})*$/;
const ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
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

// The limit counts items, so one request with 500 items costs 500 (before: 1).
async function rateLimit(req, cost) {
  const k = RL_PREFIX + clientIp(req) + ':' + Math.floor(Date.now() / 60000);
  const p = redis.pipeline();
  p.incrby(k, cost);
  p.expire(k, 70);
  const r = await p.exec();
  return Number(r[0]) <= RL_ITEMS_PER_MIN;
}

// Reads moves from a hash. A move counts if EITHER its ':s' or ':n' field exists,
// so a move whose score is 0 but count > 0 is no longer invisible.
function movesOf(h) {
  const moves = {};
  if (!h) return moves;
  const seen = new Set();
  for (const f of Object.keys(h)) {
    if (!f.endsWith(':s') && !f.endsWith(':n')) continue;
    const mv = f.slice(0, -2);
    if (seen.has(mv) || !MOVE_RE.test(mv)) continue;
    seen.add(mv);
    const score = Number(h[mv + ':s']) || 0;
    const count = Number(h[mv + ':n']) || 0;
    if (score !== 0 || count > 0) moves[mv] = [score, count];
  }
  return moves;
}

async function getPositionsByKeys(keys) {
  const uniq = [...new Set(keys || [])];
  const out = {};
  for (let i = 0; i < uniq.length; i += PIPE_CHUNK) {
    const chunk = uniq.slice(i, i + PIPE_CHUNK);
    const p = redis.pipeline();
    for (const k of chunk) p.hgetall(PREFIX + k);
    const rows = await p.exec();
    chunk.forEach((key, j) => {
      const moves = movesOf(rows[j]);
      if (Object.keys(moves).length) out[key] = moves;
    });
  }
  return out;
}

async function getAllLearned() {
  const keys = await redis.smembers(INDEX_KEY);
  return getPositionsByKeys((keys || []).filter(k => KEY_RE.test(String(k))));
}

async function getIncremental(since, current) {
  if (since <= 0 || current - since > 5000) return null; // force a full snapshot for very old clients
  const keys = await redis.zrange(CHANGES_KEY, since + 1, current, { byScore: true });
  return getPositionsByKeys(keys || []);
}

async function getCachedSnapshot(version) {
  const raw = await redis.get(CACHE_PREFIX + version);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function setCachedSnapshot(version, positions) {
  // Cache is an optimization only. If JSON is too large for Redis, GET can still rebuild it.
  const raw = JSON.stringify(positions);
  if (raw.length > 4000000) return false;
  await redis.set(CACHE_PREFIX + version, raw, { ex: 86400 });
  return true;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }
  try {
    if (req.method === 'GET') {
      const current = Number(await redis.get(VERSION_KEY) || 0);
      const since = Number(req.query?.version || 0);
      if (since === current && since > 0) return json(res, 200, { ok: true, changed: false, incremental: true, version: current, schema: SCHEMA });

      const resetVersion = Number(await redis.get(RESET_VERSION_KEY) || 0);
      if (since > 0 && since < current && since >= resetVersion) {
        const delta = await getIncremental(since, current);
        if (delta) return json(res, 200, { ok: true, changed: true, incremental: true, version: current, schema: SCHEMA, positions: delta });
      }

      let positions = await getCachedSnapshot(current);
      if (!positions) {
        positions = await getAllLearned();
        await setCachedSnapshot(current, positions);
      }
      return json(res, 200, { ok: true, changed: true, incremental: false, version: current, schema: SCHEMA, positions });
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

    const body = bodyOf(req);
    // Any client not sending the current schema tag is an old/foreign build.
    // Accept the request (so its UI doesn't show an error) but write nothing.
    if (body.schema !== SCHEMA) {
      return json(res, 200, { ok: true, accepted: 0, version: Number(await redis.get(VERSION_KEY) || 0) });
    }

    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > MAX_BATCH) return json(res, 400, { ok: false, error: 'items 1..500' });
    if (!(await rateLimit(req, items.length))) return json(res, 429, { ok: false, error: 'Rate limit' });

    const clean = [];
    for (const it of items) {
      const key = String(it?.key || '');
      const move = String(it?.move || '');
      const id = String(it?.id || '');
      let delta = Number(it?.delta);
      if (!KEY_RE.test(key) || key.length > MAX_KEY || !MOVE_RE.test(move) || !Number.isInteger(delta)) continue;
      if (!decodeMoveRange(move)) continue;
      if (!ID_RE.test(id)) continue; // id is mandatory: it is what makes a retry safe (no double counting / replay)
      delta = Math.max(-1, Math.min(1, delta)); // the app only ever sends +1 / -1
      if (delta === 0) continue;
      clean.push({ key, move, id, delta });
    }

    let accepted = 0;
    if (clean.length) {
      // 1) claim every event id in one round trip (NX also de-duplicates inside the batch)
      const pe = redis.pipeline();
      for (const c of clean) pe.set(EVENT_PREFIX + c.id, '1', { nx: true, ex: EVENT_TTL });
      const er = await pe.exec();
      const fresh = clean.filter((c, i) => er[i] === 'OK');

      // 2) apply all increments in one round trip
      if (fresh.length) {
        try {
          const pw = redis.pipeline();
          for (const c of fresh) {
            const rk = PREFIX + c.key;
            pw.hincrby(rk, c.move + ':s', c.delta);
            pw.hincrby(rk, c.move + ':n', 1);
          }
          await pw.exec();
          accepted = fresh.length;
        } catch (err) {
          // give the ids back so the client's retry is not swallowed as a duplicate
          try {
            const pr = redis.pipeline();
            for (const c of fresh) pr.del(EVENT_PREFIX + c.id);
            await pr.exec();
          } catch (_) {}
          throw err;
        }
      }
    }

    const version = accepted ? Number(await redis.incr(VERSION_KEY)) : Number(await redis.get(VERSION_KEY) || 0);
    if (accepted) {
      const freshKeys = [...new Set(clean.map(c => c.key))];
      const pidx = redis.pipeline();
      for (const key of freshKeys) {
        pidx.sadd(INDEX_KEY, key);
        pidx.zadd(CHANGES_KEY, { score: version, member: key });
      }
      await pidx.exec();
    }
    return json(res, 200, { ok: true, accepted, version });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Server error' });
  }
}
