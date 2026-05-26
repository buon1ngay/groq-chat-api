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

async function saveSongs(songs) {
  await redis('SET', 'kami:songs', JSON.stringify(songs));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  try {
    const { message_id, userId } = req.body;
    if (!message_id || !userId) return res.status(400).json({ error: 'Missing fields' });
    
    const songs = await getSongs();
    const song = songs.find(s => s.message_id === parseInt(message_id));
    if (!song) return res.status(200).json({ ok: false, error: 'Not found' });
    if (song.userId !== userId) return res.status(200).json({ ok: false, error: 'Not owner' });
    
    await saveSongs(songs.filter(s => s.message_id !== parseInt(message_id)));
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
