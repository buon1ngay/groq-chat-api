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
    let songs = [];
    const data = await redis.get(REDIS_KEY);
    
    if (data) {
      try {
        songs = typeof data === 'string' ? JSON.parse(data) : data;
      } catch (e) {
        console.error('Parse songs error:', e);
      }
    }
    
    if (!Array.isArray(songs)) songs = [];
    
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
      stats: { totalSongs: total, uniqueUsers }
    });
  } catch (e) {
    console.error('Songs error:', e);
    res.status(500).json({ error: e.message });
  }
}
