// /api/supabase-keepalive.js
// Vercel Serverless Function — gọi định kỳ để giữ Supabase project không bị pause.
//
// Cách hoạt động:
//   - Đọc thử 1 dòng từ bảng xq_position_memory (query rất nhẹ, gần như miễn phí).
//   - Bất kỳ truy vấn nào chạm tới database đều tính là "hoạt động",
//     đủ để reset lại đồng hồ 7-ngày-không-dùng của Supabase Free tier.
//   - KHÔNG cần bảng phải có dữ liệu, kể cả bảng rỗng vẫn tính là có truy vấn.
//
// Bảo vệ endpoint (tuỳ chọn nhưng nên bật):
//   Vercel Cron tự động gửi kèm header "Authorization: Bearer <CRON_SECRET>"
//   nếu bạn khai báo biến môi trường CRON_SECRET. Đoạn dưới sẽ kiểm tra để
//   chặn người ngoài gọi trực tiếp URL này (dù endpoint chỉ đọc, không ghi,
//   rủi ro thấp, nhưng chặn cho sạch).

export default async function handler(req, res) {
  // Nếu bạn có set biến môi trường CRON_SECRET trong Vercel, bật đoạn kiểm tra này:
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const SB_URL = process.env.SUPABASE_URL;   // vd: https://xxxx.supabase.co
  const SB_KEY = process.env.SUPABASE_ANON_KEY; // publishable/anon key

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ ok: false, error: 'missing SUPABASE_URL / SUPABASE_ANON_KEY env' });
  }

  try {
    const url = `${SB_URL}/rest/v1/xq_position_memory?select=pos_hash&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
      },
    });
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
