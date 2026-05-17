import Groq from 'groq-sdk';
import { writeFile, unlink } from 'fs/promises';
import { createReadStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
  process.env.GROQ_API_KEY_7,
  process.env.GROQ_API_KEY_8,
  process.env.GROQ_API_KEY_9,
  process.env.GROQ_API_KEY_10,
].filter(key => key);

function getGroqClient() {
  const key = API_KEYS[Math.floor(Math.random() * API_KEYS.length)];
  return new Groq({ apiKey: key });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { audio } = req.body;
    if (!audio) {
      return res.status(400).json({ success: false, error: 'No audio data' });
    }

    // Decode base64 → file tạm
    const buffer = Buffer.from(audio, 'base64');
    const tmpPath = join(tmpdir(), `voice_${Date.now()}.m4a`);
    await writeFile(tmpPath, buffer);

    const groq = getGroqClient();
    const transcription = await groq.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: 'whisper-large-v3-turbo',
      language: 'vi',
      response_format: 'json',
    });

    await unlink(tmpPath).catch(() => {});

    return res.status(200).json({
      success: true,
      text: transcription.text,
    });

  } catch (error) {
    console.error('Transcribe error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
