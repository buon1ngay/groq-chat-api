import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';
import axios from 'axios';

// ============ REDIS & API KEYS ============

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
  SHORT_TERM_DAYS: 7,
  WORKING_MEMORY_LIMIT: 30,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40
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

// ============ SEARCH APIs ============

// 1. Wikipedia API (FREE ∞)
async function searchWikipedia(query, language = 'vi') {
  try {
    // Bước 1: Search để tìm tên bài viết chính xác
    const searchUrl = `https://${language}.wikipedia.org/w/api.php`;
    const searchResponse = await axios.get(searchUrl, {
      params: {
        action: 'opensearch',
        search: query,
        limit: 1,
        format: 'json'
      },
      timeout: 5000
    });

    const titles = searchResponse.data[1];
    if (!titles || titles.length === 0) {
      return null;
    }

    const pageTitle = titles[0];

    // Bước 2: Lấy summary của bài viết
    const summaryUrl = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
    const summaryResponse = await axios.get(summaryUrl, {
      timeout: 5000
    });

    const data = summaryResponse.data;
    
    return {
      source: 'Wikipedia',
      title: data.title,
      extract: data.extract,
      url: data.content_urls.desktop.page,
      thumbnail: data.thumbnail?.source
    };

  } catch (error) {
    console.error('Wikipedia search error:', error.message);
    return null;
  }
}

// 2. Serper.dev API (2500 free/month)
async function searchSerper(query) {
  if (!SERPER_API_KEY) {
    console.warn('⚠️ Serper API key not configured');
    return null;
  }

  try {
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

    const results = response.data.organic || [];
    if (results.length === 0) return null;

    return {
      source: 'Serper',
      results: results.slice(0, 3).map(r => ({
        title: r.title,
        snippet: r.snippet,
        url: r.link
      }))
    };

  } catch (error) {
    console.error('Serper search error:', error.message);
    return null;
  }
}

// 3. Tavily AI (1000 free/month)
async function searchTavily(query) {
  if (!TAVILY_API_KEY) {
    console.warn('⚠️ Tavily API key not configured');
    return null;
  }

  try {
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
      answer: data.answer,
      results: data.results?.slice(0, 3).map(r => ({
        title: r.title,
        snippet: r.content,
        url: r.url
      }))
    };

  } catch (error) {
    console.error('Tavily search error:', error.message);
    return null;
  }
}

// ============ SMART SEARCH ROUTER ============

function analyzeQuery(query) {
  const lowerQuery = query.toLowerCase();
  
  // Real-time keywords
  const realtimeKeywords = ['giá', 'hôm nay', 'hiện tại', 'mới nhất', 'tin tức', 'thời tiết', 'bao nhiêu'];
  const hasRealtime = realtimeKeywords.some(kw => lowerQuery.includes(kw));
  
  // Knowledge keywords
  const knowledgeKeywords = ['là ai', 'là gì', 'định nghĩa', 'lịch sử', 'giải thích', 'ý nghĩa'];
  const hasKnowledge = knowledgeKeywords.some(kw => lowerQuery.includes(kw));
  
  // Research keywords
  const researchKeywords = ['so sánh', 'khác nhau', 'tốt hơn', 'nên chọn', 'đánh giá'];
  const hasResearch = researchKeywords.some(kw => lowerQuery.includes(kw));
  
  return {
    needsSearch: hasRealtime || hasKnowledge || hasResearch,
    preferWikipedia: hasKnowledge && !hasRealtime,
    preferSerper: hasRealtime,
    preferTavily: hasResearch
  };
}

async function smartSearch(query, userId) {
  const analysis = analyzeQuery(query);
  
  if (!analysis.needsSearch) {
    return null;
  }

  console.log(`🔍 Search strategy:`, analysis);

  let result = null;

  // Strategy 1: Ưu tiên Wikipedia (free ∞)
  if (analysis.preferWikipedia) {
    console.log(`📚 Trying Wikipedia first...`);
    result = await searchWikipedia(query);
    
    if (result) {
      return formatSearchResult(result);
    }
  }

  // Strategy 2: Real-time → Serper
  if (analysis.preferSerper && SERPER_API_KEY) {
    console.log(`🔍 Trying Serper...`);
    result = await searchSerper(query);
    
    if (result) {
      return formatSearchResult(result);
    }
  }

  // Strategy 3: Research → Tavily
  if (analysis.preferTavily && TAVILY_API_KEY) {
    console.log(`🤖 Trying Tavily...`);
    result = await searchTavily(query);
    
    if (result) {
      return formatSearchResult(result);
    }
  }

  // Fallback: Thử tuần tự nếu chưa có kết quả
  if (!result) {
    console.log(`🔄 Fallback search...`);
    
    // Wikipedia → Serper → Tavily
    result = await searchWikipedia(query);
    if (result) return formatSearchResult(result);
    
    if (SERPER_API_KEY) {
      result = await searchSerper(query);
      if (result) return formatSearchResult(result);
    }
    
    if (TAVILY_API_KEY) {
      result = await searchTavily(query);
      if (result) return formatSearchResult(result);
    }
  }

  return null;
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
  
  if (typeof history === 'string') {
    try {
      return JSON.parse(history);
    } catch {
      return [];
    }
  }
  
  return history || [];
}

async function saveShortTermMemory(userId, conversationId, history) {
  const key = `chat:${userId}:${conversationId}`;
  await setData(key, JSON.stringify(history), MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
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
      model: 'llama-3.3-70b-versatile',
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
      model: 'llama-3.3-70b-versatile',
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
      console.warn('⚠️ Redis not configured - using in-memory storage');
    }

    console.log(`📱 Request from Android - userId: ${userId}, conversationId: ${finalConversationId}`);

    // 1. Lấy memory
    let conversationHistory = await getShortTermMemory(userId, finalConversationId);
    const userProfile = await getLongTermMemory(userId);
    let existingSummary = await getSummary(userId, finalConversationId);

    console.log(`💾 Loaded ${conversationHistory.length} messages, profile fields: ${Object.keys(userProfile).length}`);

    // 2. SEARCH THÔNG TIN MỚI (nếu cần)
    const searchResult = await smartSearch(message, userId);

    // 3. Thêm tin nhắn mới
    conversationHistory.push({
      role: 'user',
      content: message.trim()
    });

    // 4. Xử lý khi vượt quá ngưỡng
    let workingMemory = [...conversationHistory];
    
    if (conversationHistory.length > MEMORY_CONFIG.SUMMARY_THRESHOLD) {
      console.log(`📊 History > ${MEMORY_CONFIG.SUMMARY_THRESHOLD}, creating summary...`);
      
      const oldMessages = conversationHistory.slice(0, -MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      workingMemory = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      
      const tempGroq = new Groq({ apiKey: API_KEYS[0] });
      const newSummary = await summarizeOldMessages(tempGroq, oldMessages);
      
      existingSummary = existingSummary 
        ? `${existingSummary}\n\n[Tiếp tục]: ${newSummary}`
        : newSummary;
        
      await saveSummary(userId, finalConversationId, existingSummary);
      console.log(`✅ Summary created: ${existingSummary.substring(0, 50)}...`);
    }

    // 5. Xây dựng context cho AI
    const currentDate = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const systemPrompt = {
      role: 'system',
      content: `Bạn là trợ lý AI thông minh và hữu ích. Hãy trả lời bằng tiếng Việt.

📅 Ngày hiện tại: ${currentDate}

${Object.keys(userProfile).length > 0 ? `
👤 THÔNG TIN NGƯỜI DÙNG (nhớ lâu dài):
${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}

${existingSummary ? `📝 TÓM TẮT CUỘC TRÒ CHUYỆN TRƯỚC:\n${existingSummary}\n` : ''}

${searchResult ? `\n${searchResult}\n⚠️ Hãy ưu tiên sử dụng thông tin tìm kiếm ở trên để trả lời câu hỏi của người dùng.\n` : ''}`
    };

    const messages = [systemPrompt, ...workingMemory];

    // 6. Gọi AI
    console.log(`🤖 Calling AI with ${workingMemory.length} messages${searchResult ? ' + search results' : ''}...`);
    const { groq, chatCompletion } = await callGroqWithRetry(userId, messages);
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    console.log(`✅ AI responded: ${assistantMessage.substring(0, 50)}...`);

    // 7. Lưu phản hồi
    workingMemory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await saveShortTermMemory(userId, finalConversationId, workingMemory);

    // 8. Trích xuất thông tin cá nhân
    if (workingMemory.length % 10 === 0) {
      console.log(`🔍 Extracting personal info at message ${workingMemory.length}...`);
      const newInfo = await extractPersonalInfo(groq, workingMemory);
      
      if (Object.keys(newInfo).length > 0) {
        const updatedProfile = { ...userProfile, ...newInfo };
        await saveLongTermMemory(userId, updatedProfile);
        console.log(`✅ Updated profile:`, newInfo);
      }
    }

    // 9. Trả về response
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId: userId,
      conversationId: finalConversationId,
      stats: {
        totalMessages: workingMemory.length,
        workingMemorySize: workingMemory.length,
        hasSummary: !!existingSummary,
        userProfileFields: Object.keys(userProfile).length,
        storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory',
        searchUsed: !!searchResult
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
  }
