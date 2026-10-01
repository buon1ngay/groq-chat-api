const sharp = require('sharp');

const GROQ_MODEL = 'qwen/qwen3.8-27b';
// ĐÃ ĐỔI từ meta-llama/llama-4-maverick-17b-128e-instruct -> model đó bị 404
// "model_not_found" trên chính bộ GROQ_API_KEY đang dùng (đã xác nhận qua log thực tế
// ở file chat.js cùng project). qwen/qwen3.8-27b là model vision xác nhận DÙNG ĐƯỢC
// trên tài khoản này.

// Nén/resize ảnh trước khi gửi Groq để tránh 429 "request too large" do input TPM
// (giống lỗi đã gặp và sửa ở chat.js). Logic giống hệt bên đó cho đồng bộ.
const VISION_TARGET_BASE64_BYTES = 2.5 * 1024 * 1024; // ~2.5MB base64
const VISION_MAX_DIMENSION = 1568; // vừa đủ chi tiết đọc quân cờ, giảm token ảnh

async function compressImageForVision(rawBuffer, mimeType) {
  const currentBase64Size = Math.ceil(rawBuffer.length / 3) * 4;
  if (currentBase64Size <= VISION_TARGET_BASE64_BYTES) {
    return { base64: rawBuffer.toString('base64'), mimeType };
  }

  let pipeline = sharp(rawBuffer).rotate();
  const metadata = await pipeline.metadata();

  if ((metadata.width || 0) > VISION_MAX_DIMENSION || (metadata.height || 0) > VISION_MAX_DIMENSION) {
    pipeline = pipeline.resize(VISION_MAX_DIMENSION, VISION_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  let quality = 80;
  let outputBuffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();

  while (outputBuffer.length > VISION_TARGET_BASE64_BYTES * 0.75 && quality > 40) {
    quality -= 10;
    outputBuffer = await sharp(rawBuffer)
      .rotate()
      .resize(VISION_MAX_DIMENSION, VISION_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  console.log(`🗜 Nén ảnh bàn cờ: ${rawBuffer.length}B -> ${outputBuffer.length}B (quality ${quality})`);
  return { base64: outputBuffer.toString('base64'), mimeType: 'image/jpeg' };
}

function getKeys() {
  const keys = [];
  for (let i = 0; i <= 10; i++) {
    const name = i === 0 ? 'GROQ_API_KEY' : `GROQ_API_KEY_${i}`;
    if (process.env[name]) keys.push(process.env[name]);
  }
  return keys;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const image = req.body && req.body.image;
    if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ ok: false, error: 'Thiếu image data URL' });
    }
    // Nới giới hạn reject từ 12MB -> 20MB: ảnh trong khoảng vượt ngưỡng nén
    // (VISION_TARGET_BASE64_BYTES ~2.5MB) sẽ được tự resize/nén ở bước dưới,
    // chỉ còn chặn cứng ảnh thật sự quá khổ, tránh timeout serverless.
    if (image.length > 20 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'Ảnh quá lớn' });
    }

    // Tách mimeType + base64 từ data URL, nén nếu cần, rồi dựng lại data URL để gửi Groq
    let finalImageUrl = image;
    try {
      const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        const rawBuffer = Buffer.from(match[2], 'base64');
        const { base64: compressedBase64, mimeType: outMime } = await compressImageForVision(rawBuffer, match[1]);
        finalImageUrl = `data:${outMime};base64,${compressedBase64}`;
      }
    } catch (compressError) {
      // Nén lỗi (ảnh hỏng, sharp không đọc được...) -> fallback dùng ảnh gốc,
      // để Groq tự trả lỗi rõ ràng thay vì chặn cứng ở đây.
      console.error('⚠ Nén ảnh bàn cờ thất bại, dùng ảnh gốc:', compressError.message);
    }

    const prompt = `Bạn là bộ nhận dạng bàn cờ Tướng. Đọc ẢNH BÀN CỜ và trả về DUY NHẤT JSON hợp lệ, không markdown.
Ma trận đúng 10 hàng x 9 cột; hàng 0 là phía ĐEN, hàng 9 là phía ĐỎ.
Ký hiệu: R=Xe đỏ, N=Mã đỏ, B=Tượng đỏ, A=Sĩ đỏ, K=Tướng đỏ, C=Pháo đỏ, P=Tốt đỏ.
r=xe đen,n=mã đen,b=tượng đen,a=sĩ đen,k=tướng đen,c=pháo đen,p=tốt đen.
Ô trống là chuỗi rỗng "".
Dạng JSON: {"board":[[...10 hàng, mỗi hàng đúng 9 ô...]],"pieces":số_quân,"confidence":0..1}.
Không tự thêm quân nếu không nhìn thấy. Nếu ảnh không phải bàn cờ Tướng hoặc không đọc được, trả {"board":[],"pieces":0,"confidence":0}.`;

    const keys = getKeys();
    if (!keys.length) throw new Error('Chưa cấu hình GROQ_API_KEY');
    let lastErr = null;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[(Math.floor(Math.random() * keys.length) + attempt) % keys.length];
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: GROQ_MODEL,
            temperature: 0,
            max_tokens: 900, // Giảm từ 1800 -> 900: tài khoản có giới hạn OTPM=1000
            // (output tokens/phút) cho qwen3.8-27b. 900 vẫn đủ cho JSON board 10x9 ô,
            // chừa margin ~100 token tránh sát ngưỡng y hệt lỗi 429 gặp ở chat.js.
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: finalImageUrl } }
            ] }]
          })
        });
        const j = await r.json();
        if (!r.ok) {
          lastErr = new Error(j.error?.message || `Groq HTTP ${r.status}`);
          if (r.status === 401 || r.status === 429 || r.status >= 500) continue;
          return res.status(r.status).json({ ok: false, error: lastErr.message });
        }
        const text = j.choices?.[0]?.message?.content || '';
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const out = JSON.parse(clean);
        if (!Array.isArray(out.board) || out.board.length !== 10 || out.board.some(row => !Array.isArray(row) || row.length !== 9)) {
          return res.status(422).json({ ok: false, error: 'OCR trả về ma trận không hợp lệ' });
        }
        return res.status(200).json({ ok: true, board: out.board, pieces: Number(out.pieces) || 0, confidence: Number(out.confidence) || 0 });
      } catch (e) {
        lastErr = e;
      }
    }
    return res.status(502).json({ ok: false, error: lastErr ? lastErr.message : 'OCR thất bại' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
