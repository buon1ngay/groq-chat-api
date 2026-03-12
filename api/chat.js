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

// 🧹 Cleanup memoryStore định kỳ để tránh memory leak
setInterval(() => {
  if (!REDIS_ENABLED && memoryStore.size > 1000) {
    const entries = [...memoryStore.entries()];
    memoryStore.clear();
    entries.slice(-500).forEach(([k, v]) => memoryStore.set(k, v));
    console.log('🧹 Cleaned memoryStore');
  }
}, 3600000); // 1 giờ

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
  SHORT_TERM_DAYS: 30,
  WORKING_MEMORY_LIMIT: 30,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40,
  MAX_SUMMARIES: 30,
  MAX_MESSAGES: 1000,
  SUMMARY_CONTEXT_LIMIT: 15
};

const DETECTION_PATTERNS = {
  never: /^(chào|hello|hi|xin chào|hey|cảm ơn|thank|thanks|tạm biệt|bye|goodbye|ok|okay|được|rồi|ừ|uhm)$/i,
  explicit: /(tìm kiếm|search|tra cứu|google|tìm đi|tìm lại|tìm giúp|tra giúp)/i,
  realtime: /(giá|giá bitcoin|giá vàng|giá dầu|tỷ giá|thời tiết|nhiệt độ|tin tức mới nhất|tin tức hôm nay)/i,
  current: /(hiện nay|hiện tại|bây giờ|hôm nay|năm nay|mới nhất|gần đây|vừa rồi|đang|ai là|là ai)/i,
  concept: /^.*(là gì|nghĩa là gì|định nghĩa|ý nghĩa|giải thích|cho.*biết về|nói về)/i,
  advice: /^(nên|có nên|tôi nên|làm sao|làm thế nào|bạn nghĩ|theo bạn|ý kiến)/i
};

const IS_DEV = process.env.NODE_ENV === 'development';
const stats = IS_DEV ? {
  search: { total: 0, cacheHits: 0 },
  perf: { responseCacheHits: 0, totalRequests: 0, avgResponseTime: 0 }
} : null;

function normalizeForCache(message) {
  return message
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 100);
}

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

async function searchWithRetry(searchFn, name) {
  try {
    return await retryWithBackoff(searchFn);
  } catch (error) {
    console.error(`${name} error:`, error.message);
    return null;
  }
}

// 🔥 THAY WIKIPEDIA bằng DUCKDUCKGO (FREE, không cần API key)
const searchDuckDuckGo = (query) => searchWithRetry(async () => {
  const response = await axios.get('https://api.duckduckgo.com/', {
    params: {
      q: query,
      format: 'json',
      no_html: 1,
      skip_disambig: 1
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Kami/1.0)'
    },
    timeout: 5000
  });

  const data = response.data;
  
  // DuckDuckGo trả về Abstract hoặc RelatedTopics
  if (data.Abstract) {
    return {
      source: 'DuckDuckGo',
      title: data.Heading || query,
      content: data.Abstract,
      url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
    };
  }
  
  // Nếu không có Abstract, lấy từ RelatedTopics
  if (data.RelatedTopics && data.RelatedTopics.length > 0) {
    const firstTopic = data.RelatedTopics[0];
    if (firstTopic.Text) {
      return {
        source: 'DuckDuckGo',
        title: firstTopic.Text.split(' - ')[0] || query,
        content: firstTopic.Text,
        url: firstTopic.FirstURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
      };
    }
  }
  
  return null;
}, 'DuckDuckGo');

const searchSerper = (query) => {
  if (!SERPER_API_KEY) return null;
  
  return searchWithRetry(async () => {
    const response = await axios.post('https://google.serper.dev/search', {
      q: query,
      gl: 'vn',
      hl: 'vi',
      num: 3
    }, {
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    const results = response.data.organic || [];
    if (results.length === 0) return null;

    return {
      source: 'Serper',
      results: results.map(r => ({
        title: r.title,
        content: r.snippet,
        url: r.link
      }))
    };
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
      timeout: 5000
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

function quickDetect(message) {
  const lower = message.toLowerCase().trim();
  
  if (DETECTION_PATTERNS.never.test(lower)) {
    return { needsSearch: false, confidence: 1.0, reason: 'casual' };
  }
  
  if (DETECTION_PATTERNS.explicit.test(lower)) {
    return { needsSearch: true, confidence: 1.0, type: 'search' };
  }
  
  if (DETECTION_PATTERNS.realtime.test(lower)) {
    return { needsSearch: true, confidence: 1.0, type: 'realtime' };
  }
  
  if (DETECTION_PATTERNS.current.test(lower)) {
    return { needsSearch: true, confidence: 0.9, type: 'knowledge' };
  }
  
  if (DETECTION_PATTERNS.concept.test(lower)) {
    const commonTopics = /(python|javascript|lập trình|code|toán|vật lý|hóa|sinh|văn|nghệ thuật)/i;
    if (commonTopics.test(lower)) {
      return { needsSearch: false, confidence: 0.9 };
    }
  }
  
  if (DETECTION_PATTERNS.advice.test(lower)) {
    return { needsSearch: false, confidence: 0.85 };
  }
  
  return { needsSearch: false, confidence: 0.5 };
}

async function shouldSearch(message, groq) {
  if (IS_DEV) stats.search.total++;
  
  const cacheKey = normalizeForCache(message);
  const cached = detectionCache.get(cacheKey);
  
  if (cached) {
    if (IS_DEV) stats.search.cacheHits++;
    console.log(`💾 Detection cache hit`);
    return cached;
  }

  const decision = quickDetect(message);
  
  if (decision.confidence >= 0.8) {
    detectionCache.set(cacheKey, decision);
    console.log(`⚡ Quick decision: ${decision.needsSearch ? 'SEARCH' : 'SKIP'} (${decision.confidence})`);
    return decision;
  }

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

async function smartSearch(query, searchType) {
  const cacheKey = normalizeForCache(query);
  const cached = searchCache.get(cacheKey);
  
  if (cached) {
    console.log(`✅ Search cache hit`);
    return cached;
  }

  console.log(`🔍 Search type: ${searchType}`);
  let result = null;

  // 🔥 Thử DuckDuckGo trước (FREE, không giới hạn)
  console.log(`🔍 Trying DuckDuckGo...`);
  result = await searchDuckDuckGo(query);
  if (result) {
    console.log(`✅ DuckDuckGo success`);
    searchCache.set(cacheKey, result);
    return result;
  }
  console.log(`❌ DuckDuckGo failed`);

  // Thử Serper nếu có API key
  if (SERPER_API_KEY) {
    console.log(`🔍 Trying Serper...`);
    result = await searchSerper(query);
    if (result) {
      console.log(`✅ Serper success`);
      searchCache.set(cacheKey, result);
      return result;
    }
    console.log(`❌ Serper failed`);
  }

  // Thử Tavily nếu có API key
  if (TAVILY_API_KEY) {
    console.log(`🔍 Trying Tavily...`);
    result = await searchTavily(query);
    if (result) {
      console.log(`✅ Tavily success`);
      searchCache.set(cacheKey, result);
      return result;
    }
    console.log(`❌ Tavily failed`);
  }

  console.log(`❌ All search sources failed`);
  return null;
}

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

async function getSummaries(userId, conversationId) {
  const key = `summaries:${userId}:${conversationId}`;
  const data = await getData(key);
  
  if (!data) return [];
  
  try {
    const summaries = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(summaries) ? summaries : [];
  } catch (error) {
    console.error('Failed to parse summaries:', error);
    return [];
  }
}

async function saveSummaries(userId, conversationId, summaries) {
  const key = `summaries:${userId}:${conversationId}`;
  await setData(key, JSON.stringify(summaries), MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

async function createNewSummary(groq, messages, summaryNumber) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Hãy tóm tắt 40 tin nhắn sau thành 3-4 câu ngắn gọn, giữ lại thông tin quan trọng, sự kiện chính và맥 lạc cuộc trò chuyện.'
        },
        {
          role: 'user',
          content: `Tóm tắt phần ${summaryNumber}:\n${JSON.stringify(messages)}`
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.3,
      max_tokens: 400
    });
    
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Error creating summary:', error);
    return `[Summary ${summaryNumber}] Cuộc trò chuyện tiếp diễn...`;
  }
}

async function summarizeOldMessages(groq, oldMessages) {
  return await createNewSummary(groq, oldMessages, 1);
}

async function manageMemory(userId, conversationId, conversationHistory, groq) {
  const totalMessages = conversationHistory.length;
  
  if (totalMessages > MEMORY_CONFIG.MAX_MESSAGES) {
    const messagesToRemove = totalMessages - MEMORY_CONFIG.MAX_MESSAGES;
    conversationHistory.splice(0, messagesToRemove);
    console.log(`🗑 Removed ${messagesToRemove} old messages, keeping ${MEMORY_CONFIG.MAX_MESSAGES}`);
  }

  const summaries = await getSummaries(userId, conversationId);
  const messagesProcessed = summaries.length * MEMORY_CONFIG.SUMMARY_THRESHOLD;
  const unprocessedMessages = totalMessages - messagesProcessed;
  
  if (unprocessedMessages >= MEMORY_CONFIG.SUMMARY_THRESHOLD) {
    const startIdx = messagesProcessed;
    const endIdx = startIdx + MEMORY_CONFIG.SUMMARY_THRESHOLD;
    const messagesToSummarize = conversationHistory.slice(startIdx, endIdx);
    
    const summaryNumber = summaries.length + 1;
    console.log(`📝 Creating summary ${summaryNumber} from messages ${startIdx}-${endIdx}...`);
    
    const newSummary = await createNewSummary(groq, messagesToSummarize, summaryNumber);
    
    summaries.push({
      number: summaryNumber,
      content: newSummary,
      messageRange: `${startIdx + 1}-${endIdx}`,
      createdAt: new Date().toISOString()
    });
    
    if (summaries.length > MEMORY_CONFIG.MAX_SUMMARIES) {
      const removed = summaries.shift();
      console.log(`🗑 Removed oldest summary #${removed.number}, keeping ${MEMORY_CONFIG.MAX_SUMMARIES}`);
    }
    
    await saveSummaries(userId, conversationId, summaries);
    console.log(`✅ Summary ${summaryNumber} created. Total summaries: ${summaries.length}`);
  }
  
  return summaries;
}

function buildContext(conversationHistory, summaries) {
  const recentMessages = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
  const recentSummaries = summaries.slice(-MEMORY_CONFIG.SUMMARY_CONTEXT_LIMIT);
  
  return {
    recentMessages,
    recentSummaries,
    contextInfo: {
      totalMessages: conversationHistory.length,
      totalSummaries: summaries.length,
      messagesInContext: recentMessages.length,
      summariesInContext: recentSummaries.length
    }
  };
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

// 🔥 CẬP NHẬT: Hỗ trợ Vision với Llama 4 Scout
async function callGroqWithRetry(userId, messages, hasImage = false) {
  let currentKeyIndex = await getUserKeyIndex(userId);
  let attempts = 0;
  const maxAttempts = API_KEYS.length;

  // ✅ Chọn model dựa trên có ảnh hay không
  const modelToUse = hasImage 
    ? 'meta-llama/llama-4-scout-17b-16e-instruct' 
    : 'llama-3.3-70b-versatile';

  while (attempts < maxAttempts) {
    try {
      const apiKey = API_KEYS[currentKeyIndex];
      const groq = new Groq({ apiKey });

      const chatCompletion = await groq.chat.completions.create({
        messages,
        model: modelToUse,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    // 🔥 THÊM HỖ TRỢ IMAGE
    const { message, userId, conversationId, image = null, imageUrl = null } = req.body;

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

    // 🔥 XỬ LÝ ẢNH: Download từ URL nếu có
    let imageBase64 = image;
    if (imageUrl && !image) {
      try {
        console.log(`🖼️ Downloading image from: ${imageUrl}`);
        const imageResponse = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          maxContentLength: 10 * 1024 * 1024 // Max 10MB
        });
        
        const buffer = Buffer.from(imageResponse.data);
        imageBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        console.log(`✅ Image downloaded successfully`);
      } catch (e) {
        console.error('❌ Failed to download image:', e.message);
        return res.status(400).json({ 
          success: false,
          error: 'Không thể tải ảnh từ URL: ' + e.message 
        });
      }
    }

    // Validate image size
    if (imageBase64) {
      const base64Length = imageBase64.length;
      const sizeInMB = (base64Length * 0.75) / (1024 * 1024); // Base64 to bytes
      
      if (sizeInMB > 4) {
        return res.status(400).json({
          success: false,
          error: `Ảnh quá lớn (${sizeInMB.toFixed(2)}MB). Tối đa 4MB.`
        });
      }
      
      console.log(`🖼️ Image size: ${sizeInMB.toFixed(2)}MB`);
    }

    // Special commands
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
      const recentMessages = conversationHistory.slice(-40); 
      
      recentMessages.forEach((msg) => {
        if (msg.role === 'user') {
          historyText += `>>>👤 Bạn: ${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
          historyText += `>>>🤖 Kami: ${msg.content}\n\n\n`;
        }
      });

      historyText += `\n📊 Tổng cộng: ${conversationHistory.length} tin nhắn (hiển thị 40 mới nhất)`;
      
      return res.status(200).json({
        success: true,
        message: historyText,
        userId: userId,
        conversationId: finalConversationId
      });
    }

    if (message === '/memory') {
      const userProfile = await getLongTermMemory(userId);
      const summaries = await getSummaries(userId, finalConversationId);

      let memoryText = "🧠 BỘ NHỚ AI\n\n";
      
      if (Object.keys(userProfile).length === 0) {
        memoryText += "📭 Chưa có thông tin cá nhân nào được lưu.\n\n";
      } else {
        memoryText += "👤 THÔNG TIN CÁ NHÂN:\n";
        const fieldNames = {
          name: "Tên",
          nickname: "Biệt danh",
          family: "Gia đình",
          age: "Tuổi",
          job: "Nghề nghiệp",
          hobbies: "Sở thích",
          location: "Nơi ở",
          other: "Khác"
        };    
        
        for (const [key, value] of Object.entries(userProfile)) {
          const displayKey = fieldNames[key] || key.charAt(0).toUpperCase() + key.slice(1);
          memoryText += `▪ ${displayKey}: ${value}\n`;
        }
        memoryText += "\n";
      }

      if (summaries.length > 0) {
        memoryText += "📝 TÓM TẮT CÁC CUỘC HỘI THOẠI:\n";
        const recentSummaries = summaries.slice(-15); 
        
        recentSummaries.forEach((summary) => {
          memoryText += `\n[Phần ${summary.number}] Tin ${summary.messageRange}:\n${summary.content}\n`;
        });
        
        memoryText += `\n📊 Tổng: ${summaries.length} tóm tắt (hiển thị 15 mới nhất)`;
      } else {
        memoryText += "📭 Chưa có tóm tắt nào (cần >= 40 tin nhắn).";
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

    console.log(`📱 Request from ${userId}: "${message.substring(0, 50)}..." ${imageBase64 ? '🖼️' : ''}`);

    if (IS_DEV) stats.perf.totalRequests++;

    const responseCacheKey = `resp:${userId}:${normalizeForCache(message)}`;
    const cachedResponse = responseCache.get(responseCacheKey);
    
    // ⚠️ KHÔNG dùng cache nếu có ảnh
    if (cachedResponse && !imageBase64) {
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

    const [conversationHistory, userProfile] = await Promise.all([
      getShortTermMemory(userId, finalConversationId),
      getLongTermMemory(userId)
    ]);

    console.log(`💾 Loaded ${conversationHistory.length} messages`);

    let searchResult = null;
    
    // ⚠️ SKIP search nếu có ảnh (Vision model tự phân tích)
    if (!imageBase64) {
      const searchCacheKey = normalizeForCache(message);
      const cachedDecision = detectionCache.get(searchCacheKey); 
      let searchDecision = null; 

      if (cachedDecision) {
        searchDecision = cachedDecision;
        console.log(`💾 Using cached search decision`);
      } else {
        searchDecision = quickDetect(message);
        console.log(`⚡ Quick detection: ${searchDecision.needsSearch ? 'SEARCH' : 'SKIP'}`);   
        
        if (searchDecision.confidence >= 0.8) {
          detectionCache.set(searchCacheKey, searchDecision);
        }
      }

      if (searchDecision.needsSearch) {
        searchResult = await smartSearch(message, searchDecision.type);
        if (searchResult) {
          console.log(`✅ Search successful: ${searchResult.source}`);
        }
      }

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
    }

    // 🔥 XÂY DỰNG USER MESSAGE (text + image nếu có)
    const userMessage = {
      role: 'user',
      content: imageBase64 ? [
        {
          type: 'text',
          text: message.trim()
        },
        {
          type: 'image_url',
          image_url: {
            url: imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
          }
        }
      ] : message.trim()
    };

    conversationHistory.push(userMessage);

    const apiKey = API_KEYS[await getUserKeyIndex(userId)];
    const tempGroq = new Groq({ apiKey }); 
    
    const summaries = await manageMemory(userId, finalConversationId, conversationHistory, tempGroq);
    const context = buildContext(conversationHistory, summaries);
    const workingMemory = context.recentMessages;

    let summaryContext = '';
    if (context.recentSummaries.length > 0) {
      summaryContext = '\n📚 TÓM TẮT CÁC CUỘC TRÒ CHUYỆN TRƯỚC:\n';
      context.recentSummaries.forEach(s => {
        summaryContext += `\n[Phần ${s.number}] (Tin ${s.messageRange}):\n${s.content}\n`;
      });
    }

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

${Object.keys(userProfile).length > 0 ? `
👤 THÔNG TIN NGƯỜI DÙNG:
${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}

${summaryContext}

${searchResult ? `
🔍 KẾT QUẢ TÌM KIẾM (dùng thông tin này để trả lời):
${JSON.stringify(searchResult, null, 2)}
` : ''}

${imageBase64 ? `
🖼️ PHÂN TÍCH ẢNH: Hãy mô tả chi tiết những gì bạn thấy trong ảnh và trả lời câu hỏi của user.
` : ''}

💾 Context: ${context.contextInfo.messagesInContext} tin mới + ${context.contextInfo.summariesInContext} summaries
📊 Tổng: ${context.contextInfo.totalMessages} tin, ${context.contextInfo.totalSummaries} summaries

Hãy trả lời chính xác và tự nhiên bằng tiếng Việt. Có thể thêm tối đa 3 emoji phù hợp.`
    };

    const messages = [systemPrompt, ...workingMemory];

    console.log(`🤖 Calling AI with ${workingMemory.length} messages... ${imageBase64 ? '(Vision Mode)' : ''}`);

    // 🔥 GỌI GROQ với Vision support
    const { groq, chatCompletion } = await callGroqWithRetry(userId, messages, !!imageBase64);

    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    console.log(`✅ AI responded`);

    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    // ⚠️ KHÔNG cache response có ảnh
    if (!imageBase64) {
      responseCache.set(responseCacheKey, assistantMessage);
    }

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
        summariesCount: summaries.length,
        summariesInContext: context.contextInfo.summariesInContext,
        userProfileFields: Object.keys(userProfile).length,
        storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory',
        searchUsed: !!searchResult,
        searchSource: searchResult?.source || null,
        hasImage: !!imageBase64,
        modelUsed: imageBase64 ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile',
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
