import Groq from 'groq-sdk';

// QUAN TRỌNG: Memory chỉ tồn tại trong 1 session của serverless function
// Để memory thực sự persistent, cần dùng Redis/Database
const conversationMemory = new Map();

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

    // Khởi tạo Groq client
    const groq = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });

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

    // Gọi Groq API với ĐÚNG format
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Bạn là trợ lý AI thông minh và hữu ích. Hãy trả lời bằng tiếng Việt.'
        },
        ...conversationHistory
      ],
      model: 'llama-3.3-70b-versatile', // Hoặc 'mixtral-8x7b-32768'
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 0.9,
      stream: false
    });

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
      historyLength: conversationHistory.length
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
