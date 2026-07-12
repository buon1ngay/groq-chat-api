// Proxy Nominatim (OpenStreetMap) qua backend.
// Lý do cần proxy thay vì gọi thẳng từ app:
// - Nominatim usage policy yêu cầu User-Agent/Referer hợp lệ và giới hạn ~1 req/s.
//   Gọi thẳng từ hàng nghìn thiết bị (chia sẻ vài dải IP mạng di động) rất dễ
//   bị Nominatim chặn cả dải IP đó.
// - Qua proxy, ta có thể thêm cache ngắn hạn để giảm số request thật ra ngoài.

const NOMINATIM_UA = 'KamiMaps/1.0 (contact: groq-chat-api.vercel.app)';

async function nominatimFetch(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': NOMINATIM_UA,
      'Accept-Language': 'vi',
    },
  });
  if (!resp.ok) {
    throw new Error('Nominatim trả lỗi HTTP ' + resp.status);
  }
  return resp.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { action } = body;

    if (action === 'search') {
      const { q, minLon, minLat, maxLon, maxLat } = body;
      if (!q || !String(q).trim()) {
        return res.status(400).json({ success: false, error: 'Thiếu q' });
      }
      const params = new URLSearchParams({
        format: 'jsonv2',
        q: String(q).slice(0, 200),
        countrycodes: 'vn',
        limit: '8',
        'accept-language': 'vi',
      });
      if (minLon !== undefined && minLat !== undefined && maxLon !== undefined && maxLat !== undefined) {
        params.set('viewbox', `${minLon},${maxLat},${maxLon},${minLat}`);
      }
      const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
      const data = await nominatimFetch(url);
      return res.status(200).json({ success: true, results: data });
    }

    if (action === 'reverse') {
      const { lat, lon } = body;
      if (lat === undefined || lon === undefined) {
        return res.status(400).json({ success: false, error: 'Thiếu lat/lon' });
      }
      const params = new URLSearchParams({
        format: 'jsonv2',
        lat: String(lat),
        lon: String(lon),
        'accept-language': 'vi',
      });
      const url = `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;
      const data = await nominatimFetch(url);
      return res.status(200).json({ success: true, result: data });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
