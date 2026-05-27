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

function maybeCleanupMemoryStore() {
  if (!REDIS_ENABLED && memoryStore.size > 1000 && Math.random() < 0.01) {
    const entries = [...memoryStore.entries()];
    memoryStore.clear();
    entries.slice(-500).forEach(([k, v]) => memoryStore.set(k, v));
    console.log('🧹 Cleaned memoryStore');
  }
}

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
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }
  clear() { this.cache.clear(); }
  get size() { return this.cache.size; }
}

const SEARCH_CONFIG = { CACHE_TTL_MINUTES: 30, DETECTION_CACHE_TTL_MINUTES: 60 };
const searchCache = new SimpleCache(SEARCH_CONFIG.CACHE_TTL_MINUTES * 60000, 100);
const detectionCache = new SimpleCache(SEARCH_CONFIG.DETECTION_CACHE_TTL_MINUTES * 60000, 200);
const responseCache = new SimpleCache(5 * 60000, 50);

const API_KEYS = [
  process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3, process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5, process.env.GROQ_API_KEY_6,
  process.env.GROQ_API_KEY_7, process.env.GROQ_API_KEY_8,
  process.env.GROQ_API_KEY_9, process.env.GROQ_API_KEY_10
].filter(key => key);

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MEMORY_CONFIG = {
  SHORT_TERM_DAYS: 30, WORKING_MEMORY_LIMIT: 30, LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40, MAX_SUMMARIES: 30, MAX_MESSAGES: 1000,
  SUMMARY_CONTEXT_LIMIT: 15
};

const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const DETECTION_PATTERNS = {
  never: /^(chào|hello|hi|xin chào|hey|cảm ơn|thank|thanks|tạm biệt|bye|goodbye|ok|okay|được|rồi|ừ|uhm)$/i,
  explicit: /(tìm kiếm|search|tra cứu|google|tìm đi|tìm lại|tìm giúp|tra giúp)/i,
  realtime: /\b(giá bitcoin|giá vàng|giá dầu|giá xăng|tỷ giá|thời tiết|nhiệt độ|tin tức mới nhất|tin tức hôm nay)\b/i,
  current: /(hiện nay|hiện tại|bây giờ|hôm nay|năm nay|mới nhất|gần đây|vừa rồi|ai là|là ai)/i,
  concept: /^.*(là gì|nghĩa là gì|định nghĩa|ý nghĩa|giải thích|cho.*biết về|nói về)/i,
  advice: /^(nên|có nên|tôi nên|làm sao|làm thế nào|bạn nghĩ|theo bạn|ý kiến)/i
};

const IS_DEV = process.env.NODE_ENV === 'development';
const stats = IS_DEV ? {
  search: { total: 0, cacheHits: 0 },
  perf: { responseCacheHits: 0, totalRequests: 0, totalResponseTime: 0 }
} : null;

function normalizeForCache(message) {
  return message.toLowerCase().trim().replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ').substring(0, 200);
}

function normalizeSearchResult(raw) {
  if (!raw) return null;
  return {
    source: raw.source || 'Unknown',
    content: raw.content || raw.results?.[0]?.content || '',
    results: raw.results || []
  };
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
  if (redis) return await redis.get(key);
  const item = memoryStore.get(key);
  if (!item) return null;
  if (item.expires && Date.now() > item.expires) {
    memoryStore.delete(key);
    return null;
  }
  return item.value;
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
  if (redis) return await redis.hgetall(key);
  const item = memoryStore.get(key);
  if (!item) return {};
  if (item.expires && Date.now() > item.expires) {
    memoryStore.delete(key);
    return {};
  }
  return item.value || {};
}

async function setExpire(key, ttl) {
  if (redis) return await redis.expire(key, ttl);
  return true;
}

function safeParseJSON(text, fallback = {}) {
  try {
    let cleaned = text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
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

const searchDuckDuckGo = (query) => searchWithRetry(async () => {
  const response = await axios.get('https://api.duckduckgo.com/', {
    params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kami/1.0)' },
    timeout: 5000
  });
  const data = response.data;
  if (data.Abstract) {
    return {
      source: 'DuckDuckGo', title: data.Heading || query,
      content: data.Abstract, url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
    };
  }
  if (data.RelatedTopics?.length > 0) {
    const first = data.RelatedTopics[0];
    if (first.Text) {
      return {
        source: 'DuckDuckGo', title: first.Text.split(' - ')[0] || query,
        content: first.Text, url: first.FirstURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
      };
    }
  }
  return null;
}, 'DuckDuckGo');

const searchWikipedia = (query) => searchWithRetry(async () => {
  const searchResp = await axios.get('https://vi.wikipedia.org/w/api.php', {
    params: { action: 'query', list: 'search', srsearch: query, srlimit: 1, format: 'json', origin: '*' },
    headers: { 'User-Agent': 'KamiApp/1.0' }, timeout: 5000
  });
  const results = searchResp.data?.query?.search;
  if (!results?.length) return null;
  const title = results[0].title;
  const extractResp = await axios.get('https://vi.wikipedia.org/w/api.php', {
    params: { action: 'query', prop: 'extracts', titles: title, exintro: true, explaintext: true, exsectionformat: 'plain', format: 'json', origin: '*' },
    headers: { 'User-Agent': 'KamiApp/1.0' }, timeout: 5000
  });
  const pages = extractResp.data?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  if (!page?.extract) return null;
  const content = page.extract.substring(0, 600).trim();
  if (content.length < 50) return null;
  return {
    source: 'Wikipedia', title: title, content: content,
    url: `https://vi.wikipedia.org/wiki/${encodeURIComponent(title)}`
  };
}, 'Wikipedia');

const searchSerper = (query) => {
  if (!SERPER_API_KEY) return null;
  return searchWithRetry(async () => {
    const response = await axios.post('https://google.serper.dev/search', {
      q: query, gl: 'vn', hl: 'vi', num: 3
    }, { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 5000 });
    const results = response.data.organic || [];
    if (!results.length) return null;
    return {
      source: 'Serper',
      results: results.map(r => ({ title: r.title, content: r.snippet, url: r.link }))
    };
  }, 'Serper');
};

const searchTavily = (query) => {
  if (!TAVILY_API_KEY) return null;
  return searchWithRetry(async () => {
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: TAVILY_API_KEY, query: query, search_depth: 'basic', include_answer: true, max_results: 3
    }, { timeout: 5000 });
    const data = response.data;
    return {
      source: 'Tavily', content: data.answer,
      results: data.results?.map(r => ({ title: r.title, content: r.content, url: r.url }))
    };
  }, 'Tavily');

function quickDetect(message) {
  const lower = message.toLowerCase().trim();
  if (DETECTION_PATTERNS.never.test(lower)) return { needsSearch: false, confidence: 1.0, reason: 'casual' };
  if (DETECTION_PATTERNS.explicit.test(lower)) return { needsSearch: true, confidence: 1.0, type: 'search' };
  if (DETECTION_PATTERNS.realtime.test(lower)) return { needsSearch: true, confidence: 1.0, type: 'realtime' };
  if (DETECTION_PATTERNS.current.test(lower)) return { needsSearch: true, confidence: 0.9, type: 'knowledge' };
  if (DETECTION_PATTERNS.concept.test(lower)) {
    if (/(python|javascript|lập trình|code|toán|vật lý|hóa|sinh|văn|nghệ thuật)/i.test(lower)) return { needsSearch: false, confidence: 0.9 };
  }
  if (DETECTION_PATTERNS.advice.test(lower)) return { needsSearch: false, confidence: 0.85 };
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
  console.log(`🤖 Using AI detection`);
  try {
    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Return JSON only: {needsSearch: boolean, type: string}' },
        { role: 'user', content: `Need internet search? "${message}"` }
      ],
      model: 'llama-3.1-8b-instant', temperature: 0, max_tokens: 50,
      response_format: { type: "json_object" }
    });
    const result = safeParseJSON(response.choices[0]?.message?.content || '{}');
    const aiDecision = { needsSearch: result.needsSearch || false, confidence: 0.9, type: result.type || 'knowledge' };
    detectionCache.set(cacheKey, aiDecision);
    return aiDecision;
  } catch (error) {
    console.error('AI detection error:', error);
    const fallback = { needsSearch: false, confidence: 0.5 };
    detectionCache.set(cacheKey, fallback);
    return fallback;
  }
}

async function smartSearch(query, searchType) {
  const cacheKey = normalizeForCache(query);
  const cached = searchCache.get(cacheKey);
  if (cached) { console.log(`✅ Search cache hit`); return cached; }
  console.log(`🔍 Search type: ${searchType}`);
  let result = null;
  const isRealtime = searchType === 'realtime';
  if (!isRealtime) {
    console.log(`🔍 Trying DuckDuckGo...`);
    result = await searchDuckDuckGo(query);
    if (result) { console.log(`✅ DuckDuckGo success`); searchCache.set(cacheKey, normalizeSearchResult(result)); return normalizeSearchResult(result); }
    console.log(`❌ DuckDuckGo failed`);
    console.log(`🔍 Trying Wikipedia...`);
    result = await searchWikipedia(query);
    if (result) { console.log(`✅ Wikipedia success`); searchCache.set(cacheKey, normalizeSearchResult(result)); return normalizeSearchResult(result); }
    console.log(`❌ Wikipedia failed`);
  }
  if (SERPER_API_KEY) {
    console.log(`🔍 Trying Serper...`);
    result = await searchSerper(query);
    if (result) { console.log(`✅ Serper success`); searchCache.set(cacheKey, normalizeSearchResult(result)); return normalizeSearchResult(result); }
    console.log(`❌ Serper failed`);
  }
  if (TAVILY_API_KEY) {
    console.log(`🔍 Trying Tavily...`);
    result = await searchTavily(query);
    if (result) { console.log(`✅ Tavily success`); searchCache.set(cacheKey, normalizeSearchResult(result)); return normalizeSearchResult(result); }
    console.log(`❌ Tavily failed`);
  }
  console.log(`❌ All search sources failed`);
  return null;
}

function validateHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(msg => msg && msg.role && msg.content && typeof msg.content === 'string');
}

async function getShortTermMemory(userId, conversationId) {
  const key = `chat:${userId}:${conversationId}`;
  const history = await getData(key);
  if (!history) return [];
  if (typeof history === 'string') { try { return JSON.parse(history); } catch { return []; } }
  if (Array.isArray(history)) return history;
  return [];
}

async function saveShortTermMemory(userId, conversationId, history) {
  const key = `chat:${userId}:${conversationId}`;
  await setData(key, Array.isArray(history) ? JSON.stringify(history) : history, MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

async function getLongTermMemory(userId) {
  const key = `user:profile:${userId}`;
  const profile = await getHashData(key);
  if (profile && Object.keys(profile).length > 0) await setExpire(key, MEMORY_CONFIG.LONG_TERM_DAYS * 86400);
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
  } catch { return []; }
}

async function saveSummaries(userId, conversationId, summaries) {
  const key = `summaries:${userId}:${conversationId}`;
  await setData(key, JSON.stringify(summaries), MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

async function createNewSummary(groq, messages, summaryNumber) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Hãy tóm tắt 40 tin nhắn sau thành 3-4 câu ngắn gọn, giữ lại thông tin quan trọng, sự kiện chính và mạch lạc cuộc trò chuyện.' },
        { role: 'user', content: `Tóm tắt phần ${summaryNumber}:\n${JSON.stringify(messages)}` }
      ],
      model: 'llama-3.1-8b-instant', temperature: 0.3, max_tokens: 400
    });
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Error creating summary:', error);
    return `[Summary ${summaryNumber}] Cuộc trò chuyện tiếp diễn...`;
  }
}

async function manageMemory(userId, conversationId, conversationHistory, groq) {
  if (conversationHistory.length > MEMORY_CONFIG.MAX_MESSAGES) {
    const toRemove = conversationHistory.length - MEMORY_CONFIG.MAX_MESSAGES;
    conversationHistory.splice(0, toRemove);
    console.log(`🗑 Removed ${toRemove} old messages`);
  }
  const currentTotal = conversationHistory.length;
  const summaries = await getSummaries(userId, conversationId);
  const processed = summaries.length * MEMORY_CONFIG.SUMMARY_THRESHOLD;
  const unprocessed = currentTotal - processed;
  if (unprocessed >= MEMORY_CONFIG.SUMMARY_THRESHOLD) {
    const startIdx = processed, endIdx = startIdx + MEMORY_CONFIG.SUMMARY_THRESHOLD;
    const toSummarize = conversationHistory.slice(startIdx, endIdx);
    const summaryNumber = summaries.length + 1;
    console.log(`📝 Creating summary ${summaryNumber} from messages ${startIdx}-${endIdx}...`);
    const newSummary = await createNewSummary(groq, toSummarize, summaryNumber);
    summaries.push({ number: summaryNumber, content: newSummary, messageRange: `${startIdx + 1}-${endIdx}`, createdAt: new Date().toISOString() });
    if (summaries.length > MEMORY_CONFIG.MAX_SUMMARIES) {
      const removed = summaries.shift();
      console.log(`🗑 Removed oldest summary #${removed.number}`);
    }
    await saveSummaries(userId, conversationId, summaries);
    console.log(`✅ Summary ${summaryNumber} created. Total: ${summaries.length}`);
  }
  return summaries;
}

function buildContext(conversationHistory, summaries) {
  const recentMessages = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
  const recentSummaries = summaries.slice(-MEMORY_CONFIG.SUMMARY_CONTEXT_LIMIT);
  return {
    recentMessages, recentSummaries,
    contextInfo: {
      totalMessages: conversationHistory.length, totalSummaries: summaries.length,
      messagesInContext: recentMessages.length, summariesInContext: recentSummaries.length
    }
  };
}

async function extractPersonalInfo(groq, conversationHistory) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: `Trích xuất thông tin cá nhân từ cuộc hội thoại (nếu có) theo format JSON:\n{\n  "name": "tên người dùng",\n  "nickname": "tên thường gọi",\n  "family": "thông tin gia đình",\n  "age": "tuổi",\n  "job": "nghề nghiệp",\n  "hobbies": "sở thích",\n  "location": "nơi ở",\n  "other": "thông tin khác"\n}\nChỉ trả về JSON, không có text thừa. Nếu không có thông tin nào thì trả về {}.` },
        { role: 'user', content: JSON.stringify(conversationHistory.slice(-10)) }
      ],
      model: 'llama-3.1-8b-instant', temperature: 0.1, max_tokens: 500
    });
    return safeParseJSON(chatCompletion.choices[0]?.message?.content || '{}', {});
  } catch (error) {
    console.error('Error extracting info:', error);
    return {};
  }
}

async function shouldExtractNow(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  const lastExtract = await getData(key);
  if (!lastExtract) return conversationHistory.length >= 5;
  try {
    const data = typeof lastExtract === 'string' ? JSON.parse(lastExtract) : lastExtract;
    const timeSince = Date.now() - data.timestamp;
    const messagesSince = conversationHistory.length - data.messageCount;
    return (timeSince > 300000 && messagesSince >= 3) || messagesSince >= 10;
  } catch { return conversationHistory.length >= 5; }
}

async function markExtracted(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  await setData(key, JSON.stringify({ timestamp: Date.now(), messageCount: conversationHistory.length, extractedAt: new Date().toISOString() }), MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

function mergeProfile(currentProfile, newInfo) {
  const updated = { ...currentProfile };
  for (const [key, value] of Object.entries(newInfo)) {
    if (!value || value === 'null' || value === 'undefined') continue;
    const val = typeof value === 'string' ? value.trim() : value;
    if (val && val !== 'không có' && val !== 'chưa có') updated[key] = val;
  }
  return updated;
}

function getRandomKeyIndex() { return Math.floor(Math.random() * API_KEYS.length); }
function getNextKeyIndex(currentIndex) { return (currentIndex + 1) % API_KEYS.length; }

async function getUserKeyIndex(userId) {
  const key = `keyindex:${userId}`;
  let index = await getData(key);
  if (index === null) { index = getRandomKeyIndex(); await setData(key, index, 86400); }
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
        messages, model: 'llama-3.3-70b-versatile', temperature: 0.7,
        max_tokens: 2048, top_p: 0.9, stream: false
      });
      await setUserKeyIndex(userId, currentKeyIndex);
      return chatCompletion;
    } catch (error) {
      const isQuotaError = error.message?.includes('quota') || error.message?.includes('rate limit') || error.message?.includes('Rate limit') || error.status === 429 || error.status === 403;
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
      const isQuotaError = error.message?.includes('quota') || error.message?.includes('rate limit') || error.message?.includes('Rate limit') || error.status === 429 || error.status === 403;
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

async function handleVisionRequest(req, res) {
  const { imageBase64, mimeType, prompt, userId, conversationId } = req.body;
  if (!imageBase64) return res.status(400).json({ success: false, error: 'Thiếu dữ liệu ảnh' });
  const safeMime = mimeType || 'image/jpeg';
  if (!ALLOWED_IMAGE_MIME.includes(safeMime)) return res.status(400).json({ success: false, error: 'Định dạng ảnh không hợp lệ' });
  if (imageBase64.length > 5 * 1024 * 1024) return res.status(413).json({ success: false, error: 'Ảnh quá lớn' });
  if (!userId || !userId.startsWith('user_')) return res.status(400).json({ success: false, error: 'Invalid userId' });
  const startTime = Date.now();
  try {
    const userPrompt = prompt?.trim() || 'Hãy mô tả chi tiết ảnh này bằng tiếng Việt.';
    const chatCompletion = await callTempGroqWithRetry(userId, async (groq) => {
      return groq.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          { role: 'system', content: 'Trả lời bằng văn xuôi tự nhiên, ngắn gọn. Không dùng markdown.' },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${safeMime};base64,${imageBase64}` } }, { type: 'text', text: userPrompt }] }
        ],
        max_tokens: 1024, temperature: 0.7
      });
    });
    const result = chatCompletion.choices[0]?.message?.content || 'Không thể phân tích ảnh';
    const finalConversationId = conversationId || 'default';
    let conversationHistory = validateHistory(await getShortTermMemory(userId, finalConversationId));
    conversationHistory.push({ role: 'user', content: `[Ảnh] ${userPrompt}` }, { role: 'assistant', content: result });
    await saveShortTermMemory(userId, finalConversationId, conversationHistory);
    return res.status(200).json({ success: true, message: result, userId, conversationId: finalConversationId, responseTime: Date.now() - startTime });
  } catch (error) {
    console.error('Vision error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Lỗi phân tích ảnh' });
  }
}

// ════════════════════════════════════════════════════════════════════════
// KAMI MUSIC P2P API — Thêm vào chat.js để hỗ trợ ứng dụng nghe nhạc P2P
// ════════════════════════════════════════════════════════════════════════

const MUSIC_CONFIG = {
  MAX_SONGS: 10000,
  SONG_TTL_DAYS: 365,
  LIST_KEY: 'kami_music:songs'
};

// Helper: Lấy tất cả bài hát từ Redis
async function getAllSongs() {
  if (!redis) {
    // Fallback: dùng memoryStore nếu không có Redis
    const allKeys = [...memoryStore.keys()].filter(k => k.startsWith('song:'));
    const songs = allKeys.map(k => {
      const item = memoryStore.get(k);
      if (!item) return null;
      if (item.expires && Date.now() > item.expires) { memoryStore.delete(k); return null; }
      try { return JSON.parse(item.value); } catch { return null; }
    }).filter(Boolean);
    return songs.sort((a, b) => (b.date || 0) - (a.date || 0));
  }
  
  // Redis: dùng sorted set hoặc list
  try {
    const songsData = await redis.lrange(MUSIC_CONFIG.LIST_KEY, 0, MUSIC_CONFIG.MAX_SONGS - 1);
    const songs = songsData.map(s => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
    return songs.sort((a, b) => (b.date || 0) - (a.date || 0));
  } catch (error) {
    console.error('Redis getAllSongs error:', error);
    return [];
  }
}

// Helper: Lưu bài hát vào Redis
async function saveSong(songData) {
  if (!songData.id && !songData.file_id && !songData.message_id) {
    throw new Error('Song must have id, file_id, or message_id');
  }
  
  const song = {
    id: songData.id || songData.file_id || `song_${Date.now()}`,
    file_id: songData.file_id || songData.id,
    name: songData.file_name || songData.name || 'Unknown',
    size: parseInt(songData.file_size || songData.size) || 0,
    message_id: parseInt(songData.message_id) || 0,
    userId: songData.userId || 'anonymous',
    date: songData.date || Math.floor(Date.now() / 1000),
    file_url: songData.file_url || null
  };
  
  if (!redis) {
    // Fallback memoryStore
    const key = `song:${song.id}`;
    memoryStore.set(key, { value: JSON.stringify(song), expires: Date.now() + MUSIC_CONFIG.SONG_TTL_DAYS * 86400 * 1000 });
    return song;
  }
  
  try {
    // Kiểm tra trùng lặp
    const exists = await redis.lrange(MUSIC_CONFIG.LIST_KEY, 0, -1);
    const parsed = exists.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    const dupIndex = parsed.findIndex(s => s.id === song.id || s.file_id === song.file_id || s.message_id === song.message_id);
    
    if (dupIndex >= 0) {
      // Cập nhật bài cũ
      await redis.lset(MUSIC_CONFIG.LIST_KEY, dupIndex, JSON.stringify(song));
    } else {
      // Thêm mới
      await redis.lpush(MUSIC_CONFIG.LIST_KEY, JSON.stringify(song));
      // Giới hạn số lượng
      await redis.ltrim(MUSIC_CONFIG.LIST_KEY, 0, MUSIC_CONFIG.MAX_SONGS - 1);
    }
    
    // Set TTL cho list
    await redis.expire(MUSIC_CONFIG.LIST_KEY, MUSIC_CONFIG.SONG_TTL_DAYS * 86400);
    return song;
  } catch (error) {
    console.error('Redis saveSong error:', error);
    throw error;
  }
}

// Helper: Xóa bài hát
async function deleteSong(message_id, userId) {
  if (!redis) {
    const keys = [...memoryStore.keys()].filter(k => k.startsWith('song:'));
    for (const key of keys) {
      const item = memoryStore.get(key);
      if (!item) continue;
      try {
        const song = JSON.parse(item.value);
        if ((song.message_id == message_id || song.id == message_id) && song.userId === userId) {
          memoryStore.delete(key);
          return true;
        }
      } catch {}
    }
    return false;
  }
  
  try {
    const songs = await redis.lrange(MUSIC_CONFIG.LIST_KEY, 0, -1);
    let found = false;
    const filtered = [];
    for (const s of songs) {
      try {
        const song = JSON.parse(s);
        if ((song.message_id == message_id || song.id == message_id) && song.userId === userId) {
          found = true;
          continue;
        }
        filtered.push(s);
      } catch { filtered.push(s); }
    }
    if (found) {
      await redis.del(MUSIC_CONFIG.LIST_KEY);
      if (filtered.length > 0) await redis.rpush(MUSIC_CONFIG.LIST_KEY, ...filtered);
      await redis.expire(MUSIC_CONFIG.LIST_KEY, MUSIC_CONFIG.SONG_TTL_DAYS * 86400);
    }
    return found;
  } catch (error) {
    console.error('Redis deleteSong error:', error);
    return false;
  }
}

// Helper: Tìm kiếm bài hát
async function searchSongs(query) {
  const allSongs = await getAllSongs();
  if (!query) return allSongs;
  const lower = query.toLowerCase();
  return allSongs.filter(s => (s.name || '').toLowerCase().includes(lower));
}

// Helper: Stats
async function getMusicStats() {
  const songs = await getAllSongs();
  const uniqueUsers = new Set(songs.map(s => s.userId)).size;
  return { totalSongs: songs.length, uniqueUsers };
}

// ════════════════════════════════════════════════════════════════════════
// MUSIC API HANDLERS
// ════════════════════════════════════════════════════════════════════════

async function handleMusicSongs(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    const sort = url.searchParams.get('sort') || 'newest';
    
    let songs = await getAllSongs();
    
    // Sort
    if (sort === 'popular') {
      songs.sort((a, b) => (b.plays || b.size || 0) - (a.plays || a.size || 0));
    } else {
      songs.sort((a, b) => (b.date || 0) - (a.date || 0));
    }
    
    const total = songs.length;
    const paginated = songs.slice(offset, offset + limit);
    const hasMore = (offset + limit) < total;
    const stats = await getMusicStats();
    
    return res.status(200).json({
      songs: paginated,
      total,
      hasMore,
      stats
    });
  } catch (error) {
    console.error('handleMusicSongs error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}

async function handleMusicUpload(req, res) {
  try {
    const { file_id, file_name, file_size, message_id, userId, date } = req.body;
    
    if (!file_id || !file_name) {
      return res.status(400).json({ ok: false, error: 'Missing file_id or file_name' });
    }
    
    const song = await saveSong({
      id: file_id,
      file_id,
      file_name,
      file_size,
      message_id,
      userId,
      date
    });
    
    console.log(`🎵 New song uploaded: ${song.name} by ${userId}`);
    return res.status(200).json({ ok: true, success: true, song });
  } catch (error) {
    console.error('handleMusicUpload error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function handleMusicDelete(req, res) {
  try {
    const { message_id, userId } = req.body;
    if (!message_id || !userId) {
      return res.status(400).json({ ok: false, error: 'Missing message_id or userId' });
    }
    
    const deleted = await deleteSong(message_id, userId);
    if (deleted) {
      console.log(`🗑 Song deleted: ${message_id} by ${userId}`);
      return res.status(200).json({ ok: true, success: true });
    }
    return res.status(403).json({ ok: false, error: 'Not authorized or song not found' });
  } catch (error) {
    console.error('handleMusicDelete error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function handleMusicSearch(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const q = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit')) || 100;
    
    const results = await searchSongs(q);
    const limited = results.slice(0, limit);
    
    return res.status(200).json({
      songs: limited,
      total: results.length,
      query: q
    });
  } catch (error) {
    console.error('handleMusicSearch error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — Router cho cả Chat và Music
// ════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS headers cho mobile app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  maybeCleanupMemoryStore();
  
  // ROUTING: Phân biệt chat API và music API dựa trên path
  const path = req.url?.split('?')[0] || '/';
  
  // Music API routes
  if (path === '/songs' && req.method === 'GET') {
    return handleMusicSongs(req, res);
  }
  if (path === '/upload' && req.method === 'POST') {
    return handleMusicUpload(req, res);
  }
  if (path === '/delete' && req.method === 'POST') {
    return handleMusicDelete(req, res);
  }
  if (path === '/search' && req.method === 'GET') {
    return handleMusicSearch(req, res);
  }
  
  // Chat API (giữ nguyên logic cũ)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (req.body.imageBase64) {
    return handleVisionRequest(req, res);
  }
  
  const startTime = Date.now();
  
  try {
    const { message, userId, conversationId } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    if (!userId || !userId.startsWith('user_')) {
      return res.status(400).json({ success: false, error: 'Invalid userId format' });
    }
    
    const finalConversationId = conversationId || 'default';
    
    if (message === '/history') {
      const conversationHistory = await getShortTermMemory(userId, finalConversationId);
      if (!conversationHistory.length) {
        return res.status(200).json({ success: true, message: "📭 Chưa có lịch sử chat nào.", userId, conversationId: finalConversationId });
      }
      let historyText = "🕘 LỊCH SỬ CHAT\n\n";
      const recent = conversationHistory.slice(-40);
      recent.forEach((msg) => {
        if (msg.role === 'user') historyText += `>>>👤 Bạn: ${msg.content}\n\n`;
        else if (msg.role === 'assistant') historyText += `>>>🤖 Kami: ${msg.content}\n\n\n`;
      });
      historyText += `\n📊 Tổng cộng: ${conversationHistory.length} tin nhắn (hiển thị 40 mới nhất)`;
      return res.status(200).json({ success: true, message: historyText, userId, conversationId: finalConversationId });
    }
    
    if (message === '/memory') {
      const userProfile = await getLongTermMemory(userId);
      const summaries = await getSummaries(userId, finalConversationId);
      let memoryText = "🧠 BỘ NHỚ AI\n\n";
      if (!Object.keys(userProfile).length) memoryText += "📭 Chưa có thông tin cá nhân.\n\n";
      else {
        memoryText += "👤 THÔNG TIN CÁ NHÂN:\n";
        const fieldNames = { name: "Tên", nickname: "Biệt danh", family: "Gia đình", age: "Tuổi", job: "Nghề nghiệp", hobbies: "Sở thích", location: "Nơi ở", other: "Khác" };
        for (const [key, value] of Object.entries(userProfile)) {
          memoryText += `▪ ${fieldNames[key] || key}: ${value}\n`;
        }
        memoryText += "\n";
      }
      if (summaries.length) {
        memoryText += "📝 TÓM TẮT:\n";
        summaries.slice(-15).forEach((s) => {
          memoryText += `\n[Phần ${s.number}] Tin ${s.messageRange}:\n${s.content}\n`;
        });
        memoryText += `\n📊 Tổng: ${summaries.length} tóm tắt`;
      } else memoryText += "📭 Chưa có tóm tắt.";
      return res.status(200).json({ success: true, message: memoryText, userId, conversationId: finalConversationId });
    }
    
    if (!API_KEYS.length) return res.status(500).json({ success: false, error: 'No API keys' });
    
    console.log(`📱 Chat request from ${userId}: "${message.substring(0, 50)}..."`);
    if (IS_DEV) stats.perf.totalRequests++;
    
    const responseCacheKey = `resp:${userId}:${finalConversationId}:${normalizeForCache(message)}`;
    const cachedResponse = responseCache.get(responseCacheKey);
    if (cachedResponse) {
      if (IS_DEV) stats.perf.responseCacheHits++;
      console.log(`💾 Response cache hit`);
      let conversationHistory = validateHistory(await getShortTermMemory(userId, finalConversationId));
      const lastMsg = conversationHistory[conversationHistory.length - 1];
      if (!(lastMsg?.role === 'assistant' && lastMsg?.content === cachedResponse)) {
        conversationHistory.push({ role: 'user', content: message.trim() }, { role: 'assistant', content: cachedResponse });
        await saveShortTermMemory(userId, finalConversationId, conversationHistory);
      }
      return res.status(200).json({ success: true, message: cachedResponse, userId, conversationId: finalConversationId, cached: true, responseTime: Date.now() - startTime });
    }
    
    let [conversationHistory, userProfile] = await Promise.all([
      getShortTermMemory(userId, finalConversationId),
      getLongTermMemory(userId)
    ]);
    conversationHistory = validateHistory(conversationHistory);
    console.log(`💾 Loaded ${conversationHistory.length} messages`);
    
    let searchResult = null;
    const searchCacheKey = normalizeForCache(message);
    const cachedDecision = detectionCache.get(searchCacheKey);
    let searchDecision = null;
    
    if (cachedDecision) {
      searchDecision = cachedDecision;
      console.log(`💾 Using cached search decision`);
    } else {
      searchDecision = quickDetect(message);
      console.log(`⚡ Quick detection: ${searchDecision.needsSearch ? 'SEARCH' : 'SKIP'} (confidence: ${searchDecision.confidence})`);
      if (searchDecision.confidence >= 0.8) detectionCache.set(searchCacheKey, searchDecision);
    }
    
    if (searchDecision.needsSearch) {
      searchResult = await smartSearch(message, searchDecision.type);
      if (searchResult) console.log(`✅ Search successful: ${searchResult.source}`);
    }
    
    if (!cachedDecision && searchDecision.confidence < 0.8) {
      callTempGroqWithRetry(userId, async (groq) => {
        const aiDecision = await shouldSearch(message, groq);
        detectionCache.set(searchCacheKey, aiDecision);
        if (aiDecision.needsSearch && !searchResult) {
          const bgResult = await smartSearch(message, aiDecision.type);
          if (bgResult) console.log(`✅ Background search cached: ${bgResult.source}`);
        }
        return aiDecision;
      }).catch(err => console.error('Background detection error:', err));
    }
    
    conversationHistory.push({ role: 'user', content: message.trim() });
    
    let summaries = [];
    try {
      summaries = await callTempGroqWithRetry(userId, async (groq) => {
        return manageMemory(userId, finalConversationId, conversationHistory, groq);
      });
    } catch (err) {
      console.error('manageMemory failed:', err.message);
      summaries = await getSummaries(userId, finalConversationId);
    }
    
    const context = buildContext(conversationHistory, summaries);
    const workingMemory = context.recentMessages;
    let summaryContext = '';
    if (context.recentSummaries.length > 0) {
      summaryContext = '\n📚 TÓM TẮT CÁC CUỘC TRÒ CHUYỆN TRƯỚC:\n';
      context.recentSummaries.forEach(s => {
        summaryContext += `\n[Phần ${s.number}] (Tin ${s.messageRange}):\n${s.content}\n`;
      });
    }
    
    const currentDate = new Date().toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const searchSection = searchResult ? `\n🔍 KẾT QUẢ TÌM KIẾM:\n--- BẮT ĐẦU DỮ LIỆU ---\n${JSON.stringify(searchResult, null, 2)}\n--- KẾT THÚC DỮ LIỆU ---\n` : '';
    
    const systemPrompt = {
      role: 'system',
      content: `Bạn là Kami – AI thông minh. Được tạo ra bởi Nguyễn Đức Thạnh.
📅 Ngày hiện tại: ${currentDate}
${Object.keys(userProfile).length > 0 ? `\n👤 THÔNG TIN NGƯỜI DÙNG:\n${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n` : ''}
${summaryContext}
${searchSection}
💾 Context: ${context.contextInfo.messagesInContext} tin mới + ${context.contextInfo.summariesInContext} summaries
📊 Tổng: ${context.contextInfo.totalMessages} tin, ${context.contextInfo.totalSummaries} summaries

# Nguyên tắc
- Ưu tiên sự thật, bằng chứng và logic. Không bịa đặt.
- Phân biệt rõ: sự kiện đã được kiểm chứng / giả thuyết / ý kiến cá nhân.
- Nếu không biết hoặc không chắc, nói thẳng không đoán mò.
- Trả lời bằng ngôn ngữ người dùng đang dùng.`
    };
    
    const messages = [systemPrompt, ...workingMemory];
    console.log(`🤖 Calling AI with ${workingMemory.length} messages...`);
    
    const chatCompletion = await callGroqWithRetry(userId, messages);
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';
    console.log(`✅ AI responded`);
    
    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    await saveShortTermMemory(userId, finalConversationId, conversationHistory);
    responseCache.set(responseCacheKey, assistantMessage);
    
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
      }).catch(err => console.error('Background extract error:', err));
    }
    
    if (redis) {
      const chatKey = `chat:${userId}:${finalConversationId}`;
      const ttl = await redis.ttl(chatKey);
      if (ttl > 0 && ttl < 2 && conversationHistory.length >= 3) {
        console.log(`⚠ Safety extract...`);
        callTempGroqWithRetry(userId, async (groq) => {
          const newInfo = await extractPersonalInfo(groq, conversationHistory);
          if (Object.keys(newInfo).length > 0) {
            const updatedProfile = mergeProfile(userProfile, newInfo);
            await saveLongTermMemory(userId, updatedProfile);
            console.log(`✅ Safety profile saved`);
          }
          return newInfo;
        }).catch(err => console.error('Background safety extract error:', err));
      }
    }
    
    const responseTime = Date.now() - startTime;
    if (IS_DEV) {
      const nonCached = stats.perf.totalRequests - stats.perf.responseCacheHits;
      if (nonCached > 0) {
        stats.perf.totalResponseTime = (stats.perf.totalResponseTime || 0) + responseTime;
        if (stats.perf.totalRequests % 10 === 0) {
          console.log(`📊 Stats:`, {
            totalRequests: stats.perf.totalRequests,
            responseCacheHitRate: `${Math.round(stats.perf.responseCacheHits / stats.perf.totalRequests * 100)}%`,
            avgResponseTime: `${Math.round(stats.perf.totalResponseTime / nonCached)}ms`,
            searchCacheHitRate: stats.search.total > 0 ? `${Math.round(stats.search.cacheHits / stats.search.total * 100)}%` : 'N/A'
          });
        }
      }
    }
    
    console.log(`⚡ Response time: ${responseTime}ms`);
    return res.status(200).json({
      success: true, message: assistantMessage, userId,
      conversationId: finalConversationId, responseTime,
      stats: {
        totalMessages: conversationHistory.length,
        workingMemorySize: workingMemory.length,
        summariesCount: summaries.length,
        summariesInContext: context.contextInfo.summariesInContext,
        userProfileFields: Object.keys(userProfile).length,
        storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory',
        searchUsed: !!searchResult,
        searchSource: searchResult?.source || null,
        modelUsed: 'llama-3.3-70b-versatile',
        cached: false
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error', errorType: error.name || 'Unknown', details: process.env.NODE_ENV === 'development' ? error.stack : undefined });
  }
}
