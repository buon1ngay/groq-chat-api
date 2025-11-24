import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// ✅ Khởi tạo Redis client (persistent storage)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ✅ DANH SÁCH API KEY (xoay khi rate limit)
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3
];
let currentKeyIndex = 0;

// ✅ Hàm tạo Groq client với key hiện tại
function getGroqClient() {
  return new Groq({ apiKey: API_KEYS[currentKeyIndex] });
}

// ✅ HÀM PHÂN TÍCH VÀ TRÍCH XUẤT THÔNG TIN QUAN TRỌNG
async function extractMemory(groq, message, currentMemory) {
  try {
    const extractionPrompt = `Phân tích tin nhắn sau và trích xuất THÔNG TIN CÁ NHÂN QUAN TRỌNG cần lưu lâu dài.

THÔNG TIN CẦN LƯU (nếu có):
- Tên, biệt danh, cách gọi ưa thích
- Nghề nghiệp, công việc hiện tại
- Sở thích, đam mê, thói quen
- Thông tin gia đình (vợ/chồng, con cái, sinh nhật, tên...)
- Địa điểm sống, quê quán
- Mục tiêu, dự định trong tương lai
- Ngôn ngữ lập trình yêu thích (nếu là developer)
- Trình độ học vấn, trường học
- Sức khỏe quan trọng (dị ứng, bệnh mãn tính...)
- Bất kỳ thông tin USER YÊU CẦU BẠN NHỚ

TIN NHẮN CỦA USER:
"${message}"

THÔNG TIN ĐÃ LƯU TRƯỚC ĐÓ:
${JSON.stringify(currentMemory, null, 2)}

HÃY TRẢ VỀ JSON VỚI CẤU TRÚC:
{
  "hasNewInfo": true/false,
  "updates": {
    "Tên key": "Giá trị mới"
  },
  "summary": "Tóm tắt ngắn gọn đã lưu gì"
}

QUY TẮC:
- Chỉ lưu thông tin QUAN TRỌNG, KHÔNG lưu câu hỏi thông thường
- Key phải là tiếng Việt có dấu, dễ hiểu (ví dụ: "Tên", "Nghề nghiệp", "Sở thích")
- Nếu tin nhắn không có thông tin mới, trả về hasNewInfo: false
- CHỈ TRẢ VỀ JSON, KHÔNG CÓ TEXT KHÁC`;

    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Bạn là trợ lý phân tích thông tin. Chỉ trả về JSON đúng format, không thêm markdown hay text khác.' },
        { role: 'user', content: extractionPrompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('📊 Memory extraction result:', parsed);
      return parsed;
    }
    return { hasNewInfo: false };
  } catch (error) {
    console.error('❌ Error extracting memory:', error);
    return { hasNewInfo: false };
  }
}

// ✅ HÀM TẠO SYSTEM PROMPT ĐỘNG TỪ MEMORY
function buildSystemPrompt(memory) {
  let prompt = 'Bạn tên là KAMI. Trợ lý AI thông minh hữu ích và thân thiện. Được tạo ra bởi Nguyễn Đức Thanh. Hãy trả lời bằng tiếng Việt một cách tự nhiên.';
  
  if (Object.keys(memory).length > 0) {
    prompt += '\n\n📝 THÔNG TIN BẠN BIẾT VỀ NGƯỜI DÙNG:\n';
    for (const [key, value] of Object.entries(memory)) {
      prompt += `- ${key}: ${value}\n`;
    }
    prompt += '\n⚠️ QUY TẮC:\n';
    prompt += '- Sử dụng các thông tin này một cách TỰ NHIÊN trong cuộc trò chuyện\n';
    prompt += '- ĐỪNG nhắc đi nhắc lại thông tin trừ khi được hỏi\n';
    prompt += '- Thể hiện bạn NHỚ người dùng qua cách xưng hô, cách nói chuyện phù hợp\n';
  }
  
  return prompt;
}

// ✅ HANDLER CHÍNH
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required' });

    console.log(`📨 [${userId}] Message: ${message}`);

    // REDIS KEYS
    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await redis.get(chatKey) || [];
    if (typeof conversationHistory === 'string') conversationHistory = JSON.parse(conversationHistory);

    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') userMemory = JSON.parse(userMemory);

    // XỬ LÝ LỆNH ĐẶC BIỆT /memory /forget
    const lowerMsg = message.toLowerCase();
    if (lowerMsg === '/memory' || lowerMsg.includes('bạn nhớ gì về tôi') || lowerMsg.includes('bạn biết gì về tôi')) {
      let memoryText = Object.keys(userMemory).length === 0 
        ? '💭 Tôi chưa có thông tin nào về bạn. Hãy chia sẻ với tôi nhé!'
        : '📝 **Thông tin tôi nhớ về bạn:**\n\n' + Object.entries(userMemory).map(([k,v]) => `• **${k}:** ${v}`).join('\n') + `\n\n_Tổng cộng ${Object.keys(userMemory).length} thông tin đã lưu._`;
      return res.status(200).json({ success: true, message: memoryText, userId, memoryCount: Object.keys(userMemory).length });
    }
    if (lowerMsg === '/forget' || lowerMsg.includes('quên tôi đi') || lowerMsg.includes('xóa thông tin')) {
      await redis.del(memoryKey);
      return res.status(200).json({ success: true, message: '🗑️ Đã xóa toàn bộ thông tin về bạn. Chúng ta bắt đầu lại từ đầu nhé!', userId });
    }
    if (lowerMsg.startsWith('/forget ')) {
      const keyToDelete = message.substring(8).trim();
      if (userMemory[keyToDelete]) {
        delete userMemory[keyToDelete];
        await redis.set(memoryKey, JSON.stringify(userMemory));
        return res.status(200).json({ success: true, message: `🗑️ Đã xóa thông tin: **${keyToDelete}**`, userId });
      } else {
        return res.status(200).json({ success: true, message: `❓ Không tìm thấy thông tin: **${keyToDelete}**\n\nGõ /memory để xem danh sách.`, userId });
      }
    }

    // Thêm tin nhắn user vào lịch sử
    conversationHistory.push({ role: 'user', content: message });
    if (conversationHistory.length > 50) conversationHistory = conversationHistory.slice(-50);

    const systemPrompt = buildSystemPrompt(userMemory);

    // 🔄 Hàm retry xoay key
    async function sendChat() {
      try {
        const groq = getGroqClient();
        const chatCompletion = await groq.chat.completions.create({
          messages: [{ role: 'system', content: systemPrompt }, ...conversationHistory],
          model: 'llama-3.3-70b-versatile',
          temperature: 0.7,
          max_tokens: 1024,
          top_p: 0.9,
          stream: false
        });
        return chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';
      } catch (error) {
        if (error.message.includes('rate_limit')) {
          currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
          console.warn(`⚠️ Rate limit reached, switching to key index ${currentKeyIndex}`);
          return sendChat(); // retry với key mới
        } else {
          throw error;
        }
      }
    }

    let assistantMessage = await sendChat();

    // Lưu memory
    const memoryExtraction = await extractMemory(getGroqClient(), message, userMemory);
    let memoryUpdated = false;
    if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      await redis.set(memoryKey, JSON.stringify(userMemory));
      memoryUpdated = true;
      assistantMessage += `\n\n💾 _${memoryExtraction.summary || 'Đã cập nhật thông tin về bạn.'}_`;
    }

    // Lưu phản hồi vào lịch sử
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
