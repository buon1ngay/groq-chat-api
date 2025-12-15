import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('❌ Thiếu UPSTASH_REDIS_REST_URL hoặc UPSTASH_REDIS_REST_TOKEN!');
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 🔧 FIX: Tăng timeout và thêm retry
async function redisWithTimeout(operation, timeoutMs = 10000, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Redis timeout')), timeoutMs)
        )
      ]);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

async function checkRedisHealth() {
  try {
    await redisWithTimeout(redis.ping());
    return true;
  } catch (e) {
    console.error('❌ Redis connection failed:', e?.message || e);
    throw new Error('Cannot connect to Redis. Please check your credentials.');
  }
}

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

let lastGroqKeyIndex = Math.floor(Math.random() * API_KEYS.length) - 1;
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

let lastSearchApiIndex = Math.floor(Math.random() * SEARCH_APIS.length) - 1;
const inFlightSearches = {};
const userRateLimits = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = userRateLimits.get(userId) || [];
  const recentRequests = userRequests.filter(t => now - t < 60000);
  
  if (recentRequests.length >= 30) {
    throw new Error('⚠️ Quá nhiều yêu cầu. Vui lòng đợi 1 phút.');
  }
  
  recentRequests.push(now);
  userRateLimits.set(userId, recentRequests);
  if (userRateLimits.size > 10000) {
    const oldestKey = userRateLimits.keys().next().value;
    userRateLimits.delete(oldestKey);
  }
}

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  
  return msg
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .substring(0, 3000);
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
    return keywords;
  } catch (e) {
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
    return summary;
  } catch (e) {
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
  
  // 🔧 FIX: Check in-flight to prevent duplicate searches
  if (inFlightSearches[cleanedQuery]) {
    try {
      console.log('⏳ Waiting for existing search to complete...');
      return await inFlightSearches[cleanedQuery];
    } catch (e) {
      delete inFlightSearches[cleanedQuery]; // Cleanup on error
      return null;
    }
  }
  
  inFlightSearches[cleanedQuery] = (async () => {
    try {
      let cached = null;
      try { 
        cached = await redisWithTimeout(redis.get(cacheKey));
        if (cached) {
          if (typeof cached === 'string') {
            try { cached = JSON.parse(cached); } catch {}
          }
          return cached;
        }
      } catch(e) {}
      
      for (let i = 0; i < SEARCH_APIS.length; i++) {
        lastSearchApiIndex = (lastSearchApiIndex + 1) % SEARCH_APIS.length;
        const api = SEARCH_APIS[lastSearchApiIndex];        
        try {
          const result = await api.search(cleanedQuery);
          if (result && result.length >= 50) {
            try { 
              await redisWithTimeout(
                redis.set(cacheKey, JSON.stringify(result), { ex: 1800 })
              );
            } catch(e) {}           
            return result;
          }
        } catch (e) {
          console.warn(`❌ ${api.name} error:`, e?.message || e);
          continue;
        }
      }
      return null;
    } catch (error) {
      delete inFlightSearches[cleanedQuery];
      throw error;
    } finally {
      delete inFlightSearches[cleanedQuery];
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
    /tin tức|sự kiện|cập nhật|thông tin/i,
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
      
      if (e.status === 413 || e?.message?.includes('Request too large')) {
        throw new Error('❌ Request quá lớn. Hãy rút ngắn tin nhắn.');
      }
      
      if (e.status === 400) {
        throw new Error('❌ Request không hợp lệ: ' + (e?.message || 'Unknown error'));
      }    
      if (e.status === 429 || e?.message?.includes('rate_limit')) {
        console.warn(`⚠️ Rate limit key ${lastGroqKeyIndex}, trying next...`);
        continue;
      }
      
      throw e;
    }
  }
  throw new Error(`❌ Hết ${maxRetries} API keys. Rate limit: ${lastError?.message || 'Unknown error'}`);
}

// 🔧 CRITICAL FIX: Redis Locking với Upstash response handling
const MAX_CUSTOM_FIELDS = 20;
const MAX_FIELD_NAME_LENGTH = 50;
const MAX_FIELD_VALUE_LENGTH = 500;

async function acquireLock(lockKey, ttl = 5000) {
  const lockValue = `${Date.now()}-${Math.random()}`;
  
  try {
    const result = await redis.set(lockKey, lockValue, { 
      ex: Math.ceil(ttl / 1000), 
      nx: true 
    });
    
    // 🔧 FIX: Upstash trả về "OK" (string) khi success, null khi fail
    if (result === "OK") {
      return lockValue;
    }
    
    // Retry với exponential backoff
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, i)));
      
      const retryResult = await redis.set(lockKey, lockValue, { 
        ex: Math.ceil(ttl / 1000), 
        nx: true 
      });
      
      if (retryResult === "OK") {
        return lockValue;
      }
    }
    
    return null;
  } catch (e) {
    console.error('❌ acquireLock error:', e);
    return null;
  }
}

async function releaseLock(lockKey, lockValue) {
  try {
    const current = await redis.get(lockKey);
    if (current === lockValue) {
      const result = await redis.del(lockKey);
      // 🔧 FIX: DEL trả về số lượng keys deleted (1 hoặc 0)
      return result === 1 || result === "1";
    }
    return false;
  } catch (e) {
    console.error('❌ releaseLock error:', e);
    return false;
  }
}

// 🔧 DYNAMIC MEMORY: Cho phép MỌI fields hợp lệ
function isValidFieldName(fieldName) {
  if (!fieldName || typeof fieldName !== 'string') return false;
  if (fieldName.length > MAX_FIELD_NAME_LENGTH) return false;
  
  // CHỈ check format, KHÔNG chặn content
  // Allow: letters, numbers, underscore
  // Must start with letter
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fieldName)) {
    console.warn(`⚠️ Invalid field name format: ${fieldName}`);
    return false;
  }
  
  return true;
}

function filterMemoryFields(updates, existingMemory = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return {};
  
  // 🔧 FIX: Validate existingMemory
  if (!existingMemory || typeof existingMemory !== 'object' || Array.isArray(existingMemory)) {
    existingMemory = {};
  }
  
  const filtered = {};
  const currentFieldCount = Object.keys(existingMemory).length;
  
  for (const [field, value] of Object.entries(updates)) {
    // Skip if too many fields already
    if (currentFieldCount + Object.keys(filtered).length >= MAX_CUSTOM_FIELDS) {
      console.warn(`⚠️ Max fields limit (${MAX_CUSTOM_FIELDS}) reached`);
      break;
    }
    
    // Validate field name FORMAT only
    if (!isValidFieldName(field)) {
      continue;
    }
    
    // Validate field value
    if (value === null || value === undefined) continue;
    
    if (typeof value === 'string') {
      if (value.trim().length === 0) continue;
      if (value.length > MAX_FIELD_VALUE_LENGTH) {
        filtered[field] = value.substring(0, MAX_FIELD_VALUE_LENGTH);
        console.warn(`⚠️ Truncated field ${field} to ${MAX_FIELD_VALUE_LENGTH} chars`);
        continue;
      }
    }
    
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
    }
    
    // 🔧 ADD: Reject boolean (ambiguous)
    if (typeof value === 'boolean') {
      // Convert to string for clarity
      filtered[field] = value ? 'true' : 'false';
      continue;
    }
    
    if (typeof value === 'object' || typeof value === 'function') {
      console.warn(`⚠️ Rejected complex type for field: ${field}`);
      continue;
    }
    
    filtered[field] = value;
  }
  
  return filtered;
}

// 🔧 FIX: Bỏ check viết hoa, chỉ check cơ bản
function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 50) return false;
  if (/(.)\1{2,}/.test(trimmed.toLowerCase())) return false;
  
  const keyboards = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
  if (keyboards.some(k => k.includes(trimmed.toLowerCase()))) return false;
  
  const invalidNames = /^(kiki|lala|baba|lolo|kaka|xixi|bibi|test|abc|xyz|aa|bb|cc|dd|ee|haha|hihi|hoho|hehe|admin|user|guest|default)$/i;
  if (invalidNames.test(trimmed)) return false;
  
  // 🔧 FIX: Bỏ check viết hoa bắt buộc
  return true;
}

async function extractMemory(message, currentMemory) {
  const cacheKey = `${message.substring(0, 100)}:${Object.keys(currentMemory).length}`;
  const cached = memoryExtractionDebounce.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 5000) return cached.result;
  
  try {
    const response = await callGroqWithRetry({
      messages: [
        { 
          role: 'system', 
          content: `Bạn là trợ lý ghi nhớ thông tin. Trích xuất CHÍNH XÁC những gì user YÊU CẦU lưu.

QUAN TRỌNG - ĐỌC KỸ:
1. Nếu user có từ "lưu", "ghi nhớ", "nhớ giúp", "save", "remember" 
   → LƯU CHÍNH XÁC thông tin sau từ đó
   → Tạo field name PHÙ HỢP với nội dung

2. Nếu user có từ "xóa", "bỏ", "delete", "remove"
   → Đánh dấu field cần xóa bằng giá trị "__DELETE__"

3. Nếu user có từ "sửa", "cập nhật", "update", "thay đổi"
   → Trả về giá trị MỚI cho field đó (sẽ ghi đè)

4. Nếu user chỉ trò chuyện bình thường (không có từ "lưu/nhớ/sửa/xóa")
   → CHỈ lưu info cá nhân CƠ BẢN: tên, tuổi, nghề nghiệp, địa điểm

QUY TẮC TẠO FIELD NAME:
- Tiếng Anh, lowercase, dùng underscore: dog_name, overtime_hours
- Rõ ràng, mô tả đúng nội dung
- Tối đa 50 ký tự

VÍ DỤ QUAN TRỌNG:

✅ THÊM MỚI:
"Lưu giúp tôi: con chó tên Buddy, 3 tuổi"
{
  "hasNewInfo": true,
  "updates": {
    "dog_name": "Buddy",
    "dog_age": 3
  }
}

✅ CẬP NHẬT:
"Sửa tuổi của tôi thành 26"
{
  "hasNewInfo": true,
  "updates": {
    "age": 26
  }
}

✅ XÓA:
"Xóa thông tin con chó"
{
  "hasNewInfo": true,
  "updates": {
    "dog_name": "__DELETE__",
    "dog_age": "__DELETE__"
  }
}

✅ "Bỏ số giờ tăng ca"
{
  "hasNewInfo": true,
  "updates": {
    "overtime_hours_this_month": "__DELETE__"
  }
}

❌ "Tìm giúp tôi thông tin về Python" (yêu cầu search, không phải lưu info)
{
  "hasNewInfo": false
}

CHỈ TRẢ JSON, KHÔNG GIẢI THÍCH.` 
        },
        { 
          role: 'user', 
          content: `Phân tích tin nhắn và trích xuất thông tin cần lưu.

TIN NHẮN: "${message}"

THÔNG TIN ĐÃ LƯU: ${JSON.stringify(currentMemory, null, 2)}

Trả về JSON:
{
  "hasNewInfo": true/false,
  "updates": {
    "field_name": "value" hoặc "__DELETE__" nếu xóa,
    ...
  },
  "summary": "Mô tả ngắn gọn những gì được lưu/sửa/xóa"
}` 
        }
      ],
      model: MODELS.memory,
      temperature: 0.1,
      max_tokens: 400
    });
    
    const jsonMatch = (response.choices[0]?.message?.content || '{}').match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { hasNewInfo: false };
    
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.hasNewInfo || !parsed.updates) return { hasNewInfo: false };
    
    // 🔧 CRITICAL: Filter với dynamic whitelist
    // Note: filterMemoryFields sẽ KHÔNG filter "__DELETE__" vì nó là string hợp lệ
    parsed.updates = filterMemoryFields(parsed.updates, currentMemory);
    
    if (Object.keys(parsed.updates).length === 0) return { hasNewInfo: false };
    
    // Validate common fields nếu có (SKIP nếu là __DELETE__)
    if (parsed.updates.name && parsed.updates.name !== "__DELETE__") {
      const normalized = parsed.updates.name.trim().toLowerCase();
      parsed.updates.name = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      if (!isValidName(parsed.updates.name)) delete parsed.updates.name;
    }
    
    if (parsed.updates.age && parsed.updates.age !== "__DELETE__") {
      const age = parseInt(parsed.updates.age);
      if (isNaN(age) || age < 0 || age > 150) delete parsed.updates.age;
    }
    
    if (parsed.updates.occupation && parsed.updates.occupation !== "__DELETE__") {
      const occ = parsed.updates.occupation.toLowerCase();
      if (occ.length < 3 || /^(kiki|lala|test|abc|xyz)$/i.test(occ)) delete parsed.updates.occupation;
    }
    
    if (Object.keys(parsed.updates).length === 0) return { hasNewInfo: false };
    
    memoryExtractionDebounce.set(cacheKey, { result: parsed, timestamp: Date.now() });
    if (memoryExtractionDebounce.size > 50) {
      const sorted = [...memoryExtractionDebounce.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      sorted.slice(0, 25).forEach(([k]) => memoryExtractionDebounce.delete(k));
    }
    
    return parsed;
  } catch (e) {
    console.error('❌ extractMemory error:', e);
    return { hasNewInfo: false };
  }
}

async function deepThinking(message, context) {
  try {
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
    console.error('❌ deepThinking error:', e);
    return null;
  }
}

function buildSystemPrompt(memory, searchResults = null, intent = null, deepThought = null) {
  let prompt = `Bạn là KAMI, một AI thông minh, được tạo ra bởi Nguyễn Đức Thạnh.

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
4. Dùng emoji tiết chế để tạo không khí thân thiện. Tránh format quá mức trừ khi được yêu cầu.
5. ✅ CÁ NHÂN HÓA TỰ NHIÊN:
   - SỬ DỤNG thông tin cá nhân user (nếu có) để trả lời phù hợp và tự nhiên hơn
   - Ví dụ: Nếu biết user là dev, có thể dùng thuật ngữ kỹ thuật thoải mái hơn
   - TRÁNH nhắc lại thông tin một cách gượng ép như "Như em đã nói, em tên X..."
   - Chỉ đề cập khi THỰC SỰ liên quan đến câu trả lời`;
  
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
    prompt += '\n\n👤 THÔNG TIN USER (sử dụng để hiểu user tốt hơn và cá nhân hóa tự nhiên):';
    for (const [k, v] of Object.entries(memory)) {
      prompt += `\n• ${k}: ${v}`;
    }
    prompt += '\n\n💡 Dùng info trên để trả lời phù hợp hơn, KHÔNG cần nhắc lại trừ khi user hỏi.';
  }
  
  return prompt;
}

async function safeRedisGet(key, defaultValue = null) {
  // 🔧 FIX: Validate key
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    console.error('❌ Invalid Redis key:', key);
    return defaultValue;
  }
  
  try {
    const data = await redisWithTimeout(redis.get(key));
    if (!data) return defaultValue;
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch { return data; }
  } catch (e) {
    console.error(`❌ Redis GET failed for key ${key}:`, e?.message || e);
    return defaultValue;
  }
}

async function safeRedisSet(key, value, expirySeconds = null) {
  // 🔧 FIX: Validate key and value
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    console.error('❌ Invalid Redis key:', key);
    return false;
  }
  
  if (!value || (typeof value === 'object' && Object.keys(value).length === 0)) {
    console.warn(`⚠️ Attempted to save empty value for key ${key}`);
    return false;
  }
  
  try {
    const stringified = typeof value === 'string' ? value : JSON.stringify(value);
    
    let result;
    if (expirySeconds) {
      result = await redisWithTimeout(redis.set(key, stringified, { ex: expirySeconds }));
    } else {
      result = await redisWithTimeout(redis.set(key, stringified));
    }
    
    // 🔧 FIX: Upstash trả về "OK" hoặc null
    return result === "OK";
  } catch (e) {
    console.error(`❌ Redis SET failed for key ${key}:`, e?.message || e);
    return false;
  }
}

async function saveMemoryWithValidation(memoryKey, newMemory, oldMemory) {
  if (!newMemory || typeof newMemory !== 'object' || Object.keys(newMemory).length === 0) {
    return false;
  }
  
  try {
    const saved = await safeRedisSet(memoryKey, newMemory, 31536000);
    if (!saved) {
      console.error('❌ Failed to save memory to Redis');
      return false;
    }
    
    // 🔧 FIX: Wait for Redis to commit (increase to 200ms for Upstash)
    await new Promise(r => setTimeout(r, 200));
    
    const verified = await safeRedisGet(memoryKey);
    if (!verified || typeof verified !== 'object') {
      console.error('❌ Memory verification failed - invalid response');
      return false;
    }
    
    const verifiedKeys = Object.keys(verified);
    const expectedKeys = Object.keys(newMemory);
    
    if (verifiedKeys.length !== expectedKeys.length) {
      console.error('❌ Memory verification failed - key count mismatch');
      console.error('Expected keys:', expectedKeys);
      console.error('Got keys:', verifiedKeys);
      return false;
    }
    
    // 🔧 ADD: Verify each key exists
    for (const key of expectedKeys) {
      if (!(key in verified)) {
        console.error(`❌ Memory verification failed - missing key: ${key}`);
        return false;
      }
    }
    
    return true;
  } catch (e) {
    console.error('❌ saveMemoryWithValidation error:', e);
    return false;
  }
}

// 🔧 FIX: Remove unnecessary async (no await inside)
function mergeMemories(oldMemory, newUpdates) {
  if (!oldMemory || typeof oldMemory !== 'object') {
    oldMemory = {};
  }
  if (!newUpdates || typeof newUpdates !== 'object') {
    return oldMemory;
  }
  
  const merged = { ...oldMemory };
  
  for (const [key, value] of Object.entries(newUpdates)) {
    // Skip null/undefined values
    if (value === null || value === undefined) {
      continue;
    }
    
    // Skip empty strings
    if (typeof value === 'string' && value.trim().length === 0) {
      continue;
    }
    
    // Update value
    merged[key] = value;
  }
  
  return merged;
}

async function shouldExtractMemory(message) {
  const SKIP_PATTERNS = [
    /^(hi|hello|chào|hey|xin chào|ok|oke|okee|được|rồi|cảm ơn|thanks|bye)$/i,
    /^(hehe|haha|hihi|lol|lmao)$/i,
  ];
  
  if (SKIP_PATTERNS.some(p => p.test(message.trim()))) {
    return false;
  }
  
  const NONSENSE_WORDS = ['kiki', 'lala', 'lolo', 'baba', 'test123', 'asdfgh'];
  const words = message.toLowerCase().split(/\s+/);
  const nonsenseCount = words.filter(w => NONSENSE_WORDS.includes(w)).length;  
  
  if (nonsenseCount > words.length * 0.5) {
    return false;
  }
  
  // 🔧 CRITICAL FIX: Detect EXPLICIT save/update/delete commands
  const EXPLICIT_SAVE_COMMANDS = [
    /\b(lưu|ghi nhớ|nhớ|ghi lại|save|remember|note)\b.{3,}/i,
    /\b(hãy|giúp|help).*(lưu|nhớ|ghi|save|remember)/i,
  ];
  
  const EXPLICIT_UPDATE_COMMANDS = [
    /\b(sửa|cập nhật|thay đổi|update|change|modify)\b.{3,}/i,
  ];
  
  const EXPLICIT_DELETE_COMMANDS = [
    /\b(xóa|bỏ|delete|remove)\b.{3,}/i,
  ];
  
  if (EXPLICIT_SAVE_COMMANDS.some(p => p.test(message))) {
    return true; // ✅ User YÊU CẦU lưu
  }
  
  if (EXPLICIT_UPDATE_COMMANDS.some(p => p.test(message))) {
    return true; // ✅ User YÊU CẦU sửa
  }
  
  if (EXPLICIT_DELETE_COMMANDS.some(p => p.test(message))) {
    return true; // ✅ User YÊU CẦU xóa
  }
  
  // Check personal info patterns (as before)
  const PERSONAL_INDICATORS = [
    /(?:tôi|mình|em|con)\s+(?:là|tên|họ|năm nay|tuổi)/i,
    /(?:tôi|mình|em)\s+(?:làm|học|sống ở|ở|thích|yêu|đam mê)/i,
    /(?:nghề|công việc|job|occupation)\s+(?:của\s+)?(?:tôi|mình|em)/i,
    /(?:sở thích|hobby|hobbies)\s+(?:của\s+)?(?:tôi|mình|em)/i,
  ];  
  
  return PERSONAL_INDICATORS.some(p => p.test(message));
}

async function recoverMemoryIfNeeded(userId, conversationHistory) {
  const memoryKey = `memory:${userId}`;
  const existingMemory = await safeRedisGet(memoryKey);
  
  if (existingMemory && Object.keys(existingMemory).length > 0) {
    return existingMemory;
  }
  
  const personalMessages = conversationHistory
    .filter(msg => msg.role === 'user')
    .map(msg => msg.content)
    .join('\n'); 
  
  if (personalMessages.length < 10) return {};
  
  try {
    const recovered = await extractMemory(personalMessages, {});   
    if (recovered.hasNewInfo && recovered.updates && Object.keys(recovered.updates).length > 0) {
      await saveMemoryWithValidation(memoryKey, recovered.updates, {});
      return recovered.updates;
    }
  } catch (e) {
    console.error('❌ Memory recovery failed:', e);
  }
  
  return {};
}

// 🔧 FIX: Import missing dependencies và constants
const summaryCache = new Map();
const memoryExtractionDebounce = new Map();

// 🔧 Consolidated: Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of summaryCache.entries()) {
    if (!value._timestamp || now - value._timestamp > 3600000) summaryCache.delete(key);
  }
  for (const [key, value] of memoryExtractionDebounce.entries()) {
    if (now - value.timestamp > 10000) memoryExtractionDebounce.delete(key);
  }
}, 300000);

async function summarizeHistory(history, userId, conversationId) {
  if (history.length < 15) return history;
  
  const cacheKey = `${userId}:${conversationId}:${history.length}`;
  const cached = summaryCache.get(cacheKey);
  if (cached?.data && cached._timestamp && Date.now() - cached._timestamp < 3600000) {
    return cached.data;
  }
  
  try {
    const summary = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Tóm tắt cuộc hội thoại sau thành 3-4 điểm chính. Giữ nguyên thông tin quan trọng.' },
        { role: 'user', content: JSON.stringify(history.slice(0, -10)) }
      ],
      model: MODELS.memory,
      temperature: 0.3,
      max_tokens: 300
    });
    
    const recentMessages = history.slice(-10);
    if (recentMessages[0]?.role === 'user') {
      recentMessages[0].content = `[Bối cảnh: ${summary.choices[0]?.message?.content || ''}]\n\n${recentMessages[0].content}`;
    }
    
    summaryCache.set(cacheKey, { data: recentMessages, _timestamp: Date.now() });
    if (summaryCache.size > 100) {
      const sorted = [...summaryCache.entries()].sort((a, b) => (a[1]._timestamp || 0) - (b[1]._timestamp || 0));
      sorted.slice(0, 50).forEach(([k]) => summaryCache.delete(k));
    }
    
    return recentMessages;
  } catch (e) {
    console.error('❌ Summary failed:', e);
    return history.slice(-12);
  }
}

// 🔧 OPTIMIZATION: Batch Redis operations để giảm latency
async function batchSaveData(operations) {
  if (!operations || operations.length === 0) {
    console.warn('⚠️ No operations to save');
    return [];
  }
  
  const promises = operations.map(async ({ key, value, ttl }) => {
    try {
      const result = await safeRedisSet(key, value, ttl);
      return result; // true/false
    } catch (e) {
      console.error(`❌ Failed to save ${key}:`, e);
      return false;
    }
  });
  
  const results = await Promise.all(promises);
  
  // 🔧 ADD: Log summary
  const successCount = results.filter(r => r === true).length;
  console.log(`📦 Batch save: ${successCount}/${operations.length} successful`);
  
  return results;
}

const metrics = {
  totalRequests: 0,
  searchCalls: 0,
  cacheHits: 0,
  errors: 0,
  avgResponseTime: 0,
  memoryUpdates: 0,
  lastReset: Date.now()
};

function updateMetrics(type, value = 1) {
  metrics[type] = (metrics[type] || 0) + value;
  if (Date.now() - metrics.lastReset > 3600000) {
    Object.keys(metrics).forEach(key => {
      if (key !== 'lastReset') metrics[key] = 0;
    });
    metrics.lastReset = Date.now();
  }
}

export default async function handler(req, res) {
  const startTime = Date.now();
  
  if (req.method === 'GET') {
    if (req.url === '/health' || req.url?.includes('/health')) {
      try {
        const redisHealth = await checkRedisHealth();
        return res.status(200).json({
          status: 'healthy',
          redis: redisHealth,
          groqKeys: API_KEYS.length,
          searchAPIs: SEARCH_APIS.length,
          metrics: metrics,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        return res.status(503).json({
          status: 'unhealthy',
          error: e?.message || 'Health check failed',
          timestamp: new Date().toISOString()
        });
      }
    }
    return res.status(405).json({ error: 'Chỉ hỗ trợ POST requests' });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Chỉ hỗ trợ POST requests' });
  }
  
  try {
    updateMetrics('totalRequests');
    
    const { message, userId = 'default', conversationId = 'default' } = req.body;
    
    // 🔧 FIX: Validate and sanitize userId and conversationId
    const sanitizedUserId = (userId && typeof userId === 'string') 
      ? userId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100) || 'default'
      : 'default';
      
    const sanitizedConversationId = (conversationId && typeof conversationId === 'string')
      ? conversationId.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 100) || 'default'
      : 'default';
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Tin nhắn là bắt buộc và phải là chuỗi ký tự' });
    }
    
    const sanitizedMessage = sanitizeMessage(message);
    
    if (!sanitizedMessage || sanitizedMessage.length < 1) {
      return res.status(400).json({ error: 'Tin nhắn không hợp lệ sau khi xử lý' });
    }
    
    if (sanitizedMessage.length > 3000) {
      return res.status(400).json({ error: 'Tin nhắn quá dài (tối đa 3000 ký tự)' });
    }
    
    try {
      checkRateLimit(sanitizedUserId);
    } catch (e) {
      return res.status(429).json({ 
        error: e?.message || 'Rate limit exceeded',
        retryAfter: 60 
      });
    }

    const chatKey = `chat:${sanitizedUserId}:${sanitizedConversationId}`;
    const memoryKey = `memory:${sanitizedUserId}`;
    
    let conversationHistory, userMemory;
    
    // 🔧 FIX: Load cả 2 parallel với better error handling
    try {
      const results = await redisWithTimeout(redis.mget(chatKey, memoryKey));
      
      // 🔧 FIX: Handle undefined/null results safely
      if (!results || !Array.isArray(results)) {
        throw new Error('Invalid mget response');
      }
      
      const [historyData, memoryData] = results;
      
      conversationHistory = historyData;
      if (typeof historyData === 'string') {
        try { conversationHistory = JSON.parse(historyData); } catch { conversationHistory = []; }
      }
      if (!conversationHistory) conversationHistory = [];
      
      userMemory = memoryData;
      if (typeof memoryData === 'string') {
        try { userMemory = JSON.parse(memoryData); } catch { userMemory = {}; }
      }
      if (!userMemory) userMemory = {};
      
    } catch (e) {
      console.error('❌ mget failed, falling back to individual gets:', e);
      conversationHistory = await safeRedisGet(chatKey, []);
      userMemory = await safeRedisGet(memoryKey, {});
    }
    
    // Validate conversation history
    if (!Array.isArray(conversationHistory)) {
      conversationHistory = [];
    } else {
      conversationHistory = conversationHistory.filter(msg => {
        if (!msg || typeof msg !== 'object') return false;
        if (!msg.role || !msg.content) return false;
        if (!['user', 'assistant', 'system'].includes(msg.role)) return false;
        if (typeof msg.content !== 'string') return false;
        return true;
      });
    }
    
    // Validate memory
    if (typeof userMemory !== 'object' || userMemory === null || Array.isArray(userMemory)) {
      userMemory = {};
    }
    
    // Only recover if empty
    if (Object.keys(userMemory).length === 0) {
      userMemory = await recoverMemoryIfNeeded(sanitizedUserId, conversationHistory);
    }
    
    const intent = await analyzeIntent(sanitizedMessage, conversationHistory);
    
    if (!Array.isArray(conversationHistory)) {
      conversationHistory = [];
    }
    
    // 🔧 FIX: Add user message BEFORE summarizing
    conversationHistory.push({ role: 'user', content: sanitizedMessage });
    
    if (conversationHistory.length > 30) {
      conversationHistory = await summarizeHistory(conversationHistory, sanitizedUserId, sanitizedConversationId);
    }
    
    let searchResults = null;
    let usedSearch = false;
    let searchKeywords = null;
    
    if (await needsWebSearch(sanitizedMessage, intent)) {
      updateMetrics('searchCalls');
      
      searchKeywords = await extractSearchKeywords(sanitizedMessage);
      const rawSearchResults = await searchWeb(searchKeywords);
      
      if (rawSearchResults) {
        searchResults = await summarizeSearchResults(rawSearchResults, sanitizedMessage);
        usedSearch = true;
      }
    }
    
    let deepThought = null;
    if (intent.needsDeepThinking && intent.complexity === 'complex') {
      deepThought = await deepThinking(sanitizedMessage, { memory: userMemory, history: conversationHistory });
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
    
    if (usedSearch === false && intent.needsSearch && !searchResults) {
      assistantMessage = "⚠️ Không thể tìm kiếm thông tin mới nhất, câu trả lời dựa trên kiến thức có sẵn:\n\n" + assistantMessage;
    }
    
    // 🔧 CRITICAL FIX: Memory update với Redis locking
    let memoryUpdated = false;
    let memoryUpdateDetails = null;
    
    if (await shouldExtractMemory(sanitizedMessage)) {
      const lockKey = `lock:${memoryKey}`;
      const lockValue = await acquireLock(lockKey, 5000);
      
      if (!lockValue) {
        console.warn('⚠️ Could not acquire memory lock, skipping update');
      } else {
        try {
          // 🔧 RE-READ memory sau khi có lock
          const freshMemory = await safeRedisGet(memoryKey, {});
          
          const memoryExtraction = await extractMemory(sanitizedMessage, freshMemory);      
          
          if (memoryExtraction.hasNewInfo && memoryExtraction.updates && Object.keys(memoryExtraction.updates).length > 0) {
            const newMemory = mergeMemories(freshMemory, memoryExtraction.updates);
            const hasChanges = JSON.stringify(freshMemory) !== JSON.stringify(newMemory);
            
            if (hasChanges && await saveMemoryWithValidation(memoryKey, newMemory, freshMemory)) {
              memoryUpdated = true;
              memoryUpdateDetails = {
                added: Object.keys(memoryExtraction.updates),
                totalKeys: Object.keys(newMemory).length
              };
              userMemory = newMemory; // Update local copy
              updateMetrics('memoryUpdates');
            }
          }
        } finally {
          // 🔧 CRITICAL: Always release lock
          await releaseLock(lockKey, lockValue);
        }
      }
    }
    
    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    
    // 🔧 OPTIMIZATION: Batch save để giảm latency
    const saveOperations = [
      { key: chatKey, value: conversationHistory, ttl: 31536000 }
    ];
    
    // 🔧 FIX: Refresh memory TTL mỗi lần request
    if (Object.keys(userMemory).length > 0) {
      saveOperations.push({ key: memoryKey, value: userMemory, ttl: 31536000 });
    }
    
    try {
      const saveResults = await batchSaveData(saveOperations);
      
      // 🔧 FIX: Check và log từng operation result
      if (!saveResults || saveResults.length === 0) {
        console.error('❌ Batch save returned no results');
      } else {
        if (!saveResults[0]) console.error('❌ Failed to save history');
        if (saveOperations.length > 1 && !saveResults[1]) console.error('❌ Failed to refresh memory TTL');
      }
    } catch (e) {
      console.error('❌ Batch save failed:', e);
    }
    
    const responseTime = Date.now() - startTime;
    updateMetrics('avgResponseTime', responseTime);
    
    const metadata = {
      success: true,
      message: assistantMessage,
      userId: sanitizedUserId,
      conversationId: sanitizedConversationId,
      historyLength: conversationHistory.length,
      memoryUpdated,
      memoryUpdateDetails,
      memoryCount: Object.keys(userMemory).length,
      usedWebSearch: usedSearch,
      searchKeywords: usedSearch ? searchKeywords : null,
      intent: intent.type,
      complexity: intent.complexity,
      usedDeepThinking: !!deepThought,
      model: MODELS.main,
      temperature,
      responseTime: responseTime + 'ms',
      timestamp: new Date().toISOString(),
      // 🔧 DEBUG: Chỉ trả currentMemory khi có debug flag
      ...(process.env.DEBUG_MODE === 'true' && { 
        currentMemory: userMemory,
        cacheStats: {
          summaryCache: summaryCache.size,
          debounceCache: memoryExtractionDebounce.size
        }
      })
    };

    return res.status(200).json(metadata);

  } catch (error) {
    updateMetrics('errors');
    console.error('❌ Handler Error:', error?.message || error, '\nStack:', error?.stack?.split('\n').slice(0, 3).join('\n'));
    
    let errMsg = error?.message || 'Lỗi hệ thống';
    let statusCode = 500;
    
    if (error?.message?.includes('rate_limit') || error?.message?.includes('Rate limit')) {
      errMsg = '⚠️ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau.';
      statusCode = 429;
    } else if (error?.message?.includes('Request quá lớn')) {
      statusCode = 413;
    } else if (error?.message?.includes('không hợp lệ')) {
      statusCode = 400;
    } else if (error?.message?.includes('Redis') || error?.message?.includes('Cannot connect') || error?.message?.includes('timeout')) {
      errMsg = '❌ Lỗi kết nối database. Vui lòng thử lại sau.';
      statusCode = 503;
    }
    
    const responseTime = Date.now() - startTime;
    
    return res.status(statusCode).json({ 
      success: false, 
      error: errMsg,
      responseTime: responseTime + 'ms',
      timestamp: new Date().toISOString()
    });
  }
          }
