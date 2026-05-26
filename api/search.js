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
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.status(400).json({ error: 'Query required' });
    
    const songs = await getSongs();
    const results = songs.filter(s => 
      (s.name || '').toLowerCase().includes(q)
    ).slice(0, parseInt(req.query.limit) || 100);
    
    res.status(200).json({ songs: results, total: results.length, query: q });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
