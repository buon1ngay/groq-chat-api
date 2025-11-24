import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// ✅ Khởi tạo Redis client (persistent storage)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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
        {
          role: 'system',
          content: 'Bạn là trợ lý phân tích thông tin. Chỉ trả về JSON đúng format, không thêm markdown hay text khác.'
        },
        {
          role: 'user',
          content: extractionPrompt
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0]?.message?.content || '{}';
    
    // Loại bỏ markdown code blocks nếu có
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

    console.log(`📨 [${userId}] Message: ${message}`);

    // Khởi tạo Groq client
    const groq = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });

    // ✅ REDIS KEYS - MỖI USER CÓ MEMORY RIÊNG
    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    console.log(`🔑 Memory key: ${memoryKey}`);

    // ✅ LẤY DỮ LIỆU TỪ REDIS
    let conversationHistory = await redis.get(chatKey) || [];
    if (typeof conversationHistory === 'string') {
      conversationHistory = JSON.parse(conversationHistory);
    }

    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') {
      userMemory = JSON.parse(userMemory);
    }

    console.log(`💾 Current memory for ${userId}:`, userMemory);

    // ✅ XỬ LÝ LỆNH ĐẶC BIỆT

    // Lệnh: Xem memory
    if (message.toLowerCase() === '/memory' || 
        message.toLowerCase() === 'bạn nhớ gì về tôi' ||
        message.toLowerCase() === 'bạn biết gì về tôi') {
      
      let memoryText = '📝 **Thông tin tôi nhớ về bạn:**\n\n';
      
      if (Object.keys(userMemory).length === 0) {
        memoryText = '💭 Tôi chưa có thông tin nào về bạn. Hãy chia sẻ với tôi nhé!';
      } else {
        for (const [key, value] of Object.entries(userMemory)) {
          memoryText += `• **${key}:** ${value}\n`;
        }
        memoryText += `\n_Tổng cộng ${Object.keys(userMemory).length} thông tin đã lưu._`;
      }
      
      return res.status(200).json({
        success: true,
        message: memoryText,
        userId: userId,
        memoryCount: Object.keys(userMemory).length
      });
    }

    // Lệnh: Xóa toàn bộ memory
    if (message.toLowerCase() === '/forget' || 
        message.toLowerCase() === 'quên tôi đi' ||
        message.toLowerCase() === 'xóa thông tin') {
      
      await redis.del(memoryKey);
      
      return res.status(200).json({
        success: true,
        message: '🗑️ Đã xóa toàn bộ thông tin về bạn. Chúng ta bắt đầu lại từ đầu nhé!',
        userId: userId
      });
    }

    // Lệnh: Xóa thông tin cụ thể
    if (message.toLowerCase().startsWith('/forget ')) {
      const keyToDelete = message.substring(8).trim();
      
      if (userMemory[keyToDelete]) {
        delete userMemory[keyToDelete];
        await redis.set(memoryKey, JSON.stringify(userMemory));
        
        return res.status(200).json({
          success: true,
          message: `🗑️ Đã xóa thông tin: **${keyToDelete}**`,
          userId: userId
        });
      } else {
        return res.status(200).json({
          success: true,
          message: `❓ Không tìm thấy thông tin: **${keyToDelete}**\n\nGõ /memory để xem danh sách.`,
          userId: userId
        });
      }
    }

    // ✅ THÊM TIN NHẮN USER VÀO LỊCH SỬ
    conversationHistory.push({
      role: 'user',
      content: message
    });

    // Giới hạn lịch sử (giữ 50 tin nhắn gần nhất)
    if (conversationHistory.length > 50) {
      conversationHistory = conversationHistory.slice(-50);
    }

    // ✅ PASS 1: TRẢ LỜI BÌNH THƯỜNG
    const systemPrompt = buildSystemPrompt(userMemory);
    
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        ...conversationHistory
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    // ✅ PASS 2: PHÂN TÍCH VÀ LƯU MEMORY
    const memoryExtraction = await extractMemory(groq, message, userMemory);
    
    let memoryUpdated = false;
    
    if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
      // Merge thông tin mới vào memory hiện tại
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      
      // ✅ LƯU VÀO REDIS - VĨNH VIỄN (không có expiry)
      await redis.set(memoryKey, JSON.stringify(userMemory));
      
      memoryUpdated = true;
      
      console.log(`💾 Saved memory for ${userId}:`, userMemory);
      
      // Thêm thông báo vào phản hồi
      const memoryUpdate = memoryExtraction.summary || 'Đã cập nhật thông tin về bạn.';
      assistantMessage += `\n\n💾 _${memoryUpdate}_`;
    }

    // Lưu phản hồi vào lịch sử
    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    // ✅ LƯU CHAT HISTORY VÀO REDIS (HẾT HẠN SAU 30 NGÀY)
    await redis.setex(chatKey, 2592000, JSON.stringify(conversationHistory));

    // Trả về response
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId: userId,
      conversationId: conversationId,
      historyLength: conversationHistory.length,
      memoryUpdated: memoryUpdated,
      memoryCount: Object.keys(userMemory).length
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
