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

// FIXED: Simple thread-safe cache implementation
class SimpleCache {
  constructor(ttl = 600000, maxSize = 100) {
    this.cache = new Map();
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  set(key, value) {
    // Auto cleanup old entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    const age = Date.now() - item.timestamp;
    if (age > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

const searchCache = new SimpleCache(600000, 100); // 10 phút, max 100 entries
const detectionCache = new SimpleCache(1800000, 200); // 30 phút, max 200 entries

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
  SHORT_TERM_DAYS: 14,
  WORKING_MEMORY_LIMIT: 30,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40,
  EXTRACT_INTERVAL: 10,
  SEARCH_CACHE_MINUTES: 10
};

// Search analytics
const searchStats = {
  total: 0,
  cacheHits: 0,
  sources: { wikipedia: 0, serper: 0, tavily: 0, failed: 0 }
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

// ============ UTILITY FUNCTIONS ============

function safeParseJSON(text, fallback = {}) {
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('JSON parse error:', error);
    return fallback;
  }
}

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

// ============ SEARCH APIs ============

async function searchWikipedia(query) {
  try {
    return await retryWithBackoff(async () => {
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
      const summaryUrl = `https://vi.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
      const summaryResponse = await axios.get(summaryUrl, {
        timeout: 4000
      });

      const data = summaryResponse.data;
      
      return {
        source: 'Wikipedia',
        confidence: 0.85,
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

async function searchSerper(query) {
  if (!SERPER_API_KEY) {
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
        confidence: 0.9,
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

async function searchTavily(query) {
  if (!TAVILY_API_KEY) {
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
        confidence: 0.8,
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

// ============ IMPROVED SEARCH DETECTION ============

function quickKeywordCheck(message) {
  const lower = message.toLowerCase().trim();
  
  // NEVER search - Casual conversation
  const neverSearch = [
    'chào', 'hello', 'hi', 'xin chào', 'hey',
    'cảm ơn', 'thank', 'thanks', 'cám ơn',
    'tạm biệt', 'bye', 'goodbye', 'bai bai',
    'ok', 'okay', 'được', 'rồi', 'ừ', 'uhm', 'oke',
    'bạn khỏe không', 'khỏe không', 'thế nào',
    'bạn là ai', 'tên bạn', 'bạn tên gì'
  ];
  
  // Check exact match or start/end with these phrases
  for (const kw of neverSearch) {
    if (lower === kw || lower.startsWith(kw + ' ') || lower.endsWith(' ' + kw) || lower.includes(' ' + kw + ' ')) {
      return { shouldSearch: false, confidence: 1.0, reason: 'casual' };
    }
  }
  
  // EXPLICIT search commands - MUST search
  const explicitSearch = [
    'tìm kiếm', 'search', 'tra cứu', 'google',
    'tìm đi', 'tìm lại', 'tìm giúp', 'tra giúp',
    'kiểm tra lại', 'xác minh', 'tra lại'
  ];
  
  for (const kw of explicitSearch) {
    if (lower.includes(kw)) {
      return { shouldSearch: true, confidence: 1.0, reason: 'explicit', type: 'search' };
    }
  }
  
  // Real-time data - MUST search
  const realtime = [
    'giá bitcoin', 'giá vàng', 'giá dầu', 'tỷ giá',
    'thời tiết', 'nhiệt độ',
    'tin tức mới nhất', 'tin tức hôm nay'
  ];
  
  for (const kw of realtime) {
    if (lower.includes(kw)) {
      return { shouldSearch: true, confidence: 1.0, reason: 'realtime', type: 'realtime' };
    }
  }
  
  return null; // Cần thêm phân tích
}

async function shouldSearch(message, groq) {
  searchStats.total++;
  
  // STEP 1: Quick keyword check (fast path)
  const quickCheck = quickKeywordCheck(message);
  if (quickCheck) {
    console.log(`⚡ Quick decision: ${quickCheck.shouldSearch ? 'SEARCH' : 'SKIP'} (${quickCheck.reason})`);
    return quickCheck.shouldSearch ? {
      needsSearch: true,
      confidence: quickCheck.confidence,
      type: quickCheck.type || 'knowledge'
    } : {
      needsSearch: false,
      confidence: 1.0
    };
  }
  
  // STEP 2: Check detection cache
  const cacheKey = message.toLowerCase().trim().substring(0, 100);
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    console.log(`💾 Detection cache hit`);
    return cached;
  }
  
  // STEP 3: Heuristic check (no AI needed)
  const heuristic = analyzeWithHeuristics(message);
  if (heuristic.confidence >= 0.9) {
    console.log(`🎯 Heuristic decision: ${heuristic.needsSearch ? 'SEARCH' : 'SKIP'}`);
    detectionCache.set(cacheKey, heuristic);
    return heuristic;
  }
  
  // STEP 4: AI-powered detection (only for ambiguous cases)
  console.log(`🤖 Using AI detection for: "${message.substring(0, 50)}..."`);
  
  try {
    const prompt = `Phân tích xem câu hỏi sau có CẦN TÌM KIẾM THÔNG TIN TRÊN INTERNET không.

Câu hỏi: "${message}"

CHỈ TÌM KIẾM KHI:
- Cần thông tin thời gian thực (giá cả, thời tiết, tin tức)
- Hỏi về sự kiện/người/địa điểm cụ thể mà AI có thể không biết
- Yêu cầu so sánh/đánh giá sản phẩm/dịch vụ hiện tại

KHÔNG TÌM KIẾM KHI:
- Trò chuyện thông thường, chào hỏi
- Hỏi về kiến thức chung, khái niệm cơ bản
- Yêu cầu lời khuyên, ý kiến cá nhân
- Hỏi về lịch sử, khoa học, văn hóa phổ thông

Trả về JSON:
{
  "needsSearch": true/false,
  "confidence": 0.0-1.0,
  "type": "realtime/knowledge/research/none",
  "reason": "lý do ngắn"
}`;

    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Bạn là chuyên gia phân tích câu hỏi. Chỉ trả về JSON.' },
        { role: 'user', content: prompt }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 150
    });

    const result = response.choices[0]?.message?.content || '{}';
    const analysis = safeParseJSON(result, { 
      needsSearch: false, 
      confidence: 0.3,
      type: 'none'
    });
    
    const decision = {
      needsSearch: analysis.needsSearch || false,
      confidence: analysis.confidence || 0.5,
      type: analysis.type || 'none'
    };
    
    detectionCache.set(cacheKey, decision);
    return decision;
    
  } catch (error) {
    console.error('AI search detection error:', error);
    return analyzeWithHeuristics(message);
  }
}

// Heuristic analysis
function analyzeWithHeuristics(query) {
  const lower = query.toLowerCase();
  const words = query.split(/\s+/).length;
  
  // Câu quá ngắn (< 3 từ) - thường là casual chat
  if (words < 3) {
    return { needsSearch: false, confidence: 0.85 };
  }
  
  // Các mẫu câu hỏi kiến thức
  const knowledgePatterns = [
    /^(.*)(là gì|nghĩa là gì|ý nghĩa|định nghĩa)/,
    /^(giải thích|cho.*biết về|nói về)/,
    /^(tại sao|vì sao|tại vì sao)/,
    /^(như thế nào|thế nào|ra sao)/
  ];
  
  const hasKnowledgePattern = knowledgePatterns.some(p => p.test(lower));
  
  // Câu hỏi kiến thức phổ thông - không cần search
  const commonKnowledge = [
    'python', 'javascript', 'lập trình', 'code', 'coding',
    'toán học', 'vật lý', 'hóa học', 'sinh học',
    'lịch sử', 'địa lý', 'văn học', 'tiếng anh'
  ];
  
  const isCommonTopic = commonKnowledge.some(t => lower.includes(t));
  
  if (hasKnowledgePattern && isCommonTopic) {
    return { needsSearch: false, confidence: 0.9 };
  }
  
  // Các từ khóa chắc chắn cần search
  const mustSearch = [
    'bao nhiêu', 'mấy giờ', 'khi nào',
    'hôm nay', 'hiện tại', 'bây giờ',
    'mới nhất', 'gần đây', 'vừa rồi'
  ];
  
  if (mustSearch.some(kw => lower.includes(kw))) {
    return { needsSearch: true, confidence: 0.9, type: 'realtime' };
  }
  
  // Default: không search
  return { needsSearch: false, confidence: 0.7 };
}

// ============ SMART SEARCH ============

async function smartSearch(query, searchType, groq) {
  const cacheKey = `${query.toLowerCase().trim()}`;
  
  // Check cache
  const cached = searchCache.get(cacheKey);
  if (cached) {
    searchStats.cacheHits++;
    console.log(`✅ Cache hit (${searchStats.cacheHits}/${searchStats.total})`);
    return cached;
  }

  console.log(`🔍 Search type: ${searchType} for: "${query.substring(0, 50)}..."`);

  let result = null;

  try {
    // Strategy 1: Realtime → Serper only
    if (searchType === 'realtime' && SERPER_API_KEY) {
      result = await searchSerper(query);
      if (result) {
        searchStats.sources.serper++;
        searchCache.set(cacheKey, result);
        return result;
      }
    }

    // Strategy 2: Knowledge → Wikipedia + Tavily parallel
    if (searchType === 'knowledge') {
      const searches = [
        searchWikipedia(query),
        TAVILY_API_KEY ? searchTavily(query) : null
      ].filter(Boolean);
      
      const results = await Promise.allSettled(searches);
      result = results.find(r => r.status === 'fulfilled' && r.value)?.value;
      
      if (result) {
        searchStats.sources[result.source.toLowerCase()]++;
        searchCache.set(cacheKey, result);
        return result;
      }
    }

    // Strategy 3: Research → Tavily first
    if (searchType === 'research' && TAVILY_API_KEY) {
      result = await searchTavily(query);
      if (result) {
        searchStats.sources.tavily++;
        searchCache.set(cacheKey, result);
        return result;
      }
    }

    // Fallback: Wikipedia only (free & reliable)
    console.log(`🔄 Fallback to Wikipedia...`);
    result = await searchWikipedia(query);
    
    if (result) {
      searchStats.sources.wikipedia++;
      searchCache.set(cacheKey, result);
      return result;
    }

    searchStats.sources.failed++;
    return null;

  } catch (error) {
    console.error('Search error:', error);
    searchStats.sources.failed++;
    return null;
  }
}

function formatSearchResult(searchData) {
  if (!searchData) return null;

  let formatted = `🔍 Thông tin tìm kiếm (${searchData.source}):\n\n`;

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

// ============ MEMORY FUNCTIONS ============

async function getShortTermMemory(userId, conversationId) {
  const key = `chat:${userId}:${conversationId}`;
  const history = await getData(key);
  
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
    return safeParseJSON(result, {});
  } catch (error) {
    console.error('Error extracting info:', error);
    return {};
  }
}

async function shouldExtractNow(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  const lastExtract = await getData(key);
  
  if (!lastExtract) {
    return conversationHistory.length >= 5;
  }
  
  try {
    const lastExtractData = typeof lastExtract === 'string' ? JSON.parse(lastExtract) : lastExtract;
    const timeSince = Date.now() - lastExtractData.timestamp;
    const messagesSince = conversationHistory.length - lastExtractData.messageCount;
    
    const shouldExtractByTime = timeSince > 300000 && messagesSince >= 3;
    const shouldExtractByCount = messagesSince >= 10;
    
    return shouldExtractByTime || shouldExtractByCount;
  } catch (error) {
    console.error('Error parsing last extract data:', error);
    return conversationHistory.length >= 5;
  }
}

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

  throw new Error('Đã thử hết tất cả API keys');
}

// ============ MAIN HANDLER ============

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

    console.log(`📱 Request from ${userId}: "${message.substring(0, 50)}..."`);

    // 1. Load memory
    let conversationHistory = await getShortTermMemory(userId, finalConversationId);
    const userProfile = await getLongTermMemory(userId);
    let existingSummary = await getSummary(userId, finalConversationId);

    console.log(`💾 Loaded ${conversationHistory.length} messages`);

    // 2. IMPROVED SEARCH DETECTION
    let searchResult = null;
    const tempGroq = new Groq({ apiKey: API_KEYS[0] });
    
    const searchDecision = await shouldSearch(message, tempGroq);
    console.log(`🤔 Search decision: ${searchDecision.needsSearch ? 'YES' : 'NO'} (confidence: ${searchDecision.confidence})`);

    // FIXED: Chỉ search khi confidence cao
    if (searchDecision.needsSearch && searchDecision.confidence >= 0.85) {
      searchResult = await smartSearch(message, searchDecision.type, tempGroq);
      
      if (searchResult) {
        console.log(`✅ Search successful: ${searchResult.source}`);
      } else {
        console.log(`⚠ Search returned no results`);
      }
    } else if (searchDecision.needsSearch && searchDecision.confidence < 0.85) {
      console.log(`⏭ Skipped search - confidence too low (${searchDecision.confidence})`);
    }

    // 3. Add user message to history
    conversationHistory.push({
      role: 'user',
      content: message.trim()
    });

    // 4. Handle summary when exceeding threshold
    let workingMemory = conversationHistory;
    
    if (conversationHistory.length > MEMORY_CONFIG.SUMMARY_THRESHOLD) {
      console.log(`📊 History > ${MEMORY_CONFIG.SUMMARY_THRESHOLD}`);
      
      const oldMessages = conversationHistory.slice(0, -MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      workingMemory = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      
      if (!existingSummary) {
        existingSummary = await summarizeOldMessages(tempGroq, oldMessages);
        await saveSummary(userId, finalConversationId, existingSummary);
        console.log(`✅ Summary created`);
      }
    }

    // 5. Build context
    const currentDate = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const systemPrompt = {
      role: 'system',
      content: `Bạn là Kami, một AI thông minh và thân thiện được tạo ra bởi Nguyễn Đức Thạnh. Hãy trả lời bằng tiếng Việt tự nhiên và không lặp lại cùng một nội dung nhiều lần. Có thể thêm nhiều nhất 4 emoji tùy ngữ cảnh để trò chuyện thêm sinh động.

📅 Ngày hiện tại: ${currentDate}
${Object.keys(userProfile).length > 0 ? `
👤 THÔNG TIN NGƯỜI DÙNG (nhớ lâu dài):
${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}
${existingSummary ? `📝 TÓM TẮT CUỘC TRÒ CHUYỆN TRƯỚC:\n${existingSummary}\n` : ''}
${searchResult ? `\n${formatSearchResult(searchResult)}\n⚠ Hãy ưu tiên sử dụng thông tin tìm kiếm ở trên để trả lời câu hỏi.\n` : ''}`
    };

    const messages = [systemPrompt, ...workingMemory];

    // 6. Call AI
    console.log(`🤖 Calling AI with ${workingMemory.length} messages${searchResult ? ' + search' : ''}...`);
    const { groq, chatCompletion } = await callGroqWithRetry(userId, messages);
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    console.log(`✅ AI responded`);

    // 7. Save response to full conversationHistory
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    // 8. Extract personal info with safe merge
    if (await shouldExtractNow(userId, finalConversationId, conversationHistory)) {
      console.log(`🔍 Extracting personal info (${conversationHistory.length} messages)...`);
      const newInfo = await extractPersonalInfo(groq, conversationHistory);
      
      if (Object.keys(newInfo).length > 0) {
        const updatedProfile = { ...userProfile };
        
        for (const [key, value] of Object.entries(newInfo)) {
          if (value === null || value === undefined || value === 'null' || value === 'undefined') {
            continue;
          }
          
          if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed !== '' && trimmed !== 'không có' && trimmed !== 'chưa có') {
              updatedProfile[key] = trimmed;
            }
          } else {
            updatedProfile[key] = value;
          }
        }
        
        await saveLongTermMemory(userId, updatedProfile);
        await markExtracted(userId, finalConversationId, conversationHistory);
        
        const extractedFields = Object.keys(newInfo).filter(k => {
          const v = newInfo[k];
          return v !== null && v !== undefined && v !== 'null' && v !== 'undefined' && 
                 (typeof v !== 'string' || (v.trim() !== '' && v.trim() !== 'không có'));
        });
        
        if (extractedFields.length > 0) {
          console.log(`✅ Profile updated: ${extractedFields.join(', ')}`);
        }
      } else {
        await markExtracted(userId, finalConversationId, conversationHistory);
        console.log(`ℹ No new personal info found`);
      }
    }

    // Safety check: Extract before expire (< 2 days)
    if (redis) {
      const chatKey = `chat:${userId}:${finalConversationId}`;
      const ttl = await redis.ttl(chatKey);
      const daysRemaining = ttl / 86400;
      
      if (daysRemaining > 0 && daysRemaining < 2 && conversationHistory.length >= 3) {
        console.log(`⚠ Safety extract - TTL < 2 days`);
        const newInfo = await extractPersonalInfo(groq, conversationHistory);
        if (Object.keys(newInfo).length > 0) {
          const updatedProfile = { ...userProfile };
          
          for (const [key, value] of Object.entries(newInfo)) {
            if (value === null || value === undefined || value === 'null' || value === 'undefined') {
              continue;
            }
            
            if (typeof value === 'string') {
              const trimmed = value.trim();
              if (trimmed !== '' && trimmed !== 'không có' && trimmed !== 'chưa có') {
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

    // 9. Response with stats
    const lastExtractData = await getData(`last_extract:${userId}:${finalConversationId}`);
    
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
    
    // Log search stats periodically
    if (searchStats.total % 10 === 0) {
      console.log(`📊 Search Stats:`, {
        total: searchStats.total,
        cacheHitRate: `${Math.round(searchStats.cacheHits / searchStats.total * 100)}%`,
        sources: searchStats.sources
      });
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
        searchStats: {
          total: searchStats.total,
          cacheHits: searchStats.cacheHits,
          cacheHitRate: searchStats.total > 0 
            ? Math.round(searchStats.cacheHits / searchStats.total * 100) 
            : 0,
          sources: searchStats.sources
        },
        lastExtract: parsedExtractData
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
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
