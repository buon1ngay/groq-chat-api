const UPSTASH_URL = process.env.UPSTASH_REDIS_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_TOKEN;

async function redisCommand(command, ...args) {
  const response = await fetch(`${UPSTASH_URL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });
  return response.json();
}

async function getSongs() {
  const result = await redisCommand('GET', 'kami_music:songs');
  if (!result.result) return [];
  try { return JSON.parse(result.result); } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const query = (req.query.q || '').toLowerCase().trim();
    const limit = parseInt(req.query.limit) || 100;
    
    if (!query) {
      return res.status(400).json({ error: 'Query required' });
    }
    
    const songs = await getSongs();
    const results = songs.filter(s => 
      (s.name || '').toLowerCase().includes(query) ||
      (s.userId || '').toLowerCase().includes(query)
    ).slice(0, limit);
    
    res.status(200).json({
      songs: results,
      total: results.length,
      query: query
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}
