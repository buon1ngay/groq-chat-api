import Groq from 'groq-sdk';
import { IncomingForm } from 'formidable';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: false,
  },
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

  const form = new IncomingForm({ keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(400).json({ success: false, error: 'Cannot parse form data' });
    }

    const audioFile = files.audio?.[0] || files.audio;
    if (!audioFile) {
      return res.status(400).json({ success: false, error: 'No audio file' });
    }

    try {
      const groq = getGroqClient();
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioFile.filepath),
        model: 'whisper-large-v3-turbo',
        language: 'vi',
        response_format: 'json',
      });

      // Xóa file tạm
      fs.unlink(audioFile.filepath, () => {});

      return res.status(200).json({
        success: true,
        text: transcription.text,
      });

    } catch (error) {
      console.error('Transcribe error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}