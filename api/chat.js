import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 🔑 4 API KEYS
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
].filter(Boolean);

if (API_KEYS.length === 0) {
  throw new Error('❌ Không tìm thấy GROQ_API_KEY!');
}

console.log(`🔑 Đã load ${API_KEYS.length} API keys`);

function createGroqClient() {
  const randomKey = API_KEYS[Math.floor(Math.random() * API_KEYS.length)];
  return new Groq({ apiKey: randomKey });
}

async function callGroqWithRetry(config, maxRetries = API_KEYS.length) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const groq = createGroqClient();
      return await groq.chat.completions.create(config);
    } catch (error) {
      lastError = error;

      // một số sdk/response trả rate limit khác nhau
      const status = error?.status || error?.statusCode || null;
      const message = (error?.message || '').toString();

      if (status === 429 || message.toLowerCase().includes('rate_limit') || message.toLowerCase().includes('rate limit')) {
        console.warn(`⚠️ Rate limit, thử key khác (${attempt + 1}/${maxRetries})`);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Hết ${maxRetries} keys: ${lastError?.message || 'unknown error'}`);
}

// ---------------------------
// 🔍 DuckDuckGo Search + Redis Cache
// ---------------------------
async function searchDuckDuckGo(query, { cacheTtl = 43200, maxChars = 1200 } = {}) {
  try {
    const cleanKey = `duck:${encodeURIComponent(query.trim().toLowerCase())}`;
    const cached = await redis.get(cleanKey);
    if (cached) {
      console.log('🟢 DuckDuckGo (cache hit)');
      return cached;
    }

    console.log('🟡 DuckDuckGo (fetching):', query);

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn('⚠️ DuckDuckGo response not OK', resp.status);
      return null;
    }

    const data = await resp.json();

    let result = '';

    if (data.Abstract && data.Abstract.trim().length > 0) {
      result = data.Abstract.trim();
    } else if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      // tìm text trong RelatedTopics flatten
      const findText = (rt) => {
        if (!rt) return null;
        if (rt.Text) return rt.Text;
        if (rt.Topics && rt.Topics.length > 0) return findText(rt.Topics[0]);
        return null;
      };
      for (const topic of data.RelatedTopics) {
        const text = findText(topic);
        if (text) {
          result = text;
          break;
        }
      }
    } else if (data.AbstractText && data.AbstractText.trim().length > 0) {
      result = data.AbstractText.trim();
    }

    if (!result || result.length === 0) {
      result = 'Không tìm thấy dữ liệu liên quan từ DuckDuckGo.';
    }

    // cắt để không làm prompt quá dài
    if (result.length > maxChars) {
      result = result.slice(0, maxChars).trim() + '...';
    }

    // Cache (setex)
    try {
      await redis.setex(cleanKey, cacheTtl, result);
    } catch (e) {
      console.warn('⚠️ Không thể set cache DuckDuckGo:', e?.message || e);
    }

    return result;
  } catch (err) {
    console.error('❌ DuckDuckGo fetch error:', err);
    return null;
  }
}

// ---------------------------
// 🔎 Intent detection (dùng model nhẹ để tiết kiệm quota)
// ---------------------------
async function detectSearchIntent(message) {
  try {
    const prompt = `
Phân tích ngắn gọn câu sau để xác định xem người dùng có muốn "tìm kiếm thông tin bên ngoài (web)" hay không.
Trả về JSON duy nhất với cấu trúc:
{"search": true/false, "query": "câu cần tìm (nếu có)", "reason": "giải thích ngắn"}

TIÊU CHÍ:
- Yêu cầu dữ liệu cập nhật, sự kiện, giá cả, thời gian thực, hay thông tin mà mô hình có thể không biết.
- Không phải trò chuyện, tâm sự, hỏi ý kiến thuần túy.

CÂU:
"${message}"
`.trim();

    // gọi model nhẹ để detect (dùng callGroqWithRetry để rotate keys)
    const result = await callGroqWithRetry({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'Bạn là bộ phân tích intent. Chỉ trả về JSON.' },
        { role: 'user', content: prompt }
      ]
    }, /*maxRetries=*/ API_KEYS.length);

    const content = result?.choices?.[0]?.message?.content || '';
    // lấy JSON trong content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        // bảo đảm cấu trúc
        return {
          search: Boolean(parsed.search),
          query: (parsed.query || '').toString().trim(),
          reason: parsed.reason || ''
        };
      } catch (e) {
        console.warn('⚠️ Intent JSON parse fail:', e);
      }
    }

    // fallback nhẹ: keyword method (nếu AI fail)
    const lower = message.toLowerCase();
    const searchKeywords = ['tìm', 'search', 'tra', 'hỏi web', 'web:', 'google', 'duck', 'wiki', 'wikipedia', 'giá', 'bao nhiêu', 'ngày', 'năm', 'thời tiết', 'tin tức'];
    const need = searchKeywords.some(k => lower.includes(k));
    if (need) {
      // tách query cơ bản
      const q = message.replace(/tìm|search|tra|hỏi web|web:|google|duck|wiki|wikipedia/gi, '').trim();
      return { search: true, query: q || message, reason: 'fallback keyword match' };
    }

    return { search: false, query: '', reason: 'no intent detected' };
  } catch (err) {
    console.error('❌ Intent detect error:', err);
    // fallback safe
    const lower = (message || '').toLowerCase();
    const searchKeywords = ['tìm', 'search', 'tra', 'hỏi web', 'web:', 'google', 'duck', 'wiki', 'wikipedia', 'giá', 'bao nhiêu', 'ngày', 'năm', 'thời tiết', 'tin tức'];
    const need = searchKeywords.some(k => lower.includes(k));
    if (need) return { search: true, query: message, reason: 'fallback on error' };
    return { search: false, query: '', reason: 'error fallback' };
  }
}

async function extractMemory(message, currentMemory) {
  try {
    const extractionPrompt = `Phân tích tin nhắn sau và trích xuất THÔNG TIN CÁ NHÂN QUAN TRỌNG cần lưu lâu dài.

THÔNG TIN CẦN LƯU (nếu có):
- Tên, biệt danh, cách gọi ưa thích
- Nghề nghiệp, công việc hiện tại
- Sở thích, đam mê, thói quen
- Thông tin gia đình (vợ/chồng, con cái, sinh nhật, tên...)
- Địa điểm sống, quê quán
- Mục tiêu, dự định trong tương lai
- Ngôn ngữ lập trình yêu thích (nếu là developer)
- Trình độ học vấn, trường học
- Sức khỏe quan trọng (dị ứng, bệnh mãn tính...)
- Bất kỳ thông tin USER YÊU CẦU BẠN NHỚ

TIN NHẮN CỦA USER:
"${message}"

THÔNG TIN ĐÃ LƯU TRƯỚC ĐÓ:
${JSON.stringify(currentMemory, null, 2)}

HÃY TRẢ VỀ JSON VỚI CẤU TRÚC:
{
  "hasNewInfo": true/false,
  "updates": {
    "Tên key": "Giá trị mới"
  },
  "summary": "Tóm tắt ngắn gọn đã lưu gì"
}

QUY TẮC:
- Chỉ lưu thông tin QUAN TRỌNG, KHÔNG lưu câu hỏi thông thường
- Key phải là tiếng Việt có dấu, dễ hiểu (ví dụ: "Tên", "Nghề nghiệp", "Sở thích")
- Nếu tin nhắn không có thông tin mới, trả về hasNewInfo: false
- CHỈ TRẢ VỀ JSON, KHÔNG CÓ TEXT KHÁC`;

    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: 'Bạn là trợ lý phân tích thông tin. Chỉ trả về JSON đúng format, không thêm markdown hay text khác.'
        },
        {
          role: 'user',
          content: extractionPrompt
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0]?.message?.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('📊 Memory extraction:', parsed);
      return parsed;
    }

    return { hasNewInfo: false };
  } catch (error) {
    console.error('❌ Error extracting memory:', error);
    return { hasNewInfo: false };
  }
}

function buildSystemPrompt(memory) {
  let prompt = 'Bạn tên là KAMI. Trợ lý AI thông minh hữu ích và thân thiện. Được tạo ra bởi Nguyễn Đức Thanh. Hãy trả lời bằng tiếng Việt một cách tự nhiên.';

  if (Object.keys(memory).length > 0) {
    prompt += '\n\n📝 THÔNG TIN BẠN BIẾT VỀ NGƯỜI DÙNG:\n';

    for (const [key, value] of Object.entries(memory)) {
      prompt += `- ${key}: ${value}\n`;
    }

    prompt += '\n⚠️ QUY TẮC:\n';
    prompt += '- Sử dụng các thông tin này một cách TỰ NHIÊN trong cuộc trò chuyện\n';
    prompt += '- ĐỪNG nhắc đi nhắc lại thông tin trừ khi được hỏi\n';
    prompt += '- Thể hiện bạn NHỚ người dùng qua cách xưng hô, cách nói chuyện phù hợp\n';
  }

  return prompt;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`📨 [${userId}] Message: ${message}`);

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await redis.get(chatKey) || [];
    if (typeof conversationHistory === 'string') {
      try {
        conversationHistory = JSON.parse(conversationHistory);
      } catch (e) {
        conversationHistory = [];
      }
    }

    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') {
      try {
        userMemory = JSON.parse(userMemory);
      } catch (e) {
        userMemory = {};
      }
    }

    console.log(`💾 Memory cho ${userId}:`, userMemory);

    const lowerMsg = message.toLowerCase().trim();

    // Các lệnh đặc biệt
    if (lowerMsg === '/memory' || lowerMsg === 'bạn nhớ gì về tôi' || lowerMsg === 'bạn biết gì về tôi') {

      let memoryText = '📝 Thông tin tôi nhớ về bạn:\n\n';

      if (Object.keys(userMemory).length === 0) {
        memoryText = '💭 Tôi chưa có thông tin nào về bạn. Hãy chia sẻ với tôi nhé!';
      } else {
        for (const [key, value] of Object.entries(userMemory)) {
          memoryText += `• ${key}: ${value}\n`;
        }
        memoryText += `\nTổng cộng ${Object.keys(userMemory).length} thông tin đã lưu.`;
      }

      return res.status(200).json({
        success: true,
        message: memoryText,
        userId: userId,
        memoryCount: Object.keys(userMemory).length
      });
    }

    if (lowerMsg === '/forget' || lowerMsg === 'quên tôi đi' || lowerMsg === 'xóa thông tin') {

      await redis.del(memoryKey);

      return res.status(200).json({
        success: true,
        message: '🗑️ Đã xóa toàn bộ thông tin về bạn. Chúng ta bắt đầu lại từ đầu nhé!',
        userId: userId
      });
    }

    if (lowerMsg.startsWith('/forget ')) {
      const keyToDelete = message.substring(8).trim();

      if (userMemory[keyToDelete]) {
        delete userMemory[keyToDelete];
        await redis.set(memoryKey, JSON.stringify(userMemory));

        return res.status(200).json({
          success: true,
          message: `🗑️ Đã xóa thông tin: ${keyToDelete}`,
          userId: userId
        });
      } else {
        return res.status(200).json({
          success: true,
          message: `❓ Không tìm thấy thông tin: ${keyToDelete}\n\nGõ /memory để xem danh sách.`,
          userId: userId
        });
      }
    }

    // === 1) Phân tích intent (AI) để quyết định có cần search hay không
    const intent = await detectSearchIntent(message);
    let webInfo = null;

    if (intent.search && intent.query) {
      // check cache trước (searchDuckDuckGo cũng check nhưng double-check key hợp lý)
      const cacheKey = `duck:${encodeURIComponent(intent.query.trim().toLowerCase())}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('⚡ Cache hit DuckDuckGo (intent):', intent.query);
        webInfo = cached;
      } else {
        console.log('🌐 Đang gọi DuckDuckGo theo intent:', intent.query);
        webInfo = await searchDuckDuckGo(intent.query, { cacheTtl: 43200, maxChars: 800 });
        if (webInfo) {
          try {
            await redis.setex(cacheKey, 43200, webInfo);
          } catch (e) {
            console.warn('⚠️ Không thể set cache (intent):', e?.message || e);
          }
        }
      }
    }

    //  Nếu có webInfo, thêm như message system phụ trước khi gọi Groq
    if (webInfo) {
      // đẩy DỮ LIỆU WEB vào conversationHistory như 1 system message
      conversationHistory.push({
        role: 'system',
        content: `DỮ LIỆU TÌM KIẾM (DuckDuckGo):\n${webInfo}\n\nHãy sử dụng dữ liệu này để trả lời chính xác; nếu mâu thuẫn, hãy ghi rõ nguồn là DuckDuckGo.`
      });
    }

    // Thêm user message vào history (nếu chưa thêm)
    // (Ở trên có thể đã push, nhưng đảm bảo user message có trong history)
    const last = conversationHistory[conversationHistory.length - 1];
    if (!last || last.role !== 'user' || last.content !== message) {
      conversationHistory.push({ role: 'user', content: message });
    }

    // giới hạn độ dài history
    if (conversationHistory.length > 50) {
      conversationHistory = conversationHistory.slice(-50);
    }

    const systemPrompt = buildSystemPrompt(userMemory);

    // Gọi Groq chính để trả lời
    const chatCompletion = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        ...conversationHistory
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    // === 2) Extract memory từ message (giữ nguyên logic)
    const memoryExtraction = await extractMemory(message, userMemory);

    let memoryUpdated = false;

    if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      try {
        await redis.set(memoryKey, JSON.stringify(userMemory));
        memoryUpdated = true;
        console.log(`💾 Đã lưu memory cho ${userId}:`, userMemory);
      } catch (e) {
        console.warn('⚠️ Không thể lưu memory lên Redis:', e?.message || e);
      }

      const memoryUpdate = memoryExtraction.summary || 'Đã cập nhật thông tin về bạn.';
      assistantMessage += `\n\n💾 _${memoryUpdate}_`;
    }

    // push assistant vào history
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    // lưu conversation history 30 ngày (2592000s)
    try {
      await redis.setex(chatKey, 2592000, JSON.stringify(conversationHistory));
    } catch (e) {
      console.warn('⚠️ Không thể lưu conversation history:', e?.message || e);
    }

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId: userId,
      conversationId: conversationId,
      historyLength: conversationHistory.length,
      memoryUpdated: memoryUpdated,
      memoryCount: Object.keys(userMemory).length
    });

  } catch (error) {
    console.error('❌ Error:', error);

    let errorMessage = error.message || 'Internal server error';

    if ((error.message || '').toLowerCase().includes('rate_limit') || (error.message || '').toLowerCase().includes('rate limit')) {
      errorMessage = '⚠️ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau vài phút.';
    }

    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
}
