import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

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
    maxHistoryLength: 50,
  },
  search: {
    timeout: 10000,
    maxResults: 8,
  }
};

// ✅ FIX 1: Thêm error handling cho Redis initialization
let redis;
try {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('✅ Redis connected');
} catch (error) {
  console.error('❌ Redis initialization failed:', error.message);
  redis = null;
}

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

// ✅ FIX 2: Safe Redis operations với fallback
async function safeRedisGet(key, defaultValue = null) {
  if (!redis) {
    console.warn('⚠ Redis not available, using default value');
    return defaultValue;
  }
  
  try {
    const value = await redis.get(key);
    
    if (value === null || value === undefined) {
      return defaultValue;
    }
    
    // ✅ FIX 3: Validate và parse JSON safely
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        // Validate structure
        if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
          console.warn(`⚠ Expected array for ${key}, got ${typeof parsed}`);
          return defaultValue;
        }
        if (typeof defaultValue === 'object' && typeof parsed !== 'object') {
          console.warn(`⚠ Expected object for ${key}, got ${typeof parsed}`);
          return defaultValue;
        }
        return parsed;
      } catch (e) {
        console.warn(`⚠ Failed to parse JSON for ${key}:`, e.message);
        return defaultValue;
      }
    }
    
    return value;
  } catch (error) {
    console.error(`❌ Redis GET error for ${key}:`, error.message);
    return defaultValue;
  }
}

async function safeRedisSet(key, value, ttl) {
  if (!redis) {
    console.warn('⚠ Redis not available, skipping set');
    return false;
  }
  
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await redis.setex(key, ttl, serialized);
    return true;
  } catch (error) {
    console.error(`❌ Redis SET error for ${key}:`, error.message);
    return false;
  }
}

async function safeRedisDel(key) {
  if (!redis) {
    console.warn('⚠ Redis not available, skipping delete');
    return false;
  }
  
  try {
    await redis.del(key);
    return true;
  } catch (error) {
    console.error(`❌ Redis DEL error for ${key}:`, error.message);
    return false;
  }
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
  const cacheKey = `search:${cleanQuery}`;
  
  const cached = await safeRedisGet(cacheKey);
  if (cached) {
    console.log('✅ Search cache hit');
    return cached;
  }
  
  for (let i = 0; i < SEARCH_APIS.length; i++) {
    currentSearchApiIndex = (currentSearchApiIndex + 1) % SEARCH_APIS.length;
    const api = SEARCH_APIS[currentSearchApiIndex];
    
    try {
      console.log(`🔎 Searching with ${api.name}...`);
      const result = await api.search(cleanQuery);
      
      if (result && result.length >= 50) {
        await safeRedisSet(cacheKey, result, CONFIG.redis.searchCacheTTL);
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
    /tin tức|sự kiện|cập nhật|thông tin|news/i,
    /thời tiết|nhiệt độ|khí hậu/i,
    /tìm|tra|search|tìm kiếm/i,
    /ai là|ai đã|là ai/i,
    /khi nào|lúc nào|bao giờ/i,
    /ở đâu|chỗ nào|tại đâu/i,
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

function normalizeMemoryKey(key) {
  if (!key || typeof key !== 'string') return 'Khác';
  
  const normalized = key.toLowerCase().trim();
  
  const keyMapping = {
    'ten': 'Tên',
    'tên': 'Tên',
    'tên đầy đủ': 'Tên',
    'họ tên': 'Tên',
    'tuổi': 'Tuổi',
    'tuoi': 'Tuổi',
    'nghề': 'Nghề nghiệp',
    'nghe': 'Nghề nghiệp',
    'nghề nghiệp': 'Nghề nghiệp',
    'nghe nghiep': 'Nghề nghiệp',
    'công việc': 'Nghề nghiệp',
    'cong viec': 'Nghề nghiệp',
    'job': 'Nghề nghiệp',
    'nơi ở': 'Địa điểm',
    'noi o': 'Địa điểm',
    'địa chỉ': 'Địa điểm',
    'dia chi': 'Địa điểm',
    'sống ở': 'Địa điểm',
    'location': 'Địa điểm',
    'sở thích': 'Sở thích',
    'so thich': 'Sở thích',
    'thích': 'Sở thích',
    'hobby': 'Sở thích',
    'hobbies': 'Sở thích',
    'học vấn': 'Học vấn',
    'hoc van': 'Học vấn',
    'trường': 'Học vấn',
    'truong': 'Học vấn',
    'education': 'Học vấn',
    'gia đình': 'Gia đình',
    'gia dinh': 'Gia đình',
    'family': 'Gia đình',
    'mục tiêu': 'Mục tiêu',
    'muc tieu': 'Mục tiêu',
    'goal': 'Mục tiêu',
  };
  
  return keyMapping[normalized] || key;
}

async function extractMemory(message, currentMemory) {
  try {
    const extractionPrompt = `Phân tích tin nhắn và trích xuất THÔNG TIN CÁ NHÂN QUAN TRỌNG cần lưu lâu dài.

TIN NHẮN: "${message}"

THÔNG TIN ĐÃ LƯU: ${JSON.stringify(currentMemory, null, 2)}

THÔNG TIN CẦN LƯU:
- Tên, biệt danh
- Nghề nghiệp, công việc
- Sở thích, đam mê
- Gia đình (vợ/chồng, con, sinh nhật...)
- Địa điểm sống
- Mục tiêu, dự định
- Học vấn
- Sức khỏe quan trọng
- Bất kỳ thông tin USER YÊU CẦU BẠN NHỚ

QUY TẮC:
- CHỈ lưu thông tin QUAN TRỌNG, lâu dài
- KHÔNG lưu câu hỏi thông thường, yêu cầu tìm kiếm
- Dùng key chuẩn: "Tên", "Tuổi", "Nghề nghiệp", "Sở thích", "Địa điểm", "Gia đình", "Học vấn", "Mục tiêu"
- Nếu không có info mới, trả về hasNewInfo: false

TRẢ VỀ JSON:
{
  "hasNewInfo": true/false,
  "updates": {
    "Tên": "giá trị",
    "Tuổi": "giá trị"
  },
  "summary": "Tóm tắt ngắn"
}

CHỈ TRẢ JSON, KHÔNG TEXT KHÁC.`;

    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: 'Bạn là trợ lý phân tích thông tin. CHỈ TRẢ JSON, không markdown hay text khác.'
        },
        {
          role: 'user',
          content: extractionPrompt
        }
      ],
      model: CONFIG.models.memory,
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // ✅ FIX 4: Validate parsed object structure
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn('⚠ Invalid memory extraction result');
        return { hasNewInfo: false };
      }
      
      // ✅ FIX 5: Safely handle updates object
      if (parsed.updates && typeof parsed.updates === 'object') {
        const normalizedUpdates = {};
        for (const [key, value] of Object.entries(parsed.updates)) {
          if (key && value && typeof value === 'string') {
            const normalizedKey = normalizeMemoryKey(key);
            normalizedUpdates[normalizedKey] = value;
          }
        }
        parsed.updates = normalizedUpdates;
        
        // If no valid updates after normalization, mark as no new info
        if (Object.keys(normalizedUpdates).length === 0) {
          parsed.hasNewInfo = false;
        }
      } else {
        parsed.hasNewInfo = false;
        parsed.updates = {};
      }
      
      console.log('📊 Memory extraction:', parsed);
      return parsed;
    }
    
    return { hasNewInfo: false, updates: {} };
    
  } catch (error) {
    console.error('❌ Error extracting memory:', error);
    return { hasNewInfo: false, updates: {} };
  }
}
function buildSystemPrompt(memory, searchResults = null) {
  let prompt = `Bạn là KAMI, một AI thông minh và có tư duy, được tạo ra bởi Nguyễn Đức Thạnh.
NGUYÊN TẮC:
– Dùng tiếng Việt trừ khi được yêu cầu ngôn ngữ khác
– Xưng "tôi" hoặc theo yêu cầu. Gọi user theo tiền tố họ chọn
– Luôn phân tích trước khi trả lời. Giọng chuyên nghiệp, bình tĩnh, rõ ràng
– Tùy biến theo ngữ cảnh. Ưu tiên tuyệt đối theo mục đích câu hỏi
– Dùng emoji tiết chế. Tránh format quá mức trừ khi được yêu cầu`;
  if (searchResults) {
    prompt += `\n\n📊 DỮ LIỆU TÌM KIẾM MỚI NHẤT:\n${searchResults}\n\n⚠ ƯU TIÊN dùng thông tin này để trả lời chính xác và cập nhật.`;
  }

  if (memory && typeof memory === 'object' && Object.keys(memory).length > 0) {
    prompt += '\n\n📝 THÔNG TIN BẠN BIẾT VỀ NGƯỜI DÙNG:\n';
    
    for (const [key, value] of Object.entries(memory)) {
      if (key && value) {
        prompt += `- ${key}: ${value}\n`;
      }
    }
    
    prompt += '\nQUY TẮC:\n';
    prompt += '- Gọi tên khi phù hợp (không mọi câu)\n';
    prompt += '- KHÔNG nhắc lại trừ khi được hỏi\n';
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
    let conversationHistory = await safeRedisGet(chatKey, []);
    let userMemory = await safeRedisGet(memoryKey, {});
    if (!Array.isArray(conversationHistory)) {
      console.warn('⚠ Invalid conversation history, resetting');
      conversationHistory = [];
    }
    
    if (typeof userMemory !== 'object' || userMemory === null) {
      console.warn('⚠ Invalid user memory, resetting');
      userMemory = {};
    }

    // Memory commands
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
      
      await safeRedisDel(memoryKey);
      
      return res.status(200).json({
        success: true,
        message: '🗑 Đã xóa toàn bộ thông tin về bạn. Chúng ta bắt đầu lại từ đầu nhé!',
        userId
      });
    }

    if (message.toLowerCase().startsWith('/forget ')) {
      const fieldToDelete = message.substring(8).trim();
      const realKey = Object.keys(userMemory).find(k => 
        k.toLowerCase() === fieldToDelete.toLowerCase()
      );

      if (realKey) {
        delete userMemory[realKey];
        await safeRedisSet(memoryKey, userMemory, CONFIG.redis.memoryTTL);

        return res.status(200).json({
          success: true,
          message: `🗑 Đã xóa thông tin: ${realKey}`,
          userId
        });
      } else {
        return res.status(200).json({
          success: true,
          message: `❓ Không tìm thấy: ${fieldToDelete}\n\nGõ /memory để xem danh sách.`,
          userId
        });
      }
    }

    // Web search
    let searchResults = null;
    let usedSearch = false;
    
    if (needsWebSearch(message)) {
      console.log('🔍 Triggering web search...');
      const keywords = await extractSearchKeywords(message);
      searchResults = await searchWeb(keywords);
      
      if (searchResults) {
        usedSearch = true;
        console.log('✅ Search completed successfully');
      } else {
        console.log('⚠ Search returned no results');
      }
    }

    // Add user message to history
    conversationHistory.push({
      role: 'user',
      content: message
    });

    // Trim history if too long
    if (conversationHistory.length > CONFIG.redis.maxHistoryLength) {
      conversationHistory = conversationHistory.slice(-CONFIG.redis.maxHistoryLength);
    }

    const systemPrompt = buildSystemPrompt(userMemory, searchResults);
    
    const chatCompletion = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        ...conversationHistory
      ],
      model: CONFIG.models.main,
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';
    
    // ✅ FIX 8: Extract memory with proper error handling
    const memoryExtraction = await extractMemory(message, userMemory);
    let memoryUpdated = false;
    
    if (memoryExtraction.hasNewInfo && 
        memoryExtraction.updates && 
        Object.keys(memoryExtraction.updates).length > 0) {
      
      // ✅ FIX 9: Merge memory safely to avoid race conditions
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      const saved = await safeRedisSet(memoryKey, userMemory, CONFIG.redis.memoryTTL);
      
      if (saved) {
        memoryUpdated = true;
        console.log(`💾 Memory updated for ${userId}:`, userMemory);
        
        const memoryNotice = memoryExtraction.summary || 'Đã cập nhật thông tin.';
        assistantMessage += `\n\n💾 _${memoryNotice}_`;
      } else {
        console.warn('⚠ Failed to save memory update');
      }
    }

    // Add assistant response to history
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    // Save conversation history
    await safeRedisSet(chatKey, conversationHistory, CONFIG.redis.historyTTL);
    
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
        timestamp: new Date().toISOString(),
        redisAvailable: !!redis
      }
    });

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
