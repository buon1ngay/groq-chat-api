
import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// Kiểm tra Redis credentials trước
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('❌ Thiếu UPSTASH_REDIS_REST_URL hoặc UPSTASH_REDIS_REST_TOKEN!');
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Kiểm tra kết nối Redis lúc khởi động
async function checkRedisHealth() {
  try {
    await redis.ping();
    console.log('✅ Redis connected successfully');
    return true;
  } catch (e) {
    console.error('❌ Redis connection failed:', e.message);
    throw new Error('Cannot connect to Redis. Please check your credentials.');
  }
}

// Gọi ngay khi start
checkRedisHealth().catch(console.error);

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
  smart: 'llama-3.3-70b-versatile',
};

if (API_KEYS.length === 0) throw new Error('❌ Không tìm thấy GROQ_API_KEY!');

console.log(`🔑 Load ${API_KEYS.length} GROQ API keys`);
console.log(`🤖 Models: Main=${MODELS.main}, Search=${MODELS.search}, Memory=${MODELS.memory}`);

let lastGroqKeyIndex = -1;
function createGroqClient() {
  lastGroqKeyIndex = (lastGroqKeyIndex + 1) % API_KEYS.length;
  return new Groq({ apiKey: API_KEYS[lastGroqKeyIndex] });
}
const SEARCH_APIS = [
  {
    name: 'Serper',
    apiKey: process.env.SERPER_API_KEY,
    enabled: !!process.env.SERPER_API_KEY,
    async search(query) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      
      try {
        const resp = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', num: 8 }),
          signal: controller.signal
        });
        
        clearTimeout(timer);
        if (!resp.ok) return null;
        
        const data = await resp.json();
        let results = '';
        
        if (data.knowledgeGraph) {
          results += `${data.knowledgeGraph.title || ''}\n${data.knowledgeGraph.description || ''}\n\n`;
        }
        if (data.answerBox?.answer) {
          results += `${data.answerBox.answer}\n\n`;
        }
        if (data.organic?.length) {
          data.organic.slice(0, 5).forEach(item => {
            results += `📌 ${item.title}\n${item.snippet || ''}\n\n`;
          });
        }
        
        return results.trim() || null;
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }
  },
  {
    name: 'Tavily',
    apiKey: process.env.TAVILY_API_KEY,
    enabled: !!process.env.TAVILY_API_KEY,
    async search(query) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      
      try {
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: this.apiKey,
            query,
            search_depth: 'advanced',
            include_answer: true,
            max_results: 8
          }),
          signal: controller.signal
        });
        
        clearTimeout(timer);
        if (!resp.ok) return null;
        
        const data = await resp.json();
        let results = '';
        
        if (data.answer) results += `💡 ${data.answer}\n\n`;
        if (data.results?.length) {
          data.results.slice(0, 5).forEach(item =>
            results += `📌 ${item.title}\n${item.content ? item.content.substring(0, 200) : ''}...\n\n`
          );
        }
        
        return results.trim() || null;
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }
  }
].filter(api => api.enabled);

console.log(`🔍 Load ${SEARCH_APIS.length} Search APIs: ${SEARCH_APIS.map(a => a.name).join(', ')}`);

let lastSearchApiIndex = -1;
// FIX: Lưu Promise thay vì boolean để tránh race condition
const inFlightSearches = {};

async function extractSearchKeywords(message) {
  try {
    const response = await callGroqWithRetry({
      messages: [
        { 
          role: 'system', 
          content: 'Trích xuất 5-10 từ khóa chính để search Google. CHỈ TRẢ TỪ KHÓA, KHÔNG GIẢI THÍCH. Ví dụ: "giá vàng hôm nay", "thời tiết Hà Nội", "tỷ giá USD VND"' 
        },
        { role: 'user', content: `Câu hỏi: "${message}"\n\nTừ khóa search:` }
      ],
      model: MODELS.search,
      temperature: 0.1,
      max_tokens: 50
    });
    
    const keywords = response.choices[0]?.message?.content?.trim() || message;
    console.log(`🔑 Extracted keywords: "${keywords}"`);
    return keywords;
  } catch (e) {
    console.warn('⚠️ Keyword extraction failed, using original message');
    return message;
  }
}

async function summarizeSearchResults(results, question) {
  if (!results || results.length < 100) return results;
  
  try {
    const response = await callGroqWithRetry({
      messages: [
        { 
          role: 'system', 
          content: 'Tóm tắt kết quả tìm kiếm thành 4-5 điểm chính, giữ nguyên số liệu và nguồn quan trọng. Dùng bullet points.' 
        },
        { 
          role: 'user', 
          content: `Câu hỏi: ${question}\n\n=== KẾT QUẢ TÌM KIẾM ===\n${results.substring(0, 2000)}` 
        }
      ],
      model: MODELS.search,
      temperature: 0.3,
      max_tokens: 500
    });
    
    const summary = response.choices[0]?.message?.content || results;
    console.log('✅ Search results summarized');
    return summary;
  } catch (e) {
    console.warn('⚠️ Summarization failed, using truncated results');
    return results.substring(0, 1500);
  }
}

// FIX: Sửa race condition - cho request thứ 2 đợi thay vì bỏ qua
async function searchWeb(query) {
  if (!SEARCH_APIS.length) {
    console.warn('⚠️ No search APIs available');
    return null;
  }
  
  const cleanedQuery = query.trim().toLowerCase();
  const cacheKey = `search:${cleanedQuery}`;
  
  // Nếu đang có search cùng query, đợi kết quả
  if (inFlightSearches[cleanedQuery]) {
    console.log(`⏳ Query đang chạy, đợi kết quả: ${cleanedQuery}`);
    try {
      return await inFlightSearches[cleanedQuery];
    } catch (e) {
      console.warn('⚠️ Waiting for search failed:', e.message);
      return null;
    }
  }

  // Tạo Promise và lưu vào inFlightSearches
  inFlightSearches[cleanedQuery] = (async () => {
    try {
      // Kiểm tra cache trước
      let cached = null;
      try { 
        cached = await redis.get(cacheKey);
        if (cached) {
          if (typeof cached === 'string') {
            try { cached = JSON.parse(cached); } catch {}
          }
          console.log('✅ Cache hit:', cleanedQuery);
          return cached;
        }
      } catch(e) { 
        console.warn('⚠️ Redis get cache failed:', e.message); 
      }
      
      // Thử từng API search
      for (let i = 0; i < SEARCH_APIS.length; i++) {
        lastSearchApiIndex = (lastSearchApiIndex + 1) % SEARCH_APIS.length;
        const api = SEARCH_APIS[lastSearchApiIndex];
        
        try {
          console.log(`🔎 Trying ${api.name}...`);
          const result = await api.search(cleanedQuery);
          if (result && result.length >= 50) {
            try { 
              await redis.set(cacheKey, JSON.stringify(result), { ex: 1800 });
            } catch(e) { 
              console.warn('⚠️ Redis set failed:', e.message); 
            }
            
            console.log(`✅ ${api.name} success (${result.length} chars)`);
            return result;
          } else {
            console.warn(`⚠️ ${api.name} returned insufficient data, trying next...`);
          }
        } catch (e) {
          console.warn(`❌ ${api.name} error: ${e.message}`);
          continue;
        }
      }

      console.warn('⚠️ All search APIs failed or returned insufficient data');
      return null;

    } finally {
      // Xóa sau 3 giây
      setTimeout(() => { 
        delete inFlightSearches[cleanedQuery]; 
      }, 3000);
    }
  })();

  return await inFlightSearches[cleanedQuery];
}

async function analyzeIntent(message, history) {
  const triggers = {
    search: /hiện (tại|nay|giờ)|bây giờ|lúc này|tìm|tra|search|năm (19|20)\d{2}|mới nhất|gần đây|tin tức|thời tiết|giá|tỷ giá|cập nhật|xu hướng/i,
    creative: /viết|kể|sáng tác|làm thơ|bài hát|câu chuyện|truyện/i,
    technical: /code|lập trình|debug|fix|algorithm|function|class|git|api|database/i,
    calculation: /tính|calculate|\d+\s*[\+\-\*\/\=\^]\s*\d+|phương trình|toán|bao nhiêu\s+\d/i,
    explanation: /giải thích|tại sao|vì sao|làm sao|như thế nào|thế nào là/i,
    comparison: /so sánh|khác nhau|tốt hơn|nên chọn|đâu là|hay hơn/i,
  };

  let intent = {
    type: 'general',
    needsSearch: false,
    complexity: 'simple',
    needsDeepThinking: false
  };
  if (triggers.search.test(message)) {
    intent.type = 'search';
    intent.needsSearch = true;
  } else if (triggers.comparison.test(message)) {
    intent.type = 'comparison';
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
  if (message.length > 200 || message.split('?').length > 2) {
    intent.complexity = 'complex';
    intent.needsDeepThinking = true;
  }
  if (history.length > 5) {
    const recentTopics = history.slice(-5).map(h => h.content).join(' ');
    if (recentTopics.includes('code') || recentTopics.includes('lập trình')) {
      intent.contextAware = 'technical';
    }
  }

  return intent;
}

async function needsWebSearch(message, intent) {
  if (intent.needsSearch) return true;

  const triggers = [
    /hiện (tại|nay|giờ)|bây giờ|lúc này|tìm lại|xem lại|tìm đi|sắp tới|năm nào|đang diễn ra/i,
    /năm (19|20)\d{2}/i,
    /mới nhất|gần đây|vừa rồi|hôm (nay|qua)|tuần (này|trước)|tháng (này|trước)/i,
    /giá|tỷ giá|bao nhiêu tiền|chi phí/i,
    /tin tức|sự kiện|cập nhật|thông tin|news|update/i,
    /ai là|ai đã|là ai|người nào/i,
    /khi nào|lúc nào|bao giờ|thời gian/i,
    /ở đâu|chỗ nào|tại đâu|địa điểm/i,
    /thời tiết|nhiệt độ|khí hậu/i,
    /tỷ số|kết quả|đội|trận đấu/i,
    /thế nào là|như thế nào về|cập nhật về|xu hướng|thay đổi/i,
    /so sánh|khác nhau|tốt hơn|nên chọn|đâu là/i,
    /\d+\s*(năm|tháng|tuần|ngày)\s*(trước|sau|tới|nữa)/i,
  ];
  if (triggers.some(r => r.test(message))) return true;
  if (message.includes('?') && message.length < 150) {
    try {
      const response = await callGroqWithRetry({
        messages: [
          { 
            role: 'system', 
            content: `Phân tích câu hỏi có CẦN TÌM KIẾM THÔNG TIN MỚI NHẤT trên web không?
Trả "YES" nếu cần dữ liệu thời gian thực: tin tức, giá cả, thời tiết, sự kiện hiện tại, xu hướng mới, so sánh sản phẩm/công nghệ mới.
Trả "NO" nếu là câu hỏi về kiến thức chung, lý thuyết, lịch sử đã biết, định nghĩa, cách làm cơ bản.
CHỈ TRẢ YES HOẶC NO.` 
          },
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

// FIX: Cải thiện logic extract memory - chỉ lưu thông tin thực sự quan trọng
async function extractMemory(message, currentMemory) {
  try {
    const prompt = `Phân tích tin nhắn và trích xuất CHỈ những thông tin CÁ NHÂN QUAN TRỌNG của user (tên thật, tuổi, nghề nghiệp, nơi ở, sở thích lâu dài, mối quan hệ quan trọng, mục tiêu dài hạn).

TIN NHẮN: "${message}"

THÔNG TIN ĐÃ BIẾT: ${JSON.stringify(currentMemory, null, 2)}

Quy tắc BẮT BUỘC:
- CHỈ lưu thông tin mang tính cá nhân lâu dài (tên, tuổi, nghề, sở thích...)
- KHÔNG lưu hành động tạm thời: "đang đói", "muốn search", "cần tìm", "hỏi về..."
- KHÔNG lưu câu hỏi hoặc yêu cầu: "làm sao để...", "giải thích...", "tìm kiếm..."
- CHỈ lưu khi user THỰC SỰ CHIA SẺ về bản thân
- Cập nhật nếu có thông tin mới chính xác hơn

Ví dụ CẦN lưu:
✅ "Tôi tên Minh, 25 tuổi" → Lưu tên và tuổi
✅ "Mình là lập trình viên ở Hà Nội" → Lưu nghề và địa điểm
✅ "Em thích chơi game và đọc sách" → Lưu sở thích

Ví dụ KHÔNG lưu:
❌ "Tôi muốn tìm kiếm giá vàng" → Yêu cầu tìm kiếm, không phải info cá nhân
❌ "Làm sao để học React?" → Câu hỏi, không phải info cá nhân  
❌ "Họ nói gì về AI?" → Không liên quan đến user

Trả về JSON:
{
  "hasNewInfo": true/false,
  "updates": { "key": "giá trị cụ thể" },
  "summary": "Tóm tắt ngắn"
}

Nếu không có thông tin cá nhân nào, trả về:
{
  "hasNewInfo": false
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

async function deepThinking(message, context) {
  try {
    console.log('🧠 Activating deep thinking mode...');
    
    const thinkingPrompt = `Phân tích câu hỏi sau theo từng bước logic:

CÂU HỎI: "${message}"
Hãy:
1. Xác định vấn đề cốt lõi
2. Liệt kê các yếu tố cần xem xét
3. Phân tích từng khía cạnh
4. Đưa ra kết luận logic`;

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

function buildSystemPrompt(memory, searchResults = null, intent = null, deepThought = null) {
  let prompt = `Bạn là KAMI, một AI thông minh, chính xác và có tư duy, được tạo ra bởi Nguyễn Đức Thạnh.
NGUYÊN TẮC:
1. Ngôn ngữ & Phong cách: Trả lời bằng tiếng Việt trừ khi được yêu cầu ngôn ngữ khác. Xưng "tôi" hoặc theo cách user yêu cầu, gọi user tùy tiền tố họ chọn. Giọng điệu thân thiện nhưng chuyên nghiệp.
2. Độ chính xác cao: 
   - Phân tích kỹ trước khi trả lời
   - Khi không chắc chắn thì tìm kiếm thêm thông tin
   - Đưa ra nhiều góc nhìn cho vấn đề phức tạp
3. Tùy biến theo ngữ cảnh:
   - Kỹ thuật: chi tiết, code examples, best practices
   - Sáng tạo: sinh động, cảm xúc, kể chuyện
   - Giải thích: từng bước, dễ hiểu, ví dụ thực tế
   - Tính toán: logic rõ ràng, công thức, kiểm tra kết quả
4. Emoji & Format: Dùng emoji tiết chế để tạo không khí thân thiện. Tránh format quá mức trừ khi được yêu cầu.
5. GHI NHỚ TỰ NHIÊN: Khi user chia sẻ thông tin cá nhân (tên, tuổi, nghề nghiệp, sở thích, mối quan hệ...), hãy ghi nhớ một cách tự nhiên KHÔNG cần thông báo rõ ràng. Chỉ nói "Được rồi", "Ok mình nhớ rồi" một cách nhẹ nhàng.`;

  if (intent) {
    prompt += `\n\n📋 LOẠI YÊU CẦU: ${intent.type} (độ phức tạp: ${intent.complexity})`;
    
    if (intent.type === 'technical') {
      prompt += '\n💡 Chế độ kỹ thuật: Cung cấp code examples, giải thích chi tiết, đề xuất best practices.';
    } else if (intent.type === 'creative') {
      prompt += '\n🎨 Chế độ sáng tạo: Tập trung vào tính sinh động, cảm xúc, chi tiết miêu tả.';
    } else if (intent.type === 'explanation') {
      prompt += '\n📚 Chế độ giải thích: Phân tích từng bước, dùng ví dụ dễ hiểu, so sánh tương đồng.';
    } else if (intent.type === 'comparison') {
      prompt += '\n⚖️ Chế độ so sánh: Phân tích ưu/nhược điểm, đưa ra bảng so sánh nếu có thể.';
    }
  }
  if (deepThought) {
    prompt += `\n\n🧠 PHÂN TÍCH SÂU:\n${deepThought}\n\n⚠️ Dùng phân tích trên làm nền tảng cho câu trả lời.`;
  }
  if (searchResults) {
    prompt += `\n\n📊 DỮ LIỆU TÌM KIẾM CẬP NHẬT:\n${searchResults}\n\n⚠️ QUAN TRỌNG: Ưu tiên dùng dữ liệu mới nhất này.`;
  }
  if (Object.keys(memory).length) {
    prompt += '\n\n👤 THÔNG TIN USER (sử dụng để cá nhân hóa câu trả lời một cách tự nhiên):';
    for (const [k, v] of Object.entries(memory)) {
      prompt += `\n• ${k}: ${v}`;
    }
  }
  
  return prompt;
}

// FIX: Cải thiện Redis operations với validation
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
      await redis.set(key, stringified, { ex: expirySeconds });
    } else {
      await redis.set(key, stringified);
    }
    return true;
  } catch (e) {
    console.error(`❌ Redis SET failed for key ${key}:`, e.message);
    return false;
  }
}

// FIX: Giảm threshold xuống 15 messages và cải thiện summarization
async function summarizeHistory(history) {
  if (history.length < 15) return history;
  
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
    
    // FIX: Dùng role 'assistant' thay vì 'system' để tương thích tốt hơn
    return [
      { role: 'assistant', content: `[Tóm tắt ${oldMessages.length} tin nhắn trước: ${summaryText}]` },
      ...recentMessages
    ];
  } catch (e) {
    console.warn('⚠️ History summarization failed:', e.message);
    return history.slice(-12);
  }
}

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

// FIX: Sử dụng mget để lấy cả 2 giá trị cùng lúc (tối ưu performance)
let conversationHistory, userMemory;
try {
  const [historyData, memoryData] = await redis.mget(chatKey, memoryKey);
  
  // Parse history
  conversationHistory = historyData;
  if (typeof historyData === 'string') {
    try { conversationHistory = JSON.parse(historyData); } catch { conversationHistory = []; }
  }
  if (!conversationHistory) conversationHistory = [];
  
  // Parse memory
  userMemory = memoryData;
  if (typeof memoryData === 'string') {
    try { userMemory = JSON.parse(memoryData); } catch { userMemory = {}; }
  }
  if (!userMemory) userMemory = {};
  
} catch (e) {
  console.warn('⚠️ Redis mget failed, using defaults:', e.message);
  conversationHistory = [];
  userMemory = {};
}

// FIX: Validate conversation history structure
if (!Array.isArray(conversationHistory)) {
  console.warn('⚠️ Invalid history format (not array), resetting');
  conversationHistory = [];
} else {
  // Validate từng message có đúng format không
  conversationHistory = conversationHistory.filter(msg => {
    if (!msg || typeof msg !== 'object') return false;
    if (!msg.role || !msg.content) return false;
    if (!['user', 'assistant', 'system'].includes(msg.role)) return false;
    if (typeof msg.content !== 'string') return false;
    return true;
  });
}

// FIX: Validate memory structure
if (typeof userMemory !== 'object' || userMemory === null || Array.isArray(userMemory)) {
  console.warn('⚠️ Invalid memory format, resetting');
  userMemory = {};
}

const intent = await analyzeIntent(message, conversationHistory);
console.log('🎯 Intent detected:', intent);

conversationHistory.push({ role: 'user', content: message });

// FIX: Giảm threshold từ 30 xuống 15
if (conversationHistory.length > 15) {
  conversationHistory = await summarizeHistory(conversationHistory);
}

let searchResults = null;
let usedSearch = false;
let searchKeywords = null;
if (await needsWebSearch(message, intent)) {
  console.log('🔍 Triggering web search...');
  searchKeywords = await extractSearchKeywords(message);
  const rawSearchResults = await searchWeb(searchKeywords);
  if (rawSearchResults) {
    searchResults = await summarizeSearchResults(rawSearchResults, message);
    usedSearch = true;
    console.log(`✅ Search completed: ${searchResults.length} chars`);
  } else {
    console.log('⚠️ Search returned no results');
  }
}

let deepThought = null;
if (intent.needsDeepThinking && intent.complexity === 'complex') {
  deepThought = await deepThinking(message, { memory: userMemory, history: conversationHistory });
}

const systemPrompt = buildSystemPrompt(userMemory, searchResults, intent, deepThought);

let temperature = 0.7;
if (intent.type === 'creative') temperature = 0.9;
if (intent.type === 'technical') temperature = 0.5;
if (intent.type === 'calculation') temperature = 0.3;
if (intent.type === 'search') temperature = 0.4; 

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

// FIX: Cải thiện logic extract memory - chỉ khi thực sự cần
let memoryUpdated = false;

// Kiểm tra xem message có thực sự chia sẻ thông tin cá nhân không
const personalInfoPatterns = [
  /tôi (là|tên|tên là|họ|sinh năm|năm nay)\s+\w+/i,
  /mình (là|tên|tên là|họ|sinh năm|năm nay)\s+\w+/i,
  /em (là|tên|tên là|họ|sinh năm|năm nay)\s+\w+/i,
  /(tôi|mình|em)\s+(làm|học|sống ở|ở|đang)\s+\w+/i,
  /(tôi|mình|em)\s+(thích|ghét|yêu|đam mê)\s+\w+/i,
  /tuổi của (tôi|mình|em)/i,
  /(tôi|mình|em)\s+\d+\s+tuổi/i,
];

const seemsPersonalInfo = personalInfoPatterns.some(pattern => pattern.test(message));

// Chỉ extract memory khi:
// 1. Message dài hơn 15 ký tự (loại bỏ "ok", "ừ", "vâng"...)
// 2. Có pattern chia sẻ thông tin cá nhân
// 3. Không phải câu hỏi đơn thuần
const isQuestion = message.trim().endsWith('?');

if (seemsPersonalInfo && message.length > 15 && !isQuestion) {
  console.log('🧠 Extracting memory from personal info...');
  const memoryExtraction = await extractMemory(message, userMemory);
  
  if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
    const oldMemoryCount = Object.keys(userMemory).length;
    userMemory = { ...userMemory, ...memoryExtraction.updates };
    const newMemoryCount = Object.keys(userMemory).length;
    
    // FIX: Thêm TTL 90 ngày cho memory
    await safeRedisSet(memoryKey, userMemory, 7776000); // 90 ngày = 7776000 giây
    memoryUpdated = true;
    
    // Chỉ log ra console, KHÔNG thêm vào response để tự nhiên hơn
    console.log(`✅ Memory updated: ${oldMemoryCount} → ${newMemoryCount} items`);
    console.log('New info:', memoryExtraction.updates);
  }
}

conversationHistory.push({ role: 'assistant', content: assistantMessage });

// Lưu history với TTL 30 ngày
await safeRedisSet(chatKey, conversationHistory, 2592000); // 30 ngày = 2592000 giây

const metadata = {
  success: true,
  message: assistantMessage,
  userId,
  conversationId,
  historyLength: conversationHistory.length,
  memoryUpdated,
  memoryCount: Object.keys(userMemory).length,
  usedWebSearch: usedSearch,
  searchKeywords: usedSearch ? searchKeywords : null,
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
} else if (error.message?.includes('Redis') || error.message?.includes('Cannot connect')) {
  errMsg = '❌ Lỗi kết nối database. Vui lòng thử lại sau.';
  statusCode = 503;
}

return res.status(statusCode).json({ 
  success: false, 
  error: errMsg,
  timestamp: new Date().toISOString()
});
}
}
