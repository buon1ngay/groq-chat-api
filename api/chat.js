import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// =========================
// 🔥 KHỞI TẠO REDIS
// =========================
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// =========================
// 🔥 LOAD 4 GROQ API KEYS
// =========================
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

// =========================
// 🔥 GROQ RETRY ENGINE
// =========================
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

  throw new Error(`🔥 Hết ${maxRetries} keys: ${lastError.message}`);
}

// =========================
// 🔍 NHẬN DIỆN CÓ CẦN TÌM KIẾM WEB KHÔNG
// =========================
function needsWebSearch(message) {
  const lower = message.toLowerCase();

  const keywords = [
    'tin tức', 'tin mới', 'mới nhất', 'vừa xảy ra', 'xảy ra',
    'hôm qua', 'hôm nay', 'đang diễn ra', 'update',
    'latest', 'breaking', 'recent',
    'ai là tổng thống', 'ai đang', 'hiện tại là',
    'mới công bố', 'tai nạn', 'bùng phát', 'vụ việc',
  ];

  return keywords.some(k => lower.includes(k));
}

// =========================
// 🔍 SEARCH: DUCKDUCKGO (MIỄN PHÍ)
// =========================
async function searchDuckDuckGo(query) {
  try {
    console.log('🟢 Searching DuckDuckGo for:', query);

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (KamiBot)'
      }
    });

    if (!response.ok) return null;

    const data = await response.json();

    let result = '';

    if (data.Abstract && data.Abstract.length > 30) {
      result = data.Abstract;
    } else if (data.Answer) {
      result = data.Answer;
    } else if (data.RelatedTopics?.length > 0) {
      const topics = data.RelatedTopics
        .filter(t => t.Text)
        .slice(0, 3)
        .map(t => t.Text)
        .join('\n\n');

      if (topics) result = topics;
    }

    if (result && result.length > 30) {
      return `[Nguồn: DuckDuckGo]\n${result}`;
    }

    return null;
  } catch (err) {
    console.error('❌ DuckDuckGo error:', err.message);
    return null;
  }
}

// =========================
// 🔍 HÀM SEARCH CHÍNH
// =========================
async function searchWeb(query) {
  console.log('🔍 Start web search:', query);

  const duck = await searchDuckDuckGo(query);
  if (duck) return duck;

  return null;
}

// =========================
// 🔥 MEMORY EXTRACTION
// =========================
async function extractMemory(message, currentMemory) {
  try {
    const extractionPrompt = `
Phân tích tin nhắn sau và trích xuất THÔNG TIN CÁ NHÂN QUAN TRỌNG.

TIN NHẮN:
"${message}"

THÔNG TIN ĐÃ LƯU:
${JSON.stringify(currentMemory)}

Chỉ xuất JSON dạng:
{
 "hasNewInfo": true/false,
 "updates": {},
 "summary": ""
}`;

    const response = await callGroqWithRetry({
      messages: [
        { role: 'system', content: 'Chỉ trả về JSON.' },
        { role: 'user', content: extractionPrompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 300
    });

    const text = response.choices[0]?.message?.content || '{}';
    const match = text.match(/\{[\s\S]*\}/);

    if (match) return JSON.parse(match[0]);

    return { hasNewInfo: false };
  } catch (error) {
    console.error('❌ Error extracting memory:', error);
    return { hasNewInfo: false };
  }
}

// =========================
// 🔥 SYSTEM PROMPT
// =========================
function buildSystemPrompt(memory) {
  let text = `Bạn tên là KAMI. Trả lời tiếng Việt tự nhiên, hữu ích.`;

  if (Object.keys(memory).length > 0) {
    text += '\n\nTHÔNG TIN BIẾT VỀ USER:\n';
    for (const [k, v] of Object.entries(memory)) {
      text += `- ${k}: ${v}\n`;
    }
  }

  return text;
}

// =========================
// 📌 API ROUTE CHÍNH
// =========================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    console.log(`📨 [${userId}]`, message);

    // ===== LOAD HISTORY & MEMORY =====
    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    let history = await redis.get(chatKey) || [];
    if (typeof history === 'string') history = JSON.parse(history);

    let memory = await redis.get(memoryKey) || {};
    if (typeof memory === 'string') memory = JSON.parse(memory);

    // ===== LỆNH /memory =====
    if (message.toLowerCase() === '/memory') {
      return res.status(200).json({
        success: true,
        message:
          Object.keys(memory).length === 0
            ? 'Tôi chưa nhớ gì về bạn.'
            : memory
      });
    }

    // ===== LỆNH /forget =====
    if (message.toLowerCase() === '/forget') {
      await redis.del(memoryKey);
      return res.status(200).json({ success: true, message: 'Đã xoá toàn bộ.' });
    }

    // ===== TỰ TRÍCH XUẤT MEMORY =====
    const memoryExtraction = await extractMemory(message, memory);

    if (memoryExtraction.hasNewInfo) {
      memory = { ...memory, ...memoryExtraction.updates };
      await redis.set(memoryKey, JSON.stringify(memory));
    }

    // ===== TÌM KIẾM NẾU CẦN =====
    let searchResult = null;

    if (needsWebSearch(message)) {
      searchResult = await searchWeb(message);
    }

    // ===== BUILD PROMPT =====
    const systemPrompt = buildSystemPrompt(memory);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    if (searchResult) {
      messages.push({
        role: 'system',
        content: `Kết quả tìm kiếm:\n${searchResult}`
      });
    }

    // ===== GỌI GROQ =====
    const response = await callGroqWithRetry({
      messages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.5,
      max_tokens: 2000
    });

    const reply = response.choices[0]?.message?.content || '...';

    // ===== LƯU LỊCH SỬ =====
    history.push(
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    );

    await redis.set(chatKey, JSON.stringify(history));

    // ===== TRẢ VỀ =====
    return res.status(200).json({
      success: true,
      reply
    });

  } catch (error) {
    console.error('❌ API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
