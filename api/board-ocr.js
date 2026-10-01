import Groq from 'groq-sdk';

// Cùng model vision đang chạy ổn trong chat.js
const VISION_MODEL = 'qwen/qwen3.8-27b';
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VALID_PIECES = 'RNBAKCPrnbakcp';

// Giống chat.js: GROQ_API_KEY_1..10 (thêm GROQ_API_KEY không đuôi cho tương thích cũ)
const API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
  process.env.GROQ_API_KEY_7,
  process.env.GROQ_API_KEY_8,
  process.env.GROQ_API_KEY_9,
  process.env.GROQ_API_KEY_10
].filter((k, i, arr) => k && arr.indexOf(k) === i);

const PROMPT = `Bạn là bộ nhận dạng bàn cờ Tướng. Đọc ẢNH BÀN CỜ và trả về DUY NHẤT JSON hợp lệ, không markdown, không giải thích.
Ma trận đúng 10 hàng x 9 cột; hàng 0 là phía ĐEN, hàng 9 là phía ĐỎ.
Ký hiệu: R=Xe đỏ, N=Mã đỏ, B=Tượng đỏ, A=Sĩ đỏ, K=Tướng đỏ, C=Pháo đỏ, P=Tốt đỏ.
r=xe đen,n=mã đen,b=tượng đen,a=sĩ đen,k=tướng đen,c=pháo đen,p=tốt đen.
Ô trống là chuỗi rỗng "".
Dạng JSON: {"board":[[...10 hàng, mỗi hàng đúng 9 ô...]],"pieces":số_quân,"confidence":0..1}.
Không tự thêm quân nếu không nhìn thấy. Nếu ảnh không phải bàn cờ Tướng hoặc không đọc được, trả {"board":[],"pieces":0,"confidence":0}.`;

function isTooLargeError(e) {
  return e?.status === 413 || e?.message?.includes('Request too large') || e?.message?.includes('reduce your message size');
}

function isRetryableError(e) {
  const m = e?.message || '';
  return (
    e?.status === 401 || e?.status === 403 || e?.status === 429 || e?.status >= 500 ||
    /quota|rate limit|rate_limit/i.test(m) || e?.code === 'rate_limit_exceeded'
  );
}

// Lấy JSON từ output model: bỏ <think>, bỏ ```json, cắt từ { đầu tới } cuối
function extractJson(text) {
  let t = (text || '').replace(/<think[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('Model không trả về JSON');
  return JSON.parse(t.slice(s, e + 1));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const body = req.body || {};

    // Nhận cả 2 dạng: data URL ("image") hoặc base64 thuần + mimeType (giống chat.js)
    let image = typeof body.image === 'string' ? body.image : '';
    if (!image && typeof body.imageBase64 === 'string' && body.imageBase64) {
      const mime = body.mimeType || 'image/jpeg';
      if (!ALLOWED_IMAGE_MIME.includes(mime)) {
        return res.status(400).json({ ok: false, error: 'Định dạng ảnh không hợp lệ' });
      }
      image = `data:${mime};base64,${body.imageBase64}`;
    }
    if (!image || !image.startsWith('data:image/')) {
      return res.status(400).json({ ok: false, error: 'Thiếu image data URL' });
    }
    if (image.length > 5 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'Ảnh quá lớn' });
    }

    if (!API_KEYS.length) throw new Error('Chưa cấu hình GROQ_API_KEY');

    const start = Math.floor(Math.random() * API_KEYS.length);
    let lastErr = null;

    for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
      const apiKey = API_KEYS[(start + attempt) % API_KEYS.length];
      try {
        const groq = new Groq({ apiKey });
        const completion = await groq.chat.completions.create({
          model: VISION_MODEL,
          temperature: 0,
          max_tokens: 1800,
          reasoning_effort: 'none', // tắt suy nghĩ để output chỉ có JSON
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image } },
              { type: 'text', text: PROMPT }
            ]
          }]
        });

        const out = extractJson(completion.choices?.[0]?.message?.content);

        if (!Array.isArray(out.board) || out.board.length !== 10 ||
            out.board.some(row => !Array.isArray(row) || row.length !== 9)) {
          return res.status(422).json({ ok: false, error: 'OCR trả về ma trận không hợp lệ' });
        }

        // Chuẩn hóa ô: chỉ nhận ký hiệu quân hợp lệ, còn lại coi là ô trống
        const board = out.board.map(row =>
          row.map(c => (typeof c === 'string' && c.length === 1 && VALID_PIECES.includes(c)) ? c : '')
        );
        const pieces = board.flat().filter(Boolean).length;

        return res.status(200).json({ ok: true, board, pieces, confidence: Number(out.confidence) || 0 });
      } catch (e) {
        lastErr = e;
        if (isTooLargeError(e)) {
          return res.status(413).json({ ok: false, error: 'Ảnh quá lớn' });
        }
        // Lỗi quota/key/5xx hoặc model trả JSON hỏng -> thử key kế tiếp
        if (isRetryableError(e) || e instanceof SyntaxError || e.message === 'Model không trả về JSON') continue;
        return res.status(e?.status || 500).json({ ok: false, error: e.message || 'OCR thất bại' });
      }
    }
    return res.status(502).json({ ok: false, error: lastErr ? lastErr.message : 'OCR thất bại' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
