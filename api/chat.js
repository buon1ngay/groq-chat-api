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
async function redisWithTimeout(operation, timeoutMs = 5000) {
  return Promise.race([
    operation,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis timeout')), timeoutMs)
    )
  ]);
}
async function checkRedisHealth() {
  try {
    await redisWithTimeout(redis.ping());
    console.log('✅ Redis connected successfully');
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
console.log(`🔍 Load ${SEARCH_APIS.length} Search APIs: ${SEARCH_APIS.map(a => a.name).join(', ')}`);

let lastSearchApiIndex = Math.floor(Math.random() * SEARCH_APIS.length) - 1;
const inFlightSearches = {};
const userRateLimits = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = userRateLimits.get(userId) || [];
  const recentRequests = userRequests.filter(t => now - t < 60000);
  
  if (recentRequests.length >= 30) { // 30 req/phút
    throw new Error('⚠️ Quá nhiều yêu cầu. Vui lòng đợi 1 phút.');
  }
  
  recentRequests.push(now);
  userRateLimits.set(userId, recentRequests);
  
  // Cleanup để tránh memory leak
  if (userRateLimits.size > 10000) {
    const oldestKey = userRateLimits.keys().next().value;
    userRateLimits.delete(oldestKey);
  }
}

// FIX: Thêm input sanitization
function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  
  return msg
    .replace(/[\u0300-\u036f]/g, '') // Xóa combining diacritics (zalgo text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Xóa zero-width chars
    .trim()
    .substring(0, 3000); // Hard limit
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
  if (inFlightSearches[cleanedQuery]) {
    console.log(`⏳ Query đang chạy, đợi kết quả: ${cleanedQuery}`);
    try {
      return await inFlightSearches[cleanedQuery];
    } catch (e) {
      console.warn('⚠️ Waiting for search failed:', e?.message || e);
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
          console.log('✅ Cache hit:', cleanedQuery);
          return cached;
        }
      } catch(e) { 
        console.warn('⚠️ Redis get cache failed:', e?.message || e); 
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
              await redisWithTimeout(
                redis.set(cacheKey, JSON.stringify(result), { ex: 1800 })
              );
            } catch(e) { 
              console.warn('⚠️ Redis set failed:', e?.message || e); 
            }
            
            console.log(`✅ ${api.name} success (${result.length} chars)`);
            return result;
          } else {
            console.warn(`⚠️ ${api.name} returned insufficient data, trying next...`);
          }
        } catch (e) {
          console.warn(`❌ ${api.name} error:`, e?.message || e, '\nStack:', e?.stack?.split('\n')[0]);
          continue;
        }
      }

      console.warn('⚠️ All search APIs failed or returned insufficient data');
      return null;

    } catch (error) {
      // FIX: Cleanup khi error
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
      console.warn('⚠️ needsWebSearch LLM call failed:', e?.message || e);
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
function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 50) return false;
  if (/(.)\1{2,}/.test(trimmed.toLowerCase())) return false;
  const keyboards = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
  if (keyboards.some(k => k.includes(trimmed.toLowerCase()))) return false;
  const invalidNames = /^(kiki|lala|baba|lolo|kaka|xixi|bibi|test|abc|xyz|aa|bb|cc|dd|ee|haha|hihi|hoho|hehe|admin|user|guest|default)$/i;
  if (invalidNames.test(trimmed)) return false;
  if (!/^[A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/.test(trimmed)) return false;
  
  return true;
}

async function extractMemory(message, currentMemory) {
  try {
    const prompt = `Phân tích tin nhắn và trích xuất CHỈ những thông tin CÁ NHÂN THỰC SỰ của user.

TIN NHẮN: "${message}"

THÔNG TIN ĐÃ BIẾT: ${JSON.stringify(currentMemory, null, 2)}
Quy tắc BẮT BUỘC - ĐỌC KỸ:
1. TÊN: 
   - CHỈ lưu tên thật có ít nhất 2 ký tự, viết hoa chữ cái đầu
   - KHÔNG lưu: kiki, lala, baba, test, abc, xyz, hoặc bất kỳ từ vô nghĩa nào
   - Ví dụ HỢP LỆ: Minh, An, Tuấn, Ngọc, Ly
   - Ví dụ KHÔNG HỢP LỆ: kiki, lolo, abc, test123
2. TUỔI: 
   - Chấp nhận mọi tuổi từ 0-120 (bao gồm cả tuổi trẻ em, người già)
   - CHỈ chặn số hoàn toàn vô lý như số âm hoặc >150
   - Ví dụ HỢP LỆ: "Tôi 25 tuổi", "Con tôi 3 tuổi", "Bố mình 70 tuổi"
3. NGHỀ NGHIỆP: 
   - CHỈ lưu nghề thực tế: lập trình viên, bác sĩ, sinh viên, giáo viên, nhân viên...
   - KHÔNG lưu mô tả chung hoặc từ vô nghĩa
4. ĐỊA ĐIỂM: 
   - CHỈ lưu tên thành phố/quốc gia thật: Hà Nội, Sài Gòn, Đà Nẵng...
   - KHÔNG lưu từ vô nghĩa hoặc địa chỉ chi tiết đầy đủ
5. CHUNG:
   - KHÔNG lưu hành động tạm thời, câu hỏi, yêu cầu
   - CHỈ lưu khi user THỰC SỰ chia sẻ info bản thân
Ví dụ HỢP LỆ - CẦN lưu:
✅ "Tôi tên Minh, 25 tuổi" → {"name": "Minh", "age": 25}
✅ "Mình là dev ở HN" → {"occupation": "Developer", "location": "Hà Nội"}
✅ "Em thích đọc sách" → {"hobbies": "đọc sách"}
✅ "Tôi tên Ly, 22 tuổi" → {"name": "Ly", "age": 22}
✅ "Con tôi 3 tuổi" → {"childAge": 3}
Ví dụ KHÔNG HỢP LỆ - KHÔNG lưu:
❌ "Tôi tên kiki" → TÊN VÔ NGHĨA
❌ "Tôi là lala" → TỪ VÔ NGHĨA
❌ "Tôi muốn tìm thông tin" → YÊU CẦU, KHÔNG PHẢI INFO CÁ NHÂN

Trả về JSON:
{
  "hasNewInfo": true/false,
  "updates": { "key": "giá trị" },
  "summary": "Mô tả ngắn"
}

Nếu message chỉ chứa từ vô nghĩa, BẮT BUỘC trả:
{
  "hasNewInfo": false
}`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý phân tích NGHIÊM NGẶT. CHỈ lưu thông tin CÁ NHÂN THẬT, từ chối mọi từ vô nghĩa như kiki, lala, test. CHỈ TRẢ JSON THUẦN.' },
        { role: 'user', content: prompt }
      ],
      model: MODELS.memory,
      temperature: 0.1,
      max_tokens: 400
    });
    
    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) return { hasNewInfo: false };
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    if (parsed.hasNewInfo && !parsed.updates) {
      return { hasNewInfo: false };
    }
    if (parsed.hasNewInfo && parsed.updates) {
      if (parsed.updates.name) {
        if (!isValidName(parsed.updates.name)) {
          delete parsed.updates.name;
          console.warn('⚠️ Rejected invalid name:', parsed.updates.name);
        }
      }
      
      if (parsed.updates.age) {
        const age = parseInt(parsed.updates.age);
        if (isNaN(age) || age < 0 || age > 150) {
          delete parsed.updates.age;
          console.warn('⚠️ Rejected invalid age:', parsed.updates.age);
        }
      }
      
      if (parsed.updates.occupation) {
        const occupation = parsed.updates.occupation.toLowerCase();
        const invalidOccupations = /^(kiki|lala|test|abc|xyz|admin|user)$/i;
        if (occupation.length < 3 || invalidOccupations.test(occupation)) {
          delete parsed.updates.occupation;
          console.warn('⚠️ Rejected invalid occupation:', occupation);
        }
      }
      if (Object.keys(parsed.updates).length === 0) {
        return { hasNewInfo: false };
      }
    }
    
    return parsed;
    
  } catch (e) {
    console.warn('⚠️ Memory extraction failed:', e?.message || e);
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
    console.warn('⚠️ Deep thinking failed:', e?.message || e);
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
  try {
    const stringified = typeof value === 'string' ? value : JSON.stringify(value);
    if (expirySeconds) {
      await redisWithTimeout(redis.set(key, stringified, { ex: expirySeconds }));
    } else {
      await redisWithTimeout(redis.set(key, stringified));
    }
    return true;
  } catch (e) {
    console.error(`❌ Redis SET failed for key ${key}:`, e?.message || e);
    return false;
  }
}

async function saveMemoryWithValidation(memoryKey, newMemory, oldMemory) {
  console.log('💾 Attempting to save memory...');
  console.log('Old memory:', JSON.stringify(oldMemory));
  console.log('New memory:', JSON.stringify(newMemory));
  
  if (!newMemory || typeof newMemory !== 'object') {
    console.error('❌ Invalid memory object');
    return false;
  }
  
  const saved = await safeRedisSet(memoryKey, newMemory, 7776000);
  
  if (!saved) {
    console.error('❌ Failed to save to Redis');
    return false;
  }
  
  const verified = await safeRedisGet(memoryKey);
  
  if (!verified) {
    console.error('❌ Memory verification failed - not found in Redis');
    return false;
  }
  
  const verifiedKeys = Object.keys(verified);
  const expectedKeys = Object.keys(newMemory);
  
  if (verifiedKeys.length !== expectedKeys.length) {
    console.error('❌ Memory verification failed - key count mismatch');
    console.error('Expected:', expectedKeys);
    console.error('Got:', verifiedKeys);
    return false;
  }
  
  console.log('✅ Memory saved and verified successfully');
  return true;
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
  const memory = await safeRedisGet(memoryKey);
  
  if (memory && Object.keys(memory).length > 0) {
    return memory;
  }
  
  console.log('🔄 Attempting memory recovery from conversation history...');
  
  const personalMessages = conversationHistory
    .filter(msg => msg.role === 'user')
    .map(msg => msg.content)
    .join('\n');
  
  if (personalMessages.length < 10) {
    return {};
  }
  
  try {
    const recovered = await extractMemory(personalMessages, {});
    
    if (recovered.hasNewInfo && recovered.updates) {
      await saveMemoryWithValidation(memoryKey, recovered.updates, {});
      console.log('✅ Memory recovered:', recovered.updates);
      return recovered.updates;
    }
  } catch (e) {
    console.warn('⚠️ Memory recovery failed:', e?.message);
  }
  
  return {};
}

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
    if (recentMessages.length > 0 && recentMessages[0].role === 'user') {
      recentMessages[0] = {
        ...recentMessages[0],
        content: `[Bối cảnh cuộc trò chuyện trước: ${summaryText}]\n\n${recentMessages[0].content}`
      };
    }
    
    return recentMessages;
  } catch (e) {
    console.warn('⚠️ History summarization failed:', e?.message || e);
    return history.slice(-12);
  }
}

const metrics = {
  totalRequests: 0,
  searchCalls: 0,
  cacheHits: 0,
  errors: 0,
  avgResponseTime: 0,
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
      checkRateLimit(userId);
    } catch (e) {
      return res.status(429).json({ 
        error: e?.message || 'Rate limit exceeded',
        retryAfter: 60 
      });
    }

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;
    let conversationHistory, userMemory;
    try {
      const results = await redisWithTimeout(redis.mget(chatKey, memoryKey));
      const [historyData, memoryData] = results || [null, null];
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
      console.warn('⚠️ Redis mget failed, trying individual gets:', e?.message || e);
      conversationHistory = await safeRedisGet(chatKey, []);
      userMemory = await safeRedisGet(memoryKey, {});
    }
    
    if (!Array.isArray(conversationHistory)) {
      console.warn('⚠️ Invalid history format (not array), resetting');
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
    
    if (typeof userMemory !== 'object' || userMemory === null || Array.isArray(userMemory)) {
      console.warn('⚠️ Invalid memory format, resetting');
      userMemory = {};
    }
    
    console.log('📖 Loaded memory:', JSON.stringify(userMemory));
    
    userMemory = await recoverMemoryIfNeeded(userId, conversationHistory);
    
    const intent = await analyzeIntent(sanitizedMessage, conversationHistory);
    console.log('🎯 Intent detected:', intent);

    if (!Array.isArray(conversationHistory)) {
      conversationHistory = [];
    }
    conversationHistory.push({ role: 'user', content: sanitizedMessage });
    
    if (conversationHistory.length > 30) {
      conversationHistory = await summarizeHistory(conversationHistory);
    }
    
    let searchResults = null;
    let usedSearch = false;
    let searchKeywords = null;
    if (await needsWebSearch(sanitizedMessage, intent)) {
      console.log('🔍 Triggering web search...');
      updateMetrics('searchCalls');
      
      searchKeywords = await extractSearchKeywords(sanitizedMessage);
      const rawSearchResults = await searchWeb(searchKeywords);
      
      if (rawSearchResults) {
        searchResults = await summarizeSearchResults(rawSearchResults, sanitizedMessage);
        usedSearch = true;
        console.log(`✅ Search completed: ${searchResults.length} chars`);
      } else {
        console.log('⚠️ Search returned no results');
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
    
    let memoryUpdated = false;
    
    const shouldExtract = await shouldExtractMemory(sanitizedMessage);

    if (shouldExtract) {
      console.log('🧠 Extracting memory from message...');
      const memoryExtraction = await extractMemory(sanitizedMessage, userMemory);
      
      if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
        const oldMemoryCount = Object.keys(userMemory).length;
        const newMemory = { ...userMemory, ...memoryExtraction.updates };
        
        const saved = await saveMemoryWithValidation(memoryKey, newMemory, userMemory);
        
        if (saved) {
          userMemory = newMemory;
          memoryUpdated = true;
          
          const newMemoryCount = Object.keys(userMemory).length;
          console.log(`✅ Memory updated: ${oldMemoryCount} → ${newMemoryCount} items`);
          console.log('New info:', memoryExtraction.updates);
        } else {
          console.error('❌ Memory update failed');
          memoryUpdated = false;
        }
      }
    }

    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    await safeRedisSet(chatKey, conversationHistory, 7776000);
    
    const responseTime = Date.now() - startTime;
    updateMetrics('avgResponseTime', responseTime);
    
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
      responseTime: responseTime + 'ms',
      timestamp: new Date().toISOString()
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
