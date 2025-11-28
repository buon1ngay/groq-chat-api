import fetch from 'node-fetch';
import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 🔑 4 GROQ API KEYS
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
].filter(Boolean);

if (API_KEYS.length === 0) {
  throw new Error('❌ Không tìm thấy GROQ_API_KEY!');
}

console.log(`🔑 Đã load ${API_KEYS.length} Groq API keys`);

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

// 🔍 KIỂM TRA CẦN TÌM KIẾM KHÔNG
function needsWebSearch(message) {
  const lower = message.toLowerCase();
  
  const searchKeywords = [
    // Tin tức & sự kiện
    'tin tức', 'tin mới', 'vụ', 'sự kiện', 'xảy ra',
    'hôm qua', 'hôm nay', 'tuần này', 'gần đây', 'mới nhất',
    
    // Câu hỏi về hiện tại
    'ai là', 'đang', 'hiện tại', 'bây giờ', 'thế nào rồi',
    
    // Từ khóa cụ thể
    'bé', 'trẻ em', 'tai nạn', 'vụ việc', 'case',
    'breaking', 'news', 'latest', 'recent', 'update'
  ];
  
  return searchKeywords.some(keyword => lower.includes(keyword));
}

// 🔍 TÌM KIẾM VỚI DUCKDUCKGO (MIỄN PHÍ, UNLIMITED!)
async function searchDuckDuckGo(query) {
  try {
    console.log('🟢 Searching DuckDuckGo for:', query);
    
    // DuckDuckGo Instant Answer API - Hoàn toàn miễn phí!
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KamiBot/1.0)'
      }
    });
    
    if (!response.ok) {
      console.warn('⚠️ DuckDuckGo error:', response.status);
      return null;
    }
    
    const data = await response.json();
    
    let result = '';
    
    // 1. Abstract (instant answer - thường là tốt nhất)
    if (data.Abstract && data.Abstract.length > 30) {
      result = data.Abstract;
      console.log('✅ Found Abstract');
    }
    // 2. Answer (direct answer)
    else if (data.Answer) {
      result = data.Answer;
      console.log('✅ Found Answer');
    }
    // 3. Related Topics
    else if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      const topics = data.RelatedTopics
        .filter(t => t.Text) // Chỉ lấy topics có text
        .slice(0, 3) // Lấy 3 kết quả đầu
        .map(t => t.Text)
        .join('\n\n');
      
      if (topics) {
        result = topics;
        console.log('✅ Found Related Topics');
      }
    }
    
    if (result && result.length > 30) {
      console.log('✅ DuckDuckGo search successful');
      return `[Nguồn: DuckDuckGo]\n${result}`;
    }
    
    console.log('⚠️ DuckDuckGo returned no useful results');
    return null;
    
  } catch (error) {
    console.error('❌ DuckDuckGo search failed:', error.message);
    return null;
  }
}

// 🔍 HÀM TÌM KIẾM CHÍNH
async function searchWeb(query) {
  console.log('🔍 Starting web search');
  
  // Hiện tại chỉ dùng DuckDuckGo (miễn phí, unlimited)
  const result = await searchDuckDuckGo(query);
  
  if (result) {
    return result;
  }
  
  console.log('❌ No search results available');
  return null;
}

async function extractMemory(message, currentMemory) {
  try {
    const extractionPrompt = `Phân tích tin nhắn sau và trích xuất THÔNG TIN CÁ NHÂN QUAN TRỌNG cần lưu lâu dài.

⚠️ QUY TẮC QUAN TRỌNG - ĐỌC KỸ:
- CHỈ lưu khi user CHÍNH THỨC GIỚI THIỆU về bản thân
- KHÔNG lưu các câu hỏi, tin nhắn thông thường
- KHÔNG lưu tên người khác, tên thương hiệu, tên sản phẩm
- KHÔNG lưu thông tin user chỉ hỏi/nhắc đến thoáng qua
- CHỈ lưu khi user NÓI VỀ CHÍNH MÌNH với ý định muốn bot nhớ

THÔNG TIN CẦN LƯU (CHỈ KHI USER CHÍNH THỨC GIỚI THIỆU):
- Tên thật của user (VD: "Tôi tên là Hùng", "Mình là An")
- Biệt danh USER MUỐN ĐƯỢC GỌI (VD: "Gọi tôi là Alex", "Hãy gọi mình là...")
- Nghề nghiệp (VD: "Tôi là lập trình viên", "Mình làm giáo viên")
- Sở thích (VD: "Tôi thích chơi game", "Mình hay đọc sách")
- Thông tin gia đình CỦA USER (VD: "Vợ tôi tên Lan", "Con tôi 5 tuổi")
- Địa điểm sống (VD: "Tôi sống ở Hà Nội")
- Năm sinh, tuổi (VD: "Tôi sinh năm 1995", "Mình 25 tuổi")
- Ngôn ngữ lập trình user dùng (VD: "Tôi code Python")
- BẤT KỲ THÔNG TIN NÀO USER CHÍNH THỨC YÊU CẦU: "Hãy nhớ rằng..."

❌ KHÔNG LƯU:
- Câu hỏi: "Dimixa hay Xadimi?" → KHÔNG LƯU
- Tên người khác: "Bạn tôi tên Hùng" → KHÔNG LƯU
- Tên thương hiệu: "iPhone", "Samsung" → KHÔNG LƯU
- Tin nhắn ngắn: "OK", "Thanks" → KHÔNG LƯU

TIN NHẮN CỦA USER:
"${message}"

THÔNG TIN ĐÃ LƯU:
${JSON.stringify(currentMemory, null, 2)}

HÃY TRẢ VỀ JSON:
{
  "hasNewInfo": true/false,
  "updates": {
    "Tên key": "Giá trị mới"
  },
  "summary": "Tóm tắt ngắn gọn"
}

QUY TẮC:
- CHỈ lưu khi USER NÓI VỀ CHÍNH MÌNH
- Key tiếng Việt có dấu
- Nếu không có thông tin cá nhân CỦA USER, trả về hasNewInfo: false
- CHỈ TRẢ VỀ JSON, KHÔNG TEXT KHÁC`;

    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'system',
          content: 'Bạn là trợ lý phân tích. CHỈ lưu khi user CHÍNH THỨC nói về bản thân. KHÔNG lưu câu hỏi. Chỉ trả về JSON.'
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

    // ✅ LỆNH: Xem memory
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

    // ✅ LỆNH: Xóa toàn bộ memory
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

    // ✅ LỆNH: Xóa thông tin cụ thể
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

    // 🔍 TÌM KIẾM WEB (NẾU CẦN)
    let searchContext = '';
    let hasSearch = false;
    
    if (needsWebSearch(message)) {
      console.log('🔍 Query needs web search');
      
      // Kiểm tra cache trước
      const cacheKey = `search:${message.toLowerCase().trim().substring(0, 100)}`;
      let cachedResult = await redis.get(cacheKey);
      
      if (cachedResult) {
        console.log('✅ Using cached search result');
        if (typeof cachedResult === 'string') {
          searchContext = cachedResult;
          hasSearch = true;
        }
      } else {
        // Tìm kiếm mới
        const searchResult = await searchWeb(message);
        
        if (searchResult) {
          searchContext = `\n\n[THÔNG TIN TÌM KIẾM TỪ WEB]\n${searchResult}\n[KẾT THÚC THÔNG TIN TÌM KIẾM]\n\n`;
          hasSearch = true;
          
          // Lưu cache 2 giờ
          await redis.setex(cacheKey, 7200, searchContext);
          
          console.log('✅ Search successful, cached for 2 hours');
        } else {
          console.log('⚠️ No search results');
        }
      }
    }

    conversationHistory.push({
      role: 'user',
      content: message
    });

    if (conversationHistory.length > 50) {
      conversationHistory = conversationHistory.slice(-50);
    }

    // Thêm search context vào system prompt
    let systemPrompt = buildSystemPrompt(userMemory);
    if (searchContext) {
      systemPrompt += searchContext;
    }
    
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

    // Thêm icon search nếu có
    if (hasSearch && !assistantMessage.startsWith('🔍')) {
      assistantMessage = '🔍 ' + assistantMessage;
    }

    // Extract memory
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
      hasSearch: hasSearch // ⬅️ Flag để biết có search không
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
