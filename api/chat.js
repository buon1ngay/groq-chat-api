import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// ==================== REDIS ====================
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ==================== API KEYS & MODEL ====================
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);

const MODELS = {
  main: 'llama-3.1-8b-instant',
  search: 'llama-3.1-8b-instant',
  memory: 'llama-3.1-8b-instant',
};

if (API_KEYS.length === 0) throw new Error('❌ Không tìm thấy GROQ_API_KEY!');

console.log(`🔑 Load ${API_KEYS.length} GROQ API keys`);
console.log(`🤖 Models: Main=${MODELS.main}, Search=${MODELS.search}, Memory=${MODELS.memory}`);

let lastGroqKeyIndex = -1;
function createGroqClient() {
  lastGroqKeyIndex = (lastGroqKeyIndex + 1) % API_KEYS.length;
  return new Groq({ apiKey: API_KEYS[lastGroqKeyIndex] });
}

// ==================== SEARCH APIs - XOAY VÒNG ====================
const SEARCH_APIS = [
  {
    name: 'Serper',
    apiKey: process.env.SERPER_API_KEY,
    enabled: !!process.env.SERPER_API_KEY,
    async search(query) {
      const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', num: 5 })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      let results = '';
      if (data.knowledgeGraph) results += `${data.knowledgeGraph.title || ''}\n${data.knowledgeGraph.description || ''}\n\n`;
      if (data.answerBox?.answer) results += `${data.answerBox.answer}\n\n`;
      if (data.organic?.length) data.organic.slice(0, 3).forEach(item => results += `${item.title}\n${item.snippet || ''}\n\n`);
      return results.trim() || null;
    }
  },
  {
    name: 'Tavily',
    apiKey: process.env.TAVILY_API_KEY,
    enabled: !!process.env.TAVILY_API_KEY,
    async search(query) {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: 'basic',
          include_answer: true,
          max_results: 5
        })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      let results = '';
      if (data.answer) results += `${data.answer}\n\n`;
      if (data.results?.length) data.results.slice(0, 3).forEach(item =>
        results += `${item.title}\n${item.content ? item.content.substring(0, 150) : ''}...\n\n`
      );
      return results.trim() || null;
    }
  }
].filter(api => api.enabled);

console.log(`🔍 Load ${SEARCH_APIS.length} Search APIs: ${SEARCH_APIS.map(a => a.name).join(', ')}`);

let lastSearchApiIndex = -1;
async function searchWeb(query) {
  if (!SEARCH_APIS.length) return null;

  // ================= CACHE SEARCH 15 PHÚT =================
  const cacheKey = `search:${query}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  for (let i = 0; i < SEARCH_APIS.length; i++) {
    lastSearchApiIndex = (lastSearchApiIndex + 1) % SEARCH_APIS.length;
    const api = SEARCH_APIS[lastSearchApiIndex];
    try {
      console.log(`   Trying ${api.name}...`);
      const result = await api.search(query);
      if (result) {
        await redis.setex(cacheKey, 900, result); // cache 15 phút
        return result;
      }
    } catch (e) {
      console.warn(`❌ ${api.name} error: ${e.message}`);
      continue;
    }
  }
  console.warn('⚠️ All search APIs failed');
  return null;
}

// ==================== CẦN SEARCH ====================
async function needsWebSearch(message) {
  const triggers = [
    /hiện (tại|nay|giờ)|bây giờ|lúc này/i,
    /năm (19|20)\d{2}/i,
    /mới nhất|gần đây|vừa rồi|hôm (nay|qua)/i,
    /giá|tỷ giá|bao nhiêu tiền/i,
    /tin tức|sự kiện|cập nhật/i,
    /ai là|ai đã|là ai/i,
    /khi nào|lúc nào|bao giờ/i,
    /ở đâu|chỗ nào|tại đâu/i,
  ];
  if (triggers.some(r => r.test(message))) return true;

  try {
    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: `Xác định câu hỏi có CẦN TÌM KIẾM WEB không. Chỉ trả "YES" hoặc "NO".` },
        { role: 'user', content: message }
      ],
      model: MODELS.search,
      temperature: 0.1,
      max_tokens: 10
    });
    const ans = response.choices[0]?.message?.content?.trim().toUpperCase();
    return ans === 'YES';
  } catch (e) {
    return message.includes('?');
  }
}

// ==================== CALL GROQ RETRY ====================
async function callGroqWithRetry(config, maxRetries = API_KEYS.length) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const groq = createGroqClient();
      return await groq.chat.completions.create(config);
    } catch (e) {
      lastError = e;
      if (e.status === 413 || e.message?.includes('Request too large')) throw new Error('Request quá lớn.');
      if (e.status === 429 || e.message?.includes('rate_limit')) continue;
      throw e;
    }
  }
  throw new Error(`Hết ${maxRetries} keys: ${lastError.message}`);
}

// ==================== MEMORY EXTRACTION ====================
async function extractMemory(message, currentMemory) {
  try {
    const prompt = `Phân tích tin nhắn sau và trích xuất thông tin quan trọng, trả về JSON.
TIN NHẮN: "${message}"
THÔNG TIN ĐÃ LƯU: ${JSON.stringify(currentMemory, null, 2)}`;
    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Chỉ trả JSON, không thêm text khác' },
        { role: 'user', content: prompt }
      ],
      model: MODELS.memory,
      temperature: 0.3,
      max_tokens: 500
    });
    const content = response.choices[0]?.message?.content || '{}';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { hasNewInfo: false };
  } catch (e) {
    return { hasNewInfo: false };
  }
}

// ==================== SYSTEM PROMPT ====================
function buildSystemPrompt(memory, searchResults = null) {
  let prompt = 'Bạn là KAMI, trợ lý AI thân thiện.';
  if (searchResults) prompt += `\n\nDữ liệu:\n${searchResults}\nTrả lời ngắn gọn.`;
  if (Object.keys(memory).length) {
    prompt += '\n\nThông tin user:\n';
    for (const [k, v] of Object.entries(memory)) prompt += `${k}: ${v}\n`;
  }
  return prompt;
}

// ==================== MAIN HANDLER ====================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required' });

    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let conversationHistory = await redis.get(chatKey) || [];
    if (typeof conversationHistory === 'string') conversationHistory = JSON.parse(conversationHistory);
    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') userMemory = JSON.parse(userMemory);

    const lowerMsg = message.toLowerCase();

    if (lowerMsg === '/memory') {
      const memText = Object.keys(userMemory).length
        ? Object.entries(userMemory).map(([k,v]) => `• ${k}: ${v}`).join('\n')
        : '💭 Tôi chưa có thông tin nào về bạn.';
      return res.status(200).json({ success: true, message: memText, memoryCount: Object.keys(userMemory).length });
    }

    if (lowerMsg.startsWith('/forget')) {
      if (lowerMsg === '/forget') {
        await redis.del(memoryKey);
        return res.status(200).json({ success: true, message: '🗑️ Đã xóa toàn bộ thông tin.' });
      } else {
        const keyToDelete = message.substring(8).trim();
        if (userMemory[keyToDelete]) {
          delete userMemory[keyToDelete];
          await redis.set(memoryKey, JSON.stringify(userMemory));
          return res.status(200).json({ success: true, message: `🗑️ Đã xóa thông tin: ${keyToDelete}` });
        } else return res.status(200).json({ success: true, message: `❓ Không tìm thấy: ${keyToDelete}` });
      }
    }

    conversationHistory.push({ role: 'user', content: message });
    if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

    let searchResults = null, usedSearch = false;
    if (await needsWebSearch(message)) {
      searchResults = await searchWeb(message);
      usedSearch = !!searchResults;
    }

    const systemPrompt = buildSystemPrompt(userMemory, searchResults);
    const chatCompletion = await callGroqWithRetry({
      messages: [{ role: 'system', content: systemPrompt }, ...conversationHistory],
      model: MODELS.main,
      temperature: 0.7,
      max_tokens: 512,
      top_p: 0.9,
      stream: false
    });

    let assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi'

    const memoryExtraction = await extractMemory(message, userMemory);
    let memoryUpdated = false;
    if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
      userMemory = { ...userMemory, ...memoryExtraction.updates };
      await redis.set(memoryKey, JSON.stringify(userMemory));
      memoryUpdated = true;
      assistantMessage += `\n\n💾 _${memoryExtraction.summary || 'Đã cập nhật thông tin về bạn.'}_`;
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
      memoryCount: Object.keys(userMemory).length,
      usedWebSearch: usedSearch
    });

  } catch (error) {
    console.error('❌ Error:', error);
    let errMsg = error.message || 'Internal server error';
    if (error.message?.includes('rate_limit')) errMsg = '⚠️ Tất cả API keys đã vượt giới hạn.';
    return res.status(500).json({ success: false, error: errMsg });
  }
}
