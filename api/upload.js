const UPSTASH_URL = process.env.UPSTASH_REDIS_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_TOKEN;

async function redis(cmd, ...args) {
  console.log(`[REDIS] ${cmd} ${args.join(' ')}`); // LOG
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args])
  });
  const result = await r.json();
  console.log(`[REDIS RESULT]`, JSON.stringify(result)); // LOG
  return result;
}

export default async function handler(req, res) {
  console.log(`[UPLOAD] Method: ${req.method}`); // LOG
  console.log(`[UPLOAD] Body:`, JSON.stringify(req.body)); // LOG
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  const { message } = req.body;
  if (!message) {
    console.log(`[UPLOAD] No message`); // LOG
    return res.status(200).json({ ok: false, error: 'No message' });
  }
  
  const audio = message.audio || message.document;
  if (!audio) {
    console.log(`[UPLOAD] No audio/document`); // LOG
    return res.status(200).json({ ok: false, error: 'No audio' });
  }
  
  const fileName = audio.file_name || 'unknown.mp3';
  console.log(`[UPLOAD] File: ${fileName}`); // LOG
  
  if (!fileName.toLowerCase().endsWith('.mp3')) {
    return res.status(200).json({ ok: false, error: 'Not MP3' });
  }
  
  const caption = message.caption || '';
  const userMatch = caption.match(/USER:([^\s|]+)/);
  const nameMatch = caption.match(/NAME:(.+?)(?:\||$)/);
  
  const song = {
    id: audio.file_id,
    file_id: audio.file_id,
    name: nameMatch ? nameMatch[1] : fileName,
    size: audio.file_size || 0,
    duration: audio.duration || 0,
    message_id: message.message_id,
    date: message.date || Math.floor(Date.now() / 1000),
    userId: userMatch ? userMatch[1] : 'unknown',
    mime_type: audio.mime_type || 'audio/mpeg'
  };
  
  console.log(`[UPLOAD] Song:`, JSON.stringify(song)); // LOG
  
  // Lưu vào Redis
  try {
    const songsData = await redis('GET', 'kami:songs');
    let songs = [];
    try { 
      songs = JSON.parse(songsData.result || '[]'); 
      console.log(`[UPLOAD] Existing songs: ${songs.length}`); // LOG
    } catch(e) { 
      console.log(`[UPLOAD] Parse error:`, e.message); // LOG
    }
    
    const exists = songs.find(s => s.message_id === song.message_id);
    if (!exists) {
      songs.unshift(song);
      await redis('SET', 'kami:songs', JSON.stringify(songs));
      console.log(`[UPLOAD] Saved! Total: ${songs.length}`); // LOG
    } else {
      console.log(`[UPLOAD] Already exists`); // LOG
    }
  } catch (e) {
    console.log(`[UPLOAD] Redis error:`, e.message); // LOG
  }
  
  res.status(200).json({ ok: true, message_id: message.message_id });
}
