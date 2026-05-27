import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

const REDIS_KEY = 'kami:songs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  try {
    const { message_id, userId } = req.body;
    if (!message_id || !userId) return res.status(400).json({ error: 'Missing fields' });
    
    let songs = [];
    const data = await redis.get(REDIS_KEY);
    
    if (data) {
      try {
        songs = typeof data === 'string' ? JSON.parse(data) : data;
      } catch (e) {}
    }
    
    if (!Array.isArray(songs)) songs = [];
    
    const song = songs.find(s => s.message_id === parseInt(message_id));
    if (!song) return res.status(200).json({ ok: false, error: 'Not found' });
    if (song.userId !== userId) return res.status(200).json({ ok: false, error: 'Not owner' });
    
    const filtered = songs.filter(s => s.message_id !== parseInt(message_id));
    await redis.set(REDIS_KEY, JSON.stringify(filtered));
    
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Delete error:', e);
    res.status(500).json({ error: e.message });
  }
}
