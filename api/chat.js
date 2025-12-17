import Groq from 'groq-sdk';
const conversationMemory = new Map();
const keyUsageMap = new Map(); // Lưu key hiện tại của mỗi user

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
].filter(key => key); // Lọc bỏ key undefined

// Hàm chọn key ngẫu nhiên cho user mới
function getRandomKeyIndex() {
  return Math.floor(Math.random() * API_KEYS.length);
}

// Hàm lấy key tiếp theo theo thứ tự
function getNextKeyIndex(currentIndex) {
  return (currentIndex + 1) % API_KEYS.length;
}

// Hàm gọi API với retry khi gặp lỗi quota/rate limit
async function callGroqWithRetry(userId, conversationHistory) {
  // Lấy hoặc khởi tạo key index cho user
  if (!keyUsageMap.has(userId)) {
    keyUsageMap.set(userId, getRandomKeyIndex());
  }
  
  let currentKeyIndex = keyUsageMap.get(userId);
  let attempts = 0;
  const maxAttempts = API_KEYS.length;

  while (attempts < maxAttempts) {
    try {
      const apiKey = API_KEYS[currentKeyIndex];
      
      const groq = new Groq({
        apiKey: apiKey
      });

      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'Bạn là trợ lý AI thông minh và hữu ích. Hãy trả lời bằng tiếng Việt.'
          },
          ...conversationHistory
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 2048,
        top_p: 0.9,
        stream: false
      });

      // Thành công - lưu lại key index
      keyUsageMap.set(userId, currentKeyIndex);
      return chatCompletion;

    } catch (error) {
      // Kiểm tra lỗi quota hoặc rate limit
      const isQuotaError = error.message?.includes('quota') || 
                          error.message?.includes('rate limit') ||
                          error.status === 429 ||
                          error.status === 403;

      if (isQuotaError && attempts < maxAttempts - 1) {
        console.log(`Key ${currentKeyIndex + 1} hết quota, chuyển sang key tiếp theo...`);
        currentKeyIndex = getNextKeyIndex(currentKeyIndex);
        attempts++;
        continue;
      }

      // Ném lỗi nếu không phải quota error hoặc đã thử hết keys
      throw error;
    }
  }

  throw new Error('Đã thử hết tất cả API keys nhưng vẫn gặp lỗi');
}

export default async function handler(req, res) {
  // Chỉ chấp nhận POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;

    // Validation
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Kiểm tra có ít nhất 1 API key
    if (API_KEYS.length === 0) {
      return res.status(500).json({ error: 'No API keys configured' });
    }

    // Lấy hoặc tạo conversation history
    const memoryKey = `${userId}_${conversationId}`;
    let conversationHistory = conversationMemory.get(memoryKey) || [];

    // Thêm tin nhắn mới vào history
    conversationHistory.push({
      role: 'user',
      content: message
    });

    // Giới hạn history (giữ 20 tin nhắn gần nhất)
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }

    // Gọi API với retry logic
    const chatCompletion = await callGroqWithRetry(userId, conversationHistory);

    // Lấy phản hồi
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    // Lưu phản hồi vào history
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    // Cập nhật memory
    conversationMemory.set(memoryKey, conversationHistory);

    // Trả về response
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      conversationId: conversationId,
      historyLength: conversationHistory.length,
      apiKeyIndex: keyUsageMap.get(userId) + 1 // Hiển thị key đang dùng (1-10)
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
