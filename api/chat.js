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
  smart: 'llama-3.3-70b-versatile', // Model cho suy luận phức tạp
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
        body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', num: 8 })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      let results = '';
      if (data.knowledgeGraph) results += `${data.knowledgeGraph.title || ''}\n${data.knowledgeGraph.description || ''}\n\n`;
      if (data.answerBox?.answer) results += `${data.answerBox.answer}\n\n`;
      if (data.organic?.length) data.organic.slice(0, 5).forEach(item => results += `${item.title}\n${item.snippet || ''}\n\n`);
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
          search_depth: 'advanced',
          include_answer: true,
          max_results: 8
        })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      let results = '';
      if (data.answer) results += `${data.answer}\n\n`;
      if (data.results?.length) data.results.slice(0, 5).forEach(item =>
        results += `${item.title}\n${item.content ? item.content.substring(0, 200) : ''}...\n\n`
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
            await redis.setex(cacheKey, 1800, JSON.stringify(result)); 
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

// ==================== PHÂN TÍCH Ý ĐỊNH ====================
async function analyzeIntent(message, history) {
  const triggers = {
    search: /hiện (tại|nay|giờ)|bây giờ|lúc này|tìm|tra|search|năm (19|20)\d{2}|mới nhất|gần đây|tin tức|thời tiết|giá|tỷ giá/i,
    creative: /viết|kể|sáng tác|làm thơ|bài hát|câu chuyện|truyện|story/i,
    technical: /code|lập trình|debug|fix|algorithm|function|class|git|api|database/i,
    calculation: /tính|calculate|\d+\s*[\+\-\*\/\=\^]\s*\d+|phương trình|toán|bao nhiêu\s+\d/i,
    explanation: /giải thích|tại sao|vì sao|làm sao|như thế nào|why|how|explain/i,
  };

  let intent = {
    type: 'general',
    needsSearch: false,
    complexity: 'simple',
    needsDeepThinking: false
  };

  // Phát hiện intent
  if (triggers.search.test(message)) {
    intent.type = 'search';
    intent.needsSearch = true;
  } else if (triggers.creative.test(message)) {
    intent.type = 'creative';
    intent.complexity = 'medium';
  } else if (triggers.technical.test(message)) {
    intent.type = 'technical';
    intent.complexity = 'complex';
  } else if (triggers.calculation.test(message)) {
    intent.type = 'calculation';
    intent.needsDeepThinking = true;
  } else if (triggers.explanation.test(message)) {
    intent.type = 'explanation';
    intent.needsDeepThinking = true;
  }

  // Đánh giá độ phức tạp
  if (message.length > 200 || message.split('?').length > 2) {
    intent.complexity = 'complex';
    intent.needsDeepThinking = true;
  }

  // Context từ lịch sử
  if (history.length > 5) {
    const recentTopics = history.slice(-5).map(h => h.content).join(' ');
    if (recentTopics.includes('code') || recentTopics.includes('lập trình')) {
      intent.contextAware = 'technical';
    }
  }

  return intent;
}

// ==================== CẦN SEARCH THÔNG MINH ====================
async function needsWebSearch(message, intent) {
  // Nếu đã phát hiện từ intent
  if (intent.needsSearch) return true;

  const triggers = [
    /hiện (tại|nay|giờ)|bây giờ|lúc này|tìm lại|xem lại|tìm đi|sắp tới|năm nào|đang diễn ra/i,
    /năm (19|20)\d{2}/i,
    /mới nhất|gần đây|vừa rồi|hôm (nay|qua)|tuần (này|trước)/i,
    /giá|tỷ giá|bao nhiêu tiền|chi phí|price/i,
    /tin tức|sự kiện|cập nhật|thông tin|news/i,
    /ai là|ai đã|là ai|người nào|who is/i,
    /khi nào|lúc nào|bao giờ|thời gian|when/i,
    /ở đâu|chỗ nào|tại đâu|địa điểm|where/i,
    /thời tiết|nhiệt độ|khí hậu|weather/i,
    /tỷ số|kết quả|đội|trận đấu|score/i,
  ];
  
  if (triggers.some(r => r.test(message))) return true;

  // Tăng độ chính xác với LLM
  if (message.includes('?') && message.length < 150) {
    try {
      const response = await callGroqWithRetry({
        messages: [
          { role: 'system', content: `Phân tích câu hỏi có CẦN TÌM KIẾM THÔNG TIN MỚI NHẤT trên web không? Trả "YES" nếu cần dữ liệu thời gian thực (tin tức, giá cả, thời tiết, sự kiện...). Trả "NO" nếu là câu hỏi về kiến thức chung, lý thuyết, lịch sử đã biết.` },
          { role: 'user', content: message }
        ],
        model: MODELS.search,
        temperature: 0.1,
        max_tokens: 10
      });
      const ans = response.choices[0]?.message?.content?.trim().toUpperCase();
      return ans.includes('YES');
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

// ==================== MEMORY EXTRACTION NÂNG CAO ====================
async function extractMemory(message, currentMemory) {
  try {
    const prompt = `Phân tích tin nhắn và trích xuất thông tin CÁ NHÂN của user (tên, tuổi, nghề nghiệp, sở thích, tính cách, mối quan hệ, mục tiêu, ngôn ngữ ưa thích...).

TIN NHẮN: "${message}"

THÔNG TIN ĐÃ BIẾT: ${JSON.stringify(currentMemory, null, 2)}

Quy tắc:
- Chỉ lưu thông tin CHẮC CHẮN và QUAN TRỌNG
- Cập nhật nếu có thông tin mới chính xác hơn
- Không lưu thông tin tạm thời (như "đang đói", "đang buồn")

Trả về JSON:
{
  "hasNewInfo": true/false,
  "updates": { "key": "giá trị cụ thể" },
  "summary": "Tóm tắt ngắn"
}`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý phân tích thông tin user. CHỈ TRẢ JSON THUẦN, KHÔNG TEXT KHÁC.' },
        { role: 'user', content: prompt }
      ],
      model: MODELS.memory,
      temperature: 0.2,
      max_tokens: 400
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

// ==================== TƯ DUY SÂU (CHAIN OF THOUGHT) ====================
async function deepThinking(message, context) {
  try {
    console.log('🧠 Activating deep thinking mode...');
    
    const thinkingPrompt = `Phân tích câu hỏi sau theo từng bước logic:

CÂU HỎI: "${message}"

Hãy:
1. Xác định vấn đề cốt lõi
2. Liệt kê các yếu tố cần xem xét
3. Phân tích từng khía cạnh
4. Đưa ra kết luận logic

TRẢ LỜI NGẮN GỌN BẰNG TIẾNG VIỆT:`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý phân tích logic chuyên sâu.' },
        { role: 'user', content: thinkingPrompt }
      ],
      model: MODELS.smart,
      temperature: 0.6,
      max_tokens: 800
    });
    
    return response.choices[0]?.message?.content || null;
  } catch (e) {
    console.warn('⚠️ Deep thinking failed:', e.message);
    return null;
  }
}

// ==================== SYSTEM PROMPT THÔNG MINH ====================
function buildSystemPrompt(memory, searchResults = null, intent = null, deepThought = null) {
  let prompt = `Bạn là KAMI, một AI thông minh, chính xác và có tư duy phản biện, được tạo ra bởi Nguyễn Đức Thạnh.

🎯 NGUYÊN TẮC CORE:
1. **Ngôn ngữ & Phong cách**: Trả lời bằng tiếng Việt trừ khi được yêu cầu. Xưng "tôi", gọi user tùy tiền tố họ chọn. Giọng điệu thân thiện nhưng chuyên nghiệp.

2. **Độ chính xác cao**: 
   - Phân tích kỹ trước khi trả lời
   - Thừa nhận khi không chắc chắn
   - Đưa ra nhiều góc nhìn cho vấn đề phức tạp
   - Trích dẫn nguồn khi có thông tin từ tìm kiếm

3. **Tư duy phản biện**:
   - Đặt câu hỏi ngược lại để hiểu rõ hơn nếu cần
   - Chỉ ra các lỗ hổng logic nếu có
   - Đưa ra phản ví dụ khi thích hợp

4. **Tùy biến theo ngữ cảnh**:
   - Kỹ thuật: chi tiết, code examples, best practices
   - Sáng tạo: sinh động, cảm xúc, kể chuyện
   - Giải thích: từng bước, dễ hiểu, ví dụ thực tế
   - Tính toán: logic rõ ràng, công thức, kiểm tra kết quả

5. **Emoji & Format**: Dùng emoji tiết chế để tạo không khí thân thiện. Tránh format quá mức trừ khi được yêu cầu.`;

  // Thêm context từ intent
  if (intent) {
    prompt += `\n\n📋 LOẠI YÊU CẦU: ${intent.type} (độ phức tạp: ${intent.complexity})`;
    
    if (intent.type === 'technical') {
      prompt += '\n💡 Chế độ kỹ thuật: Cung cấp code examples, giải thích chi tiết, đề xuất best practices.';
    } else if (intent.type === 'creative') {
      prompt += '\n🎨 Chế độ sáng tạo: Tập trung vào tính sinh động, cảm xúc, chi tiết miêu tả.';
    } else if (intent.type === 'explanation') {
      prompt += '\n📚 Chế độ giải thích: Phân tích từng bước, dùng ví dụ dễ hiểu, so sánh tương đồng.';
    }
  }

  // Thêm deep thinking
  if (deepThought) {
    prompt += `\n\n🧠 PHÂN TÍCH SÂU:\n${deepThought}\n\n⚠️ Dùng phân tích trên làm nền tảng cho câu trả lời.`;
  }

  // Thêm search results
  if (searchResults) {
    prompt += `\n\n📊 DỮ LIỆU TÌM KIẾM CẬP NHẬT:\n${searchResults}\n\n⚠️ Ưu tiên dùng dữ liệu mới nhất này. Trích dẫn nguồn khi sử dụng.`;
  }
  
  // Thêm memory
  if (Object.keys(memory).length) {
    prompt += '\n\n👤 THÔNG TIN USER (cá nhân hóa câu trả lời):';
    for (const [k, v] of Object.entries(memory)) {
      prompt += `\n• ${k}: ${v}`;
    }
  }
  
  return prompt;
}

// ==================== SAFE REDIS ====================
async function safeRedisGet(key, defaultValue = null) {
  try {
    const data = await redis.get(key);
    if (!data) return defaultValue;
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch { return data; }
  } catch (e) {
    console.error(`❌ Redis GET failed for key ${key}:`, e.message);
    return defaultValue;
  }
}

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

// ==================== TỰ ĐỘNG TÓM TẮT HỘI THOẠI DÀI ====================
async function summarizeHistory(history) {
  if (history.length < 20) return history;
  
  try {
    console.log('📝 Summarizing old conversation...');
    const oldMessages = history.slice(0, -10);
    const recentMessages = history.slice(-10);
    
    const summary = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Tóm tắt cuộc hội thoại sau thành 3-4 điểm chính. Giữ nguyên thông tin quan trọng.' },
        { role: 'user', content: JSON.stringify(oldMessages) }
      ],
      model: MODELS.memory,
      temperature: 0.3,
      max_tokens: 300
    });
    
    const summaryText = summary.choices[0]?.message?.content || '';
    
    return [
      { role: 'system', content: `📋 Tóm tắt cuộc trò chuyện trước:\n${summaryText}` },
      ...recentMessages
    ];
  } catch (e) {
    console.warn('⚠️ History summarization failed:', e.message);
    return history.slice(-15);
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
    
    if (message.length > 3000) {
      return res.status(400).json({ error: 'Message too long (max 3000 characters)' });
    }

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await safeRedisGet(chatKey, []);
    let userMemory = await safeRedisGet(memoryKey, {});
    
    if (!Array.isArray(conversationHistory)) conversationHistory = [];
    if (typeof userMemory !== 'object' || userMemory === null) userMemory = {};

    const lowerMsg = message.toLowerCase().trim();

    // Commands
    if (lowerMsg === '/memory') {
      const memText = Object.keys(userMemory).length
        ? '💾 **Thông tin đã lưu về bạn:**\n\n' + Object.entries(userMemory).map(([k,v]) => `• **${k}**: ${v}`).join('\n')
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
          message: '🗑️ Đã xóa toàn bộ thông tin về bạn. Bắt đầu lại từ đầu!' 
        });
      } else {
        const keyToDelete = message.substring(8).trim();
        if (userMemory[keyToDelete]) {
          delete userMemory[keyToDelete];
          await safeRedisSet(memoryKey, userMemory);
          return res.status(200).json({ 
            success: true, 
            message: `🗑️ Đã xóa thông tin: **${keyToDelete}**` 
          });
        } else {
          return res.status(200).json({ 
            success: true, 
            message: `❓ Không tìm thấy thông tin về: **${keyToDelete}**` 
          });
        }
      }
    }

    if (lowerMsg === '/clear') {
      await redis.del(chatKey);
      return res.status(200).json({ 
        success: true, 
        message: '🗑️ Đã xóa lịch sử hội thoại. Bắt đầu cuộc trò chuyện mới!' 
      });
    }

    if (lowerMsg === '/help') {
      return res.status(200).json({
        success: true,
        message: `🤖 **KAMI - AI Commands**

📋 **Lệnh quản lý:**
• \`/memory\` - Xem thông tin đã lưu về bạn
• \`/forget [key]\` - Xóa thông tin cụ thể hoặc toàn bộ
• \`/clear\` - Xóa lịch sử hội thoại
• \`/help\` - Hiện danh sách lệnh

✨ **Tính năng thông minh:**
• 🔍 Tự động tìm kiếm web khi cần info mới nhất
• 🧠 Deep thinking cho câu hỏi phức tạp
• 💾 Nhớ thông tin cá nhân của bạn
• 🎯 Tự động nhận diện intent để trả lời tốt hơn

Hãy chat tự nhiên, tôi sẽ tự động điều chỉnh!`
      });
    }

    // Phân tích intent
    const intent = await analyzeIntent(message, conversationHistory);
    console.log('🎯 Intent detected:', intent);

    conversationHistory.push({ role: 'user', content: message });
    
    // Tự động tóm tắt nếu quá dài
    if (conversationHistory.length > 30) {
      conversationHistory = await summarizeHistory(conversationHistory);
    }

    // Web search nếu cần
    let searchResults = null;
    let usedSearch = false;
    
    if (await needsWebSearch(message, intent)) {
      console.log('🔍 Triggering web search...');
      searchResults = await searchWeb(message);
      usedSearch = !!searchResults;
      if (searchResults) console.log('✅ Search results retrieved');
    }

    // Deep thinking cho câu hỏi phức tạp
    let deepThought = null;
    if (intent.needsDeepThinking && intent.complexity === 'complex') {
      deepThought = await deepThinking(message, { memory: userMemory, history: conversationHistory });
    }

    // Build system prompt thông minh
    const systemPrompt = buildSystemPrompt(userMemory, searchResults, intent, deepThought);

    // Điều chỉnh temperature theo intent
    let temperature = 0.7;
    if (intent.type === 'creative') temperature = 0.9;
    if (intent.type === 'technical') temperature = 0.5;
    if (intent.type === 'calculation') temperature = 0.3;

    const chatCompletion = await callGroqWithRetry({
      messages: [
        { role: 'system', content: systemPrompt }, 
        ...conversationHistory
      ],
      model: MODELS.main,
      temperature,
      max_tokens: 2500,
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Xin lỗi, tôi không thể tạo phản hồi.';

    // Memory extraction
    let memoryUpdated = false;
    const shouldExtractMemory = /tôi|mình|em|anh|chị|họ|gia đình|sống|làm|học|thích|ghét|yêu|muốn|là|tên/i.test(message);
    
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

    // Metadata phong phú
    const metadata = {
      success: true,
      message: assistantMessage,
      userId,
      conversationId,
      historyLength: conversationHistory.length,
      memoryUpdated,
      memoryCount: Object.keys(userMemory).length,
      usedWebSearch: usedSearch,
      intent: intent.type,
      complexity: intent.complexity,
      usedDeepThinking: !!deepThought,
      model: MODELS.main,
      temperature,
      timestamp: new Date().toISOString()
    };

    return res.status(200).json(metadata);

  } catch (error) {
    console.error('❌ Handler Error:', error);
    
    let errMsg = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.message?.includes('rate_limit')) {
      errMsg = '⚠️ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau 1 phút.';
      statusCode = 429;
    } else if (error.message?.includes('Request quá lớn')) {
      statusCode = 413;
    } else if (error.message?.includes('không hợp lệ')) {
      statusCode = 400;
    }
    
    return res.status(statusCode).json({ 
      success: false, 
      error: errMsg,
      timestamp: new Date().toISOString()
    });
  }
}
