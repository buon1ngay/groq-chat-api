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
const searchCache = new Map();

// ============ API KEYS ============
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

// ============ NEW: IMAGE GENERATION KEYS ============
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

// ============ CONFIGS ============
const MEMORY_CONFIG = {
  SHORT_TERM_DAYS: 14,
  WORKING_MEMORY_LIMIT: 30,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40,
  EXTRACT_INTERVAL: 10,
  SEARCH_CACHE_MINUTES: 10
};

// ============ NEW: IMAGE CONFIG ============
const IMAGE_CONFIG = {
  CACHE_TTL_MINUTES: 30,
  REQUEST_TIMEOUT: 15000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  MAX_CACHE_SIZE: 50
};

const IMAGE_DETECTION_KEYWORDS = [
  // Tiếng Việt
  'tạo ảnh', 'vẽ ảnh', 'generate image', 'tạo hình', 
  'vẽ cho tôi', 'vẽ giúp tôi', 'làm ảnh', 'design ảnh',
  'minh họa', 'hình ảnh về', 'ảnh về', 'tạo hình ảnh',
  // Tiếng Anh
  'draw', 'create image', 'generate picture', 'make image',
  'illustrate', 'visualize', 'picture of', 'image of', 'draw me'
];

// ============ NEW: IMAGE PROVIDERS ============
const IMAGE_PROVIDERS = [
  {
    name: 'HuggingFace-FLUX',
    endpoint: 'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
    enabled: !!HUGGINGFACE_API_KEY,
    priority: 1,
    description: 'FLUX.1 Schnell - Fastest, high quality'
  },
  {
    name: 'HuggingFace-SD3',
    endpoint: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-3-medium',
    enabled: !!HUGGINGFACE_API_KEY,
    priority: 2,
    description: 'Stable Diffusion 3 - Balanced'
  },
  {
    name: 'HuggingFace-SDXL',
    endpoint: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
    enabled: !!HUGGINGFACE_API_KEY,
    priority: 3,
    description: 'SDXL - Classic, reliable'
  }
];

// ============ NEW: IMAGE CACHE CLASS ============
class ImageCache {
  constructor() {
    this.cache = new Map();
    this.accessCount = new Map();
  }

  getCacheKey(prompt, provider) {
    const normalized = prompt.toLowerCase().trim().replace(/\s+/g, ' ');
    return `${provider}:${normalized}`;
  }

  get(prompt, provider) {
    const key = this.getCacheKey(prompt, provider);
    const cached = this.cache.get(key);

    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    const maxAge = IMAGE_CONFIG.CACHE_TTL_MINUTES * 60 * 1000;

    if (age > maxAge) {
      this.cache.delete(key);
      this.accessCount.delete(key);
      return null;
    }

    this.accessCount.set(key, (this.accessCount.get(key) || 0) + 1);
    console.log(`✅ Image Cache HIT: ${prompt.substring(0, 30)}...`);
    return cached.imageData;
  }

  set(prompt, provider, imageData) {
    const key = this.getCacheKey(prompt, provider);

    if (this.cache.size >= IMAGE_CONFIG.MAX_CACHE_SIZE) {
      this.evictLeastUsed();
    }

    this.cache.set(key, { imageData, timestamp: Date.now() });
    this.accessCount.set(key, 1);
    console.log(`💾 Cached image: ${prompt.substring(0, 30)}...`);
  }

  evictLeastUsed() {
    let minAccess = Infinity;
    let leastUsedKey = null;

    for (const [key, count] of this.accessCount.entries()) {
      if (count < minAccess) {
        minAccess = count;
        leastUsedKey = key;
      }
    }

    if (leastUsedKey) {
      this.cache.delete(leastUsedKey);
      this.accessCount.delete(leastUsedKey);
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: IMAGE_CONFIG.MAX_CACHE_SIZE,
      totalAccesses: Array.from(this.accessCount.values()).reduce((a, b) => a + b, 0)
    };
  }
}

const imageCache = new ImageCache();

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

// ============ NEW: IMAGE GENERATION HELPERS ============

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryImageGeneration(fn, providerName, maxRetries = IMAGE_CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = 
        error.response?.status === 503 ||
        error.response?.status === 429 ||
        error.code === 'ECONNABORTED' ||
        error.message?.includes('timeout');

      if (!isRetryable || isLastAttempt) {
        throw error;
      }

      const delay = IMAGE_CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`⚠️ ${providerName} failed (attempt ${attempt}/${maxRetries}). Retry in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

async function generateImageWithProvider(prompt, provider) {
  return await retryWithBackoff(async () => {
    console.log(`🎨 Generating with ${provider.name}...`);

    const response = await axios.post(
      provider.endpoint,
      { inputs: prompt },
      {
        headers: {
          'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: IMAGE_CONFIG.REQUEST_TIMEOUT
      }
    );

    const contentType = response.headers['content-type'];
    if (!contentType?.includes('image')) {
      const text = Buffer.from(response.data).toString('utf-8');
      throw new Error(`Not an image response: ${text.substring(0, 100)}`);
    }

    const base64 = Buffer.from(response.data).toString('base64');
    const imageData = `data:image/png;base64,${base64}`;

    console.log(`✅ ${provider.name} success!`);
    return { imageData, provider: provider.name };

  }, provider.name);
}

async function generateImage(prompt) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('Prompt is required');
  }

  const cleanPrompt = prompt.trim();
  const providers = IMAGE_PROVIDERS.filter(p => p.enabled).sort((a, b) => a.priority - b.priority);

  if (providers.length === 0) {
    throw new Error('No image providers configured. Please set HUGGINGFACE_API_KEY.');
  }

  const errors = [];

  for (const provider of providers) {
    try {
      // Check cache
      const cached = imageCache.get(cleanPrompt, provider.name);
      if (cached) {
        return { imageData: cached, provider: provider.name, cached: true, timestamp: Date.now() };
      }

      // Generate new
      const result = await generateImageWithProvider(cleanPrompt, provider);
      imageCache.set(cleanPrompt, provider.name, result.imageData);
      return { ...result, cached: false, timestamp: Date.now() };

    } catch (error) {
      console.error(`❌ ${provider.name} failed:`, error.message);
      errors.push({ provider: provider.name, error: error.message });
      continue;
    }
  }

  throw new Error(`All providers failed:\n${errors.map(e => `- ${e.provider}: ${e.error}`).join('\n')}`);
}

function detectImageRequest(message) {
  const lower = message.toLowerCase();
  const hasKeyword = IMAGE_DETECTION_KEYWORDS.some(kw => lower.includes(kw));
  
  if (hasKeyword) {
    let prompt = message;
    for (const kw of IMAGE_DETECTION_KEYWORDS) {
      if (lower.includes(kw)) {
        const index = lower.indexOf(kw);
        prompt = message.substring(index + kw.length).trim();
        break;
      }
    }
    
    return {
      isImageRequest: true,
      prompt: prompt || message,
      originalMessage: message
    };
  }
  
  return { isImageRequest: false, prompt: null, originalMessage: message };
}

// ============ SEARCH APIs ============
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

async function searchWikipedia(query) {
  try {
    return await retryWithBackoff(async () => {
      const searchUrl = 'https://vi.wikipedia.org/w/api.php';
      const searchResponse = await axios.get(searchUrl, {
        params: { action: 'opensearch', search: query, limit: 3, format: 'json' },
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

async function searchSerper(query) {
  if (!SERPER_API_KEY) return null;

  try {
    return await retryWithBackoff(async () => {
      const response = await axios.post('https://google.serper.dev/search', {
        q: query, gl: 'vn', hl: 'vi', num: 5
      }, {
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: 4000
      });

      const results = response.data.organic || [];
      if (results.length === 0) return null;

      return {
        source: 'Serper',
        confidence: 0.95,
        results: results.slice(0, 3).map(r => ({ title: r.title, snippet: r.snippet, url: r.link }))
      };
    });
  } catch (error) {
    console.error('Serper search error:', error.message);
    return null;
  }
}

async function searchTavily(query) {
  if (!TAVILY_API_KEY) return null;

  try {
    return await retryWithBackoff(async () => {
      const response = await axios.post('https://api.tavily.com/search', {
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 3
      }, { timeout: 4000 });

      const data = response.data;
      return {
        source: 'Tavily',
        confidence: 0.85,
        answer: data.answer,
        results: data.results?.slice(0, 3).map(r => ({ title: r.title, snippet: r.content, url: r.url }))
      };
    });
  } catch (error) {
    console.error('Tavily search error:', error.message);
    return null;
  }
}

async function shouldSearch(message, groq) {
  const lowerQuery = message.toLowerCase();
  
  const definiteSearchKeywords = [
    'tìm kiếm', 'search', 'tra cứu', 'google', 'bing',
    'tìm đi', 'tìm lại', 'xem lại', 'tìm giúp', 'tra giúp',
    'giá bitcoin', 'giá vàng', 'tỷ giá', 'thời tiết', 'nhiệt độ',
    'tin tức', 'mới nhất', 'hiện tại', 'hôm nay', 'bây giờ'
  ];
  
  if (definiteSearchKeywords.some(kw => lowerQuery.includes(kw))) {
    return { needsSearch: true, confidence: 1.0, type: 'realtime' };
  }

  if (message.length < 10) {
    return { needsSearch: false, confidence: 0 };
  }

  try {
    const prompt = `Phân tích câu hỏi sau và xác định có cần tìm kiếm không:
Câu hỏi: "${message}"
Trả về JSON: {"needsSearch": true/false, "type": "knowledge/realtime/research/none", "reason": "lý do"}`;

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
    return analyzeQueryKeywords(message);
  }
}

function analyzeQueryKeywords(query) {
  const lowerQuery = query.toLowerCase();
  const realtimeKeywords = ['giá', 'bao nhiêu', 'thời tiết', 'tin tức'];
  const knowledgeKeywords = ['là ai', 'là gì', 'định nghĩa', 'lịch sử', 'giải thích'];
  
  if (realtimeKeywords.some(kw => lowerQuery.includes(kw))) {
    return { needsSearch: true, confidence: 0.9, type: 'realtime' };
  }
  if (knowledgeKeywords.some(kw => lowerQuery.includes(kw))) {
    return { needsSearch: true, confidence: 0.8, type: 'knowledge' };
  }
  return { needsSearch: false, confidence: 0.3 };
}

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
  
  console.log(`✅ Search cache hit for: ${query.substring(0, 30)}...`);
  return cached.result;
}

function saveToCache(query, result) {
  const key = getCacheKey(query);
  searchCache.set(key, { result, timestamp: Date.now() });
  
  if (searchCache.size > 100) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
}

async function smartSearch(query, searchType, groq) {
  const cached = getFromCache(query);
  if (cached) return cached;

  console.log(`🔍 Search type: ${searchType} for query: "${query.substring(0, 50)}..."`);

  let result = null;

  try {
    if (searchType === 'knowledge') {
      result = await searchWikipedia(query);
      if (result) {
        saveToCache(query, result);
        return result;
      }
    }

    if (searchType === 'realtime' && SERPER_API_KEY) {
      result = await searchSerper(query);
      if (result) {
        saveToCache(query, result);
        return result;
      }
    }

    if (searchType === 'research' && TAVILY_API_KEY) {
      result = await searchTavily(query);
      if (result) {
        saveToCache(query, result);
        return result;
      }
    }

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
    formatted += `📌 ${searchData.title}\n${searchData.extract}\n🔗 ${searchData.url}`;
  } else if (searchData.source === 'Serper') {
    searchData.results.forEach((r, i) => {
      formatted += `${i + 1}. ${r.title}\n   ${r.snippet}\n   🔗 ${r.url}\n\n`;
    });
  } else if (searchData.source === 'Tavily') {
    if (searchData.answer) {
      formatted += `💡 ${searchData.answer}\n\n`;
    }
    if (searchData.results) {
      formatted += `Chi tiết:\n`;
      searchData.results.forEach((r, i) => {
        formatted += `${i + 1}. ${r.title}\n   ${r.snippet.substring(0, 150)}...\n   🔗 ${r.url}\n\n`;
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
  
  if (Array.isArray(history)) return history;
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
        { role: 'system', content: 'Hãy tóm tắt cuộc hội thoại sau thành 2-3 câu ngắn gọn.' },
        { role: 'user', content: `Tóm tắt:\n${JSON.stringify(oldMessages)}` }
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
          content: `Trích xuất thông tin cá nhân từ cuộc hội thoại theo JSON:
{"name": "tên", "age": "tuổi", "job": "nghề", "hobbies": "sở thích", "location": "nơi ở", "other": "khác"}
Chỉ trả về JSON, không text thừa. Nếu không có thì trả về {}.`
        },
        { role: 'user', content: JSON.stringify(conversationHistory.slice(-10)) }
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

async function shouldExtractNow(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  const lastExtract = await getData(key);
  
  if (!lastExtract) {
    return conversationHistory.length >= 5;
  }
  
  try {
    const lastExtractData = JSON.parse(lastExtract);
    const timeSince = Date.now() - lastExtractData.timestamp;
    const messagesSince = conversationHistory.length - lastExtractData.messageCount;
    
    const shouldExtractByTime = timeSince > 300000 && messagesSince >= 3;
    const shouldExtractByCount = messagesSince >= 10;
    
    return shouldExtractByTime || shouldExtractByCount;
  } catch (error) {
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

    console.log(`📱 Request from userId: ${userId}`);

    // ============ NEW: IMAGE REQUEST DETECTION ============
    const imageDetection = detectImageRequest(message);

    if (imageDetection.isImageRequest) {
      console.log(`🎨 Image request detected: "${imageDetection.prompt}"`);

      // Check if Hugging Face key is configured
      if (!HUGGINGFACE_API_KEY) {
        const errorMsg = '⚠️ Image generation không khả dụng. Vui lòng cấu hình HUGGINGFACE_API_KEY trong .env';
        
        let conversationHistory = await getShortTermMemory(userId, finalConversationId);
        conversationHistory.push({ role: 'user', content: message.trim() });
        conversationHistory.push({ role: 'assistant', content: errorMsg });
        await saveShortTermMemory(userId, finalConversationId, conversationHistory);

        return res.status(200).json({
          success: true,
          message: errorMsg,
          userId,
          conversationId: finalConversationId,
          imageGeneration: false,
          error: 'HUGGINGFACE_API_KEY not configured'
        });
      }

      try {
        // Load conversation history
        let conversationHistory = await getShortTermMemory(userId, finalConversationId);

        // Add user message
        conversationHistory.push({
          role: 'user',
          content: message.trim()
        });

        // Generate image
        console.log(`🎨 Generating image: "${imageDetection.prompt}"`);
        const imageResult = await generateImage(imageDetection.prompt);

        // Add assistant message with image
        conversationHistory.push({
          role: 'assistant',
          content: '🎨 Tôi đã tạo ảnh cho bạn!',
          imageData: imageResult.imageData,
          imageMetadata: {
            provider: imageResult.provider,
            cached: imageResult.cached,
            timestamp: imageResult.timestamp,
            prompt: imageDetection.prompt
          }
        });

        // Save to memory
        await saveShortTermMemory(userId, finalConversationId, conversationHistory);

        console.log(`✅ Image generated successfully with ${imageResult.provider}${imageResult.cached ? ' (cached)' : ''}`);

        return res.status(200).json({
          success: true,
          message: '🎨 Tôi đã tạo ảnh cho bạn!',
          imageData: imageResult.imageData,
          imageMetadata: {
            provider: imageResult.provider,
            cached: imageResult.cached,
            timestamp: imageResult.timestamp,
            prompt: imageDetection.prompt
          },
          userId,
          conversationId: finalConversationId,
          stats: {
            totalMessages: conversationHistory.length,
            imageGeneration: true,
            imageCacheSize: imageCache.getStats().size,
            imageCacheHits: imageCache.getStats().totalAccesses
          }
        });

      } catch (error) {
        console.error('❌ Image generation failed:', error);

        // Fallback: Save error message to conversation
        let conversationHistory = await getShortTermMemory(userId, finalConversationId);
        
        conversationHistory.push({ role: 'user', content: message.trim() });
        
        const errorMessage = `Xin lỗi, tôi không thể tạo ảnh lúc này. Lỗi: ${error.message}`;
        conversationHistory.push({ role: 'assistant', content: errorMessage });
        
        await saveShortTermMemory(userId, finalConversationId, conversationHistory);

        return res.status(200).json({
          success: true,
          message: errorMessage,
          imageData: null,
          userId,
          conversationId: finalConversationId,
          stats: {
            totalMessages: conversationHistory.length,
            imageGeneration: false,
            imageError: error.message
          }
        });
      }
    }

    // ============ NORMAL CHAT FLOW (existing code) ============

    // 1. Load memory
    let conversationHistory = await getShortTermMemory(userId, finalConversationId);
    const userProfile = await getLongTermMemory(userId);
    let existingSummary = await getSummary(userId, finalConversationId);

    console.log(`💾 Loaded ${conversationHistory.length} messages`);

    // 2. Search detection
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

    // 3. Add user message
    conversationHistory.push({
      role: 'user',
      content: message.trim()
    });

    // 4. Handle summary
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
      content: `Bạn là Kami, một AI thông minh và thân thiện được tạo ra bởi Nguyễn Đức Thạnh. Hãy trả lời bằng tiếng Việt tự nhiên và không lặp lại cùng một nội dung nhiều lần. Có thể thêm emoji tùy ngữ cảnh để trò chuyện thêm sinh động.
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

    // 7. Save response
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    // 8. Extract personal info
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
            if (trimmed !== '') {
              updatedProfile[key] = trimmed;
            }
          } else {
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
        await markExtracted(userId, finalConversationId, conversationHistory);
        console.log(`ℹ No new personal info found`);
      }
    }

    // Safety extract before expire
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
        searchCacheSize: searchCache.size,
        imageCacheSize: imageCache.getStats().size,
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

