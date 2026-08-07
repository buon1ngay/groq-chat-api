// api/forum.js
// Cần thêm 3 biến môi trường trong Vercel Project Settings > Environment Variables:
//   SUPABASE_URL              = https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = (lấy trong Supabase > Project Settings > API > service_role)
//   ADMIN_KEY                 = (tự đặt, dùng cho admin panel duyệt bài)
// LƯU Ý: service_role key có toàn quyền, TUYỆT ĐỐI không đưa vào code client Android.

const MAX_TITLE = 200;
const MAX_CONTENT = 5000;
const MAX_AUTHOR = 50;

export default async function handler(req, res) {
  // ── CORS headers for all responses ──
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');

  // ── Handle OPTIONS preflight ──
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_KEY = process.env.ADMIN_KEY;

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
    // ─────────── GET ───────────
    if (req.method === 'GET') {
      const { action, category_id, q } = req.query;

      // ── Lấy danh mục ──
      if (action === 'categories') {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_categories?select=id,name,icon,sort_order&order=sort_order.asc`,
          { headers }
        );
        if (!r.ok) throw new Error('Supabase categories fetch failed: ' + (await r.text()));
        const data = await r.json();
        return res.status(200).json({ success: true, categories: data });
      }

      // ── Admin: lấy tất cả bài viết (mọi status) ──
      if (action === 'admin') {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_posts?select=*,forum_categories(name)&order=created_at.desc`,
          { headers }
        );
        if (!r.ok) throw new Error('Supabase admin posts fetch failed: ' + (await r.text()));
        const data = await r.json();
        const posts = data.map(p => ({
          ...p,
          category_name: p.forum_categories?.name || ''
        }));
        return res.status(200).json({ success: true, posts });
      }

      // ── Search: tìm kiếm bài viết đã duyệt theo từ khóa ──
      if (action === 'search') {
        if (!q || !q.trim()) {
          return res.status(400).json({ success: false, error: 'Thiếu từ khóa tìm kiếm' });
        }
        const keyword = encodeURIComponent(q.trim());
        // PostgREST or syntax: or=(title.ilike.*keyword*,content.ilike.*keyword*)
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_posts?select=id,title,content,author,category_id,created_at&status=eq.approved&or=(title.ilike.*${keyword}*,content.ilike.*${keyword}*)&order=created_at.desc&limit=10`,
          { headers }
        );
        if (!r.ok) throw new Error('Supabase search failed: ' + (await r.text()));
        const data = await r.json();
        return res.status(200).json({ success: true, posts: data });
      }

      // ── Mặc định: lấy bài đã duyệt, lọc theo category_id nếu có ──
      let url = `${SUPABASE_URL}/rest/v1/forum_posts?select=id,category_id,title,content,author,created_at&status=eq.approved&order=created_at.desc&limit=30`;
      if (category_id) url += `&category_id=eq.${encodeURIComponent(category_id)}`;

      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error('Supabase posts fetch failed: ' + (await r.text()));
      const data = await r.json();
      return res.status(200).json({ success: true, posts: data });
    }

    // ─────────── POST ───────────
    if (req.method === 'POST') {
      const body = req.body || {};

      // ── Moderate: admin duyệt/từ chối bài ──
      if (body.action === 'moderate') {
        return await handleModerate(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }

      // ── Admin xóa bài viết ──
      if (body.action === 'delete') {
        return await handleDelete(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }

      // ── Admin sửa bài viết ──
      if (body.action === 'update') {
        return await handleUpdate(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }

      // ── Admin thêm danh mục mới ──
      if (body.action === 'addCategory') {
        return await handleAddCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }

      // ── Admin sửa danh mục ──
      if (body.action === 'editCategory') {
        return await handleEditCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }

      // ── Admin xóa danh mục ──
      if (body.action === 'deleteCategory') {
        return await handleDeleteCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }

      // ── Gửi bài mới, mặc định pending chờ duyệt ──
      return await handleSubmit(body, SUPABASE_URL, headers, res);
    }

    return res.status(405).json({ success: false, errorCode: '405', error: 'Method không hỗ trợ' });

  } catch (error) {
    console.error('forum API error:', error);
    return res.status(500).json({ success: false, errorCode: '500', error: 'Lỗi hệ thống, thử lại sau' });
  }
}

// ============ ADMIN HANDLERS ============

function verifyAdmin(body, ADMIN_KEY) {
  if (!ADMIN_KEY) return { ok: false, error: 'Admin key chưa được cấu hình' };
  if (body.adminKey !== ADMIN_KEY) return { ok: false, error: 'Admin key không đúng' };
  return { ok: true };
}

async function handleModerate(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, status } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });

  if (!id || !status || !['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id hoặc status không hợp lệ' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ status })
  });

  if (!r.ok) {
    console.error('Supabase moderate error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không cập nhật được trạng thái' });
  }

  return res.status(200).json({ success: true, message: status === 'approved' ? 'Đã duyệt bài viết' : 'Đã từ chối bài viết' });
}

async function handleDelete(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });

  if (!id) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id bài viết' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...headers, Prefer: 'return=minimal' }
  });

  if (!r.ok) {
    console.error('Supabase delete error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không xóa được bài viết' });
  }

  return res.status(200).json({ success: true, message: 'Đã xóa bài viết' });
}

async function handleUpdate(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, title, content, category_id } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });

  if (!id) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id bài viết' });
  }

  const updateData = {};
  if (title !== undefined) updateData.title = String(title).trim();
  if (content !== undefined) updateData.content = String(content).trim();
  if (category_id !== undefined) updateData.category_id = category_id;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Không có dữ liệu để cập nhật' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(updateData)
  });

  if (!r.ok) {
    console.error('Supabase update error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không cập nhật được bài viết' });
  }

  return res.status(200).json({ success: true, message: 'Đã cập nhật bài viết' });
}

async function handleAddCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { name, icon, sort_order } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });

  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu tên danh mục' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      name: String(name).trim(),
      icon: icon || '📁',
      sort_order: sort_order || 0
    })
  });

  if (!r.ok) {
    console.error('Supabase add category error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không thêm được danh mục' });
  }

  return res.status(200).json({ success: true, message: 'Đã thêm danh mục mới' });
}

async function handleEditCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, name, icon, sort_order } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });

  if (!id) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id danh mục' });
  }

  const updateData = {};
  if (name !== undefined) updateData.name = String(name).trim();
  if (icon !== undefined) updateData.icon = icon;
  if (sort_order !== undefined) updateData.sort_order = sort_order;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Không có dữ liệu để cập nhật' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(updateData)
  });

  if (!r.ok) {
    console.error('Supabase edit category error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không cập nhật được danh mục' });
  }

  return res.status(200).json({ success: true, message: 'Đã cập nhật danh mục' });
}

async function handleDeleteCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });

  if (!id) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id danh mục' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...headers, Prefer: 'return=minimal' }
  });

  if (!r.ok) {
    console.error('Supabase delete category error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không xóa được danh mục' });
  }

  return res.status(200).json({ success: true, message: 'Đã xóa danh mục' });
}

async function handleSubmit(body, SUPABASE_URL, headers, res) {
  const { category_id, title, content, author } = body;

  if (!category_id || !title || !String(title).trim() || !content || !String(content).trim()) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu danh mục, tiêu đề hoặc nội dung' });
  }
  if (String(title).length > MAX_TITLE) {
    return res.status(413).json({ success: false, errorCode: '413', error: `Tiêu đề tối đa ${MAX_TITLE} ký tự` });
  }
  if (String(content).length > MAX_CONTENT) {
    return res.status(413).json({ success: false, errorCode: '413', error: `Nội dung tối đa ${MAX_CONTENT} ký tự` });
  }

  const insertBody = {
    category_id,
    title: String(title).trim(),
    content: String(content).trim(),
    author: (author ? String(author).trim() : 'Ẩn danh').slice(0, MAX_AUTHOR),
    status: 'pending'
  };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(insertBody)
  });

  if (!r.ok) {
    console.error('Supabase insert error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không lưu được bài viết, thử lại sau' });
  }

  return res.status(200).json({ success: true, message: 'Đã gửi bài, chờ admin duyệt nhé!' });
}
