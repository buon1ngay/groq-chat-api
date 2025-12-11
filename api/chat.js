import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';
import axios from 'axios';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Upstash Redis client
const redis = Redis.fromEnv();

// Groq API Keys (6 keys xoay vòng)
const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);

// Serper API Keys
const SERPER_KEYS = [
  process.env.SERPER_API_KEY_1,
  process.env.SERPER_API_KEY_2,
  process.env.SERPER_API_KEY_3,
].filter(Boolean);

// Tavily API Keys
const TAVILY_KEYS = [
  process.env.TAVILY_API_KEY_1,
  process.env.TAVILY_API_KEY_2,
  process.env.TAVILY_API_KEY_3,
].filter(Boolean);

// TTL: 90 ngày = 90 * 24 * 60 * 60 giây
const MEMORY_TTL = 90 * 24 * 60 * 60;

// ============================================================================
// KEY ROTATION SYSTEM
// ============================================================================

let groqIndex = 0;
let serperIndex = 0;
let tavilyIndex = 0;

function getNextGroqKey() {
  const key = GROQ_KEYS[groqIndex];
  groqIndex = (groqIndex + 1) % GROQ_KEYS.length;
  return key;
}

function getNextSerperKey() {
  const key = SERPER_KEYS[serperIndex];
  serperIndex = (serperIndex + 1) % SERPER_KEYS.length;
  return key;
}

function getNextTavilyKey() {
  const key = TAVILY_KEYS[tavilyIndex];
  tavilyIndex = (tavilyIndex + 1) % TAVILY_KEYS.length;
  return key;
}

// ============================================================================
// SEARCH FUNCTIONS
// ============================================================================

// Tìm kiếm với Serper
async function searchWithSerper(query) {
  const apiKey = getNextSerperKey();
  if (!apiKey) throw new Error('No Serper API key available');

  const response = await axios.post(
    'https://google.serper.dev/search',
    {
      q: query,
      num: 5
    },
    {
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );

  const results = response.data.organic || [];
  return results.slice(0, 3).map(r => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link
  }));
}

// Tìm kiếm với Tavily
async function searchWithTavily(query) {
  const apiKey = getNextTavilyKey();
  if (!apiKey) throw new Error('No Tavily API key available');

  const response = await axios.post(
    'https://api.tavily.com/search',
    {
      api_key: apiKey,
      query: query,
      search_depth: 'basic',
      max_results: 3
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    }
  );

  return response.data.results.map(r => ({
    title: r.title,
    snippet: r.content,
    link: r.url
  }));
}

// Tìm kiếm thông minh (thử Serper trước, fallback sang Tavily)
async function smartSearch(query) {
  try {
    console.log('Searching with Serper...');
    return await searchWithSerper(query);
  } catch (error) {
    console.log('Serper failed, trying Tavily...', error.message);
    try {
      return await searchWithTavily(query);
    } catch (tavilyError) {
      console.error('Both search engines failed:', tavilyError.message);
      return [];
    }
  }
}

// ============================================================================
// MEMORY MANAGEMENT
// ============================================================================

// Lấy toàn bộ data của user
async function getUserData(userId) {
  const key = `user:${userId}`;
  const data = await redis.get(key);
  
  if (!data) {
    return {
      conversationHistory: [],
      memory: '',
      lastActive: new Date().toISOString()
    };
  }
  
  return data;
}

// Lưu data của user với TTL 90 ngày
async function saveUserData(userId, userData) {
  const key = `user:${userId}`;
  userData.lastActive = new Date().toISOString();
  await redis.setex(key, MEMORY_TTL, userData);
}

// Tạo/cập nhật memory từ lịch sử hội thoại
async function updateMemory(userId, conversationHistory) {
  if (conversationHistory.length < 4) return '';
  
  // Lấy 10 tin nhắn gần nhất để tạo memory
  const recentMessages = conversationHistory.slice(-10);
  const conversationText = recentMessages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  
  try {
    const groq = new Groq({ apiKey: getNextGroqKey() });
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Tóm tắt thông tin quan trọng về user từ cuộc trò chuyện: sở thích, công việc, mối quan tâm, bối cảnh cá nhân. Trả về ngắn gọn 2-3 câu.'
        },
        {
          role: 'user',
          content: conversationText
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 200
    });
    
    return completion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Memory creation failed:', error.message);
    return '';
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Route: GET - Export history
  if (req.method === 'GET') {
    return handleExport(req, res);
  }

  // Route: DELETE - Clear user data
  if (req.method === 'DELETE') {
    return handleClearUser(req, res);
  }

  // Route: POST - Chat
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    const { 
      message, 
      userId,
      needsSearch = false,
      model = 'llama-3.3-70b-versatile'
    } = req.body;

    // Validation
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    if (message.length > 4000) {
      return res.status(400).json({ error: 'Message too long (max 4000 chars)' });
    }

    // Lấy user data
    const userData = await getUserData(userId);
    let { conversationHistory, memory } = userData;

    // Thêm tin nhắn user
    conversationHistory.push({
      role: 'user',
      content: message.trim(),
      timestamp: new Date().toISOString()
    });

    // Giới hạn history: 30 tin nhắn gần nhất
    if (conversationHistory.length > 30) {
      conversationHistory = conversationHistory.slice(-30);
    }

    // Tìm kiếm nếu cần
    let searchResults = [];
    let searchContext = '';
    
    if (needsSearch) {
      console.log('Performing search...');
      searchResults = await smartSearch(message);
      
      if (searchResults.length > 0) {
        searchContext = '\n\n📚 Thông tin tìm kiếm:\n' + 
          searchResults.map((r, i) => 
            `${i + 1}. ${r.title}\n${r.snippet}\nNguồn: ${r.link}`
          ).join('\n\n');
      }
    }

    // Tạo system prompt với memory và search context
    let systemPrompt = 'Bạn là trợ lý AI thông minh, hữu ích và thân thiện. Trả lời bằng tiếng Việt.';
    
    if (memory) {
      systemPrompt += `\n\n💭 Thông tin về user: ${memory}`;
    }
    
    if (searchContext) {
      systemPrompt += searchContext + '\n\nHãy sử dụng thông tin tìm kiếm để trả lời chính xác hơn. Trích dẫn nguồn khi cần.';
    }

    // Gọi Groq API với retry (6 keys)
    let completion;
    let lastError;
    
    for (let attempt = 0; attempt < GROQ_KEYS.length; attempt++) {
      try {
        const apiKey = getNextGroqKey();
        const groq = new Groq({ apiKey });
        
        completion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory.map(({ role, content }) => ({ role, content }))
          ],
          model,
          temperature: 0.7,
          max_tokens: 1500,
          top_p: 0.9
        });
        
        break; // Success
      } catch (error) {
        lastError = error;
        console.error(`Groq API attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt === GROQ_KEYS.length - 1) {
          throw new Error(`All Groq API keys failed: ${error.message}`);
        }
      }
    }

    const assistantMessage = completion.choices[0]?.message?.content || 
      'Xin lỗi, tôi không thể trả lời lúc này.';

    // Lưu phản hồi
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage,
      timestamp: new Date().toISOString()
    });

    // Cập nhật memory mỗi 5 tin nhắn
    if (conversationHistory.length % 10 === 0) {
      console.log('Updating memory...');
      memory = await updateMemory(userId, conversationHistory);
    }

    // Lưu user data với TTL 90 ngày
    await saveUserData(userId, {
      conversationHistory,
      memory
    });

    // Response
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      metadata: {
        userId,
        historyLength: conversationHistory.length,
        hasMemory: !!memory,
        searchPerformed: needsSearch,
        searchResultsCount: searchResults.length,
        responseTime: Date.now() - startTime,
        model,
        expiresIn: `${MEMORY_TTL / 86400} days`
      }
    });

  } catch (error) {
    console.error('Error:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// ============================================================================
// ADDITIONAL ENDPOINTS
// ============================================================================

// Export user data
async function handleExport(req, res) {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const userData = await getUserData(userId);
    
    return res.status(200).json({
      success: true,
      userId,
      data: userData,
      messageCount: userData.conversationHistory.length
    });
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

// Clear user data
async function handleClearUser(req, res) {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    await redis.del(`user:${userId}`);
    
    return res.status(200).json({
      success: true,
      message: 'User data cleared successfully'
    });
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
