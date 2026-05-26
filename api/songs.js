const UPSTASH_URL = process.env.UPSTASH_REDIS_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_TOKEN;
async function redis(cmd, ...args) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args])
  });
  return r.json();
}

async function getSongs() {
  const r = await redis('GET', 'kami:songs');
  try { return JSON.parse(r.result || '[]'); } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  
  try {
    let songs = await getSongs();
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const sort = req.query.sort || 'newest';
    
    if (sort === 'newest') songs.sort((a, b) => (b.date || 0) - (a.date || 0));
    else if (sort === 'popular') songs.sort((a, b) => (b.size || 0) - (a.size || 0));
    
    const total = songs.length;
    const uniqueUsers = [...new Set(songs.map(s => s.userId))].filter(Boolean).length;
    
    res.status(200).json({
      songs: songs.slice(offset, offset + limit),
      total: total,
      hasMore: (offset + limit) < total,
      stats: { totalSongs: total, uniqueUsers: uniqueUsers }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
