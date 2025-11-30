import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// ==================== REDIS ====================
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ==================== API KEYS & MODEL ====================
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);

// 🤖 CẤU HÌNH MODEL - CHỈ SỬA Ở ĐÂY
const MODELS = {
  main: 'llama-3.1-8b-instant',      // Model chính cho chat
  search: 'llama-3.1-8b-instant',    // Đổi sang 70b (limit cao hơn)
  memory: 'llama-3.1-8b-instant',       // Model trích xuất memory (nhẹ)
};

if (API_KEYS.length === 0) {
  throw new Error('❌ Không tìm thấy GROQ_API_KEY!');
}

console.log(`🔑 Đã load ${API_KEYS.length} API keys`);
console.log(`🤖 Models: Main=${MODELS.main}, Search=${MODELS.search}, Memory=${MODELS.memory}`);

let lastKeyIndex = -1; // xoay vòng

function createGroqClient() {
  lastKeyIndex = (lastKeyIndex + 1) % API_KEYS.length;
  return new Groq({ apiKey: API_KEYS[lastKeyIndex] });
}

// ==================== SEARCH APIs - XOAY VÒNG ====================
const SEARCH_APIS = [
  {
    name: 'Serper',
    apiKey: process.env.SERPER_API_KEY,
    enabled: !!process.env.SERPER_API_KEY,
    async search(query) {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', num: 5 })
      });

      if (!response.ok) return null;
      const data = await response.json();
      let results = '';

      if (data.knowledgeGraph) {
        const kg = data.knowledgeGraph;
        results += `${kg.title || ''}\n${kg.description || ''}\n\n`;
      }

      if (data.answerBox?.answer) results += `${data.answerBox.answer}\n\n`;

      if (data.organic && data.organic.length > 0) {
        data.organic.slice(0, 3).forEach((item) => {
          results += `${item.title}\n${item.snippet || ''}\n\n`;
        });
      }

      return results.trim() || null;
    }
  },
  {
    name: 'Tavily',
    apiKey: process.env.TAVILY_API_KEY,
    enabled: !!process.env.TAVILY_API_KEY,
    async search(query) {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: query,
          search_depth: 'basic',
          include_answer: true,
          max_results: 5
        })
      });

      if (!response.ok) return null;
      const data = await response.json();
      let results = '';

      if (data.answer) results += `${data.answer}\n\n`;

      if (data.results && data.results.length > 0) {
        data.results.slice(0, 3).forEach((item) => {
          results += `${item.title}\n${item.content ? item.content.substring(0, 150) : ''}...\n\n`;
        });
      }

      return results.trim() || null;
    }
  }
].filter(api => api.enabled);

console.log(`🔍 Đã load ${SEARCH_APIS.length} Search APIs: ${SEARCH_APIS.map(a => a.name).join(', ')}`);

let lastSearchIndex = -1; // xoay vòng search API

async function searchWeb(query) {
  if (SEARCH_APIS.length === 0) {
    console.error('❌ Không có Search API nào!');
    return null;
  }

  // Thử xoay vòng qua các API
  for (let i = 0; i < SEARCH_APIS.length; i++) {
    lastSearchIndex = (lastSearchIndex + 1) % SEARCH_APIS.length;
    const api = SEARCH_APIS[lastSearchIndex];

    try {
      console.log(`   Trying ${api.name}...`);
      const result = await api.search(query);
      if (result) {
        console.log(`✅ ${api.name} success!`);
        return result;
      }
    } catch (error) {
      console.error(`❌ ${api.name} error:`, error.message);
      continue;
    }
  }

  console.log('⚠️ All search APIs failed');
  return null;
}

// ==================== PHÁT HIỆN CẦN SEARCH ====================
async function needsWebSearch(message) {
  // Quick check bằng regex
  const triggers = [
    /hiện (tại|nay|giờ)|bây giờ|lúc này/i,
    /năm (19|20)\d{2}/i,
    /mới nhất|gần đây|vừa rồi|hôm (nay|qua)/i,
    /giá|tỷ giá|bao nhiêu tiền/i,
    /tin tức|sự kiện|cập nhật/i,
    /ai là|who is|là ai/i,
    /khi nào|when|bao giờ/i,
    /ở đâu|where|tại đâu/i,
  ];
  
  if (triggers.some(pattern => pattern.test(message))) {
    console.log('✅ Quick trigger matched!');
    return true;
  }

  // Dùng AI phán đoán thông minh hơn
  try {
    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: `Xác định câu hỏi có CẦN TÌM KIẾM WEB không.

CẦN TÌM KIẾM nếu:
- Hỏi về sự kiện hiện tại, tin tức mới
- Hỏi về người nổi tiếng (ai là, làm gì)
- Hỏi về số liệu, giá cả, tỷ giá
- Hỏi về địa điểm, quốc gia, thành phố
- Hỏi về công nghệ mới, sản phẩm mới

KHÔNG CẦN nếu:
- Kiến thức chung, khái niệm
- Giải thích, hướng dẫn
- Trò chuyện thông thường

CHỈ TRẢ "YES" hoặc "NO".`
        },
        {
          role: 'user',
          content: `Câu hỏi: "${message}"\n\nCần tìm kiếm web không?`
        }
      ],
      model: MODELS.search,
      temperature: 0.1,
      max_tokens: 10
    });

    const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
    const needsSearch = answer === 'YES';
    
    console.log(`🤖 AI decision: ${answer} -> ${needsSearch ? 'SEARCH' : 'NO SEARCH'}`);
    
    return needsSearch;
  } catch (error) {
    console.error('❌ AI detection error:', error);
    // Fallback: nếu có dấu hỏi thì search
    return message.includes('?');
  }
}

// ==================== CALL GROQ WITH RETRY ====================
async function callGroqWithRetry(config, maxRetries = API_KEYS.length) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const groq = createGroqClient();
      return await groq.chat.completions.create(config);
    } catch (error) {
      lastError = error;
      
      // Token limit error - không retry, throw luôn
      if (error.status === 413 || error.message?.includes('Request too large')) {
        console.error('❌ Request too large! Reduce message size.');
        throw new Error('Request quá lớn. Vui lòng gửi tin nhắn ngắn hơn hoặc bắt đầu cuộc trò chuyện mới.');
      }
      
      // Rate limit - thử key khác
      if (error.status === 429 || error.message?.includes('rate_limit')) {
        console.warn(`⚠️ Rate limit, thử key khác (${attempt + 1}/${maxRetries})`);
        continue;
      }
      
      throw error;
    }
  }

  throw new Error(`Hết ${maxRetries} keys: ${lastError.message}`);
}

// ==================== MEMORY EXTRACTION ====================
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
- Key phải là tiếng Việt có dấu, dễ hiểu
- Nếu tin nhắn không có thông tin mới, trả về hasNewInfo: false
- CHỈ TRẢ VỀ JSON, KHÔNG CÓ TEXT KHÁC`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý phân tích thông tin. Chỉ trả về JSON đúng format, không thêm markdown hay text khác.' },
        { role: 'user', content: extractionPrompt }
      ],
      model: MODELS.memory,
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0]?.message?.content || '{}';
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

// ==================== SYSTEM PROMPT BUILDER ====================
function buildSystemPrompt(memory, searchResults = null) {
  let prompt = 'Bạn là KAMI, trợ lý AI thân thiện của Nguyễn Đức Thanh.';

  if (searchResults) {
    prompt += '\n\nDữ liệu:\n' + searchResults;
    prompt += '\nTrả lời ngắn gọn dựa trên dữ liệu trên.';
  }

  if (Object.keys(memory).length > 0) {
    prompt += '\n\nThông tin user:\n';
    for (const [key, value] of Object.entries(memory)) {
      prompt += `${key}: ${value}\n`;
    }
  }

  return prompt;
}

// ==================== MAIN HANDLER ====================
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
    if (typeof conversationHistory === 'string') conversationHistory = JSON.parse(conversationHistory);

    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') userMemory = JSON.parse(userMemory);

    console.log(`💾 Memory cho ${userId}:`, userMemory);

    // ==================== LỆNH /MEMORY ====================
    const lowerMsg = message.toLowerCase();
    if (lowerMsg === '/memory' || lowerMsg === 'bạn nhớ gì về tôi' || lowerMsg === 'bạn biết gì về tôi') {
      let memoryText = '📝 **Thông tin tôi nhớ về bạn:**\n\n';
      if (Object.keys(userMemory).length === 0) memoryText = '💭 Tôi chưa có thông tin nào về bạn. Hãy chia sẻ với tôi nhé!';
      else {
        for (const [key, value] of Object.entries(userMemory)) memoryText += `• **${key}:** ${value}\n`;
        memoryText += `\n_Tổng cộng ${Object.keys(userMemory).length} thông tin đã lưu._`;
      }
      return res.status(200).json({ success: true, message: memoryText, userId, memoryCount: Object.keys(userMemory).length });
    }

    // ==================== LỆNH /FORGET ====================
    if (lowerMsg === '/forget' || lowerMsg === 'quên tôi đi' || lowerMsg === 'xóa thông tin') {
      await redis.del(memoryKey);
      return res.status(200).json({ success: true, message: '🗑️ Đã xóa toàn bộ thông tin về bạn. Chúng ta bắt đầu lại từ đầu nhé!', userId });
    }

    if (lowerMsg.startsWith('/forget ')) {
      const keyToDelete = message.substring(8).trim();
      if (userMemory[keyToDelete]) {
        delete userMemory[keyToDelete];
        await redis.set(memoryKey, JSON.stringify(userMemory));
        return res.status(200).json({ success: true, message: `🗑️ Đã xóa thông tin: **${keyToDelete}**`, userId });
      } else {
        return res.status(200).json({ success: true, message: `❓ Không tìm thấy thông tin: **${keyToDelete}**\n\nGõ /memory để xem danh sách.`, userId });
      }
    }

    // ==================== CHUYỂN MESSAGE VÀ CHAT ====================
    conversationHistory.push({ role: 'user', content: message });
    
    // Giảm history để tránh vượt token limit (8b-instant chỉ 6000 TPM)
    if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

    // ==================== WEB SEARCH ====================
    let searchResults = null;
    let usedSearch = false;
    
    if (await needsWebSearch(message)) {
      console.log('🔍 Triggering web search...');
      searchResults = await searchWeb(message);
      usedSearch = !!searchResults;
    }

    const systemPrompt = buildSystemPrompt(userMemory, searchResults);
    
    const chatCompletion = await callGroqWithRetry({
      messages: [{ role: 'system', content: systemPrompt }, ...conversationHistory],
      model: MODELS.main,
      temperature: 0.7,
      max_tokens: 512,  // ⚡ Giảm từ 1024 → 512
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    // ==================== FILTER XÓA TEXT CẤM ====================
    if (usedSearch) {
      assistantMessage = assistantMessage
        .split('\n')
        .filter(line => !line.includes('🌐'))
        .filter(line => !line.includes('💻'))
        .filter(line => !line.toLowerCase().includes('tôi đã tìm'))
        .filter(line => !line.toLowerCase().includes('tôi tìm thấy'))
        .filter(line => !line.toLowerCase().includes('tôi nhớ lại'))
        .filter(line => !line.toLowerCase().includes('vui lòng cho tôi biết'))
        .filter(line => !line.toLowerCase().includes('cậu chủ cần thông tin'))
        .filter(line => !line.toLowerCase().includes('dựa trên web'))
        .filter(line => !line.toLowerCase().includes('không có khả năng cập nhật'))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    const memoryExtraction = await extractMemory(message, userMemory);
    let memoryUpdated = false;

    if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      await redis.set(memoryKey, JSON.stringify(userMemory));
      memoryUpdated = true;

      console.log(`💾 Đã lưu memory cho ${userId}:`, userMemory);
      const memoryUpdate = memoryExtraction.summary || 'Đã cập nhật thông tin về bạn.';
      assistantMessage += `\n\n💾 _${memoryUpdate}_`;
    }

    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    await redis.setex(chatKey, 2592000, JSON.stringify(conversationHistory));

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId,
      conversationId,
      historyLength: conversationHistory.length,
      memoryUpdated,
      memoryCount: Object.keys(userMemory).length,
      usedWebSearch: usedSearch
    });

  } catch (error) {
    console.error('❌ Error:', error);
    let errorMessage = error.message || 'Internal server error';
    if (error.message?.includes('rate_limit')) errorMessage = '⚠️ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau vài phút.';
    return res.status(500).json({ success: false, error: errorMessage });
  }
}
