import Groq from 'groq-sdk';
import Redis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';

// Redis client (thay Map() để persistent storage)
const redis = new Redis(process.env.REDIS_URL);

// Rate limiter: 20 requests/phút/user
const rateLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'chatbot_rl',
  points: 20,
  duration: 60,
});

// Khởi tạo Groq với fallback API keys
const groqClients = [
  new Groq({ apiKey: process.env.GROQ_API_KEY_1 }),
  new Groq({ apiKey: process.env.GROQ_API_KEY_2 }),
  new Groq({ apiKey: process.env.GROQ_API_KEY_3 }),
].filter(client => client.apiKey);

let currentClientIndex = 0;

// Helper: Lấy Groq client với rotation
function getGroqClient() {
  const client = groqClients[currentClientIndex];
  currentClientIndex = (currentClientIndex + 1) % groqClients.length;
  return client;
}

// Helper: Đếm tokens (ước lượng)
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Helper: Lấy conversation từ Redis
async function getConversation(memoryKey) {
  const data = await redis.get(memoryKey);
  return data ? JSON.parse(data) : [];
}

// Helper: Lưu conversation vào Redis (TTL: 7 ngày)
async function saveConversation(memoryKey, history) {
  await redis.setex(memoryKey, 7 * 24 * 60 * 60, JSON.stringify(history));
}

// Main handler
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Route handling
  if (req.method === 'GET' && req.query.action === 'export') {
    return handleExport(req, res);
  }
  
  if (req.method === 'DELETE') {
    return handleClearConversation(req, res);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    const { 
      message, 
      userId = 'default', 
      conversationId = 'default',
      stream = false,
      model = 'llama-3.3-70b-versatile'
    } = req.body;

    // Validation
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (message.length > 4000) {
      return res.status(400).json({ error: 'Message too long (max 4000 chars)' });
    }

    // Rate limiting
    try {
      await rateLimiter.consume(userId);
    } catch (rateLimiterRes) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil(rateLimiterRes.msBeforeNext / 1000)
      });
    }

    const memoryKey = `chat:${userId}:${conversationId}`;
    let conversationHistory = await getConversation(memoryKey);

    // Thêm tin nhắn user
    conversationHistory.push({
      role: 'user',
      content: message.trim(),
      timestamp: new Date().toISOString()
    });

    // Giới hạn history: giữ 20 tin nhắn gần nhất
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }

    // Tính tổng tokens
    const totalTokens = conversationHistory.reduce((sum, msg) => 
      sum + estimateTokens(msg.content), 0
    );

    // Gọi Groq API với retry logic
    let chatCompletion;
    let lastError;
    
    for (let i = 0; i < groqClients.length; i++) {
      try {
        const groq = getGroqClient();
        
        chatCompletion = await groq.chat.completions.create({
          messages: [
            {
              role: 'system',
              content: 'Bạn là trợ lý AI thông minh, hữu ích và thân thiện. Hãy trả lời bằng tiếng Việt một cách tự nhiên và súc tích.'
            },
            ...conversationHistory.map(({ role, content }) => ({ role, content }))
          ],
          model,
          temperature: 0.7,
          max_tokens: 1024,
          top_p: 0.9,
          stream: false
        });
        
        break; // Success, thoát loop
      } catch (error) {
        lastError = error;
        console.error(`API key ${i + 1} failed:`, error.message);
        
        if (i === groqClients.length - 1) {
          throw error; // Hết API keys, throw error
        }
      }
    }

    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Xin lỗi, tôi không thể trả lời lúc này.';

    // Lưu phản hồi
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage,
      timestamp: new Date().toISOString()
    });

    await saveConversation(memoryKey, conversationHistory);

    // Logging
    console.log({
      userId,
      conversationId,
      responseTime: Date.now() - startTime,
      tokens: totalTokens,
      model
    });

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      metadata: {
        conversationId,
        historyLength: conversationHistory.length,
        estimatedTokens: totalTokens,
        responseTime: Date.now() - startTime,
        model
      }
    });

  } catch (error) {
    console.error('Error:', {
      message: error.message,
      stack: error.stack,
      userId: req.body?.userId
    });

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// Export conversation history
async function handleExport(req, res) {
  try {
    const { userId = 'default', conversationId = 'default' } = req.query;
    const memoryKey = `chat:${userId}:${conversationId}`;
    
    const history = await getConversation(memoryKey);
    
    return res.status(200).json({
      success: true,
      conversationId,
      messageCount: history.length,
      messages: history
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Clear conversation
async function handleClearConversation(req, res) {
  try {
    const { userId = 'default', conversationId = 'default' } = req.body;
    const memoryKey = `chat:${userId}:${conversationId}`;
    
    await redis.del(memoryKey);
    
    return res.status(200).json({
      success: true,
      message: 'Conversation cleared'
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
