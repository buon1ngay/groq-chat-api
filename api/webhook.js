const { getRedis } = require('./_redis.js');

const redis = getRedis();
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('Webhook received:', JSON.stringify(body, null, 2));

    const msg = body.message || body.channel_post;
    if (!msg) return res.status(200).json({ ok: true, message: 'No message' });

    const doc = msg.document || msg.audio;
    if (!doc) return res.status(200).json({ ok: true, message: 'Not a file' });

    const fileName = doc.file_name || 'unknown.mp3';
    if (!fileName.toLowerCase().endsWith('.mp3')) {
      return res.status(200).json({ ok: true, message: 'Not MP3' });
    }

    const caption = msg.caption || '';
    const uidMatch = caption.match(/USER:([^\s|]+)/);
    const nameMatch = caption.match(/NAME:(.+?)(?:\||$)/);
    
    const userId = uidMatch ? uidMatch[1] : `user_${msg.from?.id || 'unknown'}`;
    const songName = nameMatch ? nameMatch[1].trim() : fileName;

    const song = {
      id: doc.file_id,
      file_id: doc.file_id,
      name: songName,
      size: doc.file_size || 0,
      date: msg.date,
      message_id: msg.message_id,
      userId: userId,
      chat_id: msg.chat?.id || CHANNEL_ID,
      added_at: Date.now()
    };

    const member = JSON.stringify(song);
    
    await redis.zadd('songs', { score: msg.date, member: member });
    await redis.hset(`song:${msg.message_id}`, song);
    await redis.sadd(`user:${userId}:songs`, msg.message_id);
    await redis.incr('stats:total_songs');

    console.log('✅ Saved:', songName, 'by', userId);
    
    return res.status(200).json({ ok: true, saved: songName });

  } catch (e) {
    console.error('❌ Error:', e);
    return res.status(500).json({ error: e.message });
  }
};
