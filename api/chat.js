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

const MODELS = {
  main: 'llama-3.3-70b-versatile',
  search: 'llama-3.1-8b-instant',
  memory: 'llama-3.1-8b-instant',
};

if (API_KEYS.length === 0) throw new Error('❌ Không tìm thấy GROQ_API_KEY!');

console.log(`🔑 Load ${API_KEYS.length} GROQ API keys`);
console.log(`🤖 Models: Main=${MODELS.main}, Search=${MODELS.search}, Memory=${MODELS.memory}`);

let lastGroqKeyIndex = -1;
function createGroqClient() {
  lastGroqKeyIndex = (lastGroqKeyIndex + 1) % API_KEYS.length;
  return new Groq({ apiKey: API_KEYS[lastGroqKeyIndex] });
}

// ==================== SEARCH APIs - XOAY VÒNG ====================
const SEARCH_APIS = [
  {
    name: 'Serper',
    apiKey: process.env.SERPER_API_KEY,
    enabled: !!process.env.SERPER_API_KEY,
    async search(query) {
      const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', num: 5 })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      let results = '';
      if (data.knowledgeGraph) results += `${data.knowledgeGraph.title || ''}\n${data.knowledgeGraph.description || ''}\n\n`;
      if (data.answerBox?.answer) results += `${data.answerBox.answer}\n\n`;
      if (data.organic?.length) data.organic.slice(0, 3).forEach(item => results += `${item.title}\n${item.snippet || ''}\n\n`);
      return results.trim() || null;
    }
  },
  {
    name: 'Tavily',
    apiKey: process.env.TAVILY_API_KEY,
    enabled: !!process.env.TAVILY_API_KEY,
    async search(query) {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: 'basic',
          include_answer: true,
          max_results: 5
        })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      let results = '';
      if (data.answer) results += `${data.answer}\n\n`;
      if (data.results?.length) data.results.slice(0, 3).forEach(item =>
        results += `${item.title}\n${item.content ? item.content.substring(0, 150) : ''}...\n\n`
      );
      return results.trim() || null;
    }
  }
].filter(api => api.enabled);

console.log(`🔍 Load ${SEARCH_APIS.length} Search APIs: ${SEARCH_APIS.map(a => a.name).join(', ')}`);

let lastSearchApiIndex = -1;
const inFlightSearches = {};

async function searchWeb(query) {
  if (!SEARCH_APIS.length) return null;

  const cacheKey = `search:${query}`;

  if (inFlightSearches[query]) {
    console.log(`⚠️ Query đang chạy, bỏ qua: ${query}`);
    return null;
  }
  inFlightSearches[query] = true;

  try {
    let cached = null;
    try { 
      cached = await redis.get(cacheKey);
      if (cached && typeof cached === 'string') {
        cached = JSON.parse(cached);
      }
    } catch(e) { 
      console.warn('⚠️ Redis get cache failed:', e.message); 
    }
    if (cached) {
      console.log('✅ Cache hit:', query);
      return cached;
    }

    for (let i = 0; i < SEARCH_APIS.length; i++) {
      lastSearchApiIndex = (lastSearchApiIndex + 1) % SEARCH_APIS.length;
      const api = SEARCH_APIS[lastSearchApiIndex];
      try {
        console.log(`   🔎 Trying ${api.name}...`);
        const result = await api.search(query);
        if (result) {
          try { 
            await redis.setex(cacheKey, 900, JSON.stringify(result)); 
          } catch(e) { 
            console.warn('⚠️ Redis setex failed:', e.message); 
          }
          console.log(`✅ ${api.name} success`);
          return result;
        }
      } catch (e) {
        console.warn(`❌ ${api.name} error: ${e.message}`);
        continue;
      }
    }

    console.warn('⚠️ All search APIs failed');
    return null;

  } finally {
    setTimeout(() => { delete inFlightSearches[query]; }, 3000);
  }
}

// ==================== CẦN SEARCH ====================
async function needsWebSearch(message) {
  const triggers = [
    /hiện (tại|nay|giờ)|bây giờ|lúc này|đang diễn ra/i,
    /năm (19|20)\d{2}/i,
    /mới nhất|gần đây|vừa rồi|hôm (nay|qua)|tuần (này|trước)/i,
    /giá|tỷ giá|bao nhiêu tiền|chi phí/i,
    /tin tức|sự kiện|cập nhật|thông tin/i,
    /ai là|ai đã|là ai|người nào/i,
    /khi nào|lúc nào|bao giờ|thời gian/i,
    /ở đâu|chỗ nào|tại đâu|địa điểm/i,
    /thời tiết|nhiệt độ|khí hậu/i,
    /tỷ số|kết quả|đội|trận đấu/i,
  ];
  
  if (triggers.some(r => r.test(message))) return true;

  if (message.includes('?') && message.length < 100) {
    try {
      const response = await callGroqWithRetry({
        messages: [
          { role: 'system', content: `Xác định câu hỏi có CẦN TÌM KIẾM WEB không. Chỉ trả "YES" hoặc "NO".` },
          { role: 'user', content: message }
        ],
        model: MODELS.search,
        temperature: 0.1,
        max_tokens: 10
      });
      const ans = response.choices[0]?.message?.content?.trim().toUpperCase();
      return ans === 'YES';
    } catch (e) {
      console.warn('⚠️ needsWebSearch LLM call failed:', e.message);
      return false;
    }
  }
  
  return false;
}

// ==================== CALL GROQ RETRY ====================
async function callGroqWithRetry(config, maxRetries = API_KEYS.length) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const groq = createGroqClient();
      return await groq.chat.completions.create(config);
    } catch (e) {
      lastError = e;
      
      if (e.status === 413 || e.message?.includes('Request too large')) {
        throw new Error('❌ Request quá lớn. Hãy rút ngắn tin nhắn.');
      }
      
      if (e.status === 400) {
        throw new Error('❌ Request không hợp lệ: ' + e.message);
      }
      
      if (e.status === 429 || e.message?.includes('rate_limit')) {
        console.warn(`⚠️ Rate limit key ${lastGroqKeyIndex}, trying next...`);
        continue;
      }
      
      throw e;
    }
  }
  throw new Error(`❌ Hết ${maxRetries} API keys. Rate limit: ${lastError.message}`);
}

// ==================== MEMORY EXTRACTION ====================
async function extractMemory(message, currentMemory) {
  try {
    const prompt = `Phân tích tin nhắn và trích xuất thông tin CÁ NHÂN của user (tên, tuổi, sở thích, công việc, gia đình...).
    
TIN NHẮN: "${message}"

THÔNG TIN ĐÃ LƯU: ${JSON.stringify(currentMemory, null, 2)}

Trả về JSON:
{
  "hasNewInfo": true/false,
  "updates": { "key": "value" },
  "summary": "Tóm tắt ngắn gọn"
}`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý trích xuất thông tin. CHỈ TRẢ JSON, KHÔNG TEXT KHÁC.' },
        { role: 'user', content: prompt }
      ],
      model: MODELS.memory,
      temperature: 0.2,
      max_tokens: 200
    });
    
    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) return { hasNewInfo: false };
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    if (parsed.hasNewInfo && !parsed.updates) {
      return { hasNewInfo: false };
    }
    
    return parsed;
    
  } catch (e) {
    console.warn('⚠️ Memory extraction failed:', e.message);
    return { hasNewInfo: false };
  }
}

// ==================== SYSTEM PROMPT ====================
function buildSystemPrompt(memory, searchResults = null) {
  let prompt = `Bạn là KAMI, trợ lý AI thân thiện, hữu ích và chuyên nghiệp.

QUY TẮC:
- Trả lời ngắn gọn, rõ ràng
- Sử dụng emoji phù hợp
- Thân thiện nhưng không nói nhiều
- Nếu không biết, hãy thừa nhận`;

  if (searchResults) {
    prompt += `\n\n📊 DỮ LIỆU TÌM KIẾM:\n${searchResults}\n\n⚠️ Ưu tiên dùng dữ liệu trên để trả lời.`;
  }
  
  if (Object.keys(memory).length) {
    prompt += '\n\n👤 THÔNG TIN USER:\n';
    for (const [k, v] of Object.entries(memory)) {
      prompt += `• ${k}: ${v}\n`;
    }
  }
  
  return prompt;
}

// ==================== SAFE REDIS GET ====================
async function safeRedisGet(key, defaultValue = null) {
  try {
    const data = await redis.get(key);
    if (!data) return defaultValue;
    
    if (typeof data === 'object') {
      return data;
    }
    
    try {
      return JSON.parse(data);
    } catch (e) {
      return data;
    }
    
  } catch (e) {
    console.error(`❌ Redis GET failed for key ${key}:`, e.message);
    return defaultValue;
  }
}

// ==================== SAFE REDIS SET ====================
async function safeRedisSet(key, value, expirySeconds = null) {
  try {
    const stringified = typeof value === 'string' ? value : JSON.stringify(value);
    
    if (expirySeconds) {
      await redis.setex(key, expirySeconds, stringified);
    } else {
      await redis.set(key, stringified);
    }
    return true;
  } catch (e) {
    console.error(`❌ Redis SET failed for key ${key}:`, e.message);
    return false;
  }
}

// ==================== MAIN HANDLER ====================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required and must be a string' });
    }
    
    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message too long (max 2000 characters)' });
    }

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await safeRedisGet(chatKey, []);
    let userMemory = await safeRedisGet(memoryKey, {});
    
    if (!Array.isArray(conversationHistory)) conversationHistory = [];
    if (typeof userMemory !== 'object' || userMemory === null) userMemory = {};

    const lowerMsg = message.toLowerCase().trim();

    if (lowerMsg === '/memory') {
      const memText = Object.keys(userMemory).length
        ? Object.entries(userMemory).map(([k,v]) => `• ${k}: ${v}`).join('\n')
        : '💭 Tôi chưa có thông tin nào về bạn.';
      return res.status(200).json({ 
        success: true, 
        message: memText, 
        memoryCount: Object.keys(userMemory).length 
      });
    }

    if (lowerMsg.startsWith('/forget')) {
      if (lowerMsg === '/forget') {
        await redis.del(memoryKey);
        return res.status(200).json({ 
          success: true, 
          message: '🗑️ Đã xóa toàn bộ thông tin về bạn.' 
        });
      } else {
        const keyToDelete = message.substring(8).trim();
        if (userMemory[keyToDelete]) {
          delete userMemory[keyToDelete];
          await safeRedisSet(memoryKey, userMemory);
          return res.status(200).json({ 
            success: true, 
            message: `🗑️ Đã xóa: ${keyToDelete}` 
          });
        } else {
          return res.status(200).json({ 
            success: true, 
            message: `❓ Không tìm thấy thông tin: ${keyToDelete}` 
          });
        }
      }
    }

    if (lowerMsg === '/clear') {
      await redis.del(chatKey);
      return res.status(200).json({ 
        success: true, 
        message: '🗑️ Đã xóa lịch sử hội thoại.' 
      });
    }

    conversationHistory.push({ role: 'user', content: message });
    
    if (conversationHistory.length > 30) {
      conversationHistory = conversationHistory.slice(-30);
    }

    let searchResults = null;
    let usedSearch = false;
    
    if (await needsWebSearch(message)) {
      console.log('🔍 Triggering web search...');
      searchResults = await searchWeb(message);
      usedSearch = !!searchResults;
      if (searchResults) {
        console.log('✅ Search results retrieved');
      }
    }

    const systemPrompt = buildSystemPrompt(userMemory, searchResults);

    const chatCompletion = await callGroqWithRetry({
      messages: [
        { role: 'system', content: systemPrompt }, 
        ...conversationHistory
      ],
      model: MODELS.main,
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Xin lỗi, tôi không thể tạo phản hồi.';

    let memoryUpdated = false;
    const shouldExtractMemory = /tôi|mình|em|anh|chị|họ|gia đình|sống|làm|học|thích|ghét|yêu|muốn/i.test(message);
    
    if (shouldExtractMemory && message.length > 10) {
      console.log('🧠 Extracting memory...');
      const memoryExtraction = await extractMemory(message, userMemory);
      
      if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
        userMemory = { ...userMemory, ...memoryExtraction.updates };
        await safeRedisSet(memoryKey, userMemory);
        memoryUpdated = true;
        
        const summary = memoryExtraction.summary || 'Đã lưu thông tin về bạn';
        assistantMessage += `\n\n💾 _${summary}_`;
        console.log('✅ Memory updated:', memoryExtraction.updates);
      }
    }

    conversationHistory.push({ role: 'assistant', content: assistantMessage });

    await safeRedisSet(chatKey, conversationHistory, 2592000);

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
    console.error('❌ Handler Error:', error);
    
    let errMsg = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.message?.includes('rate_limit')) {
      errMsg = '⚠️ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau.';
      statusCode = 429;
    } else if (error.message?.includes('Request quá lớn')) {
      statusCode = 413;
    } else if (error.message?.includes('không hợp lệ')) {
      statusCode = 400;
    }
    
    return res.status(statusCode).json({ 
      success: false, 
      error: errMsg 
    });
  }
}
