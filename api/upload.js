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
  
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(200).json({ ok: false, error: 'No message' });
    }
    
    // Hỗ trợ cả audio và document (mp3)
    const fileObj = message.audio || message.document;
    if (!fileObj) {
      return res.status(200).json({ ok: false, error: 'No audio/document' });
    }
    
    // Chỉ nhận file mp3
    const fileName = fileObj.file_name || 'unknown.mp3';
    if (!fileName.toLowerCase().endsWith('.mp3') && fileObj.mime_type !== 'audio/mpeg') {
      return res.status(200).json({ ok: false, error: 'Not MP3' });
    }
    
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
    const exists = songs.find(s => s.message_id === song.message_id || s.file_id === song.file_id);
    
    if (!exists) {
      songs.unshift(song);
      await saveSongs(songs);
    }
    
    const totalSongs = songs.length;
    const uniqueUsers = [...new Set(songs.map(s => s.userId))].length;
    
    res.status(200).json({
      ok: true,
      added: !exists,
      song: song,
      stats: { totalSongs, uniqueUsers }
    });
  } catch (error) {
    console.error('Upload webhook error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}
