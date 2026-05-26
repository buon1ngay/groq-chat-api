export default async function handler(req, res) {
  console.log(`[UPLOAD] Method: ${req.method}`);
  console.log(`[UPLOAD] Body:`, JSON.stringify(req.body));
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  
  const { message } = req.body;
  if (!message) {
    console.log(`[UPLOAD] No message`);
    return res.status(200).json({ ok: false, error: 'No message' });
  }
  
  // NHẬN TẤT CẢ LOẠI FILE: audio, document, video, photo
  const fileObj = message.audio || message.document || message.video || (message.photo ? message.photo[message.photo.length - 1] : null);
  
  if (!fileObj) {
    console.log(`[UPLOAD] No file found. Message keys:`, Object.keys(message));
    return res.status(200).json({ ok: false, error: 'No file', message_keys: Object.keys(message) });
  }
  
  console.log(`[UPLOAD] File type:`, message.audio ? 'audio' : message.document ? 'document' : message.video ? 'video' : 'photo');
  console.log(`[UPLOAD] File:`, JSON.stringify(fileObj));
  
  const fileName = fileObj.file_name || 'unknown.mp3';
  
  // Chấp nhận cả file không có .mp3 extension (vì có thể là audio MIME type)
  const mimeType = fileObj.mime_type || '';
  const isAudio = mimeType.includes('audio') || fileName.toLowerCase().endsWith('.mp3') || fileName.toLowerCase().endsWith('.m4a') || fileName.toLowerCase().endsWith('.wav');
  
  if (!isAudio) {
    console.log(`[UPLOAD] Not audio. mimeType: ${mimeType}, fileName: ${fileName}`);
    return res.status(200).json({ ok: false, error: 'Not audio', mimeType, fileName });
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
    mime_type: mimeType || 'audio/mpeg',
    file_type: message.audio ? 'audio' : message.document ? 'document' : message.video ? 'video' : 'photo'
  };
  
  console.log(`[UPLOAD] Song:`, JSON.stringify(song));
  
  // Lưu vào Redis
  try {
    const songsData = await redis('GET', 'kami:songs');
    let songs = [];
    try { 
      songs = JSON.parse(songsData.result || '[]'); 
      console.log(`[UPLOAD] Existing songs: ${songs.length}`);
    } catch(e) { 
      console.log(`[UPLOAD] Parse error:`, e.message);
    }
    
    const exists = songs.find(s => s.message_id === song.message_id);
    if (!exists) {
      songs.unshift(song);
      await redis('SET', 'kami:songs', JSON.stringify(songs));
      console.log(`[UPLOAD] Saved! Total: ${songs.length}`);
    } else {
      console.log(`[UPLOAD] Already exists`);
    }
  } catch (e) {
    console.log(`[UPLOAD] Redis error:`, e.message);
  }
  
  res.status(200).json({ ok: true, message_id: message.message_id, file_type: song.file_type });
}
