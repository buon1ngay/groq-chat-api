import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// Khởi tạo Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

// Danh sách 10 API keys
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

// Cấu hình memory
const MEMORY_CONFIG = {
  SHORT_TERM_DAYS: 7,           // Lịch sử chat tự xóa sau 7 ngày
  WORKING_MEMORY_LIMIT: 30,     // Chỉ lấy 30 tin nhắn gần nhất cho context
  LONG_TERM_DAYS: 365,          // Memory "cứng" tự xóa sau 1 năm không chat
  SUMMARY_THRESHOLD: 40         // Khi > 40 tin nhắn thì tóm tắt
};

// ============ MEMORY FUNCTIONS ============

// 1. Lấy lịch sử chat ngắn hạn (auto-expire 7 ngày)
async function getShortTermMemory(userId, conversationId) {
  const key = `chat:${userId}:${conversationId}`;
  const history = await redis.get(key);
  return history || [];
}

// 2. Lưu lịch sử chat ngắn hạn
async function saveShortTermMemory(userId, conversationId, history) {
  const key = `chat:${userId}:${conversationId}`;
  await redis.set(key, history, {
    ex: MEMORY_CONFIG.SHORT_TERM_DAYS * 86400 // 7 ngày
  });
}

// 3. Lấy memory "cứng" vĩnh viễn (tên, tuổi, sở thích...)
async function getLongTermMemory(userId) {
  const key = `user:profile:${userId}`;
  const profile = await redis.hgetall(key);
  
  // Reset TTL mỗi lần truy cập (1 năm không chat mới xóa)
  if (profile && Object.keys(profile).length > 0) {
    await redis.expire(key, MEMORY_CONFIG.LONG_TERM_DAYS * 86400);
  }
  
  return profile || {};
}

// 4. Lưu memory "cứng" vĩnh viễn
async function saveLongTermMemory(userId, profileData) {
  const key = `user:profile:${userId}`;
  await redis.hset(key, profileData);
  await redis.expire(key, MEMORY_CONFIG.LONG_TERM_DAYS * 86400); // 1 năm
}

// 5. Lấy tóm tắt các tin nhắn cũ
async function getSummary(userId, conversationId) {
  const key = `summary:${userId}:${conversationId}`;
  const summary = await redis.get(key);
  
  if (summary) {
    await redis.expire(key, MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
  }
  
  return summary || '';
}

// 6. Lưu tóm tắt
async function saveSummary(userId, conversationId, summary) {
  const key = `summary:${userId}:${conversationId}`;
  await redis.set(key, summary, {
    ex: MEMORY_CONFIG.SHORT_TERM_DAYS * 86400
  });
}

// 7. Tóm tắt tin nhắn cũ bằng AI
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

// 8. Trích xuất thông tin cá nhân từ hội thoại
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
  let index = await redis.get(key);
  
  if (index === null) {
    index = getRandomKeyIndex();
    await redis.set(key, index, { ex: 86400 }); // Cache 24h
  }
  
  return parseInt(index);
}

async function setUserKeyIndex(userId, index) {
  const key = `keyindex:${userId}`;
  await redis.set(key, index, { ex: 86400 });
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
    const { message, userId = 'default', conversationId = 'default' } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (API_KEYS.length === 0) {
      return res.status(500).json({ error: 'No API keys configured' });
    }

    // 1. Lấy memory từ Redis
    let conversationHistory = await getShortTermMemory(userId, conversationId);
    const userProfile = await getLongTermMemory(userId);
    let existingSummary = await getSummary(userId, conversationId);

    // 2. Thêm tin nhắn mới
    conversationHistory.push({
      role: 'user',
      content: message
    });

    // 3. Xử lý khi vượt quá ngưỡng (> 40 tin nhắn)
    let workingMemory = conversationHistory;
    
    if (conversationHistory.length > MEMORY_CONFIG.SUMMARY_THRESHOLD) {
      // Tách: tin nhắn cũ vs tin nhắn gần đây
      const oldMessages = conversationHistory.slice(0, -MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      workingMemory = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
      
      // Tóm tắt tin nhắn cũ (chỉ làm 1 lần)
      if (!existingSummary) {
        const tempGroq = new Groq({ apiKey: API_KEYS[0] });
        existingSummary = await summarizeOldMessages(tempGroq, oldMessages);
        await saveSummary(userId, conversationId, existingSummary);
      }
    }

    // 4. Xây dựng context cho AI
    const systemPrompt = {
      role: 'system',
      content: `Bạn là trợ lý AI thông minh và hữu ích. Hãy trả lời bằng tiếng Việt.

${Object.keys(userProfile).length > 0 ? `
THÔNG TIN NGƯỜI DÙNG (nhớ lâu dài):
${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}

${existingSummary ? `TÓM TẮT CUỘC TRÒ CHUYỆN TRƯỚC:\n${existingSummary}\n` : ''}`
    };

    const messages = [systemPrompt, ...workingMemory];

    // 5. Gọi AI
    const { groq, chatCompletion } = await callGroqWithRetry(userId, messages);
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    // 6. Lưu phản hồi vào history
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    // 7. Lưu vào Redis
    await saveShortTermMemory(userId, conversationId, conversationHistory);

    // 8. Trích xuất và cập nhật thông tin cá nhân (mỗi 5 tin nhắn)
    if (conversationHistory.length % 10 === 0) {
      const newInfo = await extractPersonalInfo(groq, conversationHistory);
      if (Object.keys(newInfo).length > 0) {
        const updatedProfile = { ...userProfile, ...newInfo };
        await saveLongTermMemory(userId, updatedProfile);
      }
    }

    // 9. Trả về response
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      conversationId,
      stats: {
        totalMessages: conversationHistory.length,
        workingMemorySize: workingMemory.length,
        hasSummary: !!existingSummary,
        userProfileFields: Object.keys(userProfile).length
      }
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
