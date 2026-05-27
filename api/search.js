import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

const REDIS_KEY = 'kami:songs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.status(400).json({ error: 'Query required' });
    
    let songs = [];
    const data = await redis.get(REDIS_KEY);
    
    if (data) {
      try {
        songs = typeof data === 'string' ? JSON.parse(data) : data;
      } catch (e) {}
    }
    
    if (!Array.isArray(songs)) songs = [];
    
    const results = songs.filter(s => 
      (s.name || '').toLowerCase().includes(q)
    ).slice(0, parseInt(req.query.limit) || 100);
    
    res.status(200).json({
      songs: results,
      total: results.length,
      query: q
    });
  } catch (e) {
    console.error('Search error:', e);
    res.status(500).json({ error: e.message });
  }
}
