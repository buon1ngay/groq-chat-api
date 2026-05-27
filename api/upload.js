import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

const REDIS_KEY = 'kami:songs';

export default async function handler(req, res) {
  console.log(`[UPLOAD] Method: ${req.method}`);
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  const { message } = req.body;
  if (!message) {
    console.log(`[UPLOAD] No message`);
    return res.status(200).json({ ok: false, error: 'No message' });
  }
  
  console.log(`[UPLOAD] Message keys:`, Object.keys(message));
  
  const fileObj = message.audio || message.document || message.video;
  
  if (!fileObj) {
    console.log(`[UPLOAD] No file found`);
    return res.status(200).json({ ok: false, error: 'No file' });
  }
  
  console.log(`[UPLOAD] File found! Type:`, message.audio ? 'audio' : message.document ? 'document' : 'video');
  
  const fileName = fileObj.file_name || 'unknown.mp3';
  const mimeType = fileObj.mime_type || '';
  const isAudio = mimeType.includes('audio') || fileName.toLowerCase().endsWith('.mp3');
  
  if (!isAudio) {
    console.log(`[UPLOAD] Not audio. mimeType: ${mimeType}, fileName: ${fileName}`);
    return res.status(200).json({ ok: false, error: 'Not audio' });
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
    mime_type: mimeType || 'audio/mpeg'
  };
  
  console.log(`[UPLOAD] Song:`, JSON.stringify(song));
  
  try {
    let songs = [];
    const data = await redis.get(REDIS_KEY);
    
    if (data) {
      try {
        songs = typeof data === 'string' ? JSON.parse(data) : data;
      } catch (e) {}
    }
    
    if (!Array.isArray(songs)) songs = [];
    
    const exists = songs.find(s => s.message_id === song.message_id);
    if (!exists) {
      songs.unshift(song);
      await redis.set(REDIS_KEY, JSON.stringify(songs));
      console.log(`[UPLOAD] Saved! Total: ${songs.length}`);
    } else {
      console.log(`[UPLOAD] Already exists`);
    }
  } catch (e) {
    console.error(`[UPLOAD] Redis error:`, e);
  }
  
  res.status(200).json({ ok: true, message_id: message.message_id });
}
