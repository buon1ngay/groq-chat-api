// api/forum.js
// Cần thêm 2 biến môi trường trong Vercel Project Settings > Environment Variables:
//   SUPABASE_URL              = https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = (lấy trong Supabase > Project Settings > API > service_role)
// LƯU Ý: service_role key có toàn quyền, TUYỆT ĐỐI không đưa vào code client Android.

const MAX_TITLE = 200;
const MAX_CONTENT = 5000;
const MAX_AUTHOR = 50;

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong env');
    return res.status(500).json({ success: false, errorCode: '500', error: 'Máy chủ chưa cấu hình xong, thử lại sau' });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    // ─────────── GET: lấy danh mục hoặc bài viết đã duyệt ───────────
    if (req.method === 'GET') {
      const { action, category_id } = req.query;

      if (action === 'categories') {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_categories?select=id,name,icon&order=sort_order.asc`,
          { headers }
        );
        if (!r.ok) throw new Error('Supabase categories fetch failed: ' + (await r.text()));
        const data = await r.json();
        return res.status(200).json({ success: true, categories: data });
      }

      // Mặc định: lấy bài đã duyệt, lọc theo category_id nếu có
      let url = `${SUPABASE_URL}/rest/v1/forum_posts?select=id,category_id,title,content,author,created_at&status=eq.approved&order=created_at.desc&limit=30`;
      if (category_id) url += `&category_id=eq.${encodeURIComponent(category_id)}`;

      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error('Supabase posts fetch failed: ' + (await r.text()));
      const data = await r.json();
      return res.status(200).json({ success: true, posts: data });
    }

    // ─────────── POST: gửi bài mới, mặc định pending chờ duyệt ───────────
    if (req.method === 'POST') {
      const { category_id, title, content, author } = req.body || {};

      if (!category_id || !title || !String(title).trim() || !content || !String(content).trim()) {
        return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu danh mục, tiêu đề hoặc nội dung' });
      }
      if (String(title).length > MAX_TITLE) {
        return res.status(413).json({ success: false, errorCode: '413', error: `Tiêu đề tối đa ${MAX_TITLE} ký tự` });
      }
      if (String(content).length > MAX_CONTENT) {
        return res.status(413).json({ success: false, errorCode: '413', error: `Nội dung tối đa ${MAX_CONTENT} ký tự` });
      }

      const body = {
        category_id,
        title: String(title).trim(),
        content: String(content).trim(),
        author: (author ? String(author).trim() : 'Ẩn danh').slice(0, MAX_AUTHOR),
        status: 'pending'
      };

      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(body)
      });

      if (!r.ok) {
        console.error('Supabase insert error:', await r.text());
        return res.status(500).json({ success: false, errorCode: '500', error: 'Không lưu được bài viết, thử lại sau' });
      }

      return res.status(200).json({ success: true, message: 'Đã gửi bài, chờ admin duyệt nhé!' });
    }

    return res.status(405).json({ success: false, errorCode: '405', error: 'Method không hỗ trợ' });

  } catch (error) {
    console.error('forum API error:', error);
    return res.status(500).json({ success: false, errorCode: '500', error: 'Lỗi hệ thống, thử lại sau' });
  }
}
