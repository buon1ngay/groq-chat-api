const { getRedis } = require('./_redis.js');
const redis = getRedis();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { offset = '0', limit = '50', search = '', userId = '', sort = 'newest' } = req.query;
    
    const off = parseInt(offset) || 0;
    const lim = Math.min(parseInt(limit) || 50, 200);

    let songs = [];
    
    if (userId) {
      const msgIds = await redis.smembers(`user:${userId}:songs`);
      for (const mid of msgIds) {
        const s = await redis.hgetall(`song:${mid}`);
        if (s && s.id) songs.push(s);
      }
      songs.sort((a, b) => (b.date || 0) - (a.date || 0));
    } else {
      const rev = sort === 'oldest' ? false : true;
      const songsData = await redis.zrange('songs', 0, -1, { rev: rev });
      
      songs = songsData.map(s => {
        try { return JSON.parse(s) } catch(e) { return null }
      }).filter(Boolean);
    }

    if (search) {
      const q = search.toLowerCase();
      songs = songs.filter(s => 
        (s.name || '').toLowerCase().includes(q) ||
        (s.userId || '').toLowerCase().includes(q)
      );
    }

    if (sort === 'name') {
      songs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    const total = songs.length;
    const paginated = songs.slice(off, off + lim);

    const totalSongs = await redis.get('stats:total_songs') || total;

    return res.status(200).json({
      songs: paginated,
      total: total,
      offset: off,
      limit: lim,
      hasMore: (off + lim) < total,
      stats: {
        totalSongs: parseInt(totalSongs) || total
      }
    });

  } catch (e) {
    console.error('Songs error:', e);
    return res.status(500).json({ error: e.message });
  }
};
