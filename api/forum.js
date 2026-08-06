// api/forum.js - KamiForum v2.0
// API_BASE_URL = "https://memory-orpin-two.vercel.app/api"
//
// Biến môi trường:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_KEY

const MAX_TITLE = 200;
const MAX_CONTENT = 5000;
const MAX_AUTHOR = 50;
const MAX_COMMENT = 1000;
const POSTS_PER_PAGE = 100;

export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_KEY = process.env.ADMIN_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ success: false, errorCode: '500', error: 'Server chưa cấu hình xong' });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    // ═══════════ GET ═══════════
    if (req.method === 'GET') {
      const { action, category_id, q, post_id, user_id, page, status } = req.query;

      // ── Danh mục ──
      if (action === 'categories') {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_categories?select=id,name,icon,sort_order&order=sort_order.asc`,
          { headers }
        );
        if (!r.ok) throw new Error('categories fetch failed');
        return res.status(200).json({ success: true, categories: await r.json() });
      }

      // ── Lấy 1 bài viết chi tiết (kèm comments) ──
      if (action === 'post' && post_id) {
        // Tăng view count (async, không chờ)
        fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_post_views`, {
          method: 'POST', headers, body: JSON.stringify({ p_post_id: parseInt(post_id) })
        }).catch(() => {});

        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(post_id)}&select=*,forum_categories(name)`,
          { headers }
        );
        if (!r.ok) throw new Error('post fetch failed');
        const posts = await r.json();
        if (!posts.length) return res.status(404).json({ success: false, error: 'Không tìm thấy bài viết' });

        const post = posts[0];
        post.category_name = post.forum_categories?.name || '';
        delete post.forum_categories;

        // Lấy comments
        const cr = await fetch(
          `${SUPABASE_URL}/rest/v1/rpc/get_post_comments?p_post_id=${encodeURIComponent(post_id)}`,
          { headers }
        );
        post.comments = cr.ok ? await cr.json() : [];

        return res.status(200).json({ success: true, post });
      }

      // ── Danh sách bài viết (phân trang) ──
      if (action === 'posts') {
        const pg = Math.max(1, parseInt(page) || 1);
        const offset = (pg - 1) * POSTS_PER_PAGE;
        const st = status || 'approved';

        let url = `${SUPABASE_URL}/rest/v1/forum_posts?select=id,category_id,title,content,author,user_id,status,view_count,comment_count,created_at&status=eq.${st}&order=created_at.desc&limit=${POSTS_PER_PAGE}&offset=${offset}`;
        if (category_id) url += `&category_id=eq.${encodeURIComponent(category_id)}`;
        if (user_id) url += `&user_id=eq.${encodeURIComponent(user_id)}`;

        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error('posts fetch failed');
        const data = await r.json();

        // Đếm tổng
        let countUrl = `${SUPABASE_URL}/rest/v1/forum_posts?select=id&status=eq.${st}`;
        if (category_id) countUrl += `&category_id=eq.${encodeURIComponent(category_id)}`;
        if (user_id) countUrl += `&user_id=eq.${encodeURIComponent(user_id)}`;
        const cr = await fetch(countUrl, { headers });
        const total = cr.ok ? (await cr.json()).length : data.length;

        return res.status(200).json({ 
          success: true, 
          posts: data, 
          pagination: { page: pg, perPage: POSTS_PER_PAGE, total, totalPages: Math.ceil(total / POSTS_PER_PAGE) }
        });
      }

      // ── Tìm kiếm nâng cao (dùng RPC function) ──
      if (action === 'search' && q) {
        const keyword = q.trim();
        if (!keyword) return res.status(400).json({ success: false, error: 'Thiếu từ khóa' });

        const pg = Math.max(1, parseInt(page) || 1);
        const offset = (pg - 1) * POSTS_PER_PAGE;
        const cat = category_id ? parseInt(category_id) : null;

        // Gọi RPC search
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_forum_posts_v2`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            search_query: keyword,
            p_category_id: cat,
            p_limit: POSTS_PER_PAGE,
            p_offset: offset
          })
        });

        if (!r.ok) {
          // Fallback về ilike nếu RPC lỗi
          const orConditions = keyword.split(/\s+/).filter(w => w.length >= 2).map(k => 
            `title.ilike.*${encodeURIComponent(k)}*,content.ilike.*${encodeURIComponent(k)}*`
          ).join(',');

          let fbUrl = `${SUPABASE_URL}/rest/v1/forum_posts?select=id,title,content,author,user_id,category_id,view_count,comment_count,created_at&status=eq.approved&or=(${orConditions})&order=created_at.desc&limit=${POSTS_PER_PAGE}&offset=${offset}`;
          if (cat) fbUrl += `&category_id=eq.${encodeURIComponent(cat)}`;

          const fbr = await fetch(fbUrl, { headers });
          const fbData = fbr.ok ? await fbr.json() : [];
          return res.status(200).json({ success: true, posts: fbData, pagination: { page: pg, perPage: POSTS_PER_PAGE, total: fbData.length, totalPages: 1 } });
        }

        const data = await r.json();

        // Đếm tổng
        const cr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/count_search_forum_posts`, {
          method: 'POST', headers, body: JSON.stringify({ search_query: keyword, p_category_id: cat })
        });
        const total = cr.ok ? (await cr.json()) : data.length;

        return res.status(200).json({ 
          success: true, 
          posts: data, 
          pagination: { page: pg, perPage: POSTS_PER_PAGE, total, totalPages: Math.ceil(total / POSTS_PER_PAGE) }
        });
      }

      // ── Thống kê user ──
      if (action === 'userStats' && user_id) {
        const [totalR, approvedR, pendingR, rejectedR, commentsR] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/forum_posts?select=id&user_id=eq.${encodeURIComponent(user_id)}`, { headers }),
          fetch(`${SUPABASE_URL}/rest/v1/forum_posts?select=id&user_id=eq.${encodeURIComponent(user_id)}&status=eq.approved`, { headers }),
          fetch(`${SUPABASE_URL}/rest/v1/forum_posts?select=id&user_id=eq.${encodeURIComponent(user_id)}&status=eq.pending`, { headers }),
          fetch(`${SUPABASE_URL}/rest/v1/forum_posts?select=id&user_id=eq.${encodeURIComponent(user_id)}&status=eq.rejected`, { headers }),
          fetch(`${SUPABASE_URL}/rest/v1/forum_comments?select=id&user_id=eq.${encodeURIComponent(user_id)}`, { headers })
        ]);

        return res.status(200).json({
          success: true,
          stats: {
            totalPosts: totalR.ok ? (await totalR.json()).length : 0,
            approved: approvedR.ok ? (await approvedR.json()).length : 0,
            pending: pendingR.ok ? (await pendingR.json()).length : 0,
            rejected: rejectedR.ok ? (await rejectedR.json()).length : 0,
            totalComments: commentsR.ok ? (await commentsR.json()).length : 0
          }
        });
      }

      // ── Admin: tất cả bài ──
      if (action === 'admin') {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_posts?select=*,forum_categories(name)&order=created_at.desc`,
          { headers }
        );
        if (!r.ok) throw new Error('admin fetch failed');
        const data = await r.json();
        return res.status(200).json({ 
          success: true, 
          posts: data.map(p => ({ ...p, category_name: p.forum_categories?.name || '' }))
        });
      }

      // ── Mặc định: lấy bài đã duyệt ──
      let url = `${SUPABASE_URL}/rest/v1/forum_posts?select=id,category_id,title,content,author,user_id,view_count,comment_count,created_at&status=eq.approved&order=created_at.desc&limit=${POSTS_PER_PAGE}`;
      if (category_id) url += `&category_id=eq.${encodeURIComponent(category_id)}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error('posts fetch failed');
      return res.status(200).json({ success: true, posts: await r.json() });
    }

    // ═══════════ POST ═══════════
    if (req.method === 'POST') {
      const body = req.body || {};

      // ── Moderate ──
      if (body.action === 'moderate') {
        return await handleModerate(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Delete post ──
      if (body.action === 'delete') {
        return await handleDelete(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Update post ──
      if (body.action === 'update') {
        return await handleUpdate(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Add category ──
      if (body.action === 'addCategory') {
        return await handleAddCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Edit category ──
      if (body.action === 'editCategory') {
        return await handleEditCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Delete category ──
      if (body.action === 'deleteCategory') {
        return await handleDeleteCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Add comment ──
      if (body.action === 'addComment') {
        return await handleAddComment(body, SUPABASE_URL, headers, res);
      }
      // ── Delete comment ──
      if (body.action === 'deleteComment') {
        return await handleDeleteComment(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Gửi bài mới ──
      return await handleSubmit(body, SUPABASE_URL, headers, res);
    }

    return res.status(405).json({ success: false, errorCode: '405', error: 'Method không hỗ trợ' });

  } catch (error) {
    console.error('forum API error:', error);
    return res.status(500).json({ success: false, errorCode: '500', error: 'Lỗi hệ thống' });
  }
}

// ============ HANDLERS ============

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
    method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ status })
  });
  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không cập nhật được' });
  return res.status(200).json({ success: true, message: status === 'approved' ? 'Đã duyệt' : 'Đã từ chối' });
}

async function handleDelete(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, userId } = body;

  // Admin có thể xóa mọi bài, user chỉ xóa bài của mình
  const isAdmin = ADMIN_KEY && body.adminKey === ADMIN_KEY;

  if (!isAdmin) {
    // Kiểm tra ownership
    const checkR = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(id)}&select=user_id`, { headers });
    const posts = checkR.ok ? await checkR.json() : [];
    if (!posts.length || posts[0].user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Không có quyền xóa bài này' });
    }
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' }
  });
  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không xóa được' });
  return res.status(200).json({ success: true, message: 'Đã xóa bài viết' });
}

async function handleUpdate(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, title, content, category_id, userId } = body;
  const isAdmin = ADMIN_KEY && body.adminKey === ADMIN_KEY;

  if (!isAdmin) {
    const checkR = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(id)}&select=user_id`, { headers });
    const posts = checkR.ok ? await checkR.json() : [];
    if (!posts.length || posts[0].user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Không có quyền sửa bài này' });
    }
  }

  if (!id) return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id' });

  const updateData = {};
  if (title !== undefined) updateData.title = String(title).trim();
  if (content !== undefined) updateData.content = String(content).trim();
  if (category_id !== undefined) updateData.category_id = category_id;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Không có dữ liệu cập nhật' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(updateData)
  });
  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không cập nhật được' });
  return res.status(200).json({ success: true, message: 'Đã cập nhật bài viết' });
}

async function handleAddCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { name, icon, sort_order } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });
  if (!name || !String(name).trim()) return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu tên danh mục' });

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ name: String(name).trim(), icon: icon || '📁', sort_order: sort_order || 0 })
  });
  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không thêm được' });
  return res.status(200).json({ success: true, message: 'Đã thêm danh mục' });
}

async function handleEditCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, name, icon, sort_order } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });
  if (!id) return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id' });

  const updateData = {};
  if (name !== undefined) updateData.name = String(name).trim();
  if (icon !== undefined) updateData.icon = icon;
  if (sort_order !== undefined) updateData.sort_order = sort_order;

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(updateData)
  });
  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không cập nhật được' });
  return res.status(200).json({ success: true, message: 'Đã cập nhật danh mục' });
}

async function handleDeleteCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, errorCode: '403', error: auth.error });
  if (!id) return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu id' });

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' }
  });
  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không xóa được' });
  return res.status(200).json({ success: true, message: 'Đã xóa danh mục' });
}

async function handleAddComment(body, SUPABASE_URL, headers, res) {
  const { post_id, user_id, author, content, parent_id } = body;

  if (!post_id || !user_id || !content || !String(content).trim()) {
    return res.status(400).json({ success: false, errorCode: '400', error: 'Thiếu thông tin bình luận' });
  }
  if (String(content).length > MAX_COMMENT) {
    return res.status(413).json({ success: false, errorCode: '413', error: `Bình luận tối đa ${MAX_COMMENT} ký tự` });
  }

  const insertBody = {
    post_id: parseInt(post_id),
    user_id: String(user_id).trim(),
    author: (author ? String(author).trim() : 'Ẩn danh').slice(0, MAX_AUTHOR),
    content: String(content).trim(),
    parent_id: parent_id ? parseInt(parent_id) : null
  };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_comments`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(insertBody)
  });

  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không lưu được bình luận' });

  // Cập nhật comment_count
  fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${post_id}`, {
    method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ comment_count: { "#increment": 1 } })
  }).catch(() => {});

  return res.status(200).json({ success: true, message: 'Đã gửi bình luận' });
}

async function handleDeleteComment(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, userId } = body;
  const isAdmin = ADMIN_KEY && body.adminKey === ADMIN_KEY;

  if (!isAdmin && userId) {
    const checkR = await fetch(`${SUPABASE_URL}/rest/v1/forum_comments?id=eq.${encodeURIComponent(id)}&select=user_id,post_id`, { headers });
    const comments = checkR.ok ? await checkR.json() : [];
    if (!comments.length || comments[0].user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Không có quyền xóa' });
    }
    // Giảm comment_count
    if (comments[0].post_id) {
      fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${comments[0].post_id}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ comment_count: { "#decrement": 1 } })
      }).catch(() => {});
    }
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_comments?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' }
  });
  if (!r.ok) return res.status(500).json({ success: false, errorCode: '500', error: 'Không xóa được' });
  return res.status(200).json({ success: true, message: 'Đã xóa bình luận' });
}

async function handleSubmit(body, SUPABASE_URL, headers, res) {
  const { category_id, title, content, author, user_id, is_anonymous } = body;

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
    author: (is_anonymous ? 'Ẩn danh' : (author ? String(author).trim() : 'Ẩn danh')).slice(0, MAX_AUTHOR),
    user_id: user_id || null,
    status: 'pending'
  };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(insertBody)
  });

  if (!r.ok) {
    console.error('Supabase insert error:', await r.text());
    return res.status(500).json({ success: false, errorCode: '500', error: 'Không lưu được bài viết' });
  }

  return res.status(200).json({ success: true, message: 'Đã gửi bài, chờ admin duyệt nhé!' });
}
