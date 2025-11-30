// /api/chat.js
import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ----- CONFIG -----
const MODELS = {
  main: 'llama-3.1-8b-instant',
  search: 'llama-3.1-8b-instant',   // dùng cho summarization / lightweight calls
  memory: 'llama-3.1-8b-instant'
};

// Safety token limits (based on Groq error logs)
const MODEL_TOKEN_LIMIT = 6000;      // hard limit reported by Groq
const SAFETY_MARGIN = 500;          // reserve for the model output
const MAX_INPUT_TOKENS = MODEL_TOKEN_LIMIT - SAFETY_MARGIN; // e.g., 5500

// API KEYS - ensure these env vars exist in Vercel/host
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
].filter(Boolean);

if (API_KEYS.length === 0) {
  console.error('❌ No GROQ API keys found!');
}

// Global round-robin pointer (module-level persistence helps serverless warm starts)
let keyPointer = 0;

// ----- UTILITIES -----

function getNextKeyIndex() {
  if (API_KEYS.length === 0) return null;
  const idx = keyPointer % API_KEYS.length;
  keyPointer = (keyPointer + 1) % API_KEYS.length;
  return idx;
}

function createGroqClientWithIndex(index) {
  const apiKey = API_KEYS[index];
  return new Groq({ apiKey });
}

// Rough token estimator: tokens ≈ chars / 4 (approx)
function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateTokensFromMessages(messages) {
  // messages: [{role, content}, ...]
  let total = 0;
  for (const m of messages) {
    total += estimateTokensFromText(m.content || '');
    // lightweight overhead per message
    total += 3;
  }
  return total;
}

// Sequential retry across keys (round-robin start)
// Tries up to API_KEYS.length keys sequentially (not random)
async function callGroqWithRoundRobin(config) {
  if (API_KEYS.length === 0) {
    throw new Error('No API keys configured.');
  }

  let lastErr = null;
  // Start from current pointer but try up to API_KEYS.length different keys
  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const idx = getNextKeyIndex();
    try {
      const groq = createGroqClientWithIndex(idx);
      const result = await groq.chat.completions.create(config);
      return result;
    } catch (error) {
      lastErr = error;
      // If rate limit, try next key
      if (error.status === 429 || (error.message && error.message.includes('rate_limit'))) {
        console.warn(`Key idx ${idx} rate-limited, trying next key...`);
        continue;
      }
      // If token limit (413), immediate fail: request too large for model
      if (error.status === 413 || (error.message && error.message.toLowerCase().includes('request too large'))) {
        // Bubble up so caller can handle (we should avoid retrying keys for this case)
        throw error;
      }
      // For other transient errors, try next key once
      console.warn(`Key idx ${idx} error: ${error.message || error}`);
      continue;
    }
  }

  // If reached here, all keys exhausted / failed
  const msg = lastErr?.message || 'All API keys failed';
  const err = new Error(`All ${API_KEYS.length} keys failed: ${msg}`);
  err.cause = lastErr;
  throw err;
}

// Summarize a chunk of messages using the search/memory model
async function summarizeMessagesChunk(messagesChunk = []) {
  if (!messagesChunk || messagesChunk.length === 0) return null;

  const raw = messagesChunk.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

  const systemPrompt = `Bạn là một trợ lý tóm tắt chuyên nghiệp. Tóm tắt ngắn gọn các điểm chính, ý định của người dùng, quyết định, các task quan trọng, và trạng thái cảm xúc nếu có. Giữ dưới 300 từ. Không thêm thông tin mới.`;

  const config = {
    model: MODELS.search,
    temperature: 0.0,
    max_tokens: 400,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Tóm tắt đoạn hội thoại sau:\n\n${raw}` }
    ]
  };

  try {
    const resp = await callGroqWithRoundRobin(config);
    const summary = resp.choices?.[0]?.message?.content?.trim();
    return summary || null;
  } catch (error) {
    console.error('❌ summarizeMessagesChunk error:', error?.message || error);
    return null;
  }
}

// Compress history until estimated tokens <= MAX_INPUT_TOKENS
async function compressHistoryIfNeeded(systemPromptText, memoryObject, conversationHistory, currentUserMessage) {
  // Build tentative messages to test size
  // system + memory + conversationHistory + currentUserMessage
  const memoryText = Object.keys(memoryObject || {}).length > 0
    ? Object.entries(memoryObject).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';

  const baseSystem = systemPromptText || '';
  let messagesForEstimate = [
    { role: 'system', content: baseSystem },
  ];

  if (memoryText) {
    messagesForEstimate.push({ role: 'system', content: `Thông tin người dùng:\n${memoryText}` });
  }

  // append full history
  for (const m of conversationHistory) messagesForEstimate.push(m);
  // append current user
  messagesForEstimate.push({ role: 'user', content: currentUserMessage });

  let totalTokens = estimateTokensFromMessages(messagesForEstimate);

  // If already within safe limit, return without changes
  if (totalTokens <= MAX_INPUT_TOKENS) {
    return {
      messages: messagesForEstimate,
      compressed: false,
      totalTokens
    };
  }

  // Otherwise compress iteratively: take oldest messages chunk and summarize
  // We'll aim to compress until totalTokens <= MAX_INPUT_TOKENS
  // Strategy: repeatedly take the oldest N messages (start with 8 messages) and summarize them.
  const history = [...conversationHistory]; // copy
  let attempts = 0;
  const maxAttempts = 10;

  while (totalTokens > MAX_INPUT_TOKENS && history.length > 0 && attempts < maxAttempts) {
    attempts++;

    // choose chunk size: proportional to history length but limited
    const chunkSize = Math.min(Math.max(6, Math.floor(history.length * 0.3)), 20); // 6..20
    const chunk = history.splice(0, chunkSize);

    // Ensure chunk isn't enormous string; if too large, reduce chunk by half
    let chunkText = chunk.map(m => `${m.role}: ${m.content}`).join('\n\n');
    if (estimateTokensFromText(chunkText) > 3000) {
      // reduce chunk size drastically
      const half = Math.ceil(chunkSize / 2);
      const reduced = [...chunk].slice(0, half);
      // put back the rest
      history.unshift(...chunk.slice(half));
      chunkText = reduced.map(m => `${m.role}: ${m.content}`).join('\n\n');
    }

    // Summarize that chunk
    const summary = await summarizeMessagesChunk(chunk);
    if (summary) {
      // Insert a single assistant message representing the summary at the start
      const summaryMessage = { role: 'assistant', content: `TÓM TẮT: ${summary}` };
      history.unshift(summaryMessage);
    } else {
      // If summarization failed, as a fallback remove the chunk (drop oldest)
      // (we prefer to drop content than to exceed token limit)
      // nothing to unshift
      console.warn('Summarization failed; dropping oldest chunk.');
    }

    // Rebuild messagesForEstimate and re-estimate
    messagesForEstimate = [{ role: 'system', content: baseSystem }];
    if (memoryText) messagesForEstimate.push({ role: 'system', content: `Thông tin người dùng:\n${memoryText}` });
    for (const m of history) messagesForEstimate.push(m);
    messagesForEstimate.push({ role: 'user', content: currentUserMessage });

    totalTokens = estimateTokensFromMessages(messagesForEstimate);
    console.log(`Compress attempt ${attempts}: estimated tokens -> ${totalTokens}`);
  }

  // Final return
  return {
    messages: messagesForEstimate,
    compressed: totalTokens <= MAX_INPUT_TOKENS ? true : false,
    totalTokens
  };
}

// ----- MAIN HANDLER -----
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`📨 [${userId}] Message length chars: ${message.length}`);

    // Redis keys
    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;

    // Load conversation history and memory
    let conversationHistory = await redis.get(chatKey) || [];
    if (typeof conversationHistory === 'string') {
      try { conversationHistory = JSON.parse(conversationHistory); } catch { conversationHistory = []; }
    }
    if (!Array.isArray(conversationHistory)) conversationHistory = [];

    let userMemory = await redis.get(memoryKey) || {};
    if (typeof userMemory === 'string') {
      try { userMemory = JSON.parse(userMemory); } catch { userMemory = {}; }
    }
    if (!userMemory || typeof userMemory !== 'object') userMemory = {};

    // Basic commands handling (memory, forget)
    const lowerMsg = message.toLowerCase().trim();
    if (lowerMsg === '/memory' || lowerMsg === 'bạn nhớ gì về tôi' || lowerMsg === 'bạn biết gì về tôi') {
      let memoryText = '📝 Thông tin tôi nhớ về bạn:\n\n';
      if (Object.keys(userMemory).length === 0) {
        memoryText = '💭 Tôi chưa có thông tin nào về bạn.';
      } else {
        for (const [k, v] of Object.entries(userMemory)) memoryText += `• ${k}: ${v}\n`;
        memoryText += `\n_Tổng cộng ${Object.keys(userMemory).length} thông tin._`;
      }
      return res.status(200).json({ success: true, message: memoryText });
    }
    if (lowerMsg === '/forget' || lowerMsg === 'quên tôi đi' || lowerMsg === 'xóa thông tin') {
      await redis.del(memoryKey);
      return res.status(200).json({ success: true, message: '🗑️ Đã xóa toàn bộ thông tin về bạn.' });
    }
    if (lowerMsg.startsWith('/forget ')) {
      const keyToDel = message.substring(8).trim();
      if (userMemory[keyToDel]) {
        delete userMemory[keyToDel];
        await redis.set(memoryKey, JSON.stringify(userMemory));
        return res.status(200).json({ success: true, message: `🗑️ Đã xóa thông tin: ${keyToDel}` });
      } else {
        return res.status(200).json({ success: false, message: `❓ Không tìm thấy thông tin: ${keyToDel}` });
      }
    }

    // Append user message to conversationHistory temporarily for estimation
    const tempHistory = [...conversationHistory];
    tempHistory.push({ role: 'user', content: message });

    // Build base system prompt text (as before)
    const buildSystemPromptText = (memoryObj, searchResults = null) => {
      let prompt = 'Bạn tên là KAMI. Trợ lý AI thông minh hữu ích và thân thiện. Được tạo ra bởi Nguyễn Đức Thanh.';
      if (searchResults) {
        prompt += '\n\nThông tin tham khảo:\n' + searchResults;
        prompt += '\n\nHãy trả lời ngắn gọn, chính xác dựa trên thông tin trên.';
      }
      if (Object.keys(memoryObj).length > 0) {
        prompt += '\n\n📝 THÔNG TIN BẠN BIẾT VỀ NGƯỜI DÙNG:\n';
        for (const [key, value] of Object.entries(memoryObj)) {
          prompt += `- ${key}: ${value}\n`;
        }
        prompt += '\n⚠️ QUY TẮC:\n';
        prompt += '- Sử dụng các thông tin này một cách TỰ NHIÊN trong cuộc trò chuyện\n';
        prompt += '- ĐỪNG nhắc đi nhắc lại thông tin trừ khi được hỏi\n';
      }
      return prompt;
    };

    const systemPromptText = buildSystemPromptText(userMemory, null);

    // Compress history if needed (this will estimate tokens and summarize oldest chunks until safe)
    const { messages: preparedMessages, compressed, totalTokens } = await compressHistoryIfNeeded(systemPromptText, userMemory, conversationHistory, message);

    console.log(`Prepared messages tokens estimate: ${totalTokens}, compressed? ${compressed}`);

    // If still too large after compression attempts, fail gracefully with actionable message
    if (totalTokens > MODEL_TOKEN_LIMIT) {
      return res.status(413).json({
        success: false,
        error: `Request too large even after compression. Estimated tokens: ${totalTokens}. Reduce message size or history length.`
      });
    }

    // Build final messages array for model
    // preparedMessages already contains system and memory as system messages and history + user message
    // But ensure system comes only once at top (preparedMessages already has system entries)
    const finalMessages = preparedMessages;

    // Create request config for main model
    const chatConfig = {
      model: MODELS.main,
      temperature: 0.7,
      max_tokens: 1024, // response budget (we reserved SAFETY_MARGIN earlier)
      top_p: 0.9,
      messages: finalMessages,
      stream: false
    };

    // Call model with round-robin keys
    let completion;
    try {
      completion = await callGroqWithRoundRobin(chatConfig);
    } catch (error) {
      // If it's a token-size (413) error, forward specific message
      if (error.status === 413 || (error.message && error.message.toLowerCase().includes('request too large'))) {
        return res.status(413).json({
          success: false,
          error: `Request too large for model. Estimated tokens: ${totalTokens}. Limit: ${MODEL_TOKEN_LIMIT}.`
        });
      }
      // If rate limits exhausted
      if (error.message && error.message.toLowerCase().includes('rate')) {
        return res.status(429).json({ success: false, error: 'Rate limit across all API keys. Vui lòng thử lại sau.' });
      }
      console.error('❌ Model call failed:', error?.message || error);
      return res.status(500).json({ success: false, error: error.message || 'Model call failed' });
    }

    const assistantMessage = completion.choices?.[0]?.message?.content || 'Không có phản hồi';

    // Post-process: save memory if extractor finds new info
    // Reuse earlier extraction logic if present (simple placeholder here)
    // For now, we keep previous extractMemory behavior if desired (omitted for brevity)
    // Append assistant message and user message to conversation history (and trim)
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: assistantMessage });

    // Keep reasonable length of conversationHistory in Redis (e.g., last 200 messages)
    const MAX_HISTORY_MESSAGES = 200;
    if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    await redis.setex(chatKey, 2592000, JSON.stringify(conversationHistory));

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId,
      conversationId,
      historyLength: conversationHistory.length,
      compressed,
      estimatedTokens: totalTokens,
      availableApiKeys: API_KEYS.length
    });

  } catch (error) {
    console.error('❌ Handler error:', error?.message || error);
    const msg = error?.message || 'Internal server error';
    return res.status(500).json({ success: false, error: msg });
  }
}
