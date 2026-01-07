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

// Simple thread-safe cache implementation
class SimpleCache {
  constructor(ttl = 600000, maxSize = 100) {
    this.cache = new Map();
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
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

// Config
const SEARCH_CONFIG = {
  CACHE_TTL_MINUTES: 30,
  DETECTION_CACHE_TTL_MINUTES: 60
};

const searchCache = new SimpleCache(SEARCH_CONFIG.CACHE_TTL_MINUTES * 60000, 100);
const detectionCache = new SimpleCache(SEARCH_CONFIG.DETECTION_CACHE_TTL_MINUTES * 60000, 200);
const responseCache = new SimpleCache(5 * 60000, 50);

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

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MEMORY_CONFIG = {
  SHORT_TERM_DAYS: 14,
  WORKING_MEMORY_LIMIT: 20,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40
};

// ✅ FIXED: Detection patterns - Tighter rules
const DETECTION_PATTERNS = {
  // Chỉ skip những greeting thực sự đơn giản
  never: /^(chào|hello|hi|xin chào|hey|ok|okay|được|rồi|ừ|uhm|à|ừm)$/i,
  
  // Explicit search - mở rộng thêm
  explicit: /(tìm kiếm|search|tra cứu|google|tìm đi|tìm lại|tìm giúp|tra giúp|cho tôi biết|hãy tìm)/i,
  
  // Real-time data - cần search ngay
  realtime: /(giá bitcoin|giá vàng|giá dầu|giá cổ phiếu|tỷ giá|thời tiết|nhiệt độ|tin tức mới nhất|tin tức hôm nay|breaking news)/i,
  
  // Current state - người, vị trí, sự kiện hiện tại
  current: /(hiện nay|hiện tại|bây giờ|hôm nay|năm nay|năm \d{4}|mới nhất|gần đây|vừa rồi|đang|ai là|là ai|tổng thống|thủ tướng|ceo|giám đốc)/i,
  
  // Facts that need verification
  factual: /(khi nào|bao giờ|năm nào|ngày nào|ở đâu|tại đâu|bao nhiêu|có bao nhiêu|cao bao nhiêu|dài bao nhiêu|diện tích)/i,
  
  // Advice - AI CÓ THỂ trả lời
  advice: /^(nên|có nên|tôi nên|làm sao|làm thế nào để|bạn nghĩ|theo bạn|ý kiến|gợi ý)/i
};

// ✅ OPTIMIZATION #5: Conditional stats (only in dev)
const IS_DEV = process.env.NODE_ENV === 'development';
const stats = IS_DEV ? {
  search: { total: 0, cacheHits: 0 },
  perf: { responseCacheHits: 0, totalRequests: 0, avgResponseTime: 0 }
} : null;

// ✅ OPTIMIZATION #3: Normalize for better cache hit rate
function normalizeForCache(message) {
  return message
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 100);
}

// === STORAGE HELPERS ===

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

// === UTILITY FUNCTIONS ===

function safeParseJSON(text, fallback = {}) {
  try {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/```json\n?/g, '');
    cleaned = cleaned.replace(/```\n?/g, '');
    
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('JSON parse error:', error.message);
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

// === SEARCH APIs ===

// ✅ OPTIMIZATION #2: Generic search wrapper
async function searchWithRetry(searchFn, name) {
  try {
    return await retryWithBackoff(searchFn);
  } catch (error) {
    console.error(`${name} error:`, error.message);
    return null;
  }
}

const searchWikipedia = (query) => searchWithRetry(async () => {
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
  if (!titles || titles.length === 0) return null;

  const pageTitle = titles[0];
  const summaryUrl = `https://vi.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
  const summaryResponse = await axios.get(summaryUrl, { timeout: 4000 });
  const data = summaryResponse.data;
  
  return {
    source: 'Wikipedia',
    title: data.title,
    content: data.extract,
    url: data.content_urls.desktop.page
  };
}, 'Wikipedia');

// ✅ NEW: English Wikipedia fallback
const searchWikipediaEN = (query) => searchWithRetry(async () => {
  const searchUrl = 'https://en.wikipedia.org/w/api.php';
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
  if (!titles || titles.length === 0) return null;

  const pageTitle = titles[0];
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
  const summaryResponse = await axios.get(summaryUrl, { timeout: 4000 });
  const data = summaryResponse.data;
  
  return {
    source: 'Wikipedia (EN)',
    title: data.title,
    content: data.extract,
    url: data.content_urls.desktop.page
  };
}, 'Wikipedia EN');

// ✅ FIXED: Improved Serper with better formatting
const searchSerper = (query) => {
  if (!SERPER_API_KEY) return null;
  return searchWithRetry(async () => {
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
      timeout: 5000
    });

    const organic = response.data.organic || [];
    const knowledgeGraph = response.data.knowledgeGraph;
    const answerBox = response.data.answerBox;

    // Priority 1: Answer box
    if (answerBox?.answer || answerBox?.snippet) {
      return {
        source: 'Serper',
        answer: answerBox.answer || answerBox.snippet,
        title: answerBox.title,
        results: organic.slice(0, 3).map(r => ({
          title: r.title,
          content: r.snippet,
          url: r.link
        }))
      };
    }

    // Priority 2: Knowledge graph
    if (knowledgeGraph) {
      return {
        source: 'Serper',
        title: knowledgeGraph.title,
        content: knowledgeGraph.description,
        attributes: knowledgeGraph.attributes,
        results: organic.slice(0, 3).map(r => ({
          title: r.title,
          content: r.snippet,
          url: r.link
        }))
      };
    }

    // Priority 3: Organic results
    if (organic.length > 0) {
      return {
        source: 'Serper',
        results: organic.slice(0, 5).map(r => ({
          title: r.title,
          content: r.snippet,
          url: r.link
        }))
      };
    }

    return null;
  }, 'Serper');
};

const searchTavily = (query) => {
  if (!TAVILY_API_KEY) return null;
  return searchWithRetry(async () => {
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
      content: data.answer,
      results: data.results?.map(r => ({
        title: r.title,
        content: r.content,
        url: r.url
      }))
    };
  }, 'Tavily');
};

// === SEARCH DETECTION ===
// ✅ FIXED: Smarter detection
function quickDetect(message) {
  const lower = message.toLowerCase().trim();
  const length = lower.length;
  
  // 1. Never search - chỉ với greeting thực sự ngắn
  if (length < 15 && DETECTION_PATTERNS.never.test(lower)) {
    return { needsSearch: false, confidence: 1.0, reason: 'greeting' };
  }
  
  // 2. Explicit search - luôn search
  if (DETECTION_PATTERNS.explicit.test(lower)) {
    return { needsSearch: true, confidence: 1.0, type: 'search' };
  }
  
  // 3. Real-time data - PHẢI search
  if (DETECTION_PATTERNS.realtime.test(lower)) {
    return { needsSearch: true, confidence: 1.0, type: 'realtime' };
  }
  
  // 4. Current events/people - PHẢI search
  if (DETECTION_PATTERNS.current.test(lower)) {
    return { needsSearch: true, confidence: 0.95, type: 'knowledge' };
  }
  
  // 5. Factual questions - NÊN search
  if (DETECTION_PATTERNS.factual.test(lower)) {
    return { needsSearch: true, confidence: 0.9, type: 'knowledge' };
  }
  
  // 6. Proper nouns (tên riêng) - có thể cần search
  if (/[A-Z][a-z]+/.test(message)) {
    return { needsSearch: true, confidence: 0.8, type: 'knowledge' };
  }
  
  // 7. Questions (có dấu hỏi) - xu hướng search
  if (lower.includes('?')) {
    return { needsSearch: true, confidence: 0.7, type: 'knowledge' };
  }
  
  // 8. Advice - AI trả lời được
  if (DETECTION_PATTERNS.advice.test(lower)) {
    return { needsSearch: false, confidence: 0.9, reason: 'advice' };
  }
  
  // 9. Default: câu dài thì nên search
  if (length > 30) {
    return { needsSearch: true, confidence: 0.6, type: 'knowledge' };
  }
  
  // 10. Uncertain
  return { needsSearch: false, confidence: 0.5 };
}

// ✅ OPTIMIZATION #7: Simplified shouldSearch (120 lines → 40 lines)
async function shouldSearch(message, groq) {
  if (IS_DEV) stats.search.total++;
  
  const cacheKey = normalizeForCache(message);
  
  // Layer 1: Cache
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    if (IS_DEV) stats.search.cacheHits++;
    console.log(`💾 Detection cache hit`);
    return cached;
  }
  
  // Layer 2: Quick detect
  const decision = quickDetect(message);
  
  // High confidence → cache & return
  if (decision.confidence >= 0.8) {
    detectionCache.set(cacheKey, decision);
    console.log(`⚡ Quick decision: ${decision.needsSearch ? 'SEARCH' : 'SKIP'} (${decision.confidence})`);
    return decision;
  }
  
  // Low confidence → AI detection
  console.log(`🤖 Using AI detection`);
  try {
    const response = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: 'Return JSON only: {needsSearch: boolean, type: string}' 
        },
        { 
          role: 'user', 
          content: `Need internet search? "${message}"` 
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      max_tokens: 50,
      response_format: { type: "json_object" }
    });
    
    const result = safeParseJSON(response.choices[0]?.message?.content || '{}');
    const aiDecision = {
      needsSearch: result.needsSearch || false,
      confidence: 0.9,
      type: result.type || 'knowledge'
    };
    
    detectionCache.set(cacheKey, aiDecision);
    return aiDecision;
  } catch (error) {
    console.error('AI detection error:', error);
    detectionCache.set(cacheKey, decision);
    return decision;
  }
}

// === SMART SEARCH ===
// ✅ FIXED: Smarter search với fallback chain
async function smartSearch(query, searchType) {
  const cacheKey = normalizeForCache(query);
  
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`✅ Search cache hit`);
    return cached;
  }

  console.log(`🔍 Search type: ${searchType}, Query: "${query}"`);

  let result = null;
  const searches = [];

  // Strategy 1: Real-time data → Serper first
  if (searchType === 'realtime') {
    if (SERPER_API_KEY) {
      console.log(`🔥 Trying Serper (realtime)...`);
      result = await searchSerper(query);
      if (result) {
        searchCache.set(cacheKey, result);
        return result;
      }
    }
    
    // Fallback: Tavily
    if (TAVILY_API_KEY) {
      console.log(`🔄 Fallback to Tavily...`);
      result = await searchTavily(query);
      if (result) {
        searchCache.set(cacheKey, result);
        return result;
      }
    }
  }

  // Strategy 2: Knowledge questions → Try all sources
  if (searchType === 'knowledge' || searchType === 'search') {
    // Parallel search: Wikipedia + Tavily + Serper
    if (TAVILY_API_KEY) searches.push(searchTavily(query));
    if (SERPER_API_KEY) searches.push(searchSerper(query));
    searches.push(searchWikipedia(query));
    
    console.log(`🔍 Trying ${searches.length} sources in parallel...`);
    
    const results = await Promise.allSettled(searches);
    
    // Pick first successful result
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        result = r.value;
        console.log(`✅ Got result from ${result.source}`);
        searchCache.set(cacheKey, result);
        return result;
      }
    }
  }

  // Strategy 3: Final fallback - Try English Wikipedia
  if (!result) {
    console.log(`🌍 Trying English Wikipedia...`);
    result = await searchWikipediaEN(query);
    if (result) {
      searchCache.set(cacheKey, result);
      return result;
    }
  }

  console.log(`❌ All search sources failed`);
  return null;
}

// === MEMORY FUNCTIONS ===

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
  "nickname": "tên thường gọi",
  "family": "thông tin gia đình",
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

// ✅ OPTIMIZATION #4: Shared merge function (eliminates 60 lines of duplication)
function mergeProfile(currentProfile, newInfo) {
  const updated = { ...currentProfile };
  
  for (const [key, value] of Object.entries(newInfo)) {
    if (!value || value === 'null' || value === 'undefined') continue;
    
    const val = typeof value === 'string' ? value.trim() : value;
    if (val && val !== 'không có' && val !== 'chưa có') {
      updated[key] = val;
    }
  }
  
  return updated;
}

// === API KEY MANAGEMENT ===

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

async function callTempGroqWithRetry(userId, fn) {
  let currentKeyIndex = await getUserKeyIndex(userId);
  let attempts = 0;
  const maxAttempts = API_KEYS.length;

  while (attempts < maxAttempts) {
    try {
      const apiKey = API_KEYS[currentKeyIndex];
      const groq = new Groq({ apiKey });

      const result = await fn(groq);
      
      await setUserKeyIndex(userId, currentKeyIndex);
      return result;

    } catch (error) {
      const isQuotaError = 
        error.message?.includes('quota') || 
        error.message?.includes('rate limit') ||
        error.message?.includes('Rate limit') ||
        error.status === 429 ||
        error.status === 403;

      if (isQuotaError && attempts < maxAttempts - 1) {
        console.log(`tempGroq key ${currentKeyIndex + 1} hết quota, chuyển key...`);
        currentKeyIndex = getNextKeyIndex(currentKeyIndex);
        attempts++;
        continue;
      }

      throw error;
    }
  }

  throw new Error('Đã thử hết tất cả API keys cho tempGroq');
}

// === MAIN HANDLER ===

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

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

    // ✅ XỬ LÝ COMMANDS
    if (message === '/history') {
      const conversationHistory = await getShortTermMemory(userId, finalConversationId);
      
      if (conversationHistory.length === 0) {
        return res.status(200).json({
          success: true,
          message: "📭 Chưa có lịch sử chat nào.",
          userId: userId,
          conversationId: finalConversationId
        });
      }

      let historyText = "🕘 LỊCH SỬ CHAT\n\n";
      const recentMessages = conversationHistory.slice(-30);
      
      recentMessages.forEach((msg) => {
        if (msg.role === 'user') {
          historyText += `👤 Bạn: ${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
          historyText += `🤖 Kami: ${msg.content}\n\n`;
        }
      });

      historyText += `\n📊 Tổng cộng: 30 tin cuối/${conversationHistory.length} tin nhắn`;

      return res.status(200).json({
        success: true,
        message: historyText,
        userId: userId,
        conversationId: finalConversationId
      });
    }

    if (message === '/memory') {
      const userProfile = await getLongTermMemory(userId);
      const summary = await getSummary(userId, finalConversationId);

      let memoryText = "🧠 BỘ NHỚ AI\n\n";

      if (Object.keys(userProfile).length === 0) {
        memoryText += "📭 Chưa có thông tin cá nhân nào được lưu.\n\n";
      } else {
        memoryText += "👤 THÔNG TIN CÁ NHÂN:\n";
        for (const [key, value] of Object.entries(userProfile)) {
          const displayKey = key.charAt(0).toUpperCase() + key.slice(1);
          memoryText += `▪️ ${displayKey}: ${value}\n`;
        }
        memoryText += "\n";
      }

      if (summary) {
        memoryText += "📝 TÓM TẮT HỘI THOẠI:\n";
        memoryText += summary;
      }

      return res.status(200).json({
        success: true,
        message: memoryText,
        userId: userId,
        conversationId: finalConversationId
      });
    }

    if (API_KEYS.length === 0) {
      return res.status(500).json({ 
        success: false,
        error: 'No API keys configured' 
      });
    }

    console.log(`📱 Request from ${userId}: "${message.substring(0, 50)}..."`);

    if (IS_DEV) stats.perf.totalRequests++;

    // Check response cache FIRST
    const responseCacheKey = `resp:${userId}:${normalizeForCache(message)}`;
    const cachedResponse = responseCache.get(responseCacheKey);
    
    if (cachedResponse) {
      if (IS_DEV) stats.perf.responseCacheHits++;
      console.log(`💾 Response cache hit`);
      
      const conversationHistory = await getShortTermMemory(userId, finalConversationId);
      
      conversationHistory.push(
        { role: 'user', content: message.trim() },
        { role: 'assistant', content: cachedResponse }
      );
      
      await saveShortTermMemory(userId, finalConversationId, conversationHistory);
      
      const responseTime = Date.now() - startTime;
      
      return res.status(200).json({
        success: true,
        message: cachedResponse,
        userId: userId,
        conversationId: finalConversationId,
        cached: true,
        responseTime: responseTime
      });
    }

    // Load memory in parallel
    const [conversationHistory, userProfile] = await Promise.all([
      getShortTermMemory(userId, finalConversationId),
      getLongTermMemory(userId)
    ]);

    console.log(`💾 Loaded ${conversationHistory.length} messages`);

    // Search detection with quick detect
    let searchResult = null;
    const searchCacheKey = normalizeForCache(message);
    const cachedDecision = detectionCache.get(searchCacheKey);
    
    let searchDecision = null;
    
    if (cachedDecision) {
      searchDecision = cachedDecision;
      console.log(`💾 Using cached search decision`);
    } else {
      searchDecision = quickDetect(message);
      console.log(`🎯 Detection: ${searchDecision.needsSearch ? 'SEARCH' : 'SKIP'} (${searchDecision.confidence}) - ${searchDecision.type || searchDecision.reason}`);
      
      if (searchDecision.confidence >= 0.8) {
        detectionCache.set(searchCacheKey, searchDecision);
      }
    }
    
    if (searchDecision.needsSearch) {
      searchResult = await smartSearch(message, searchDecision.type);
      
      if (searchResult) {
        console.log(`✅ Search result from ${searchResult.source}:`, {
          hasAnswer: !!searchResult.answer,
          hasContent: !!searchResult.content,
          resultsCount: searchResult.results?.length || 0
        });
      }
    }

    // Background: AI detection for low confidence cases
    if (!cachedDecision && searchDecision.confidence < 0.8) {
      callTempGroqWithRetry(userId, async (groq) => {
        const aiDecision = await shouldSearch(message, groq);
        detectionCache.set(searchCacheKey, aiDecision);
        
        if (aiDecision.needsSearch && !searchResult) {
          await smartSearch(message, aiDecision.type);
        }
        
        return aiDecision;
      }).catch(err => console.error('Background detection error:', err));
    }

    // Add user message
    conversationHistory.push({
      role: 'user',
      content: message.trim()
    });

    // Handle summary (lazy load)
    let workingMemory = conversationHistory;
    let existingSummary = null;
    
    if (conversationHistory.length > MEMORY_CONFIG.SUMMARY_THRESHOLD) {
      existingSummary = await getSummary(userId, finalConversationId);
      
      const oldMessages = conversationHistory.slice(0, -MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      workingMemory = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      
      if (!existingSummary) {
        console.log(`📝 Background summarizing...`);
        
        callTempGroqWithRetry(userId, async (groq) => {
          const summary = await summarizeOldMessages(groq, oldMessages);
          await saveSummary(userId, finalConversationId, summary);
          return summary;
        })
          .then(() => console.log(`✅ Summary created`))
          .catch(err => console.error('Background summary error:', err));
      }
    }

    // Build context
    const currentDate = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const systemPrompt = {
      role: 'system',
      content: `Bạn là Kami, một AI thông minh được tạo ra bởi Nguyễn Đức Thạnh. 
📅 Ngày hiện tại: ${currentDate}

${Object.keys(userProfile).length > 0 ? `👤 THÔNG TIN NGƯỜI DÙNG:
${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}

${existingSummary ? `📝 TÓM TẮT TRƯỚC:\n${existingSummary}\n` : ''}

${searchResult ? `🔍 KẾT QUẢ TÌM KIẾM MỚI NHẤT:
Nguồn: ${searchResult.source}
${searchResult.answer ? `Câu trả lời trực tiếp: ${searchResult.answer}\n` : ''}
${searchResult.title ? `Tiêu đề: ${searchResult.title}\n` : ''}
${searchResult.content ? `Nội dung: ${searchResult.content}\n` : ''}
${searchResult.attributes ? `Thông tin: ${JSON.stringify(searchResult.attributes)}\n` : ''}
${searchResult.results ? `Chi tiết:\n${searchResult.results.map((r, i) => `${i+1}. ${r.title}\n   ${r.content}\n   ${r.url}`).join('\n\n')}` : ''}

⚠️ QUAN TRỌNG: 
- Sử dụng thông tin tìm kiếm ở trên để trả lời
- Nếu thông tin tìm kiếm liên quan trực tiếp đến câu hỏi, ưu tiên dùng nó
- Trích dẫn nguồn khi cần: "Theo ${searchResult.source}..."
- Nếu thông tin không đủ, hãy nói thẳng
` : ''}

Hãy trả lời chính xác, tự nhiên bằng tiếng Việt. Có thể dùng 1-3 emoji phù hợp.`
    };

    const messages = [systemPrompt, ...workingMemory];

    // Call main AI
    console.log(`🤖 Calling AI with ${workingMemory.length} messages...`);
    const { groq, chatCompletion } = await callGroqWithRetry(userId, messages);
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    console.log(`✅ AI responded`);

    // Save response
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    // Cache response
    responseCache.set(responseCacheKey, assistantMessage);

    // Background: Extract personal info
    if (await shouldExtractNow(userId, finalConversationId, conversationHistory)) {
      console.log(`🔍 Background extracting...`);
      
      callTempGroqWithRetry(userId, async (groq) => {
        const newInfo = await extractPersonalInfo(groq, conversationHistory);
        
        if (Object.keys(newInfo).length > 0) {
          const updatedProfile = mergeProfile(userProfile, newInfo);
          await saveLongTermMemory(userId, updatedProfile);
          await markExtracted(userId, finalConversationId, conversationHistory);
          console.log(`✅ Profile updated`);
        } else {
          await markExtracted(userId, finalConversationId, conversationHistory);
        }
        
        return newInfo;
      })
        .catch(err => console.error('Background extract error:', err));
    }

    // Safety extract before TTL expires
    if (redis) {
      const chatKey = `chat:${userId}:${finalConversationId}`;
      const ttl = await redis.ttl(chatKey);
      const daysRemaining = ttl / 86400;
      
      if (daysRemaining > 0 && daysRemaining < 2 && conversationHistory.length >= 3) {
        console.log(`⚠ Safety extract...`);
        
        callTempGroqWithRetry(userId, async (groq) => {
          const newInfo = await extractPersonalInfo(groq, conversationHistory);
          
          if (Object.keys(newInfo).length > 0) {
            const updatedProfile = mergeProfile(userProfile, newInfo);
            await saveLongTermMemory(userId, updatedProfile);
            console.log(`✅ Safety profile saved`);
          }
          
          return newInfo;
        })
          .catch(err => console.error('Background safety extract error:', err));
      }
    }

    // Response
    const responseTime = Date.now() - startTime;
    
    if (IS_DEV) {
      stats.perf.avgResponseTime = 
        (stats.perf.avgResponseTime * (stats.perf.totalRequests - 1) + responseTime) / stats.perf.totalRequests;
      
      if (stats.perf.totalRequests % 10 === 0) {
        console.log(`📊 Stats:`, {
          totalRequests: stats.perf.totalRequests,
          responseCacheHitRate: `${Math.round(stats.perf.responseCacheHits / stats.perf.totalRequests * 100)}%`,
          avgResponseTime: `${Math.round(stats.perf.avgResponseTime)}ms`,
          searchCacheHitRate: stats.search.total > 0 
            ? `${Math.round(stats.search.cacheHits / stats.search.total * 100)}%` 
            : 'N/A'
        });
      }
    }
    
    console.log(`⚡ Response time: ${responseTime}ms`);
    
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId: userId,
      conversationId: finalConversationId,
      responseTime: responseTime,
      stats: {
        totalMessages: conversationHistory.length,
        workingMemorySize: workingMemory.length,
        hasSummary: !!existingSummary,
        userProfileFields: Object.keys(userProfile).length,
        storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory',
        searchUsed: !!searchResult,
        searchSource: searchResult?.source || null,
        cached: false
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      errorType: error.name || 'Unknown',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
