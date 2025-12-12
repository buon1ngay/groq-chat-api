import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const CONFIG = {
  models: {
    main: 'llama-3.3-70b-versatile',
    search: 'llama-3.1-8b-instant',
    memory: 'llama-3.1-8b-instant',
  },
  redis: {
    historyTTL: 7776000, // 90 days
    memoryTTL: 7776000,  // 90 days
    searchCacheTTL: 1800, // 30 minutes
    maxHistoryLength: 100,
  },
  search: {
    timeout: 10000,
    maxResults: 8,
  }
};
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

if (API_KEYS.length === 0) {
  throw new Error('❌ Không tìm thấy GROQ_API_KEY!');
}

console.log(`🔑 Đã load ${API_KEYS.length} GROQ API keys`);

let currentKeyIndex = -1;

function createGroqClient() {
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return new Groq({ apiKey: API_KEYS[currentKeyIndex] });
}

async function callGroqWithRetry(config, maxRetries = API_KEYS.length) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const groq = createGroqClient();
      return await groq.chat.completions.create(config);
    } catch (error) {
      lastError = error;
      
      if (error.status === 429 || error.message?.includes('rate_limit')) {
        console.warn(`⚠ Rate limit key ${currentKeyIndex}, thử key tiếp (${attempt + 1}/${maxRetries})`);
        continue;
      }
      
      if (error.status === 413 || error.message?.includes('Request too large')) {
        throw new Error('❌ Request quá lớn. Hãy rút ngắn tin nhắn.');
      }
      
      throw error;
    }
  }
  
  throw new Error(`❌ Hết ${maxRetries} API keys: ${lastError.message}`);
}
const SEARCH_APIS = [
  {
    name: 'Serper',
    enabled: !!process.env.SERPER_API_KEY,
    async search(query) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.search.timeout);
      
      try {
        const resp = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': process.env.SERPER_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            q: query,
            gl: 'vn',
            hl: 'vi',
            num: CONFIG.search.maxResults
          }),
          signal: controller.signal
        });
        
        clearTimeout(timer);
        
        if (!resp.ok) {
          console.warn(`⚠ Serper returned ${resp.status}`);
          return null;
        }
        
        const data = await resp.json();
        let results = '';
        
        if (data.knowledgeGraph) {
          results += `${data.knowledgeGraph.title || ''}\n${data.knowledgeGraph.description || ''}\n\n`;
        }
        
        if (data.answerBox?.answer) {
          results += `💡 ${data.answerBox.answer}\n\n`;
        }
        
        if (data.organic?.length) {
          data.organic.slice(0, 5).forEach(item => {
            results += `📌 ${item.title}\n${item.snippet || ''}\n\n`;
          });
        }
        
        return results.trim() || null;
        
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          console.warn('⚠ Serper timeout');
        } else {
          console.warn('⚠ Serper error:', e.message);
        }
        return null;
      }
    }
  },
  {
    name: 'Tavily',
    enabled: !!process.env.TAVILY_API_KEY,
    async search(query) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.search.timeout);
      
      try {
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            search_depth: 'advanced',
            include_answer: true,
            max_results: CONFIG.search.maxResults
          }),
          signal: controller.signal
        });
        
        clearTimeout(timer);
        
        if (!resp.ok) {
          console.warn(`⚠ Tavily returned ${resp.status}`);
          return null;
        }
        
        const data = await resp.json();
        let results = '';
        
        if (data.answer) {
          results += `💡 ${data.answer}\n\n`;
        }
        
        if (data.results?.length) {
          data.results.slice(0, 5).forEach(item => {
            results += `📌 ${item.title}\n${item.content ? item.content.substring(0, 200) : ''}...\n\n`;
          });
        }
        
        return results.trim() || null;
        
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          console.warn('⚠ Tavily timeout');
        } else {
          console.warn('⚠ Tavily error:', e.message);
        }
        return null;
      }
    }
  }
].filter(api => api.enabled);

console.log(`🔍 Search APIs available: ${SEARCH_APIS.map(a => a.name).join(', ')}`);

let currentSearchApiIndex = -1;

async function searchWeb(query) {
  if (SEARCH_APIS.length === 0) {
    console.warn('⚠ No search APIs configured');
    return null;
  }
  
  const cleanQuery = query.trim().toLowerCase();
  const hash = crypto.createHash('md5').update(cleanQuery).digest('hex');
  const cacheKey = `search:${hash}`;
  
  try {
    let cached = await redis.get(cacheKey);
    if (cached) {
      if (typeof cached === 'string') {
        try { cached = JSON.parse(cached); } catch {}
      }
      console.log('✅ Search cache hit');
      return cached;
    }
  } catch (e) {
    console.warn('⚠ Cache check failed:', e.message);
  }
  for (let i = 0; i < SEARCH_APIS.length; i++) {
    currentSearchApiIndex = (currentSearchApiIndex + 1) % SEARCH_APIS.length;
    const api = SEARCH_APIS[currentSearchApiIndex];
    
    try {
      console.log(`🔎 Searching with ${api.name}...`);
      const result = await api.search(cleanQuery);
      
      if (result && result.length >= 50) {
        try {
          await redis.setex(cacheKey, CONFIG.redis.searchCacheTTL, JSON.stringify(result));
        } catch (e) {
          console.warn('⚠ Failed to cache search result');
        }
        
        console.log(`✅ ${api.name} success (${result.length} chars)`);
        return result;
      } else {
        console.warn(`⚠ ${api.name} returned insufficient data`);
      }
    } catch (e) {
      console.warn(`❌ ${api.name} failed:`, e.message);
      continue;
    }
  }
  
  console.warn('❌ All search APIs failed');
  return null;
}
function needsWebSearch(message) {
  const searchTriggers = [
    /hiện (tại|nay|giờ)|bây giờ|lúc này/i,
    /năm (19|20)\d{2}/i,
    /mới nhất|gần đây|vừa rồi|hôm (nay|qua)|tuần (này|trước)/i,
    /giá|tỷ giá|bao nhiêu tiền|chi phí/i,
    /tin tức|sự kiện|cập nhật|thông tin/i,
    /thời tiết|nhiệt độ|khí hậu/i,
    /tìm|tra|tìm đi|tìm kiếm/i,
    /ai là|ai đã|là ai/i,
    /khi nào|lúc nào|bao giờ/i,
    /ở đâu|chỗ nào|tại đâu/i,
    /so sánh|khác nhau|giống nhau|khác gì/i,
    /đánh giá|review|nhận xét/i,
    /cách|làm sao|làm thế nào/i,
    /top \d+|tốt nhất|hay nhất|xuất sắc nhất/i,
  ];
  
  return searchTriggers.some(trigger => trigger.test(message));
}

async function extractSearchKeywords(message) {
  try {
    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: 'Trích xuất 5-10 từ khóa chính để tìm kiếm Google. CHỈ TRẢ TỪ KHÓA, KHÔNG GIẢI THÍCH.'
        },
        {
          role: 'user',
          content: `Câu hỏi: "${message}"\n\nTừ khóa tìm kiếm:`
        }
      ],
      model: CONFIG.models.search,
      temperature: 0.1,
      max_tokens: 50
    });
    
    const keywords = response.choices[0]?.message?.content?.trim() || message;
    console.log(`🔑 Search keywords: "${keywords}"`);
    return keywords;
  } catch (e) {
    console.warn('⚠ Keyword extraction failed, using original message');
    return message;
  }
}

// ========== MEMORY SYSTEM - FIXED VERSION ==========

// Danh sách key chuẩn được phép
const ALLOWED_MEMORY_KEYS = [
  'Tên',
  'Tuổi', 
  'Nghề nghiệp',
  'Sở thích',
  'Địa điểm',
  'Gia đình',
  'Học vấn',
  'Mục tiêu',
  'Sinh nhật',
  'Số điện thoại',
  'Giới tính',
  'Quê quán',
  'Tình trạng hôn nhân',
  'Sức khỏe'
];

function normalizeMemoryKey(key) {
  if (!key || typeof key !== 'string') return null;
  
  const normalized = key.toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  
  const keyMapping = {
    'ten': 'Tên',
    'tên': 'Tên',
    'tên đầy đủ': 'Tên',
    'họ tên': 'Tên',
    'ho ten': 'Tên',
    
    'tuổi': 'Tuổi',
    'tuoi': 'Tuổi',
    
    'nghề': 'Nghề nghiệp',
    'nghe': 'Nghề nghiệp',
    'nghề nghiệp': 'Nghề nghiệp',
    'nghe nghiep': 'Nghề nghiệp',
    'công việc': 'Nghề nghiệp',
    'cong viec': 'Nghề nghiệp',
    
    'nơi ở': 'Địa điểm',
    'noi o': 'Địa điểm',
    'địa chỉ': 'Địa điểm',
    'dia chi': 'Địa điểm',
    'sống ở': 'Địa điểm',
    'song o': 'Địa điểm',
    
    'sở thích': 'Sở thích',
    'so thich': 'Sở thích',
    'thích': 'Sở thích',
    'thich': 'Sở thích',
    
    'học vấn': 'Học vấn',
    'hoc van': 'Học vấn',
    'trường': 'Học vấn',
    'truong': 'Học vấn',
    
    'gia đình': 'Gia đình',
    'gia dinh': 'Gia đình',
    
    'mục tiêu': 'Mục tiêu',
    'muc tieu': 'Mục tiêu',
    
    'sinh nhật': 'Sinh nhật',
    'sinh nhat': 'Sinh nhật',
    'ngày sinh': 'Sinh nhật',
    'ngay sinh': 'Sinh nhật',
    
    'số điện thoại': 'Số điện thoại',
    'so dien thoai': 'Số điện thoại',
    'điện thoại': 'Số điện thoại',
    'dien thoai': 'Số điện thoại',
    'sđt': 'Số điện thoại',
    'sdt': 'Số điện thoại',
    
    'giới tính': 'Giới tính',
    'gioi tinh': 'Giới tính',
    
    'quê quán': 'Quê quán',
    'que quan': 'Quê quán',
    'quê': 'Quê quán',
    'que': 'Quê quán',
    
    'tình trạng hôn nhân': 'Tình trạng hôn nhân',
    'tinh trang hon nhan': 'Tình trạng hôn nhân',
    'hôn nhân': 'Tình trạng hôn nhân',
    'hon nhan': 'Tình trạng hôn nhân',
    
    'sức khỏe': 'Sức khỏe',
    'suc khoe': 'Sức khỏe',
    'bệnh': 'Sức khỏe',
    'benh': 'Sức khỏe',
  };
  
  const mappedKey = keyMapping[normalized];
  
  if (mappedKey && ALLOWED_MEMORY_KEYS.includes(mappedKey)) {
    return mappedKey;
  }
  
  return null;
}

function sanitizeMemoryValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  if (typeof value !== 'string') {
    value = String(value);
  }
  
  value = value.trim().replace(/\s+/g, ' ');
  
  if (value.length > 500) {
    value = value.substring(0, 500);
  }
  
  if (!/[a-zA-Z0-9\u00C0-\u1EF9]/.test(value)) {
    return null;
  }
  
  return value;
}

async function extractMemory(message, currentMemory) {
  try {
    const formattedMemory = Object.keys(currentMemory).length > 0 
      ? JSON.stringify(currentMemory, null, 2)
      : 'Chưa có thông tin';

    const extractionPrompt = `Phân tích tin nhắn và trích xuất THÔNG TIN CÁ NHÂN QUAN TRỌNG cần lưu lâu dài.

TIN NHẮN: "${message}"

THÔNG TIN ĐÃ LƯU:
${formattedMemory}

CHỈ LƯU CÁC LOẠI THÔNG TIN SAU (dùng KEY CHÍNH XÁC):
- Tên (tên đầy đủ, biệt danh)
- Tuổi (số tuổi)
- Nghề nghiệp (công việc hiện tại)
- Sở thích (sở thích, đam mê)
- Địa điểm (nơi sống hiện tại)
- Gia đình (thông tin vợ/chồng/con/cha mẹ)
- Học vấn (trường học, bằng cấp)
- Mục tiêu (mục tiêu, dự định tương lai)
- Sinh nhật (ngày sinh)
- Số điện thoại
- Giới tính
- Quê quán
- Tình trạng hôn nhân
- Sức khỏe (vấn đề sức khỏe quan trọng)

QUY TẮC BẮT BUỘC:
1. CHỈ lưu thông tin QUAN TRỌNG, LÂU DÀI về người dùng
2. KHÔNG lưu câu hỏi thường, yêu cầu tìm kiếm, trò chuyện tạm thời
3. PHẢI dùng KEY CHÍNH XÁC từ danh sách trên
4. Nếu thông tin đã có, chỉ CẬP NHẬT khi có thay đổi rõ ràng
5. KHÔNG tạo key mới ngoài danh sách
6. Nếu KHÔNG có thông tin mới, trả về hasNewInfo: false và updates: {}
7. KHÔNG BAO GIỜ để giá trị null, undefined, hoặc rỗng
8. Giá trị phải là STRING có ý nghĩa

TRẢ VỀ JSON (KHÔNG có markdown, KHÔNG có text khác):
{
  "hasNewInfo": true,
  "updates": {
    "Tên": "Nguyễn Văn A",
    "Tuổi": "25"
  },
  "summary": "Lưu tên và tuổi"
}

HOẶC nếu không có info mới:
{
  "hasNewInfo": false,
  "updates": {}
}`;

    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: 'Bạn là trợ lý phân tích thông tin cá nhân. CHỈ TRẢ VỀ JSON thuần túy, KHÔNG có ```json``` hay text giải thích.'
        },
        {
          role: 'user',
          content: extractionPrompt
        }
      ],
      model: CONFIG.models.memory,
      temperature: 0.2,
      max_tokens: 500
    });

    let content = response.choices[0]?.message?.content || '{}';
    
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      console.warn('⚠ No valid JSON found in memory extraction');
      return { hasNewInfo: false, updates: {} };
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    if (typeof parsed.hasNewInfo !== 'boolean') {
      console.warn('⚠ Invalid hasNewInfo field');
      return { hasNewInfo: false, updates: {} };
    }
    
    if (!parsed.hasNewInfo || !parsed.updates || typeof parsed.updates !== 'object') {
      console.log('📊 No new memory info');
      return { hasNewInfo: false, updates: {} };
    }
    
    // Validate và normalize updates
    const validatedUpdates = {};
    for (const [rawKey, rawValue] of Object.entries(parsed.updates)) {
      const normalizedKey = normalizeMemoryKey(rawKey);
      const sanitizedValue = sanitizeMemoryValue(rawValue);
      
      if (!normalizedKey) {
        console.warn(`⚠ Invalid memory key skipped: "${rawKey}"`);
        continue;
      }
      
      if (!sanitizedValue) {
        console.warn(`⚠ Invalid memory value skipped for "${normalizedKey}": "${rawValue}"`);
        continue;
      }
      
      // Chỉ update nếu thực sự khác
      if (currentMemory[normalizedKey] !== sanitizedValue) {
        validatedUpdates[normalizedKey] = sanitizedValue;
        console.log(`✅ Memory change: ${normalizedKey} = "${sanitizedValue}"`);
      }
    }
    
    if (Object.keys(validatedUpdates).length === 0) {
      console.log('📊 No actual changes detected');
      return { hasNewInfo: false, updates: {} };
    }
    
    console.log('📊 Memory extraction successful:', validatedUpdates);
    return { 
      hasNewInfo: true, 
      updates: validatedUpdates,
      summary: parsed.summary 
    };
    
  } catch (error) {
    console.error('❌ Error extracting memory:', error.message);
    return { hasNewInfo: false, updates: {} };
  }
}

function buildSystemPrompt(memory, searchResults = null) {
  let prompt = `Bạn là KAMI, một AI thông minh và có tư duy, được tạo ra bởi Nguyễn Đức Thạnh.

NGUYÊN TẮC QUAN TRỌNG:
– Dùng tiếng Việt trừ khi được yêu cầu ngôn ngữ khác
– Xưng "tôi", gọi user theo tên nếu biết (KHÔNG lạm dụng)
– Trả lời NGẮN GỌN, TỰ NHIÊN như con người
– Với câu hỏi đơn giản ("Chào", "Hi"...) → chỉ 1-2 câu thôi
– Với câu hỏi phức tạp → phân tích chi tiết
– TUYỆT ĐỐI KHÔNG LẶP LẠI cùng một ý nhiều lần
– Dùng emoji tiết chế (0-2 emoji mỗi response)
– KHÔNG list hoặc format nhiều trừ khi được yêu cầu`;

  if (searchResults) {
    prompt += `\n\n📊 DỮ LIỆU TÌM KIẾM MỚI NHẤT:\n${searchResults}\n\n⚠ ƯU TIÊN dùng thông tin này để trả lời chính xác và cập nhật.`;
  }

  if (Object.keys(memory).length > 0) {
    prompt += '\n\n📝 THÔNG TIN VỀ NGƯỜI DÙNG (dùng TỰ NHIÊN, KHÔNG nhắc lại):';
    
    for (const [key, value] of Object.entries(memory)) {
      prompt += `\n- ${key}: ${value}`;
    }
    
    prompt += '\n\n⚠ CHỈ dùng info này khi LIÊN QUAN đến câu hỏi. KHÔNG tự động nhắc lại mọi lần.';
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

    if (message.length > 3000) {
      return res.status(400).json({ error: 'Message too long (max 3000 chars)' });
    }

    console.log(`📨 [${userId}] ${message}`);

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;
    const lockKey = `lock:${userId}:${conversationId}`;
    
    const lockAcquired = await redis.set(lockKey, '1', { ex: 30, nx: true });
    if (!lockAcquired) {
      return res.status(429).json({ error: 'Another request is being processed' });
    }
    
    try {
      let conversationHistory;
      try {
        conversationHistory = await redis.get(chatKey) || [];
        if (typeof conversationHistory === 'string') {
          conversationHistory = JSON.parse(conversationHistory);
        }
        if (!Array.isArray(conversationHistory)) {
          conversationHistory = [];
        }
      } catch (e) {
        console.warn('⚠ Failed to parse history, resetting');
        conversationHistory = [];
      }

      // Load và validate memory
      let userMemory;
      try {
        userMemory = await redis.get(memoryKey) || {};
        if (typeof userMemory === 'string') {
          userMemory = JSON.parse(userMemory);
        }
        if (typeof userMemory !== 'object' || Array.isArray(userMemory)) {
          userMemory = {};
        }
        
        // Auto-clean invalid keys/values
        const cleanedMemory = {};
        for (const [key, value] of Object.entries(userMemory)) {
          const normalizedKey = normalizeMemoryKey(key);
          const sanitizedValue = sanitizeMemoryValue(value);
          
          if (normalizedKey && sanitizedValue) {
            cleanedMemory[normalizedKey] = sanitizedValue;
          } else {
            console.warn(`🧹 Cleaned invalid memory: ${key}=${value}`);
          }
        }
        
        if (JSON.stringify(cleanedMemory) !== JSON.stringify(userMemory)) {
          console.log('🔧 Memory auto-cleaned');
          userMemory = cleanedMemory;
          await redis.setex(memoryKey, CONFIG.redis.memoryTTL, JSON.stringify(userMemory));
        }
        
      } catch (e) {
        console.warn('⚠ Failed to parse memory, resetting');
        userMemory = {};
      }
      
      if (message.toLowerCase() === '/memory' || 
          message.toLowerCase() === 'bạn nhớ gì về tôi' ||
          message.toLowerCase() === 'bạn biết gì về tôi') {
        
        let memoryText = '📝 Thông tin tôi nhớ về bạn:\n\n';
        
        if (Object.keys(userMemory).length === 0) {
          memoryText = '💭 Tôi chưa có thông tin nào về bạn. Hãy chia sẻ với tôi nhé!';
        } else {
          for (const [key, value] of Object.entries(userMemory)) {
            memoryText += `• ${key}: ${value}\n`;
          }
          memoryText += `\n_Tổng cộng ${Object.keys(userMemory).length} thông tin đã lưu._`;
        }
        
        await redis.del(lockKey);
        return res.status(200).json({
          success: true,
          message: memoryText,
          userId,
          memoryCount: Object.keys(userMemory).length
        });
      }

      if (message.toLowerCase() === '/forget' || 
          message.toLowerCase() === 'quên tôi đi' ||
          message.toLowerCase() === 'xóa thông tin') {
        
        await redis.del(memoryKey);
        await redis.del(lockKey);
        
        return res.status(200).json({
          success: true,
          message: '🗑 Đã xóa toàn bộ thông tin về bạn. Chúng ta bắt đầu lại từ đầu nhé!',
          userId
        });
      }

      if (message.toLowerCase().startsWith('/forget ')) {
        const fieldToDelete = message.substring(8).trim();
        const normalizedFieldToDelete = normalizeMemoryKey(fieldToDelete);
        
        if (normalizedFieldToDelete && userMemory[normalizedFieldToDelete]) {
          delete userMemory[normalizedFieldToDelete];
          await redis.setex(memoryKey, CONFIG.redis.memoryTTL, JSON.stringify(userMemory));
          await redis.del(lockKey);

          return res.status(200).json({
            success: true,
            message: `🗑 Đã xóa thông tin: ${normalizedFieldToDelete}`,
            userId
          });
        } else {
          await redis.del(lockKey);
          return res.status(200).json({
            success: true,
            message: `❓ Không tìm thấy: ${fieldToDelete}\n\nGõ /memory để xem danh sách.`,
            userId
          });
        }
      }
      
      let searchResults = null;
      let usedSearch = false;
      
      if (needsWebSearch(message)) {
        const keywords = await extractSearchKeywords(message);
        searchResults = await searchWeb(keywords);
        
        if (searchResults) {
          usedSearch = true;
          console.log('✅ Search completed successfully');
        } else {
          console.log('⚠ Search returned no results');
        }
      }

      conversationHistory.push({
        role: 'user',
        content: message
      });

      if (conversationHistory.length > CONFIG.redis.maxHistoryLength) {
        conversationHistory = conversationHistory.slice(-CONFIG.redis.maxHistoryLength);
      }

      const systemPrompt = buildSystemPrompt(userMemory, searchResults);
      
      // Điều chỉnh parameters dựa trên độ phức tạp của message
      const isSimpleMessage = message.trim().length < 20 && 
                              !message.includes('?') && 
                              /^(chào|hi|hello|hey|xin chào|ok|vâng|ừ|à|ơ|alo)/i.test(message.trim());
      
      const chatCompletion = await callGroqWithRetry({
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          ...conversationHistory
        ],
        model: CONFIG.models.main,
        temperature: isSimpleMessage ? 0.3 : 0.7, // Giảm temperature cho câu đơn giản
        max_tokens: isSimpleMessage ? 100 : 1024, // Giới hạn tokens cho câu đơn giản
        top_p: 0.9,
        frequency_penalty: 0.5, // Phạt lặp lại
        presence_penalty: 0.3,  // Khuyến khích đa dạng
        stop: ['\n\n\n', '---', '___'], // Stop khi gặp nhiều newline
        stream: false
      });

      let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';
      
      // Extract memory với validation chặt chẽ
      const memoryExtraction = await extractMemory(message, userMemory);
      let memoryUpdated = false;
      
      if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
        // Merge updates vào current memory
        const updatedMemory = { ...userMemory, ...memoryExtraction.updates };
        
        // Double-check: chỉ lưu key hợp lệ
        const finalMemory = {};
        for (const [key, value] of Object.entries(updatedMemory)) {
          if (ALLOWED_MEMORY_KEYS.includes(key) && value && value.trim()) {
            finalMemory[key] = value;
          }
        }
        
        // Lưu vào Redis
        try {
          await redis.setex(memoryKey, CONFIG.redis.memoryTTL, JSON.stringify(finalMemory));
          userMemory = finalMemory;
          memoryUpdated = true;
          console.log(`💾 Memory saved for ${userId}:`, finalMemory);
        } catch (saveError) {
          console.error('❌ Failed to save memory:', saveError.message);
        }
      }

      conversationHistory.push({
        role: 'assistant',
        content: assistantMessage
      });

      await redis.setex(chatKey, CONFIG.redis.historyTTL, JSON.stringify(conversationHistory));
      await redis.del(lockKey);
      
      return res.status(200).json({
        success: true,
        message: assistantMessage,
        metadata: {
          userId,
          conversationId,
          historyLength: conversationHistory.length,
          memoryUpdated,
          memoryCount: Object.keys(userMemory).length,
          usedWebSearch: usedSearch,
          model: CONFIG.models.main,
          timestamp: new Date().toISOString()
        }
      });
    } finally {
      await redis.del(lockKey).catch(() => {});
    }

  } catch (error) {
    console.error('❌ Error:', error);
    
    let errorMessage = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.message?.includes('rate_limit')) {
      errorMessage = '⚠ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau.';
      statusCode = 429;
    } else if (error.message?.includes('Request quá lớn')) {
      statusCode = 413;
    }
    
    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      timestamp: new Date().toISOString()
    });
  }
}
