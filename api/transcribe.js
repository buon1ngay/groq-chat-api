import Groq from 'groq-sdk';

const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
].filter(key => key);

let keyIndex = 0;
function getNextKey() {
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex++;
  return key;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Parse multipart thủ công — lấy boundary
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'No boundary' });
    }
    const boundary = boundaryMatch[1];
    const parts = buffer.toString('binary').split('--' + boundary);

    let audioBuffer = null;
    let filename = 'audio.m4a';

    for (const part of parts) {
      if (part.includes('name="file"')) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const header = part.substring(0, headerEnd);
        const fnMatch = header.match(/filename="([^"]+)"/);
        if (fnMatch) filename = fnMatch[1];
        const body = part.substring(headerEnd + 4, part.lastIndexOf('\r\n'));
        audioBuffer = Buffer.from(body, 'binary');
        break;
      }
    }

    if (!audioBuffer || audioBuffer.length < 100) {
      return res.status(400).json({ error: 'No audio data' });
    }

    const groq = new Groq({ apiKey: getNextKey() });

    const { Readable } = await import('stream');
    const stream = new Readable();
    stream.push(audioBuffer);
    stream.push(null);
    stream.path = filename;

    const transcription = await groq.audio.transcriptions.create({
      file: stream,
      model: 'whisper-large-v3-turbo',
      language: 'vi',
      response_format: 'json',
    });

    return res.status(200).json({
      success: true,
      text: transcription.text || ''
    });

  } catch (error) {
    console.error('Transcribe error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export const config = {
  api: { bodyParser: false }
};
