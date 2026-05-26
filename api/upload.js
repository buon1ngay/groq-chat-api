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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  try {
    const { message } = req.body;
    if (!message) return res.status(200).json({ ok: false, error: 'No message' });
    
    const fileObj = message.audio || message.document;
    if (!fileObj) return res.status(200).json({ ok: false, error: 'No file' });
    
    const fileName = fileObj.file_name || 'unknown.mp3';
    if (!fileName.toLowerCase().endsWith('.mp3')) return res.status(200).json({ ok: false, error: 'Not MP3' });
    
    const caption = message.caption || '';
    const userMatch = caption.match(/USER:([^\s|]+)/);
    const nameMatch = caption.match(/NAME:(.+?)(?:\||$)/);
    
    const song = {
      id: fileObj.file_id,
      file_id: fileObj.file_id,
      name: nameMatch ? nameMatch[1] : fileName,
      size: fileObj.file_size || 0,
      duration: fileObj.duration || 0,
      message_id: message.message_id,
      date: message.date || Math.floor(Date.now() / 1000),
      userId: userMatch ? userMatch[1] : 'unknown',
      mime_type: fileObj.mime_type || 'audio/mpeg'
    };
    
    const songs = await getSongs();
    const exists = songs.find(s => s.message_id === song.message_id);
    if (!exists) {
      songs.unshift(song);
      await saveSongs(songs);
    }
    
    const total = songs.length;
    const uniqueUsers = [...new Set(songs.map(s => s.userId))].filter(Boolean).length;
    
    res.status(200).json({ ok: true, added: !exists, song, stats: { totalSongs: total, uniqueUsers } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
