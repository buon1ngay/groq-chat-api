const GROQ_MODEL = 'meta-llama/llama-4-maverick-17b-128e-instruct';

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
    if (image.length > 12 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'Ảnh quá lớn' });
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
            max_tokens: 1800,
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: image } }
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
