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
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);

const MODELS = {
  main: 'llama-3.3-70b-versatile',
  search: 'llama-3.1-8b-instant',
  memory: 'llama-3.1-8b-instant',
  smart: 'llama-3.3-70b-versatile',
  vision: 'llama-3.2-90b-vision-preview',
};

if (API_KEYS.length === 0) throw new Error('❌ Không tìm thấy GROQ_API_KEY!');

console.log(`🔑 Load ${API_KEYS.length} GROQ API keys`);
console.log(`🤖 Models: Main=${MODELS.main}, Vision=${MODELS.vision}, Search=${MODELS.search}`);

let lastGroqKeyIndex = -1;
function createGroqClient() {
  lastGroqKeyIndex = (lastGroqKeyIndex + 1) % API_KEYS.length;
  return new Groq({ apiKey: API_KEYS[lastGroqKeyIndex] });
}
const SEARCH_APIS = [
  {
    name: 'Serper',
    apiKey: process.env.SERPER_API_KEY,
    enabled: !!process.env.SERPER_API_KEY,
    async search(query) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      
      try {
        const resp = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', num: 8 }),
          signal: controller.signal
        });
        
        clearTimeout(timer);
        if (!resp.ok) return null;
        
        const data = await resp.json();
        let results = '';
        
        if (data.knowledgeGraph) {
          results += `${data.knowledgeGraph.title || ''}\n${data.knowledgeGraph.description || ''}\n\n`;
        }
        if (data.answerBox?.answer) {
          results += `${data.answerBox.answer}\n\n`;
        }
        if (data.organic?.length) {
          data.organic.slice(0, 5).forEach(item => {
            results += `📌 ${item.title}\n${item.snippet || ''}\n\n`;
          });
        }
        
        return results.trim() || null;
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }
  },
  {
    name: 'Tavily',
    apiKey: process.env.TAVILY_API_KEY,
    enabled: !!process.env.TAVILY_API_KEY,
    async search(query) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      
      try {
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: this.apiKey,
            query,
            search_depth: 'advanced',
            include_answer: true,
            max_results: 8
          }),
          signal: controller.signal
        });
        
        clearTimeout(timer);
        if (!resp.ok) return null;
        
        const data = await resp.json();
        let results = '';
        
        if (data.answer) results += `💡 ${data.answer}\n\n`;
        if (data.results?.length) {
          data.results.slice(0, 5).forEach(item =>
            results += `📌 ${item.title}\n${item.content ? item.content.substring(0, 200) : ''}...\n\n`
          );
        }
        
        return results.trim() || null;
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }
  }
].filter(api => api.enabled);

console.log(`🔍 Load ${SEARCH_APIS.length} Search APIs: ${SEARCH_APIS.map(a => a.name).join(', ')}`);

let lastSearchApiIndex = -1;
const inFlightSearches = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [query, timestamp] of inFlightSearches.entries()) {
    if (now - timestamp > 15000) {
      inFlightSearches.delete(query);
      console.log(`🧹 Cleaned up stale search: ${query}`);
    }
  }
}, 10000);

function isValidSearchResult(result) {
  if (!result || typeof result !== 'string') return false;
  
  if (result.length < 50) return false;
  
  const cleanResult = result.trim().replace(/\s+/g, ' ');
  if (cleanResult.length < 30) return false;
  
  const textContent = cleanResult.replace(/[^\w\sàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi, '');
  if (textContent.length < 20) return false;
  const hasWords = /[a-zA-Zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]{5,}/i.test(result);
  if (!hasWords) return false;
  const errorPatterns = [
    /no results/i,
    /không tìm thấy/i,
    /error/i,
    /failed/i,
    /unavailable/i
  ];
  if (errorPatterns.some(p => p.test(result))) return false;
  
  return true;
}

function getSmartCacheTime(query) {
  const lowerQuery = query.toLowerCase();
  const realtimePatterns = [
    /giá|tỷ giá|chứng khoán/i,
    /thời tiết|nhiệt độ/i,
    /tỷ số|kết quả trận/i,
    /crypto|bitcoin|btc|eth/i,
    /tin mới|tin nóng/i
  ];
  if (realtimePatterns.some(p => p.test(lowerQuery))) {
    console.log('⏱️ Cache: 5 min (realtime)');
    return 300;
  }
  const shortTermPatterns = [
    /mới nhất|hiện tại|hiện nay|bây giờ|lúc này|hôm nay/i,
    /tin tức.*(?:hôm nay)/i
  ];
  if (shortTermPatterns.some(p => p.test(lowerQuery))) {
    return 1800;
  }
  const mediumTermPatterns = [
    /gần đây|tuần này/i,
    /xu hướng|trend/i,
    /tin tức(?!.*hôm nay)/i
  ];
  if (mediumTermPatterns.some(p => p.test(lowerQuery))) {
    return 7200;
  }
  
  const longTermPatterns = [
    /lịch sử|năm \d{4}/i,
    /là gì|định nghĩa|cách|hướng dẫn|giải thích/i
  ];
  if (longTermPatterns.some(p => p.test(lowerQuery))) {
    return 86400;
  }
  return 3600;
}
async function analyzeImage(imageBase64, userPrompt = null) {
  try {
    
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new Error('Invalid image data');
    }
    
    const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    
    const defaultPrompt = `Phân tích chi tiết hình ảnh này. Hãy mô tả:
1. Nội dung chính (đối tượng, con người, cảnh vật)
2. Màu sắc và bố cục
3. Cảm xúc hoặc thông điệp nếu có
4. Bất kỳ văn bản nào trong ảnh
5. Chất lượng và đề xuất cải thiện nếu cần
Trả lời bằng tiếng Việt, chi tiết nhưng súc tích.`;
    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt || defaultPrompt },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64Data}` }
            }
          ]
        }
      ],
      model: MODELS.vision,
      temperature: 0.5,
      max_tokens: 1500
    });
    
    const analysis = response.choices[0]?.message?.content || 'Không thể phân tích ảnh.';
    console.log('✅ Image analyzed successfully');
    return analysis;
    
  } catch (e) {
    console.error('❌ Image analysis failed:', e.message);
    throw new Error(`Lỗi phân tích ảnh: ${e.message}`);
  }
}
async function suggestImageEdits(imageBase64, editRequest) {
  try {
    
    const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    
    const editPrompt = `Dựa trên hình ảnh này, hãy đưa ra hướng dẫn chi tiết để:
${editRequest}

Hãy cung cấp:
1. Phân tích vấn đề hiện tại trong ảnh
2. Các bước chỉnh sửa cụ thể (có thể dùng app như Snapseed, Lightroom, PicsArt)
3. Thông số đề xuất (độ sáng, độ tương phản, bão hòa, v.v.)
4. Lời khuyên về composition hoặc cropping
5. Kỹ thuật nâng cao nếu cần

Trả lời bằng tiếng Việt, dễ hiểu cho người mới bắt đầu.`;

    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: editPrompt },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64Data}` }
            }
          ]
        }
      ],
      model: MODELS.vision,
      temperature: 0.6,
      max_tokens: 2000
    });
    
    const suggestions = response.choices[0]?.message?.content || 'Không thể tạo gợi ý.';
    console.log('✅ Edit suggestions generated');
    return suggestions;
    
  } catch (e) {
    console.error('❌ Edit suggestions failed:', e.message);
    throw new Error(`Lỗi tạo gợi ý: ${e.message}`);
  }
}
async function extractTextFromImage(imageBase64) {
  try {
    const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    
    const response = await callGroqWithRetry({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Trích xuất TẤT CẢ văn bản trong ảnh này. Giữ nguyên định dạng và bố cục. Nếu không có văn bản, trả về "Không có văn bản".'
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64Data}` }
            }
          ]
        }
      ],
      model: MODELS.vision,
      temperature: 0.1,
      max_tokens: 1000
    });
    
    const extractedText = response.choices[0]?.message?.content || 'Không tìm thấy văn bản.';
    console.log('✅ Text extracted successfully');
    return extractedText;
    
  } catch (e) {
    console.error('❌ Text extraction failed:', e.message);
    throw new Error(`Lỗi trích xuất văn bản: ${e.message}`);
  }
}
async function extractSearchKeywords(message) {
  try {
    const response = await callGroqWithRetry({
      messages: [
        { 
          role: 'system', 
          content: 'Trích xuất 3-5 từ khóa chính để search Google. CHỈ TRẢ TỪ KHÓA, KHÔNG GIẢI THÍCH.' 
        },
        { role: 'user', content: `Câu hỏi: "${message}"\n\nTừ khóa search:` }
      ],
      model: MODELS.search,
      temperature: 0.1,
      max_tokens: 50
    });
    
    const keywords = response.choices[0]?.message?.content?.trim() || message;
    console.log(`🔑 Extracted keywords: "${keywords}"`);
    return keywords;
  } catch (e) {
    console.warn('⚠️ Keyword extraction failed, using original message');
    return message;
  }
}
async function summarizeSearchResults(results, question) {
  if (!results || results.length < 500) return results;
  
  try {
    const response = await callGroqWithRetry({
      messages: [
        { 
          role: 'system', 
          content: 'Tóm tắt kết quả tìm kiếm thành 4-5 điểm chính, giữ nguyên số liệu và nguồn quan trọng. Dùng bullet points.' 
        },
        { 
          role: 'user', 
          content: `Câu hỏi: ${question}\n\n=== KẾT QUẢ TÌM KIẾM ===\n${results.substring(0, 2000)}` 
        }
      ],
      model: MODELS.search,
      temperature: 0.3,
      max_tokens: 500
    });
    
    const summary = response.choices[0]?.message?.content || results;
    console.log('✅ Search results summarized');
    return summary;
  } catch (e) {
    console.warn('⚠️ Summarization failed, using truncated results');
    return results.substring(0, 1500);
  }
}
async function searchWeb(query, forceRefresh = false) {
  if (!SEARCH_APIS.length) {
    console.warn('⚠️ No search APIs available');
    return null;
  }

  const cleanedQuery = query.trim().toLowerCase();
  const cacheKey = `search:${cleanedQuery}`;

  if (inFlightSearches.has(cleanedQuery)) {
    const startTime = inFlightSearches.get(cleanedQuery);
    const elapsed = Date.now() - startTime;
    if (elapsed < 15000) {
      console.log(`⏳ Query in progress (${Math.round(elapsed/1000)}s): ${cleanedQuery}`);
      return 'SEARCH_IN_PROGRESS';
    }
  }

  inFlightSearches.set(cleanedQuery, Date.now());

  try {
    if (!forceRefresh) {
      try {
        let cached = await redis.get(cacheKey);
        if (cached) {
          if (typeof cached === 'string') {
            try { 
              cached = JSON.parse(cached); 
            } catch {
            }
          }
          
          if (isValidSearchResult(cached)) {
            return cached;
          } else {
 cleanedQuery);
            await redis.del(cacheKey);
          }
        }
      } catch (e) {
        console.warn('⚠️ Redis get failed:', e.message);
      }
    } else {
    }

    const errors = [];
    for (let i = 0; i < SEARCH_APIS.length; i++) {
      lastSearchApiIndex = (lastSearchApiIndex + 1) % SEARCH_APIS.length;
      const api = SEARCH_APIS[lastSearchApiIndex];
      
      try {
        const result = await api.search(cleanedQuery);
        
        if (isValidSearchResult(result)) {
          const cacheTime = getSmartCacheTime(cleanedQuery);
          try {
            await redis.set(cacheKey, JSON.stringify(result), { ex: cacheTime });
          } catch (e) {
            console.warn('⚠️ Redis set failed:', e.message);
          }
          
          return result;
        } else {
          console.warn(`⚠️ ${api.name} returned invalid result (length: ${result?.length || 0})`);
          errors.push(`${api.name}: Invalid result`);
          continue;
        }
      } catch (e) {
        const errMsg = e.message || 'Unknown error';
        console.warn(`❌ ${api.name} error: ${errMsg}`);
        errors.push(`${api.name}: ${errMsg}`);
        continue;
      }
    }

    console.warn('⚠️ All search APIs failed or returned invalid results');
    console.warn('Errors:', errors.join('; '));
    return null;

  } finally {
    inFlightSearches.delete(cleanedQuery);
  }
}
async function analyzeIntent(message, history, hasImage = false) {
  const triggers = {
    search: /\b(hiện tại|hiện nay|bây giờ|lúc này|hôm nay|hôm qua)\b|tìm kiếm|tra cứu|năm (19|20)\d{2}|mới nhất|gần đây|tin tức|thời tiết|giá cả|tỷ giá/i,
    creative: /viết|kể|sáng tác|làm thơ|bài hát|câu chuyện|truyện/i,
    technical: /code|lập trình|debug|fix|algorithm|function|class|git|api|database|sửa lỗi/i,
    calculation: /tính toán|calculate|\d+\s*[\+\-\*\/\=\^]\s*\d+|phương trình|toán/i,
    explanation: /giải thích|tại sao|vì sao|làm sao|như thế nào|why|how|explain/i,
    comparison: /so sánh|khác nhau|tốt hơn|nên chọn/i,
    image_analysis: /ảnh|hình|photo|image|phân tích ảnh|mô tả ảnh|trong ảnh|xem ảnh/i,
    image_edit: /chỉnh|edit|sửa ảnh|cải thiện|photoshop|filter|màu sắc|độ sáng/i,
    ocr: /đọc chữ|text trong ảnh|văn bản|trích xuất|ocr|chữ trong ảnh/i,
  };

  let intent = {
    type: 'general',
    needsSearch: false,
    complexity: 'simple',
    needsDeepThinking: false,
    hasImage: hasImage
  };

  if (hasImage) {
    if (triggers.ocr.test(message)) {
      intent.type = 'ocr';
      intent.complexity = 'simple';
    } else if (triggers.image_edit.test(message)) {
      intent.type = 'image_edit';
      intent.complexity = 'medium';
    } else if (triggers.image_analysis.test(message) || message.length < 20) {
      intent.type = 'image_analysis';
      intent.complexity = 'simple';
    } else {
      intent.type = 'image_analysis';
      intent.complexity = 'simple';
    }
    return intent;
  }

  if (triggers.technical.test(message)) {
    intent.type = 'technical';
    intent.complexity = 'complex';
  } else if (triggers.search.test(message)) {
    intent.type = 'search';
    intent.needsSearch = true;
  } else if (triggers.comparison.test(message)) {
    intent.type = 'comparison';
    intent.needsSearch = true;
  } else if (triggers.creative.test(message)) {
    intent.type = 'creative';
    intent.complexity = 'medium';
  } else if (triggers.calculation.test(message)) {
    intent.type = 'calculation';
    intent.needsDeepThinking = true;
  } else if (triggers.explanation.test(message)) {
    intent.type = 'explanation';
    intent.needsDeepThinking = true;
  }

  if (message.length > 200 || message.split('?').length > 2) {
    intent.complexity = 'complex';
    intent.needsDeepThinking = true;
  }

  return intent;
}
async function needsWebSearch(message, intent) {
  if (intent.type === 'technical' || intent.hasImage) return false;
  if (intent.needsSearch) return true;

  const triggers = [
    /\b(hiện tại|hiện nay|bây giờ|lúc này|hôm nay|hôm qua)\b.*\?/i,
    /năm (19|20)\d{2}/i,
    /mới nhất|gần đây|vừa rồi|tuần (này|trước)/i,
    /giá|tỷ giá|bao nhiêu tiền|chi phí/i,
    /tin tức|sự kiện|cập nhật|thông tin mới/i,
    /\b(ai là|ai đã|là ai)\b.*\?/i,
    /\b(khi nào|lúc nào|bao giờ)\b.*\?/i,
    /\b(ở đâu|chỗ nào|tại đâu)\b.*\?/i,
    /thời tiết|nhiệt độ|weather/i,
    /tỷ số|kết quả|trận đấu/i,
    /xu hướng|thay đổi|phát triển.*mới/i,
    /\d+\s*(năm|tháng|tuần|ngày)\s*(trước|sau|tới)/i,
  ];
  
  return triggers.some(r => r.test(message));
}

async function callGroqWithRetry(config, maxRetries = API_KEYS.length) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const groq = createGroqClient();
      return await groq.chat.completions.create(config);
    } catch (e) {
      lastError = e;
      
      if (e.status === 413 || e.message?.includes('Request too large')) {
        throw new Error('❌ Request quá lớn. Hãy rút ngắn tin nhắn.');
      }
      
      if (e.status === 400) {
        throw new Error('❌ Request không hợp lệ: ' + e.message);
      }
      
      if (e.status === 429 || e.message?.includes('rate_limit')) {
        console.warn(`⚠️ Rate limit key ${lastGroqKeyIndex}, trying next...`);
        continue;
      }
      
      throw e;
    }
  }
  throw new Error(`❌ Hết ${maxRetries} API keys: ${lastError.message}`);
}
async function extractMemory(message, currentMemory) {
  try {
    const prompt = `Phân tích tin nhắn và trích xuất thông tin CÁ NHÂN của user.

TIN NHẮN: "${message}"
THÔNG TIN ĐÃ BIẾT: ${JSON.stringify(currentMemory, null, 2)}

Trả về JSON: {"hasNewInfo": true/false, "updates": {}, "summary": ""}`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'CHỈ TRẢ JSON THUẦN.' },
        { role: 'user', content: prompt }
      ],
      model: MODELS.memory,
      temperature: 0.2,
      max_tokens: 400
    });
    
    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { hasNewInfo: false };
    
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.hasNewInfo && !parsed.updates) return { hasNewInfo: false };
    
    return parsed;
  } catch (e) {
    console.warn('⚠️ Memory extraction failed');
    return { hasNewInfo: false };
  }
}

async function deepThinking(message, context) {
  try {
    console.log('🧠 Deep thinking...');
    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Phân tích logic chuyên sâu.' },
        { role: 'user', content: `Phân tích: "${message}"` }
      ],
      model: MODELS.smart,
      temperature: 0.6,
      max_tokens: 800
    });
    return response.choices[0]?.message?.content || null;
  } catch (e) {
    return null;
  }
}

function buildSystemPrompt(memory, searchResults, intent, deepThought, imageAnalysis) {
  let prompt = `Bạn là KAMI, một AI chuyên nghiệp, chính xác và có tầm nhìn, được tạo ra bởi Nguyễn Đức Thạnh. Khi trả lời, tuân theo những nguyên tắc:
1. Trả lời bằng tiếng Việt (trừ khi user yêu cầu ngôn ngữ khác). Xưng là "tôi" hoặc tùy ngữ cảnh user yêu cầu; gọi user theo tiền tố họ đã chọn.
2. Ưu tiên câu trả lời rõ ràng, thực tế, có chính kiến; cung cấp ví dụ cụ thể và giải thích logic đằng sau. Khi vấn đề phức tạp, tóm tắt ngắn trước rồi giải thích chi tiết.
3. Sử dụng emoji tiết chế để tạo không khí thân thiện khi phù hợp (không dùng emoji trong nội dung pháp lý, y tế nghiêm trọng, hay khi user biểu hiện nhu cầu trang trọng).
4. Nếu user yêu cầu kể chuyện, tạo nội dung sinh động.
5. Khi thông tin có thể đã thay đổi theo thời gian (tin tức, giá, chức vụ, địa lý, ...), tra cứu nguồn cập nhật tìm kiếm trước khi trả lời; nếu không được, nói rõ giới hạn thời điểm kiến thức`;

  if (intent) {
    prompt += `\n\n📋 LOẠI: ${intent.type} (${intent.complexity})`;
    
    if (intent.type === 'image_analysis') {
      prompt += '\n🎨 Chế độ phân tích ảnh: Mô tả chi tiết, màu sắc, bố cục, cảm xúc.';
    } else if (intent.type === 'image_edit') {
      prompt += '\n🖼️ Chế độ chỉnh sửa: Hướng dẫn cụ thể, thông số rõ ràng, dễ hiểu.';
    } else if (intent.type === 'ocr') {
      prompt += '\n📸 Chế độ OCR: Trích xuất văn bản chính xác, giữ định dạng.';
    } else if (intent.type === 'technical') {
      prompt += '\n💡 Kỹ thuật: Code examples, best practices.';
    } else if (intent.type === 'creative') {
      prompt += '\n🎨 Sáng tạo: Sinh động, cảm xúc.';
    }
  }

  if (deepThought) {
    prompt += `\n\n🧠 PHÂN TÍCH:\n${deepThought}`;
  }

  if (imageAnalysis) {
    prompt += `\n\n🎨 PHÂN TÍCH ẢNH:\n${imageAnalysis}\n\n⚠️ Dùng thông tin từ ảnh để trả lời.`;
  }

  if (searchResults) {
    prompt += `\n\n📊 DỮ LIỆU SEARCH:\n${searchResults}\n\n⚠️ Ưu tiên dữ liệu này.`;
  }
  
  if (Object.keys(memory).length) {
    prompt += '\n\n👤 THÔNG TIN USER:';
    for (const [k, v] of Object.entries(memory)) {
      prompt += `\n• ${k}: ${v}`;
    }
  }
  
  return prompt;
}

async function safeRedisGet(key, defaultValue = null) {
  try {
    const data = await redis.get(key);
    if (!data) return defaultValue;
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch { return data; }
  } catch (e) {
    console.error(`❌ Redis GET failed: ${key}`);
    return defaultValue;
  }
}

async function safeRedisSet(key, value, expirySeconds = null) {
  try {
    const stringified = typeof value === 'string' ? value : JSON.stringify(value);
    if (expirySeconds) {
      await redis.set(key, stringified, { ex: expirySeconds });
    } else {
      await redis.set(key, stringified);
    }
    return true;
  } catch (e) {
    console.error(`❌ Redis SET failed: ${key}`);
    return false;
  }
}

async function summarizeHistory(history) {
  if (history.length < 20) return history;
  
  try {
    const oldMessages = history.slice(0, -10);
    const recentMessages = history.slice(-10);
    
    const summary = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Tóm tắt 3-4 điểm chính.' },
        { role: 'user', content: JSON.stringify(oldMessages) }
      ],
      model: MODELS.memory,
      temperature: 0.3,
      max_tokens: 300
    });
    
    return [
      { role: 'system', content: `📋 Tóm tắt: ${summary.choices[0]?.message?.content}` },
      ...recentMessages
    ];
  } catch (e) {
    return history.slice(-15);
  }
}
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { message, userId = 'default', conversationId = 'default', image = null } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message required' });
    }
    
    if (message.length > 3000) {
      return res.status(400).json({ error: 'Message too long (max 3000)' });
    }
    if (image) {
      if (typeof image !== 'string') {
        return res.status(400).json({ error: 'Image must be base64 string' });
      }
      if (image.length > 5500000) {
        return res.status(400).json({ error: 'Image too large (max 4MB)' });
      }
    }

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await safeRedisGet(chatKey, []);
    let userMemory = await safeRedisGet(memoryKey, {});
    
    if (!Array.isArray(conversationHistory)) conversationHistory = [];
    if (typeof userMemory !== 'object' || userMemory === null) userMemory = {};

    const lowerMsg = message.toLowerCase().trim();
    if (lowerMsg === '/memory') {
      const memText = Object.keys(userMemory).length
        ? '💾 Thông tin:\n\n' + Object.entries(userMemory).map(([k,v]) => `• ${k}: ${v}`).join('\n')
        : '💭 Chưa có thông tin.';
      return res.status(200).json({ 
        success: true, 
        message: memText,
        memoryCount: Object.keys(userMemory).length 
      });
    }

    if (lowerMsg.startsWith('/forget')) {
      if (lowerMsg === '/forget') {
        await redis.del(memoryKey);
        return res.status(200).json({ 
          success: true, 
          message: '🗑️ Đã xóa toàn bộ.' 
        });
      } else {
        const keyToDelete = message.substring(8).trim();
        if (userMemory[keyToDelete]) {
          delete userMemory[keyToDelete];
          await safeRedisSet(memoryKey, userMemory);
          return res.status(200).json({ 
            success: true, 
            message: `🗑️ Đã xóa: ${keyToDelete}` 
          });
        } else {
          return res.status(200).json({ 
            success: true, 
            message: `❓ Không tìm thấy: ${keyToDelete}` 
          });
        }
      }
    }

    if (lowerMsg === '/clear') {
      await redis.del(chatKey);
      return res.status(200).json({ 
        success: true, 
        message: '🗑️ Đã xóa lịch sử.' 
      });
    }

    if (lowerMsg === '/clearcache') {
      try {
        const keys = await redis.keys('search:*');
        if (keys?.length) {
          await Promise.all(keys.map(k => redis.del(k)));
          return res.status(200).json({ 
            success: true, 
            message: `🗑️ Đã xóa ${keys.length} cache search.` 
          });
        }
        return res.status(200).json({ 
          success: true, 
          message: '✅ Cache trống.' 
        });
      } catch (e) {
        return res.status(200).json({ 
          success: true, 
          message: '⚠️ Không thể xóa cache: ' + e.message 
        });
      }
    }
    if (lowerMsg.startsWith('/search ')) {
      const query = message.substring(8).trim();
      if (!query) {
        return res.status(400).json({ error: 'Query required for /search' });
      }

      console.log(`🔄 Force refresh search: "${query}"`);
      
      const searchResults = await searchWeb(query, true);
      
      if (searchResults === 'SEARCH_IN_PROGRESS') {
        return res.status(200).json({
          success: true,
          message: '⏳ Đang tìm kiếm, vui lòng thử lại sau giây lát...'
        });
      }
      
      if (!searchResults) {
        return res.status(200).json({
          success: true,
          message: '❌ Không tìm thấy kết quả cho: ' + query
        });
      }

      return res.status(200).json({
        success: true,
        message: `🔍 Kết quả tìm kiếm: ${query}\n\n${searchResults}`,
        usedWebSearch: true,
        searchKeywords: query
      });
    }

    if (lowerMsg === '/help') {
      return res.status(200).json({
        success: true,
        message: `🤖 KAMI - AI Commands

📋 Lệnh:
• \`/memory\` - Xem thông tin đã lưu
• \`/forget [key]\` - Xóa thông tin
• \`/clear\` - Xóa lịch sử chat
• \`/clearcache\` - Xóa cache search
• \`/search <query>\` - Tìm kiếm mới (bỏ qua cache)
• \`/help\` - Danh sách lệnh

✨ Tính năng:
• 🔍 Tự động search web với cache thông minh
• 🧠 Deep thinking cho câu hỏi phức tạp
• 💾 Nhớ thông tin user
• 🎨 Phân tích & chỉnh sửa ảnh
• 📸 OCR - đọc chữ trong ảnh

🎨 Sử dụng ảnh:
Gửi ảnh kèm text:
• "Phân tích ảnh này"
• "Đọc chữ trong ảnh"
• "Làm sao để ảnh đẹp hơn?"
• "Chỉnh sửa độ sáng, màu sắc"

⏱️ Cache thông minh:
• Realtime (5p): giá, thời tiết, crypto
• Short-term (30p): tin tức hôm nay
• Medium-term (2h): xu hướng, tin tức
• Long-term (24h): định nghĩa, lịch sử`
      });
    }
    const hasImage = !!image;
    const intent = await analyzeIntent(message, conversationHistory, hasImage);
    console.log('🎯 Intent:', intent);

    conversationHistory.push({ role: 'user', content: message });
    
    if (conversationHistory.length > 30) {
      conversationHistory = await summarizeHistory(conversationHistory);
    }
    let imageAnalysis = null;
    let imageProcessed = false;
    
    if (hasImage) {
      try {
        console.log(`🎨 Processing image with intent: ${intent.type}`);
        
        if (intent.type === 'ocr') {
          imageAnalysis = await extractTextFromImage(image);
          imageProcessed = true;
          console.log('✅ OCR completed');
          
        } else if (intent.type === 'image_edit') {
          imageAnalysis = await suggestImageEdits(image, message);
          imageProcessed = true;
          console.log('✅ Edit suggestions generated');
          
        } else {
          imageAnalysis = await analyzeImage(image, message.length > 20 ? message : null);
          imageProcessed = true;
          console.log('✅ Image analyzed');
        }
        
      } catch (e) {
        console.error('❌ Image processing error:', e.message);
        imageAnalysis = `⚠️ Lỗi xử lý ảnh: ${e.message}`;
      }
    }
    let searchResults = null;
    let usedSearch = false;
    let searchKeywords = null;
    let searchStatus = 'not_needed';
    
    if (!hasImage && await needsWebSearch(message, intent)) {
      console.log('🔍 Initiating web search...');
      
      searchKeywords = await extractSearchKeywords(message);
      const rawSearchResults = await searchWeb(searchKeywords, false);
      
      if (rawSearchResults === 'SEARCH_IN_PROGRESS') {
        searchStatus = 'in_progress';
        console.log('⏳ Search already in progress');
      } else if (rawSearchResults) {
        searchResults = await summarizeSearchResults(rawSearchResults, message);
        usedSearch = true;
        searchStatus = 'success';
        console.log(`✅ Search completed: ${searchResults.length} chars`);
      } else {
        searchStatus = 'failed';
        console.log('❌ Search failed');
      }
    }
    let deepThought = null;
    if (intent.needsDeepThinking && intent.complexity === 'complex') {
      deepThought = await deepThinking(message, { memory: userMemory, history: conversationHistory });
      if (deepThought) {
        console.log('🧠 Deep thinking completed');
      }
    }
    const systemPrompt = buildSystemPrompt(userMemory, searchResults, intent, deepThought, imageAnalysis);
    let temperature = 0.7;
    if (intent.type === 'creative') temperature = 0.9;
    if (intent.type === 'technical') temperature = 0.5;
    if (intent.type === 'calculation') temperature = 0.3;
    if (intent.type === 'search') temperature = 0.4;
    if (intent.type === 'image_analysis' || intent.type === 'image_edit') temperature = 0.6;
    if (intent.type === 'ocr') temperature = 0.2;
    const chatCompletion = await callGroqWithRetry({
      messages: [
        { role: 'system', content: systemPrompt }, 
        ...conversationHistory
      ],
      model: MODELS.main,
      temperature,
      max_tokens: 2500,
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Xin lỗi, không thể tạo phản hồi.';
    if (searchStatus === 'failed' && intent.needsSearch) {
      assistantMessage += '\n\n_⚠️ Không thể tìm kiếm web, câu trả lời dựa trên kiến thức có sẵn._';
    } else if (searchStatus === 'in_progress') {
      assistantMessage += '\n\n_⏳ Tìm kiếm đang bận, sử dụng kiến thức có sẵn._';
    }

    let memoryUpdated = false;
    const shouldExtractMemory = /tôi|mình|em|anh|chị|họ|gia đình|sống|làm|học|thích|ghét|yêu|muốn|là|tên/i.test(message);
    
    if (shouldExtractMemory && message.length > 10 && !hasImage) {
      console.log('🧠 Attempting memory extraction...');
      const memoryExtraction = await extractMemory(message, userMemory);
      
      if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
        userMemory = { ...userMemory, ...memoryExtraction.updates };
        await safeRedisSet(memoryKey, userMemory);
        memoryUpdated = true;
        
        const summary = memoryExtraction.summary || 'Đã lưu thông tin';
        assistantMessage += `\n\n💾 _${summary}_`;
      }
    }

    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    await safeRedisSet(chatKey, conversationHistory, 2592000);
    const metadata = {
      success: true,
      message: assistantMessage,
      userId,
      conversationId,
      historyLength: conversationHistory.length,
      memoryUpdated,
      memoryCount: Object.keys(userMemory).length,
      usedWebSearch: usedSearch,
      searchStatus,
      searchKeywords: usedSearch ? searchKeywords : null,
      
      hasImage,
      imageProcessed,
      imageIntent: hasImage ? intent.type : null,
      
      intent: intent.type,
      complexity: intent.complexity,
      usedDeepThinking: !!deepThought,
    
      model: MODELS.main,
      visionModel: hasImage ? MODELS.vision : null,
      temperature,
      
      timestamp: new Date().toISOString()
    };
    return res.status(200).json(metadata);

  } catch (error) {
    console.error('❌ Handler Error:', error);
    
    let errMsg = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.message?.includes('rate_limit')) {
      errMsg = '⚠️ Tất cả API keys vượt giới hạn. Thử lại sau 1 phút.';
      statusCode = 429;
    } else if (error.message?.includes('Request quá lớn')) {
      statusCode = 413;
    } else if (error.message?.includes('không hợp lệ')) {
      statusCode = 400;
    }
    
    return res.status(statusCode).json({ 
      success: false, 
      error: errMsg,
      timestamp: new Date().toISOString()
    });
  }
}
