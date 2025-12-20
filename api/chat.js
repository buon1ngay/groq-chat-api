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
  WORKING_MEMORY_LIMIT: 30,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40,
  EXTRACT_INTERVAL: 10,
  SEARCH_CACHE_MINUTES: 10
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
    // 🔧 FIX: Upstash hset requires flat key-value pairs
    // Convert {name: "Thạnh", age: "25"} → ["name", "Thạnh", "age", "25"]
    const flatData = Object.entries(data).flat();
    
    if (flatData.length > 0) {
      await redis.hset(key, ...flatData);
      if (ttl) await redis.expire(key, ttl);
    }
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

// ============ SEARCH DETECTION ============

async function shouldSearch(message, groq) {
  const lowerQuery = message.toLowerCase();
  
  const definiteSearchKeywords = [
    'tìm kiếm', 'search', 'tra cứu', 'google', 'bing',
    'tìm đi', 'tìm lại', 'tìm lại đi', 'xem lại', 
    'tìm giúp', 'tra giúp', 'kiểm tra lại', 'search lại',
    'tra lại', 'xác minh', 'chắc chắn không', 'có đúng không',
    'giá bitcoin', 'giá vàng', 'giá dầu', 'tỷ giá',
    'thời tiết', 'nhiệt độ',
    'tin tức', 'mới nhất', 'hiện tại', 'hôm nay', 'bây giờ',
    'bao nhiêu', 'mấy giờ', 'khi nào'
  ];
  
  if (definiteSearchKeywords.some(kw => lowerQuery.includes(kw))) {
    return { needsSearch: true, confidence: 1.0, type: 'realtime' };
  }

  if (message.length < 10) {
    return { needsSearch: false, confidence: 0 };
  }

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
    return analyzeQueryKeywords(message);
  }
}

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

// ============ SMART SEARCH ============

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

    if (searchType === 'realtime') {
      if (SERPER_API_KEY) {
        result = await searchSerper(query);
        if (result) {
          saveToCache(query, result);
          return result;
        }
      }
    }

    if (searchType === 'research') {
      if (TAVILY_API_KEY) {
        result = await searchTavily(query);
        if (result) {
          saveToCache(query, result);
          return result;
        }
      }
    }

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

// ============ 🔧 SMART PROFILE MERGE ============

function smartMergeProfile(oldProfile, newInfo) {
  const merged = { ...oldProfile };
  const changes = [];
  
  for (const [key, value] of Object.entries(newInfo)) {
    const isValidValue = value && 
                        typeof value === 'string' && 
                        value.trim() !== '' && 
                        value !== 'null' && 
                        value !== 'undefined';
    
    if (isValidValue) {
      const oldValue = merged[key];
      merged[key] = value;
      
      if (oldValue && oldValue !== value) {
        changes.push(`${key}: "${oldValue}" → "${value}"`);
      } else if (!oldValue) {
        changes.push(`${key}: NEW → "${value}"`);
      }
    }
  }
  
  return { merged, changes };
}

async function extractPersonalInfo(groq, conversationHistory, currentProfile = {}) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Bạn là trợ lý quản lý thông tin cá nhân. Phân tích cuộc hội thoại và cập nhật profile.

PROFILE HIỆN TẠI:
${Object.keys(currentProfile).length > 0 ? JSON.stringify(currentProfile, null, 2) : 'Chưa có thông tin'}

NHIỆM VỤ:
1. Tìm thông tin cá nhân MỚI từ hội thoại
2. Phát hiện yêu cầu SỬA/CẬP NHẬT thông tin cũ (VD: "sửa tên thành...", "tên là... chứ không phải...")
3. Trả về JSON với các field:

{
  "name": "tên đầy đủ (nếu có update)",
  "age": "tuổi",
  "job": "nghề nghiệp", 
  "hobbies": "sở thích",
  "location": "địa điểm",
  "nickname": "biệt danh/tên thân mật",
  "other": "thông tin bổ sung khác"
}

QUY TẮC:
- Nếu user nói "sửa X thành Y" → trả về field với giá trị Y
- Nếu user nói "tên là A chứ không phải B" → trả về {"name": "A"}
- Nếu user nói "gọi tôi là X" hoặc "gọi tao là X" → trả về {"nickname": "X"}
- CHỈ trả về các field CÓ THÔNG TIN, bỏ qua field rỗng
- Chỉ trả về JSON thuần, không markdown, không giải thích`
        },
        {
          role: 'user',
          content: `Hội thoại gần đây:\n${JSON.stringify(conversationHistory.slice(-10), null, 2)}`
        }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 600
    });
    
    const result = chatCompletion.choices[0]?.message?.content || '{}';
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('Error extracting info:', error);
    return {};
  }
}

// ============ EXTRACT LOGIC ============

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

// ============ 🔧 FIXED: BUILD USER PROFILE STRING ============

function buildUserProfileString(profile) {
  if (!profile || Object.keys(profile).length === 0) {
    return '';
  }

  const lines = [];
  
  // Priority: nickname first
  if (profile.nickname) {
    lines.push(`- Gọi là: ${profile.nickname}`);
  }
  
  if (profile.name) {
    lines.push(`- Tên thật: ${profile.name}`);
  }
  
  // Other fields
  const otherFields = Object.entries(profile)
    .filter(([k]) => k !== 'name' && k !== 'nickname')
    .map(([k, v]) => `- ${k}: ${v}`);
  
  lines.push(...otherFields);
  
  return lines.length > 0 
    ? `\n👤 THÔNG TIN NGƯỜI DÙNG (nhớ lâu dài):\n${lines.join('\n')}\n\n⚠️ Ưu tiên gọi người dùng bằng nickname nếu có!` 
    : '';
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
      const isQuotaError = error.message?.includes('quota') || 
                          error.message?.includes('rate limit') ||
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

    // 1. Load memory
    let conversationHistory = await getShortTermMemory(userId, finalConversationId);
    const userProfile = await getLongTermMemory(userId);
    let existingSummary = await getSummary(userId, finalConversationId);

    console.log(`💾 Loaded ${conversationHistory.length} messages, profile fields: ${Object.keys(userProfile).length}`);

    // 2. AI-powered search detection
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

    // 5. Build context - FIXED SYSTEM PROMPT
    const currentDate = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Build profile string safely
    const profileString = buildUserProfileString(userProfile);
    const summaryString = existingSummary ? `\n📝 TÓM TẮT CUỘC TRÒ CHUYỆN TRƯỚC:\n${existingSummary}\n` : '';
    const searchString = searchResult ? `\n${formatSearchResult(searchResult)}\n⚠ Hãy ưu tiên sử dụng thông tin tìm kiếm ở trên để trả lời câu hỏi.\n` : '';

    const systemPrompt = {
      role: 'system',
      content: `Bạn là Kami, một AI thông minh và thân thiện được tạo ra bởi Nguyễn Đức Thạnh. Hãy trả lời bằng tiếng Việt tự nhiên và không lặp lại cùng một nội dung nhiều lần. Có thể thêm emoji tùy ngữ cảnh để trò chuyện thêm sinh động.

📅 Ngày hiện tại: ${currentDate}${profileString}${summaryString}${searchString}`
    };

    const messages = [systemPrompt, ...workingMemory];

    // 6. Call AI
    console.log(`🤖 Calling AI with ${workingMemory.length} messages${searchResult ? ' + search' : ''}...`);
    const { groq, chatCompletion } = await callGroqWithRetry(userId, messages);
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    console.log(`✅ AI responded`);

    // 7. Save response to FULL conversationHistory
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    // 8. Smart extract with proper merge
    if (await shouldExtractNow(userId, finalConversationId, conversationHistory)) {
      console.log(`🔍 Extracting personal info (${conversationHistory.length} messages)...`);
      const newInfo = await extractPersonalInfo(groq, conversationHistory, userProfile);
      
      if (Object.keys(newInfo).length > 0) {
        const { merged, changes } = smartMergeProfile(userProfile, newInfo);
        
        if (changes.length > 0) {
          await saveLongTermMemory(userId, merged);
          await markExtracted(userId, finalConversationId, conversationHistory);
          console.log(`✅ Profile updated (${changes.length} changes):`);
          changes.forEach(change => console.log(`   - ${change}`));
        } else {
          await markExtracted(userId, finalConversationId, conversationHistory);
          console.log(`ℹ No meaningful changes detected`);
        }
      } else {
        await markExtracted(userId, finalConversationId, conversationHistory);
        console.log(`ℹ No new personal info found`);
      }
    }

    // 9. Safety check: Extract before expire (< 2 days)
    if (redis) {
      const chatKey = `chat:${userId}:${finalConversationId}`;
      const ttl = await redis.ttl(chatKey);
      const daysRemaining = ttl / 86400;
      
      if (daysRemaining > 0 && daysRemaining < 2 && conversationHistory.length >= 3) {
        console.log(`⚠ Safety extract - TTL < 2 days`);
        const newInfo = await extractPersonalInfo(groq, conversationHistory, userProfile);
        if (Object.keys(newInfo).length > 0) {
          const { merged } = smartMergeProfile(userProfile, newInfo);
          await saveLongTermMemory(userId, merged);
        }
      }
    }

    // 10. Response
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
        userProfile: userProfile,
        storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory',
        searchUsed: !!searchResult,
        searchSource: searchResult?.source || null,
        cacheSize: searchCache.size,
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
