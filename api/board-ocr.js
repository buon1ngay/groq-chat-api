// Vercel: api/board-ocr.js
// POST { image: "data:image/jpeg;base64,..." }
// Returns { ok:true, board:[[...9 chars] x 10] }

const MODEL = process.env.BOARD_OCR_MODEL || 'meta-llama/llama-4-maverick-17b-128e-instruct';

function getKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY);
  for (let i = 1; i <= 10; i++) {
    const k = process.env['GROQ_API_KEY_' + i];
    if (k) keys.push(k);
  }
  return [...new Set(keys.filter(Boolean))];
}

function cleanImageData(image) {
  if (typeof image !== 'string') return null;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(image)) return null;
  // Keep the request bounded. The Android client already compresses to ~1600px JPEG.
  if (image.length > 12 * 1024 * 1024) return null;
  return image;
}

function parseModelJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

function validBoard(board) {
  if (!Array.isArray(board) || board.length !== 10) return false;
  const allowed = new Set(['R','N','B','A','K','C','P','r','n','b','a','k','c','p',' ']);
  let rk = 0, bk = 0;
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== 9) return false;
    for (const x of row) {
      if (!allowed.has(x)) return false;
      if (x === 'K') rk++;
      if (x === 'k') bk++;
    }
  }
  return rk === 1 && bk === 1;
}

function normaliseBoard(board) {
  if (!validBoard(board)) return null;
  return board.map(row => row.map(x => (x === '.' || x === '0' || x === '-') ? ' ' : x));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  const image = cleanImageData(req.body && req.body.image);
  if (!image) return res.status(400).json({ ok:false, error:'Ảnh không hợp lệ hoặc quá lớn.' });

  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ ok:false, error:'Chưa cấu hình GROQ_API_KEY.' });

  const prompt = `Bạn là bộ nhận dạng bàn Cờ Tướng từ ảnh. Chỉ nhận dạng bàn cờ, không phân tích nước đi.

QUY ƯỚC BẮT BUỘC:
- Bàn có đúng 10 hàng x 9 cột giao điểm.
- Hàng 0 là hàng trên cùng trong ảnh; hàng 9 là hàng dưới cùng.
- Cột 0 là trái nhất; cột 8 là phải nhất.
- Quân Đỏ dùng chữ HOA: R Xe, N Mã, B Tượng, A Sĩ, K Tướng, C Pháo, P Tốt.
- Quân Đen dùng chữ thường: r Xe, n Mã, b Tượng, a Sĩ, k Tướng, c Pháo, p Tốt.
- Ô trống là một dấu cách ' '.
- Không được tự suy ra nước đi hoặc thay đổi vị trí vì cho rằng thế cờ bất thường.
- Nếu ảnh không đủ rõ để xác định một quân, ưu tiên trả về ' ' cho ô đó thay vì đoán.
- Tuyệt đối trả JSON thuần, không markdown.

JSON bắt buộc:
{"board":[[9 ô],[9 ô],[9 ô],[9 ô],[9 ô],[9 ô],[9 ô],[9 ô],[9 ô],[9 ô]],"confidence":0.0}

Ảnh có thể là ảnh chụp màn hình hoặc ảnh chụp bàn cờ thực tế. Hãy xác định vùng bàn cờ trước rồi lập ma trận 10x9.`;

  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 1800,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: image } }
      ]
    }]
  };

  let lastError = 'OCR failed';
  for (const key of keys) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const text = await r.text();
      if (!r.ok) {
        lastError = 'Groq HTTP ' + r.status;
        continue;
      }
      const j = JSON.parse(text);
      const content = j?.choices?.[0]?.message?.content || '';
      const parsed = parseModelJson(content);
      const board = normaliseBoard(parsed.board);
      if (!board) {
        lastError = 'AI trả về ma trận bàn cờ không hợp lệ.';
        continue;
      }
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      return res.status(200).json({ ok:true, board, confidence, model:MODEL });
    } catch (e) {
      lastError = e?.message || String(e);
    }
  }
  return res.status(502).json({ ok:false, error:lastError });
}
