import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// ✅ Khởi tạo Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ✅ Danh sách API key (xoay khi rate limit)
const API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY2,
  process.env.GROQ_API_KEY3
];
let currentKeyIndex = 0;

// ✅ Hàm tạo Groq client với key hiện tại
function getGroqClient() {
  return new Groq({ apiKey: API_KEYS[currentKeyIndex] });
}

// 🔄 Hàm retry xoay key khi rate limit (dùng cho chat + memory)
async function retryGroq(fn, attempt = 0) {
  try {
    return await fn();
  } catch (error) {
    if (error.message.includes('rate_limit') && attempt < API_KEYS.length) {
      currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
      console.warn(`⚠️ Rate limit reached, switching to key index ${currentKeyIndex}`);
      return retryGroq(fn, attempt + 1);
    } else {
      throw error;
    }
  }
}

// ✅ Hàm extract memory (xoay key)
async function extractMemory(message, currentMemory) {
  try {
    const groq = getGroqClient();
    const extractionPrompt = `Phân tích tin nhắn sau và trích xuất THÔNG TIN CÁ NHÂN QUAN TRỌNG cần lưu lâu dài.
TIN NHẮN CỦA USER:
"${message}"
THÔNG TIN ĐÃ LƯU TRƯỚC ĐÓ:
${JSON.stringify(currentMemory, null, 2)}
HÃY TRẢ VỀ JSON VỚI CẤU TRÚC:
{
  "hasNewInfo": true/false,
  "updates": { "Tên key": "Giá trị mới" },
  "summary": "Tóm tắt ngắn gọn đã lưu gì"
}
CHỈ TRẢ VỀ JSON, KHÔNG CÓ TEXT KHÁC`;

    const response = await retryGroq(() =>
      groq.chat.completions.create({
        messages: [
          { role: 'system', content: 'Bạn là trợ lý phân tích thông tin. Chỉ trả về JSON.' },
          { role: 'user', content: extractionPrompt }
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.3,
        max_tokens: 500
      })
    );

    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('📊 Memory extraction result:', parsed);
      return parsed;
    }
    return { hasNewInfo: false };
  } catch (error) {
    console.error('❌ Memory extraction failed:', error.message);
    return { hasNewInfo: false };
  }
}

// ✅ Build system prompt từ memory
function buildSystemPrompt(memory) {
  let prompt = 'Bạn tên là KAMI, trợ lý AI thông minh, thân thiện. Hãy trả lời bằng tiếng Việt tự nhiên.';
  if (Object.keys(memory).length > 0) {
    prompt += '\n\n📝 Thông tin về người dùng:\n';
    for (const [k, v] of Object.entries(memory)) prompt += `- ${k}: ${v}\n`;
  }
  return prompt;
}

// ✅ Handler chính
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required' });

    console.log(`📨 [${userId}] Message: ${message}`);

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await redis.get(chatKey) || [];
    if (typeof conversationHistory === 'string') conversationHistory = JSON.parse(conversationHistory);

    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') userMemory = JSON.parse(userMemory);

    const lowerMsg = message.toLowerCase();

    // Lệnh đặc biệt
    if (lowerMsg === '/memory' || lowerMsg.includes('bạn nhớ gì về tôi') || lowerMsg.includes('bạn biết gì về tôi')) {
      const memoryText = Object.keys(userMemory).length === 0
        ? '💭 Tôi chưa có thông tin nào về bạn. Hãy chia sẻ nhé!'
        : '📝 Thông tin tôi nhớ về bạn:\n' + Object.entries(userMemory).map(([k,v]) => `• ${k}: ${v}`).join('\n');
      return res.status(200).json({ success: true, message: memoryText, userId, memoryCount: Object.keys(userMemory).length });
    }
    if (lowerMsg === '/forget' || lowerMsg.includes('quên tôi đi') || lowerMsg.includes('xóa thông tin')) {
      await redis.del(memoryKey);
      return res.status(200).json({ success: true, message: '🗑️ Đã xóa toàn bộ thông tin.', userId });
    }
    if (lowerMsg.startsWith('/forget ')) {
      const keyToDelete = message.substring(8).trim();
      if (userMemory[keyToDelete]) {
        delete userMemory[keyToDelete];
        await redis.set(memoryKey, JSON.stringify(userMemory));
        return res.status(200).json({ success: true, message: `🗑️ Đã xóa thông tin: ${keyToDelete}`, userId });
      } else {
        return res.status(200).json({ success: true, message: `❓ Không tìm thấy thông tin: ${keyToDelete}`, userId });
      }
    }

    // Thêm tin nhắn user
    conversationHistory.push({ role: 'user', content: message });
    if (conversationHistory.length > 50) conversationHistory = conversationHistory.slice(-50);

    const systemPrompt = buildSystemPrompt(userMemory);

    // 🔄 Chat chính với retry xoay key
    const assistantMessage = await retryGroq(() =>
      getGroqClient().chat.completions.create({
        messages: [{ role: 'system', content: systemPrompt }, ...conversationHistory],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.7,
        max_tokens: 1024,
        top_p: 0.9,
        stream: false
      }).then(r => r.choices[0]?.message?.content || 'Không có phản hồi')
    );

    // 🔄 Lưu memory (thất bại không block chat)
    const memoryExtraction = await extractMemory(message, userMemory);
    let memoryUpdated = false;
    if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      await redis.set(memoryKey, JSON.stringify(userMemory));
      memoryUpdated = true;
    }

    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    await redis.setex(chatKey, 2592000, JSON.stringify(conversationHistory));

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId,
      conversationId,
      historyLength: conversationHistory.length,
      memoryUpdated,
      memoryCount: Object.keys(userMemory).length
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
}
