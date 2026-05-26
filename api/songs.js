// Dùng Upstash Redis REST API trực tiếp
const UPSTASH_URL = process.env.UPSTASH_REDIS_URL;  // vd: https://us1-xxx.upstash.io
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

// Helper: get/set JSON
async function getSongs() {
  const result = await redisCommand('GET', 'kami_music:songs');
  if (!result.result) return [];
  try {
    return JSON.parse(result.result);
  } catch { return []; }
}

async function saveSongs(songs) {
  await redisCommand('SET', 'kami_music:songs', JSON.stringify(songs));
}

async function getStats() {
  const songs = await getSongs();
  const uniqueUsers = [...new Set(songs.map(s => s.userId).filter(Boolean))].length;
  return { totalSongs: songs.length, uniqueUsers };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const sort = req.query.sort || 'newest';
    
    let songs = await getSongs();
    
    if (sort === 'newest') {
      songs.sort((a, b) => (b.date || 0) - (a.date || 0));
    } else if (sort === 'popular') {
      songs.sort((a, b) => (b.size || 0) - (a.size || 0));
    }
    
    const total = songs.length;
    const paginated = songs.slice(offset, offset + limit);
    const hasMore = (offset + limit) < total;
    const stats = await getStats();
    
    res.status(200).json({
      songs: paginated,
      total: total,
      hasMore: hasMore,
      stats: stats
    });
  } catch (error) {
    console.error('Songs error:', error);
    res.status(500).json({ error: 'Server error', message: error.message });
  }
}
