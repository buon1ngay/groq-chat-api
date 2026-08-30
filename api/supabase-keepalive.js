// /api/supabase-keepalive.js — BẢN DEBUG TẠM THỜI
// Sau khi xác định xong nguyên nhân 401, thay lại bằng bản gốc (không có phần debug).

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized (cron secret)' });
    }
  }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_ANON_KEY;

  // --- Thông tin chẩn đoán (an toàn, không lộ giá trị thật) ---
  const diag = {
    sb_url_present: !!SB_URL,
    sb_url_length: SB_URL ? SB_URL.length : 0,
    sb_url_preview: SB_URL ? (SB_URL.slice(0, 20) + '...' + SB_URL.slice(-10)) : null,
    sb_key_present: !!SB_KEY,
    sb_key_length: SB_KEY ? SB_KEY.length : 0,
    sb_key_prefix: SB_KEY ? SB_KEY.slice(0, 18) : null,
    sb_key_suffix: SB_KEY ? SB_KEY.slice(-6) : null,
    sb_key_has_whitespace: SB_KEY ? /\s/.test(SB_KEY) : null,
    sb_url_has_whitespace: SB_URL ? /\s/.test(SB_URL) : null,
  };

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ ok: false, error: 'missing SUPABASE_URL / SUPABASE_ANON_KEY env', diag });
  }

  try {
    const cleanUrl = SB_URL.trim().replace(/\/+$/, '');
    const url = `${cleanUrl}/rest/v1/xq_position_memory?select=pos_hash&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: SB_KEY.trim(),
        Authorization: `Bearer ${SB_KEY.trim()}`,
      },
    });
    const bodyText = await r.text();
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      supabase_response: bodyText.slice(0, 500),
      called_url: url,
      diag,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e), diag });
  }
}
