import crypto from 'crypto';
import { Redis } from '@upstash/redis';
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

const SCHEMA_FORMAT = 'kami-xiangqi-learn-v2';
const PREFIX = 'book:learn:v2:';
const VERSION_KEY = 'book:learn:v2:version';
const RL_PREFIX = 'book:learn:v2:rl:';
const EVENT_PREFIX = 'book:learn-event:v2:';
const ADMIN_KEY = process.env.BOOK_ADMIN_KEY || process.env.ADMIN_KEY || '';
const KEY_RE = /^(?:[A-Za-z0-9_-]{3})*$/;
const MOVE_RE = /^[A-Za-z0-9_-]{3}$/;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_KEY = 300; // 100 plies * 3 chars
const MAX_MOVES = 100000;
const SCAN_COUNT = 500;
const CHUNK = 250;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
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

function authorized(req) {
  if (!ADMIN_KEY) return false;
  return safeEqual(req.headers['x-book-admin-key'] || '', ADMIN_KEY);
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
}

function decodeMoveRange(mv) {
  const n = (B64.indexOf(mv[0]) << 12) | (B64.indexOf(mv[1]) << 6) | B64.indexOf(mv[2]);
  if (n < 0 || n > 8099) return false;
  const src = Math.floor(n / 90), dst = n % 90;
  return src !== dst;
}

// Only real position hashes: never the version counter or the rate-limit counters.
async function allPositionKeys() {
  const out = [];
  let cursor = '0';
  do {
    const r = await redis.scan(cursor, { match: PREFIX + '*', count: SCAN_COUNT });
    cursor = String(r[0]);
    for (const k of (r[1] || [])) {
      if (k === VERSION_KEY || k.startsWith(RL_PREFIX)) continue;
      if (KEY_RE.test(k.slice(PREFIX.length))) out.push(k);
    }
  } while (cursor !== '0');
  return [...new Set(out)];
}

// Idempotency markers only (book:learn-event:v2:<id>), never position data - safe to wipe independently.
async function allEventKeys() {
  const out = [];
  let cursor = '0';
  do {
    const r = await redis.scan(cursor, { match: EVENT_PREFIX + '*', count: SCAN_COUNT });
    cursor = String(r[0]);
    for (const k of (r[1] || [])) out.push(k);
  } while (cursor !== '0');
  return [...new Set(out)];
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized - set BOOK_ADMIN_KEY' });

  try {
    const body = bodyOf(req);

    // Separate maintenance action: purge the learn-event dedup keys only. Does not touch book:learn:v2:* data
    // and does not require the backup format/positions fields below.
    if (body.mode === 'purge-events') {
      const keys = await allEventKeys();
      for (let i = 0; i < keys.length; i += CHUNK) {
        const p = redis.pipeline();
        for (const k of keys.slice(i, i + CHUNK)) p.del(k);
        await p.exec();
      }
      return json(res, 200, { ok: true, mode: 'purge-events', deleted: keys.length });
    }

    if (body.format !== SCHEMA_FORMAT || !body.positions || typeof body.positions !== 'object' || Array.isArray(body.positions)) {
      return json(res, 400, { ok: false, error: 'Invalid backup format - expected ' + SCHEMA_FORMAT });
    }

    // ---- validate EVERYTHING first; nothing is touched in Redis until the backup is fully valid ----
    const rows = []; // [positionKey, [[move, score, count], ...]]
    let moveCount = 0, skipped = 0;
    for (const key of Object.keys(body.positions)) {
      if (!KEY_RE.test(key) || key.length > MAX_KEY) return json(res, 400, { ok: false, error: 'Invalid position key' });
      const moves = body.positions[key];
      if (!moves || typeof moves !== 'object') return json(res, 400, { ok: false, error: 'Invalid moves' });
      const fields = [];
      for (const move of Object.keys(moves)) {
        // a move code that cannot exist on the board is skipped (reported), not fatal for the whole backup
        if (!MOVE_RE.test(move) || !decodeMoveRange(move)) { skipped++; continue; }
        const pair = moves[move];
        if (!Array.isArray(pair) || pair.length < 2) return json(res, 400, { ok: false, error: 'Invalid score/count' });
        const score = Number(pair[0]), count = Number(pair[1]);
        if (!Number.isInteger(score) || !Number.isInteger(count) || Math.abs(score) > 1000000000 || count < 0 || count > 1000000000) {
          return json(res, 400, { ok: false, error: 'Invalid score/count range' });
        }
        if (score === 0 && count === 0) { skipped++; continue; }
        fields.push([move, score, count]);
        moveCount++;
        if (moveCount > MAX_MOVES) return json(res, 413, { ok: false, error: 'Backup too large' });
      }
      rows.push([key, fields]);
    }

    const mode = body.mode === 'replace' ? 'replace' : 'merge';

    if (mode === 'replace') {
      // Write the new data FIRST (batched), and only afterwards delete positions that are not in the backup.
      // If the function is cut off half-way the old book is still mostly intact (before: everything was
      // deleted first and then re-written one command at a time, so a timeout could wipe the book).
      for (let i = 0; i < rows.length; i += CHUNK) {
        const p = redis.pipeline();
        for (const [key, fields] of rows.slice(i, i + CHUNK)) {
          const k = PREFIX + key;
          p.del(k);
          if (fields.length) {
            const h = {};
            for (const [mv, s, n] of fields) { h[mv + ':s'] = s; h[mv + ':n'] = n; }
            p.hset(k, h);
          }
        }
        await p.exec();
      }
      const keep = new Set(rows.filter(r => r[1].length).map(r => PREFIX + r[0]));
      const stale = (await allPositionKeys()).filter(k => !keep.has(k));
      for (let i = 0; i < stale.length; i += CHUNK) {
        const p = redis.pipeline();
        for (const k of stale.slice(i, i + CHUNK)) p.del(k);
        await p.exec();
      }
    } else {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const p = redis.pipeline();
        for (const [key, fields] of rows.slice(i, i + CHUNK)) {
          const k = PREFIX + key;
          for (const [mv, s, n] of fields) {
            // ':s' is written even when the score is 0, otherwise a (0, count>0) move loses its score field
            p.hincrby(k, mv + ':s', s);
            p.hincrby(k, mv + ':n', n);
          }
        }
        await p.exec();
      }
    }

    const version = Number(await redis.incr(VERSION_KEY));
    return json(res, 200, { ok: true, mode, positions: Object.keys(body.positions).length, moves: moveCount, skipped, version });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Import failed' });
  }
}
