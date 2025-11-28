import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
].filter(Boolean);

if (API_KEYS.length === 0) {
  throw new Error('❌ Không tìm thấy GROQ_API_KEY!');
}

console.log(`🔑 Đã load ${API_KEYS.length} API keys`);

function createGroqClient() {
  const randomKey = API_KEYS[Math.floor(Math.random() * API_KEYS.length)];
  return new Groq({ apiKey: randomKey });
}

async function callGroqWithRetry(config, maxRetries = API_KEYS.length) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const groq = createGroqClient();
      return await groq.chat.completions.create(config);
    } catch (error) {
      lastError = error;
      
      if (error.status === 429 || error.message?.includes('rate_limit')) {
        console.warn(`⚠️ Rate limit, thử key khác (${attempt + 1}/${maxRetries})`);
        continue;
      }
      
      throw error;
    }
  }
  
  throw new Error(`Hết ${maxRetries} keys: ${lastError.message}`);
}
// 🔍 WEB SEARCH FUNCTION - CHỈ DÙNG SERPER API
async function searchWeb(query) {
  try {
    console.log('🔍 Searching web for:', query);

    if (!process.env.SERPER_API_KEY) {
      console.error('❌ Thiếu SERPER_API_KEY');
      return null;
    }

    // Gửi request tới Serper.dev
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: query,
        gl: 'vn',    // Việt Nam
        hl: 'vi',    // Ngôn ngữ tiếng Việt
        num: 5       // Lấy 5 kết quả
      })
    });

    if (!response.ok) {
      console.error('❌ Serper API lỗi:', await response.text());
      return null;
    }

    const data = await response.json();
    let results = '';

    // 🎯 Knowledge Graph
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      results += `📌 ${kg.title || ''}\n`;
      if (kg.description) results += `${kg.description}\n`;
      if (kg.attributes) {
        Object.entries(kg.attributes).slice(0, 3).forEach(([k, v]) => {
          results += `• ${k}: ${v}\n`;
        });
      }
      results += '\n';
    }

    // 🎯 Answer Box (nếu có)
    if (data.answerBox) {
      const ab = data.answerBox;
      if (ab.answer) results += `✅ ${ab.answer}\n\n`;
      if (ab.snippet) results += `${ab.snippet}\n\n`;
    }

    // 🎯 Organic results (Google Search)
    if (data.organic && data.organic.length > 0) {
      results += '🔗 Kết quả tìm kiếm:\n';
      data.organic.slice(0, 3).forEach((item, i) => {
        results += `${i + 1}. ${item.title}\n`;
        if (item.snippet) results += `   ${item.snippet}\n`;
      });
    }

    return results.trim() || null;

  } catch (error) {
    console.error('❌ Search error:', error);
    return null;
  }
}

// 🤖 PHÁT HIỆN CẦN SEARCH - CẢI TIẾN
async function needsWebSearch(message) {
  // Kiểm tra nhanh bằng regex trước
  const quickSearchTriggers = [
    /hiện (tại|nay|giờ)|bây giờ|lúc này|ngày nay/i,
    /năm (19|20)\d{2}|tháng \d+\/\d+/i,
    /bao nhiêu|mấy|số lượng|tổng số/i,
    /mới nhất|gần đây|vừa rồi|hôm (nay|qua)|tuần này|tháng này/i,
    /giá cả|bao nhiêu tiền|tỷ giá|đắt|rẻ/i,
    /tin tức|sự kiện|diễn biến|cập nhật/i,
    /ai là|who is|là ai/i,
    /khi nào|when|bao giờ/i,
    /ở đâu|where|tại đâu/i,
  ];
  
  // Nếu match quick trigger, return true ngay
  if (quickSearchTriggers.some(pattern => pattern.test(message))) {
    console.log('✅ Quick trigger matched!');
    return true;
  }
  
  // Sử dụng AI để phán đoán thông minh hơn
  try {
    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: `Bạn là trợ lý phân tích. Xác định xem câu hỏi có CẦN TÌM KIẾM WEB không.

CẦN TÌM KIẾM nếu:
- Hỏi về sự kiện hiện tại, tin tức mới
- Hỏi về người nổi tiếng (ai là, làm gì)
- Hỏi về số liệu, giá cả, tỷ giá
- Hỏi về thời gian, ngày tháng cụ thể
- Hỏi về địa điểm, quốc gia, thành phố
- Hỏi về công nghệ mới, sản phẩm mới

KHÔNG CẦN TÌM KIẾM nếu:
- Hỏi về kiến thức chung, khái niệm
- Yêu cầu giải thích, hướng dẫn
- Trò chuyện thông thường
- Hỏi về bản thân người dùng

CHỈ TRẢ VỀ "YES" hoặc "NO", không giải thích.`
        },
        {
          role: 'user',
          content: `Câu hỏi: "${message}"\n\nCần tìm kiếm web không?`
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 10
    });

    const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
    const needsSearch = answer === 'YES';
    
    console.log(`🤖 AI decision: ${answer} -> ${needsSearch ? 'SEARCH' : 'NO SEARCH'}`);
    
    return needsSearch;
  } catch (error) {
    console.error('❌ AI detection error:', error);
    // Fallback: nếu có từ khóa câu hỏi, search
    return /\?|ai |gì |nào |đâu |sao |như thế nào/i.test(message);
  }
}

async function extractMemory(message, currentMemory) {
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

    const response = await callGroqWithRetry({
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
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('📊 Memory extraction:', parsed);
      return parsed;
    }
    
    return { hasNewInfo: false };
  } catch (error) {
    console.error('❌ Error extracting memory:', error);
    return { hasNewInfo: false };
  }
}

function buildSystemPrompt(memory, searchResults = null) {
  let prompt = 'Bạn tên là KAMI. Trợ lý AI thông minh hữu ích và thân thiện. Được tạo ra bởi Nguyễn Đức Thanh. Hãy trả lời bằng tiếng Việt một cách tự nhiên.';
  
  if (searchResults) {
    prompt += '\n\n🌐 THÔNG TIN MỚI NHẤT TỪ WEB:\n';
    prompt += searchResults;
    prompt += '\n\n⚠️ HÃY SỬ DỤNG thông tin web phía trên để trả lời CHÍNH XÁC nhất. Ưu tiên thông tin web hơn kiến thức cũ của bạn.\n';
  }
  
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`📨 [${userId}] Message: ${message}`);

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await redis.get(chatKey) || [];
    if (typeof conversationHistory === 'string') {
      conversationHistory = JSON.parse(conversationHistory);
    }

    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') {
      userMemory = JSON.parse(userMemory);
    }

    console.log(`💾 Memory cho ${userId}:`, userMemory);

    // Commands
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

    // ✅ THÊM LỆNH DEBUG SEARCH
    if (message.toLowerCase() === '/search test') {
      const testQuery = 'Elon Musk';
      console.log('🧪 Testing search with:', testQuery);
      const testResults = await searchWeb(testQuery);
      
      return res.status(200).json({
        success: true,
        message: `🧪 **Test Search Results:**\n\n${testResults || 'No results'}`,
        userId: userId
      });
    }

    conversationHistory.push({
      role: 'user',
      content: message
    });

    if (conversationHistory.length > 50) {
      conversationHistory = conversationHistory.slice(-50);
    }

    // ✅ KIỂM TRA XEM CÓ CẦN SEARCH WEB KHÔNG
    let searchResults = null;
    let usedSearch = false;
    
    const shouldSearch = await needsWebSearch(message);
    console.log(`🔍 Should search: ${shouldSearch}`);
    
    if (shouldSearch) {
      console.log('🔍 Triggering web search...');
      searchResults = await searchWeb(message);
      usedSearch = true;
      
      if (searchResults) {
        console.log('✅ Search results:', searchResults.substring(0, 200) + '...');
      } else {
        console.log('⚠️ Search returned no results');
      }
    }

    const systemPrompt = buildSystemPrompt(userMemory, searchResults);
    
    const chatCompletion = await callGroqWithRetry({
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

    if (usedSearch && searchResults) {
      assistantMessage += '\n\n🌐 _Thông tin được cập nhật từ web_';
    }

    const memoryExtraction = await extractMemory(message, userMemory);
    
    let memoryUpdated = false;
    
    if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      await redis.set(memoryKey, JSON.stringify(userMemory));
      memoryUpdated = true;
      
      console.log(`💾 Đã lưu memory cho ${userId}:`, userMemory);
      
      const memoryUpdate = memoryExtraction.summary || 'Đã cập nhật thông tin về bạn.';
      assistantMessage += `\n\n💾 _${memoryUpdate}_`;
    }

    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await redis.setex(chatKey, 2592000, JSON.stringify(conversationHistory));

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId: userId,
      conversationId: conversationId,
      historyLength: conversationHistory.length,
      memoryUpdated: memoryUpdated,
      memoryCount: Object.keys(userMemory).length,
      usedWebSearch: usedSearch,
      searchTriggered: shouldSearch
    });

  } catch (error) {
    console.error('❌ Error:', error);
    
    let errorMessage = error.message || 'Internal server error';
    
    if (error.message?.includes('rate_limit')) {
      errorMessage = '⚠️ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau vài phút.';
    }
    
    return res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
}
