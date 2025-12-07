import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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
  memory: 'llama-3.3-70b-versatile',
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
const inFlightSearches = new Map();

// Helper: Parse JSON an toàn hơn
function safeParseJSON(text, defaultValue = null) {
  if (!text) return defaultValue;
  
  try {
    return JSON.parse(text);
  } catch {
    try {
      const match = text.match(/\{[\s\S]*?\}/);
      if (match) return JSON.parse(match[0]);
    } catch {
      console.warn('⚠️ JSON parse failed completely');
    }
    return defaultValue;
  }
}

// Helper: Sanitize key để tránh injection
function sanitizeKey(key) {
  if (!key || typeof key !== 'string') return 'default';
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
}

// Helper: Normalize memory keys để tránh duplicate
function normalizeMemoryKeys(updates) {
  const normalized = {};
  
  // Mapping các key variations về chuẩn (lowercase, không dấu)
  const keyMapping = {
    'tên': 'tên',
    'Tên': 'tên',
    'name': 'tên',
    
    'tuổi': 'tuổi',
    'Tuổi': 'tuổi',
    'age': 'tuổi',
    
    'nghề': 'nghề nghiệp',
    'Nghề': 'nghề nghiệp',
    'nghề nghiệp': 'nghề nghiệp',
    'Nghề nghiệp': 'nghề nghiệp',
    'job': 'nghề nghiệp',
    
    'sở thích': 'sở thích',
    'Sở thích': 'sở thích',
    'hobby': 'sở thích',
    'hobbies': 'sở thích',
    
    'ngôn ngữ lập trình yêu thích': 'ngôn ngữ lập trình',
    'Ngôn ngữ lập trình yêu thích': 'ngôn ngữ lập trình',
    'ngôn ngữ lập trình': 'ngôn ngữ lập trình',
    'Ngôn ngữ lập trình': 'ngôn ngữ lập trình',
    
    'ngôn ngữ ưa thích': 'ngôn ngữ ưa thích',
    'Ngôn ngữ ưa thích': 'ngôn ngữ ưa thích',
    
    'mối quan hệ': 'mối quan hệ',
    'Mối quan hệ': 'mối quan hệ',
    'relationship': 'mối quan hệ',
    
    'sinh nhật': 'sinh nhật',
    'Sinh nhật': 'sinh nhật',
    'birthday': 'sinh nhật',
    'ngày sinh': 'sinh nhật',
    
    'địa chỉ': 'địa chỉ',
    'Địa chỉ': 'địa chỉ',
    'thành phố': 'địa chỉ',
    'Thành phố': 'địa chỉ',
    
    'email': 'email',
    'Email': 'email',
    
    'số điện thoại': 'số điện thoại',
    'Số điện thoại': 'số điện thoại',
    'phone': 'số điện thoại',
  };
  
  for (const [key, value] of Object.entries(updates)) {
    // Skip null/undefined
    if (!value) continue;
    
    // Skip values không rõ ràng
    const valueStr = String(value).toLowerCase();
    if (valueStr.includes('không rõ') ||
        valueStr.includes('không biết') ||
        valueStr.includes('chưa có') ||
        valueStr.includes('chưa rõ') ||
        valueStr === 'none' ||
        valueStr === 'n/a') {
      console.log(`⚠️ Skipping unclear value: ${key}: ${value}`);
      continue;
    }
    
    // Normalize key
    const normalizedKey = keyMapping[key] || key.toLowerCase().trim();
    
    // Nếu key đã tồn tại, merge values (cho sở thích)
    if (normalized[normalizedKey] && normalizedKey === 'sở thích') {
      // Merge sở thích
      const existing = normalized[normalizedKey];
      if (!existing.includes(value)) {
        normalized[normalizedKey] = `${existing}, ${value}`;
      }
    } else {
      normalized[normalizedKey] = value;
    }
  }
  
  return normalized;
}

// Helper: Cleanup memory - remove duplicates and unclear values
function cleanupMemory(memory) {
  const cleaned = {};
  const seen = new Set();
  
  for (const [key, value] of Object.entries(memory)) {
    const normalizedKey = key.toLowerCase().trim();
    
    // Skip duplicates
    if (seen.has(normalizedKey)) {
      console.log(`⚠️ Duplicate key detected, skipping: ${key}`);
      continue;
    }
    
    // Skip null/undefined
    if (!value) continue;
    
    // Skip unclear values
    const valueStr = String(value).toLowerCase();
    if (valueStr.includes('không rõ') ||
        valueStr.includes('không biết') ||
        valueStr.includes('chưa có') ||
        valueStr.includes('chưa rõ') ||
        valueStr === 'none' ||
        valueStr === 'n/a') {
      console.log(`⚠️ Unclear value, skipping: ${key}: ${value}`);
      continue;
    }
    
    seen.add(normalizedKey);
    cleaned[normalizedKey] = value;
  }
  
  return cleaned;
}

// NEW: Detect memory management actions
function detectMemoryAction(message) {
  const lower = message.toLowerCase().trim();
  
  // CLEANUP MEMORY - Dọn dẹp duplicate
  if (lower.match(/dọn dẹp|cleanup|sắp xếp|tối ưu.*memory|gọn gàng/i)) {
    return { action: 'cleanup_memory' };
  }
  
  // EXPLICIT MEMORY SAVE - User yêu cầu nhớ cụ thể
  if (lower.match(/nhớ (rằng|là|giúp|hộ|cái này)|ghi nhớ|lưu lại|hãy nhớ|đừng quên|save|remember/i)) {
    return { action: 'save_memory_explicit', message };
  }
  
  // View memory - nhiều cách hỏi
  if (lower.match(/xem|hiện|cho (tôi|mình|tao) xem|bạn nhớ gì|thông tin (đã lưu|về (tôi|mình|tao))|memory|đã biết gì/i)) {
    return { action: 'view_memory' };
  }
  
  // Clear all memory - xóa toàn bộ
  if (lower.match(/quên hết|xóa (tất cả|toàn bộ|hết) (thông tin|memory|info)|reset memory|xóa sạch|bắt đầu lại/i)) {
    return { action: 'clear_memory' };
  }
  
  // Delete specific key - xóa từng field cụ thể
  const deletePatterns = [
    { pattern: /quên|xóa|bỏ.*tuổi/i, key: 'tuổi' },
    { pattern: /quên|xóa|bỏ.*tên/i, key: 'tên' },
    { pattern: /quên|xóa|bỏ.*nghề/i, key: 'nghề nghiệp' },
    { pattern: /quên|xóa|bỏ.*sở thích/i, key: 'sở thích' },
    { pattern: /quên|xóa|bỏ.*địa chỉ/i, key: 'địa chỉ' },
    { pattern: /quên|xóa|bỏ.*email/i, key: 'email' },
    { pattern: /quên|xóa|bỏ.*số điện thoại/i, key: 'số điện thoại' },
    { pattern: /quên|xóa|bỏ.*sinh nhật/i, key: 'sinh nhật' },
  ];
  
  for (const { pattern, key } of deletePatterns) {
    if (pattern.test(lower)) {
      return { action: 'delete_memory_key', key };
    }
  }
  
  // Clear history - xóa lịch sử chat
  if (lower.match(/xóa (lịch sử|chat|cuộc trò chuyện|tin nhắn)|clear (history|chat)/i)) {
    return { action: 'clear_history' };
  }
  
  return null; // Normal chat
}

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

async function searchWeb(query) {
  if (!SEARCH_APIS.length) {
    console.warn('⚠️ No search APIs available');
    return null;
  }
  
  const cleanedQuery = query.trim().toLowerCase();
  const cacheKey = `search:${cleanedQuery}`;
  
  if (inFlightSearches.has(cleanedQuery)) {
    console.log(`⚠️ Query đang chạy, bỏ qua: ${cleanedQuery}`);
    return null;
  }
  
  inFlightSearches.set(cleanedQuery, Date.now());

  try {
    try { 
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsedCache = typeof cached === 'string' ? safeParseJSON(cached, cached) : cached;
        console.log('✅ Cache hit:', cleanedQuery);
        return parsedCache;
      }
    } catch(e) { 
      console.warn('⚠️ Redis get cache failed:', e.message); 
    }
    
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
    inFlightSearches.delete(cleanedQuery);
  }
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

async function extractMemory(message, currentMemory) {
  try {
    const prompt = `Phân tích tin nhắn và trích xuất thông tin CÁ NHÂN của user.

TIN NHẮN: "${message}"

THÔNG TIN ĐÃ BIẾT: ${JSON.stringify(currentMemory, null, 2)}

QUY TẮC BẮT BUỘC:
1. CHỈ lưu thông tin CHẮC CHẮN và CỤ THỂ
2. TUYỆT ĐỐI KHÔNG lưu giá trị: "không rõ", "không biết", "chưa có", "chưa rõ", "none", "N/A"
3. Key PHẢI dùng các key chuẩn này: tên, tuổi, nghề nghiệp, sở thích, email, số điện thoại, địa chỉ, sinh nhật, mối quan hệ, ngôn ngữ lập trình
4. Nếu THÔNG TIN ĐÃ BIẾT có key tương tự, PHẢI dùng ĐÚNG key đó
5. Cập nhật nếu có thông tin mới CHÍNH XÁC hơn
6. Nếu không có thông tin cụ thể, trả về hasNewInfo: false

Trả về JSON (CHỈ JSON THUẦN, KHÔNG TEXT/MARKDOWN):
{
  "hasNewInfo": true/false,
  "updates": { "key": "giá trị" },
  "summary": "Tóm tắt ngắn"
}`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý phân tích thông tin user. CHỈ TRẢ JSON THUẦN, KHÔNG THÊM TEXT/MARKDOWN BẤT KỲ.' },
        { role: 'user', content: prompt }
      ],
      model: MODELS.memory,
      temperature: 0.2,
      max_tokens: 400
    });
    
    const content = response.choices[0]?.message?.content || '{}';
    const parsed = safeParseJSON(content, { hasNewInfo: false });
    
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

4. Emoji & Format: Dùng emoji tiết chế để tạo không khí thân thiện. Tránh format quá mức trừ khi được yêu cầu.`;

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
    prompt += '\n\n👤 THÔNG TIN USER (cá nhân hóa câu trả lời):';
    for (const [k, v] of Object.entries(memory)) {
      prompt += `\n• ${k}: ${v}`;
    }
  }
  
  return prompt;
}

async function safeRedisGet(key, defaultValue = null) {
  try {
    const data = await redis.get(key);
    if (!data) return defaultValue;
    if (typeof data === 'object') return data;
    return safeParseJSON(data, data);
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

function optimizeHistory(history) {
  if (history.length <= 30) return history;
  
  console.log('📝 Optimizing conversation history with sliding window...');
  
  const systemMessages = history.filter(m => m.role === 'system');
  const conversationMessages = history.filter(m => m.role !== 'system');
  
  const recentMessages = conversationMessages.slice(-25);
  
  return [...systemMessages, ...recentMessages];
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

    const safeUserId = sanitizeKey(userId);
    const safeConversationId = sanitizeKey(conversationId);
    const chatKey = `chat:${safeUserId}:${safeConversationId}`;
    const memoryKey = `memory:${safeUserId}`;

    // ============ DETECT MEMORY MANAGEMENT ACTIONS ============
    const memoryAction = detectMemoryAction(message);
    
    if (memoryAction) {
      console.log(`🎯 Memory action detected: ${memoryAction.action}`);
      
      // CLEANUP MEMORY - Dọn dẹp duplicate và unclear values
      if (memoryAction.action === 'cleanup_memory') {
        let memory = await safeRedisGet(memoryKey, {});
        const originalCount = Object.keys(memory).length;
        
        memory = cleanupMemory(memory);
        const cleanedCount = Object.keys(memory).length;
        const removed = originalCount - cleanedCount;
        
        await safeRedisSet(memoryKey, memory);
        
        console.log(`✅ Cleaned up memory: ${originalCount} → ${cleanedCount} (removed ${removed})`);
        
        return res.status(200).json({
          success: true,
          message: `🧹 **Đã dọn dẹp memory!**\n\n📊 **Trước**: ${originalCount} thông tin\n✅ **Sau**: ${cleanedCount} thông tin\n🗑️ **Đã xóa**: ${removed} duplicate/unclear entries`,
          memoryAction: 'cleanup_memory',
          before: originalCount,
          after: cleanedCount,
          removed: removed,
          timestamp: new Date().toISOString()
        });
      }
      
      // EXPLICIT MEMORY SAVE - User yêu cầu lưu cụ thể
      if (memoryAction.action === 'save_memory_explicit') {
        let userMemory = await safeRedisGet(memoryKey, {});
        
        console.log('💾 Explicit memory save requested');
        const memoryExtraction = await extractMemory(message, userMemory);
        
        if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
          // NORMALIZE keys trước khi merge
          const normalizedUpdates = normalizeMemoryKeys(memoryExtraction.updates);
          
          if (Object.keys(normalizedUpdates).length === 0) {
            return res.status(200).json({
              success: true,
              message: '💭 Thông tin không đủ rõ ràng để lưu. Bạn có thể nói cụ thể hơn không?\n\n_Ví dụ: "Nhớ rằng email của tôi là nam@gmail.com"_',
              memoryAction: 'save_memory_explicit',
              noValidInfo: true,
              timestamp: new Date().toISOString()
            });
          }
          
          userMemory = { ...userMemory, ...normalizedUpdates };
          await safeRedisSet(memoryKey, userMemory);
          
          let response = '✅ **Đã ghi nhớ!**\n\n💾 **Thông tin vừa lưu:**\n';
          for (const [key, value] of Object.entries(normalizedUpdates)) {
            response += `• **${key}**: ${value}\n`;
          }
          
          const summary = memoryExtraction.summary;
          if (summary) {
            response += `\n_${summary}_`;
          }
          
          console.log(`✅ Explicitly saved: ${JSON.stringify(normalizedUpdates)}`);
          
          return res.status(200).json({
            success: true,
            message: response,
            memoryAction: 'save_memory_explicit',
            updates: normalizedUpdates,
            totalMemoryCount: Object.keys(userMemory).length,
            timestamp: new Date().toISOString()
          });
        } else {
          return res.status(200).json({
            success: true,
            message: '💭 Tôi không tìm thấy thông tin cụ thể nào để lưu. Bạn có thể nói rõ hơn được không?\n\n_Ví dụ: "Nhớ rằng email của tôi là nam@gmail.com"_',
            memoryAction: 'save_memory_explicit',
            noInfoFound: true,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // VIEW MEMORY
      if (memoryAction.action === 'view_memory') {
        const memory = await safeRedisGet(memoryKey, {});
        
        let response = '';
        if (Object.keys(memory).length === 0) {
          response = '💭 Tôi chưa có thông tin nào về bạn. Hãy chia sẻ để tôi nhớ bạn hơn nhé!';
        } else {
          response = '💾 **Thông tin tôi đã lưu về bạn:**\n\n';
          for (const [key, value] of Object.entries(memory)) {
            response += `• **${key}**: ${value}\n`;
          }
          response += `\n_Tổng cộng ${Object.keys(memory).length} thông tin_`;
        }
        
        return res.status(200).json({
          success: true,
          message: response,
          memoryAction: 'view_memory',
          memoryCount: Object.keys(memory).length,
          timestamp: new Date().toISOString()
        });
      }
      
      // CLEAR MEMORY
      if (memoryAction.action === 'clear_memory') {
        try {
          await redis.del(memoryKey);
          console.log(`✅ Cleared memory for user: ${safeUserId}`);
          
          return res.status(200).json({
            success: true,
            message: '🗑️ Đã xóa toàn bộ thông tin về bạn. Chúng ta bắt đầu làm quen lại từ đầu nhé!',
            memoryAction: 'clear_memory',
            timestamp: new Date().toISOString()
          });
        } catch (e) {
          return res.status(500).json({
            success: false,
            error: 'Không thể xóa memory: ' + e.message,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // DELETE SPECIFIC KEY
      if (memoryAction.action === 'delete_memory_key') {
        const keyToDelete = memoryAction.key;
        let memory = await safeRedisGet(memoryKey, {});
        
        // Tìm exact match hoặc close match
        let actualKey = null;
        
        // Priority 1: Exact match (case-insensitive)
        for (const key of Object.keys(memory)) {
          if (key.toLowerCase() === keyToDelete.toLowerCase()) {
            actualKey = key;
            break;
          }
        }
        
        // Priority 2: Key contains keyToDelete
        if (!actualKey) {
          for (const key of Object.keys(memory)) {
            if (key.toLowerCase().includes(keyToDelete.toLowerCase())) {
              actualKey = key;
              break;
            }
          }
        }
        
        // Priority 3: KeyToDelete contains key (less strict)
        if (!actualKey) {
          for (const key of Object.keys(memory)) {
            if (keyToDelete.toLowerCase().includes(key.toLowerCase()) && key.length > 3) {
              actualKey = key;
              break;
            }
          }
        }
        
        if (actualKey) {
          const deletedValue = memory[actualKey];
          delete memory[actualKey];
          await safeRedisSet(memoryKey, memory);
          console.log(`✅ Deleted memory key: ${actualKey}`);
          
          return res.status(200).json({
            success: true,
            message: `🗑️ Đã xóa thông tin về **${actualKey}** của bạn.\n\n_Giá trị đã xóa: ${deletedValue}_`,
            memoryAction: 'delete_memory_key',
            deletedKey: actualKey,
            deletedValue: deletedValue,
            remainingCount: Object.keys(memory).length,
            timestamp: new Date().toISOString()
          });
        } else {
          // Hiển thị các keys có sẵn để user biết
          const availableKeys = Object.keys(memory).join(', ');
          
          return res.status(200).json({
            success: true,
            message: `💭 Tôi không có lưu thông tin về **${keyToDelete}** của bạn.\n\n📋 Các thông tin hiện có: ${availableKeys || '(trống)'}`,
            memoryAction: 'delete_memory_key',
            keyNotFound: true,
            requestedKey: keyToDelete,
            availableKeys: Object.keys(memory),
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // CLEAR HISTORY
      if (memoryAction.action === 'clear_history') {
        try {
          await redis.del(chatKey);
          console.log(`✅ Cleared history for conversation: ${safeConversationId}`);
          
          return res.status(200).json({
            success: true,
            message: '🗑️ Đã xóa lịch sử hội thoại. Chúng ta bắt đầu cuộc trò chuyện mới nhé!',
            memoryAction: 'clear_history',
            timestamp: new Date().toISOString()
          });
        } catch (e) {
          return res.status(500).json({
            success: false,
            error: 'Không thể xóa history: ' + e.message,
            timestamp: new Date().toISOString()
          });
        }
      }
    }

    // ============ NORMAL CHAT FLOW ============
    
    let conversationHistory = await safeRedisGet(chatKey, []);
    let userMemory = await safeRedisGet(memoryKey, {});
    
    if (!Array.isArray(conversationHistory)) conversationHistory = [];
    if (typeof userMemory !== 'object' || userMemory === null) userMemory = {};
    
    const intent = await analyzeIntent(message, conversationHistory);
    console.log('🎯 Intent detected:', intent);

    conversationHistory.push({ role: 'user', content: message });
    
    if (conversationHistory.length > 30) {
      conversationHistory = optimizeHistory(conversationHistory);
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
    
    let memoryUpdated = false;
    const shouldExtractMemory = /tôi|mình|em|anh|chị|họ|gia đình|sống|làm|học|thích|ghét|yêu|muốn|là|tên/i.test(message);
    
    if (shouldExtractMemory && message.length > 10) {
      console.log('🧠 Extracting memory...');
      const memoryExtraction = await extractMemory(message, userMemory);
      
      if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
        // NORMALIZE keys trước khi merge
        const normalizedUpdates = normalizeMemoryKeys(memoryExtraction.updates);
        
        if (Object.keys(normalizedUpdates).length > 0) {
          userMemory = { ...userMemory, ...normalizedUpdates };
          await safeRedisSet(memoryKey, userMemory);
          memoryUpdated = true;
          
          const summary = memoryExtraction.summary || 'Đã lưu thông tin về bạn';
          assistantMessage += `\n\n💾 _${summary}_`;
          console.log('✅ Memory updated:', normalizedUpdates);
        }
      }
    }

    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    
    await safeRedisSet(chatKey, conversationHistory, 2592000);
    
    const metadata = {
      success: true,
      message: assistantMessage,
      userId: safeUserId,
      conversationId: safeConversationId,
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
    }
    
    return res.status(statusCode).json({ 
      success: false, 
      error: errMsg,
      timestamp: new Date().toISOString()
    });
  }
}
