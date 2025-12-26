import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';
import axios from 'axios';
let redis = null;
const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;

if (REDIS_ENABLED) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  } catch (error) {
    console.error('❌ Redis initialization error:', error);
  }
}
const memoryStore = new Map();
const searchCache = new Map(); // Cache search results

const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
  process.env.GROQ_API_KEY_7,
  process.env.GROQ_API_KEY_8,
  process.env.GROQ_API_KEY_9,
  process.env.GROQ_API_KEY_10
].filter(key => key);

// Search API keys
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MEMORY_CONFIG = {
  SHORT_TERM_DAYS: 14,              // Tăng lên 14 ngày (fix bug mất data)
  WORKING_MEMORY_LIMIT: 30,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40,
  EXTRACT_INTERVAL: 10,             // Extract mỗi 10 tin
  SEARCH_CACHE_MINUTES: 10          // Cache search 10 phút
};

// ============ STORAGE HELPERS ============

async function setData(key, value, ttl = null) {
  if (redis) {
    return ttl ? await redis.set(key, value, { ex: ttl }) : await redis.set(key, value);
  } else {
    memoryStore.set(key, { value, expires: ttl ? Date.now() + ttl * 1000 : null });
    return true;
  }
}

async function getData(key) {
  if (redis) {
    return await redis.get(key);
  } else {
    const item = memoryStore.get(key);
    if (!item) return null;
    if (item.expires && Date.now() > item.expires) {
      memoryStore.delete(key);
      return null;
    }
    return item.value;
  }
}

async function setHashData(key, data, ttl = null) {
  if (redis) {
    await redis.hset(key, data);
    if (ttl) await redis.expire(key, ttl);
    return true;
  } else {
    memoryStore.set(key, { value: data, expires: ttl ? Date.now() + ttl * 1000 : null });
    return true;
  }
}

async function getHashData(key) {
  if (redis) {
    return await redis.hgetall(key);
  } else {
    const item = memoryStore.get(key);
    if (!item) return {};
    if (item.expires && Date.now() > item.expires) {
      memoryStore.delete(key);
      return {};
    }
    return item.value || {};
  }
}

async function setExpire(key, ttl) {
  if (redis) {
    return await redis.expire(key, ttl);
  }
  return true;
}

// ============ SEARCH APIs với Retry & Timeout ============

// Helper: Retry với exponential backoff
async function retryWithBackoff(fn, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
    }
  }
}

// 1. Wikipedia API (FREE ∞)
async function searchWikipedia(query) {
  try {
    return await retryWithBackoff(async () => {
      // Bước 1: Search để tìm tên bài viết
      const searchUrl = 'https://vi.wikipedia.org/w/api.php';
      const searchResponse = await axios.get(searchUrl, {
        params: {
          action: 'opensearch',
          search: query,
          limit: 3,
          format: 'json'
        },
        timeout: 4000
      });

      const titles = searchResponse.data[1];
      if (!titles || titles.length === 0) {
        return null;
      }

      const pageTitle = titles[0];

      // Bước 2: Lấy summary
      const summaryUrl = `https://vi.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
      const summaryResponse = await axios.get(summaryUrl, {
        timeout: 4000
      });

      const data = summaryResponse.data;
      
      return {
        source: 'Wikipedia',
        confidence: 0.9,
        title: data.title,
        extract: data.extract,
        url: data.content_urls.desktop.page,
        thumbnail: data.thumbnail?.source
      };
    });
  } catch (error) {
    console.error('Wikipedia search error:', error.message);
    return null;
  }
}

// 2. Serper.dev API
async function searchSerper(query) {
  if (!SERPER_API_KEY) {
    console.warn('⚠ Serper API key not configured');
    return null;
  }

  try {
    return await retryWithBackoff(async () => {
      const response = await axios.post('https://google.serper.dev/search', {
        q: query,
        gl: 'vn',
        hl: 'vi',
        num: 5
      }, {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 4000
      });

      const results = response.data.organic || [];
      if (results.length === 0) return null;

      return {
        source: 'Serper',
        confidence: 0.95,
        results: results.slice(0, 3).map(r => ({
          title: r.title,
          snippet: r.snippet,
          url: r.link
        }))
      };
    });
  } catch (error) {
    console.error('Serper search error:', error.message);
    return null;
  }
}

// 3. Tavily AI
async function searchTavily(query) {
  if (!TAVILY_API_KEY) {
    console.warn('⚠ Tavily API key not configured');
    return null;
  }

  try {
    return await retryWithBackoff(async () => {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 3
      }, {
        timeout: 4000
      });

      const data = response.data;
      
      return {
        source: 'Tavily',
        confidence: 0.85,
        answer: data.answer,
        results: data.results?.slice(0, 3).map(r => ({
          title: r.title,
          snippet: r.content,
          url: r.url
        }))
      };
    });
  } catch (error) {
    console.error('Tavily search error:', error.message);
    return null;
  }
}

// ============ AI-POWERED SEARCH DETECTION ============

async function shouldSearch(message, groq) {
  // Quick keyword check first (fast path)
  const lowerQuery = message.toLowerCase();
  
  const definiteSearchKeywords = [
    // Tìm kiếm cơ bản
  'tìm kiếm', 'search', 'tra cứu', 'google', 'bing',
  // Tìm lại (khi user nghi ngờ)
  'tìm đi', 'tìm lại', 'tìm lại đi', 'xem lại', 
  'tìm giúp', 'tra giúp', 'kiểm tra lại', 'search lại',
  'tra lại', 'xác minh', 'chắc chắn không', 'có đúng không',
  // Real-time data
  'giá bitcoin', 'giá vàng', 'giá dầu', 'tỷ giá',
  'thời tiết', 'nhiệt độ',
  'tin tức', 'mới nhất', 'hiện tại', 'hôm nay', 'bây giờ',
  // Câu hỏi trực tiếp
  'bao nhiêu', 'mấy giờ', 'khi nào'
];  
  if (definiteSearchKeywords.some(kw => lowerQuery.includes(kw))) {
    return { needsSearch: true, confidence: 1.0, type: 'realtime' };
  }

  // Nếu câu hỏi ngắn và không rõ ràng, skip AI detection
  if (message.length < 10) {
    return { needsSearch: false, confidence: 0 };
  }

  // AI-powered detection cho các case phức tạp
  try {
    const prompt = `Phân tích câu hỏi sau và xác định có cần tìm kiếm thông tin không:

Câu hỏi: "${message}"

Trả về JSON:
{
  "needsSearch": true/false,
  "type": "knowledge/realtime/research/none",
  "reason": "lý do ngắn gọn"
}

Chỉ trả về JSON, không có text thừa.`;

    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý phân tích câu hỏi.' },
        { role: 'user', content: prompt }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 150
    });

    const result = response.choices[0]?.message?.content || '{}';
    const analysis = JSON.parse(result.replace(/```json|```/g, '').trim());
    
    return {
      needsSearch: analysis.needsSearch || false,
      confidence: analysis.needsSearch ? 0.8 : 0.2,
      type: analysis.type || 'none'
    };
  } catch (error) {
    console.error('AI search detection error:', error);
    // Fallback to keyword-based detection
    return analyzeQueryKeywords(message);
  }
}

// Fallback keyword analysis
function analyzeQueryKeywords(query) {
  const lowerQuery = query.toLowerCase();
  
  const realtimeKeywords = ['giá', 'bao nhiêu', 'thời tiết', 'tin tức'];
  const knowledgeKeywords = ['là ai', 'là gì', 'định nghĩa', 'lịch sử', 'giải thích', 'ý nghĩa', 'về', 'cho tôi biết'];
  const researchKeywords = ['so sánh', 'khác nhau', 'tốt hơn', 'nên chọn', 'đánh giá'];
  
  const hasRealtime = realtimeKeywords.some(kw => lowerQuery.includes(kw));
  const hasKnowledge = knowledgeKeywords.some(kw => lowerQuery.includes(kw));
  const hasResearch = researchKeywords.some(kw => lowerQuery.includes(kw));
  
  if (hasRealtime) return { needsSearch: true, confidence: 0.9, type: 'realtime' };
  if (hasKnowledge) return { needsSearch: true, confidence: 0.8, type: 'knowledge' };
  if (hasResearch) return { needsSearch: true, confidence: 0.7, type: 'research' };
  
  return { needsSearch: false, confidence: 0.3 };
}

// ============ SMART SEARCH với Cache ============

function getCacheKey(query) {
  return `search:${query.toLowerCase().trim()}`;
}

function getFromCache(query) {
  const key = getCacheKey(query);
  const cached = searchCache.get(key);
  
  if (!cached) return null;
  
  const age = Date.now() - cached.timestamp;
  const maxAge = MEMORY_CONFIG.SEARCH_CACHE_MINUTES * 60 * 1000;
  
  if (age > maxAge) {
    searchCache.delete(key);
    return null;
  }
  
  console.log(`✅ Cache hit for: ${query.substring(0, 30)}...`);
  return cached.result;
}

function saveToCache(query, result) {
  const key = getCacheKey(query);
  searchCache.set(key, {
    result,
    timestamp: Date.now()
  });
  
  // Giới hạn cache size (max 100 entries)
  if (searchCache.size > 100) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
}

async function smartSearch(query, searchType, groq) {
  // Check cache first
  const cached = getFromCache(query);
  if (cached) return cached;

  console.log(`🔍 Search type: ${searchType} for query: "${query.substring(0, 50)}..."`);

  let result = null;

  try {
    // Strategy based on type
    if (searchType === 'knowledge') {
      // Wikipedia first (free + best for knowledge)
      result = await searchWikipedia(query);
      if (result) {
        saveToCache(query, result);
        return result;
      }
    }

    if (searchType === 'realtime') {
      // Serper first (best for real-time)
      if (SERPER_API_KEY) {
        result = await searchSerper(query);
        if (result) {
          saveToCache(query, result);
          return result;
        }
      }
    }

    if (searchType === 'research') {
      // Tavily first (best for research)
      if (TAVILY_API_KEY) {
        result = await searchTavily(query);
        if (result) {
          saveToCache(query, result);
          return result;
        }
      }
    }

    // Fallback: Try all in order (Wikipedia → Serper → Tavily)
    console.log(`🔄 Fallback search mode...`);
    
    result = await searchWikipedia(query);
    if (result) {
      saveToCache(query, result);
      return result;
    }
    
    if (SERPER_API_KEY) {
      result = await searchSerper(query);
      if (result) {
        saveToCache(query, result);
        return result;
      }
    }
    
    if (TAVILY_API_KEY) {
      result = await searchTavily(query);
      if (result) {
        saveToCache(query, result);
        return result;
      }
    }

    return null;
  } catch (error) {
    console.error('Search error:', error);
    return null;
  }
}

function formatSearchResult(searchData) {
  if (!searchData) return null;

  let formatted = `🔍 THÔNG TIN TÌM KIẾM (Nguồn: ${searchData.source})\n\n`;

  if (searchData.source === 'Wikipedia') {
    formatted += `📌 ${searchData.title}\n`;
    formatted += `${searchData.extract}\n`;
    formatted += `🔗 ${searchData.url}`;
  } 
  else if (searchData.source === 'Serper') {
    searchData.results.forEach((r, i) => {
      formatted += `${i + 1}. ${r.title}\n`;
      formatted += `   ${r.snippet}\n`;
      formatted += `   🔗 ${r.url}\n\n`;
    });
  }
  else if (searchData.source === 'Tavily') {
    if (searchData.answer) {
      formatted += `💡 ${searchData.answer}\n\n`;
    }
    if (searchData.results) {
      formatted += `Chi tiết:\n`;
      searchData.results.forEach((r, i) => {
        formatted += `${i + 1}. ${r.title}\n`;
        formatted += `   ${r.snippet.substring(0, 150)}...\n`;
        formatted += `   🔗 ${r.url}\n\n`;
      });
    }
  }

  return formatted;
}

// ============ MEMORY FUNCTIONS (FIXED) ============

async function getShortTermMemory(userId, conversationId) {
  const key = `chat:${userId}:${conversationId}`;
  const history = await getData(key);
  
  // Safe parsing
  if (!history) return [];
  
  if (typeof history === 'string') {
    try {
      return JSON.parse(history);
    } catch (error) {
      console.error('Failed to parse history:', error);
      return [];
    }
  }
  
  if (Array.isArray(history)) {
    return history;
  }
  
  return [];
}

async function saveShortTermMemory(userId, conversationId, history) {
  const key = `chat:${userId}:${conversationId}`;
  const data = Array.isArray(history) ? JSON.stringify(history) : history;
  await setData(key, data, MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

async function getLongTermMemory(userId) {
  const key = `user:profile:${userId}`;
  const profile = await getHashData(key);
  
  if (profile && Object.keys(profile).length > 0) {
    await setExpire(key, MEMORY_CONFIG.LONG_TERM_DAYS * 86400);
  }
  
  return profile || {};
}

async function saveLongTermMemory(userId, profileData) {
  const key = `user:profile:${userId}`;
  await setHashData(key, profileData, MEMORY_CONFIG.LONG_TERM_DAYS * 86400);
}

async function getSummary(userId, conversationId) {
  const key = `summary:${userId}:${conversationId}`;
  const summary = await getData(key);
  
  if (summary) {
    await setExpire(key, MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
  }
  
  return summary || '';
}

async function saveSummary(userId, conversationId, summary) {
  const key = `summary:${userId}:${conversationId}`;
  await setData(key, summary, MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

async function summarizeOldMessages(groq, oldMessages) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Hãy tóm tắt cuộc hội thoại sau thành 2-3 câu ngắn gọn, giữ lại thông tin quan trọng.'
        },
        {
          role: 'user',
          content: `Tóm tắt cuộc hội thoại:\n${JSON.stringify(oldMessages)}`
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.3,
      max_tokens: 300
    });
    
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Error summarizing:', error);
    return 'Cuộc trò chuyện trước đó...';
  }
}

async function extractPersonalInfo(groq, conversationHistory) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Trích xuất thông tin cá nhân từ cuộc hội thoại (nếu có) theo format JSON:
{
  "name": "tên người dùng",
  "age": "tuổi",
  "job": "nghề nghiệp",
  "hobbies": "sở thích",
  "location": "nơi ở",
  "other": "thông tin khác"
}
Chỉ trả về JSON, không có text thừa. Nếu không có thông tin nào thì trả về {}.`
        },
        {
          role: 'user',
          content: JSON.stringify(conversationHistory.slice(-10))
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 500
    });
    
    const result = chatCompletion.choices[0]?.message?.content || '{}';
    return JSON.parse(result.replace(/```json|```/g, '').trim());
  } catch (error) {
    console.error('Error extracting info:', error);
    return {};
  }
}

// ============ FIXED EXTRACT LOGIC ============

/**
 * Kiểm tra xem có nên extract thông tin bây giờ không
 * @param {string} userId 
 * @param {string} conversationId 
 * @param {Array} conversationHistory 
 * @returns {Promise<boolean>}
 */
async function shouldExtractNow(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  const lastExtract = await getData(key);
  
  // Lần đầu tiên: extract khi có đủ 5 tin để phân tích
  if (!lastExtract) {
    return conversationHistory.length >= 5;
  }
  
  try {
    const lastExtractData = JSON.parse(lastExtract);
    const timeSince = Date.now() - lastExtractData.timestamp;
    const messagesSince = conversationHistory.length - lastExtractData.messageCount;
    
    // Logic extract thông minh:
    // 1. Đã qua 5 phút VÀ có ít nhất 3 tin mới (user chat bình thường)
    // 2. HOẶC có 10 tin mới (user chat liên tục)
    const shouldExtractByTime = timeSince > 300000 && messagesSince >= 3;
    const shouldExtractByCount = messagesSince >= 10;
    
    return shouldExtractByTime || shouldExtractByCount;
  } catch (error) {
    console.error('Error parsing last extract data:', error);
    // Fallback: extract nếu có >= 5 tin
    return conversationHistory.length >= 5;
  }
}

/**
 * Đánh dấu đã extract xong
 * @param {string} userId 
 * @param {string} conversationId 
 * @param {Array} conversationHistory 
 */
async function markExtracted(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  await setData(key, JSON.stringify({
    timestamp: Date.now(),
    messageCount: conversationHistory.length,
    extractedAt: new Date().toISOString()
  }), MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

// ============ API KEY MANAGEMENT ============

function getRandomKeyIndex() {
  return Math.floor(Math.random() * API_KEYS.length);
}

function getNextKeyIndex(currentIndex) {
  return (currentIndex + 1) % API_KEYS.length;
}

async function getUserKeyIndex(userId) {
  const key = `keyindex:${userId}`;
  let index = await getData(key);
  
  if (index === null) {
    index = getRandomKeyIndex();
    await setData(key, index, 86400);
  }
  
  return parseInt(index);
}

async function setUserKeyIndex(userId, index) {
  const key = `keyindex:${userId}`;
  await setData(key, index, 86400);
}

async function callGroqWithRetry(userId, messages) {
  let currentKeyIndex = await getUserKeyIndex(userId);
  let attempts = 0;
  const maxAttempts = API_KEYS.length;

  while (attempts < maxAttempts) {
    try {
      const apiKey = API_KEYS[currentKeyIndex];
      const groq = new Groq({ apiKey });

      const chatCompletion = await groq.chat.completions.create({
        messages,
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 2048,
        top_p: 0.9,
        stream: false
      });

      await setUserKeyIndex(userId, currentKeyIndex);
      return { groq, chatCompletion };

    } catch (error) {
      const isQuotaError = 
  error.message?.includes('quota') || 
  error.message?.includes('rate limit') ||
  error.message?.includes('Rate limit') ||
  error.status === 429 ||
  error.status === 403;

      if (isQuotaError && attempts < maxAttempts - 1) {
        console.log(`Key ${currentKeyIndex + 1} hết quota, chuyển key...`);
        currentKeyIndex = getNextKeyIndex(currentKeyIndex);
        attempts++;
        continue;
      }

      throw error;
    }
  }

  throw new Error('Đã thử hết tất cả dữ liệu');
}

// ============ MAIN HANDLER (FIXED) ============

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId, conversationId } = req.body;

    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ 
        success: false,
        error: 'Message is required and cannot be empty' 
      });
    }

    if (!userId || !userId.startsWith('user_')) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid userId format. Expected format: user_<timestamp>' 
      });
    }

    const finalConversationId = conversationId || 'default';

    if (API_KEYS.length === 0) {
      return res.status(500).json({ 
        success: false,
        error: 'No API keys configured' 
      });
    }

    if (!REDIS_ENABLED) {
      console.warn('⚠ Redis not configured - using in-memory storage');
    }

    console.log(`📱 Request from userId: ${userId}`);

    // 1. Lấy memory
    let conversationHistory = await getShortTermMemory(userId, finalConversationId);
    const userProfile = await getLongTermMemory(userId);
    let existingSummary = await getSummary(userId, finalConversationId);

    console.log(`💾 Loaded ${conversationHistory.length} messages`);

    // 2. AI-POWERED SEARCH DETECTION
    let searchResult = null;
    const tempGroq = new Groq({ apiKey: API_KEYS[0] });
    
    const searchDecision = await shouldSearch(message, tempGroq);
    console.log(`🤔 Search decision:`, searchDecision);

    if (searchDecision.needsSearch && searchDecision.confidence > 0.6) {
      searchResult = await smartSearch(message, searchDecision.type, tempGroq);
      
      if (searchResult) {
        console.log(`✅ Search successful: ${searchResult.source}`);
      } else {
        console.log(`⚠ Search returned no results`);
      }
    }

    // 3. Thêm tin nhắn user vào history
    conversationHistory.push({
      role: 'user',
      content: message.trim()
    });

    // 4. Xử lý summary khi vượt ngưỡng (FIXED)
    let workingMemory = conversationHistory;
    
    if (conversationHistory.length > MEMORY_CONFIG.SUMMARY_THRESHOLD) {
      console.log(`📊 History > ${MEMORY_CONFIG.SUMMARY_THRESHOLD}`);
      
      const oldMessages = conversationHistory.slice(0, -MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      workingMemory = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      
      // FIXED: Chỉ tạo summary MỘT LẦN
      if (!existingSummary) {
        existingSummary = await summarizeOldMessages(tempGroq, oldMessages);
        await saveSummary(userId, finalConversationId, existingSummary);
        console.log(`✅ Summary created`);
      }
    }

    // 5. Xây dựng context
    const currentDate = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const systemPrompt = {
      role: 'system',
      content: `Bạn là Kami, một AI được tạo ra bởi Nguyễn Đức Thạnh. Hãy trả lời bằng tiếng Việt tự nhiên và không lặp lại cùng một nội dung nhiều lần. Có thể thêm nhiều nhất 4 emoji tùy ngữ cảnh để trò chuyện thêm sinh động.
📅 Ngày hiện tại: ${currentDate}
${Object.keys(userProfile).length > 0 ? `
👤 THÔNG TIN NGƯỜI DÙNG (nhớ lâu dài):
${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}
${existingSummary ? `📝 TÓM TẮT CUỘC TRÒ CHUYỆN TRƯỚC:\n${existingSummary}\n` : ''}

${searchResult ? `\n${formatSearchResult(searchResult)}\n⚠ Hãy ưu tiên sử dụng thông tin tìm kiếm ở trên để trả lời câu hỏi.\n` : ''}`
    };

    const messages = [systemPrompt, ...workingMemory];

    // 6. Gọi AI
    console.log(`🤖 Calling AI with ${workingMemory.length} messages${searchResult ? ' + search' : ''}...`);
    const { groq, chatCompletion } = await callGroqWithRetry(userId, messages);
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    console.log(`✅ AI responded`);

    // 7. FIXED: Lưu response vào FULL conversationHistory
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    // FIXED: Lưu FULL conversationHistory (không phải workingMemory)
    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    // 8. FIXED Extract personal info với logic merge an toàn
    if (await shouldExtractNow(userId, finalConversationId, conversationHistory)) {
      console.log(`🔍 Extracting personal info (${conversationHistory.length} messages)...`);
      const newInfo = await extractPersonalInfo(groq, conversationHistory);
      
      if (Object.keys(newInfo).length > 0) {
        // FIXED: Chỉ merge các field có giá trị thực sự (không rỗng, null, undefined)
        const updatedProfile = { ...userProfile };
        
        for (const [key, value] of Object.entries(newInfo)) {
          // Kiểm tra value có thực sự có nội dung không
          if (value === null || value === undefined || value === 'null' || value === 'undefined') {
            continue; // Skip, giữ nguyên giá trị cũ
          }
          
          // Nếu là string, kiểm tra trim
          if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed !== '') {
              updatedProfile[key] = trimmed;
            }
          } 
          // Nếu là number, boolean, hoặc object khác, cập nhật luôn
          else {
            updatedProfile[key] = value;
          }
        }
        
        await saveLongTermMemory(userId, updatedProfile);
        await markExtracted(userId, finalConversationId, conversationHistory);
        console.log(`✅ Profile updated:`, Object.keys(newInfo).filter(k => {
          const v = newInfo[k];
          return v !== null && v !== undefined && v !== 'null' && v !== 'undefined' && 
                 (typeof v !== 'string' || v.trim() !== '');
        }));
      } else {
        // Không có info mới nhưng vẫn mark để tránh spam extract
        await markExtracted(userId, finalConversationId, conversationHistory);
        console.log(`ℹ No new personal info found`);
      }
    }

    // Safety check: Extract trước khi expire (< 2 ngày)
    if (redis) {
      const chatKey = `chat:${userId}:${finalConversationId}`;
      const ttl = await redis.ttl(chatKey);
      const daysRemaining = ttl / 86400;
      
      if (daysRemaining > 0 && daysRemaining < 2 && conversationHistory.length >= 3) {
        console.log(`⚠ Safety extract - TTL < 2 days`);
        const newInfo = await extractPersonalInfo(groq, conversationHistory);
        if (Object.keys(newInfo).length > 0) {
          // FIXED: Áp dụng cùng logic merge an toàn
          const updatedProfile = { ...userProfile };
          
          for (const [key, value] of Object.entries(newInfo)) {
            if (value === null || value === undefined || value === 'null' || value === 'undefined') {
              continue;
            }
            
            if (typeof value === 'string') {
              const trimmed = value.trim();
              if (trimmed !== '') {
                updatedProfile[key] = trimmed;
              }
            } else {
              updatedProfile[key] = value;
            }
          }
          
          await saveLongTermMemory(userId, updatedProfile);
        }
      }
    }

    // 9. Response
    const lastExtractData = await getData(`last_extract:${userId}:${finalConversationId}`);
    
    // Safe parse lastExtractData
    let parsedExtractData = null;
    if (lastExtractData) {
      try {
        parsedExtractData = typeof lastExtractData === 'string' 
          ? JSON.parse(lastExtractData) 
          : lastExtractData;
      } catch (error) {
        console.error('Failed to parse lastExtractData:', error);
        parsedExtractData = null;
      }
    }
    
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId: userId,
      conversationId: finalConversationId,
      stats: {
        totalMessages: conversationHistory.length,
        workingMemorySize: workingMemory.length,
        hasSummary: !!existingSummary,
        userProfileFields: Object.keys(userProfile).length,
        storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory',
        searchUsed: !!searchResult,
        searchSource: searchResult?.source || null,
        cacheSize: searchCache.size,
        lastExtract: parsedExtractData
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    
    // Detailed error logging
    console.error('Error stack:', error.stack);
    console.error('Error name:', error.name);
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      errorType: error.name || 'Unknown',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
