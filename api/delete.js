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

async function saveSongs(songs) {
  await redisCommand('SET', 'kami_music:songs', JSON.stringify(songs));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message_id, userId } = req.body;
    
    if (!message_id || !userId) {
      return res.status(400).json({ error: 'message_id and userId required' });
    }
    
    const songs = await getSongs();
    const song = songs.find(s => s.message_id === parseInt(message_id));
    
    if (!song) {
      return res.status(200).json({ ok: false, error: 'Not found' });
    }
    if (song.userId !== userId) {
      return res.status(200).json({ ok: false, error: 'Not owner' });
    }
    
    const filtered = songs.filter(s => s.message_id !== parseInt(message_id));
    await saveSongs(filtered);
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}
