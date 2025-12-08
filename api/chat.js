import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

// ============================================
// REDIS CONNECTION WITH RETRY & FALLBACK
// ============================================

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('❌ Thiếu UPSTASH_REDIS_REST_URL hoặc UPSTASH_REDIS_REST_TOKEN!');
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  retry: {
    retries: 3,
    backoff: (retryCount) => Math.min(1000 * 2 ** retryCount, 8000)
  }
});

// Redis health check với graceful degradation
let redisHealthy = false;
async function checkRedisHealth() {
  try {
    await redis.ping();
    redisHealthy = true;
    console.log('✅ Redis connected successfully');
    return true;
  } catch (e) {
    redisHealthy = false;
    console.error('❌ Redis connection failed:', e.message);
    console.warn('⚠️ Running in DEGRADED MODE (no persistence)');
    return false;
  }
}

// Check on startup
checkRedisHealth().catch(console.error);

// Periodic health check every 5 minutes
setInterval(() => checkRedisHealth(), 300000);

// ============================================
// IN-MEMORY FALLBACK CACHE
// ============================================

const memoryCache = {
  conversations: new Map(), // userId:convId -> messages[]
  memories: new Map(),      // userId -> memory object
  maxSize: 100,             // Max conversations to keep in memory
  
  get(key) {
    const [type, ...rest] = key.split(':');
    const map = type === 'chat' ? this.conversations : this.memories;
    return map.get(rest.join(':'));
  },
  
  set(key, value) {
    const [type, ...rest] = key.split(':');
    const map = type === 'chat' ? this.conversations : this.memories;
    
    // LRU eviction
    if (map.size >= this.maxSize) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    
    map.set(rest.join(':'), value);
  },
  
  clear() {
    this.conversations.clear();
    this.memories.clear();
  }
};

// ============================================
// IMPROVED REDIS OPERATIONS
// ============================================

async function safeRedisGet(key, defaultValue = null) {
  if (!redisHealthy) {
    console.warn(`⚠️ Redis unhealthy, using memory cache for ${key}`);
    return memoryCache.get(key) || defaultValue;
  }
  
  try {
    const data = await redis.get(key);
    if (!data) return defaultValue;
    
    // Cache in memory for faster access
    memoryCache.set(key, data);
    
    if (typeof data === 'object') return data;
    try { return JSON.parse(data); } catch { return data; }
  } catch (e) {
    console.error(`❌ Redis GET failed for ${key}:`, e.message);
    // Fallback to memory cache
    return memoryCache.get(key) || defaultValue;
  }
}

async function safeRedisSet(key, value, expirySeconds = null) {
  // Always update memory cache first
  memoryCache.set(key, value);
  
  if (!redisHealthy) {
    console.warn(`⚠️ Redis unhealthy, data stored in memory only (will be lost on restart)`);
    return true; // Return success to not break app flow
  }
  
  try {
    const stringified = typeof value === 'string' ? value : JSON.stringify(value);
    if (expirySeconds) {
      await redis.set(key, stringified, { ex: expirySeconds });
    } else {
      await redis.set(key, stringified);
    }
    return true;
  } catch (e) {
    console.error(`❌ Redis SET failed for ${key}:`, e.message);
    // Data is still in memory cache
    return false;
  }
}

// ============================================
// ATOMIC HISTORY OPERATIONS (Fix Race Condition)
// ============================================

async function appendToHistory(chatKey, userMsg, assistantMsg, maxLength = 30) {
  const lockKey = `lock:${chatKey}`;
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTTL = 10; // 10 seconds
  
  try {
    // Try to acquire lock with retry
    let lockAcquired = false;
    for (let i = 0; i < 5; i++) {
      const result = await redis.set(lockKey, lockValue, { 
        nx: true, // Only set if not exists
        ex: lockTTL 
      });
      
      if (result === 'OK') {
        lockAcquired = true;
        break;
      }
      
      // Wait 100-300ms before retry
      await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    }
    
    if (!lockAcquired) {
      console.warn(`⚠️ Could not acquire lock for ${chatKey}, proceeding without lock`);
    }
    
    // Get current history
    let history = await safeRedisGet(chatKey, []);
    if (!Array.isArray(history)) history = [];
    
    // Validate and append new messages
    history.push(
      { role: 'user', content: userMsg, timestamp: Date.now() },
      { role: 'assistant', content: assistantMsg, timestamp: Date.now() }
    );
    
    // Trim if too long (keep only recent messages)
    if (history.length > maxLength) {
      // Keep system message if exists, plus recent messages
      const systemMsgs = history.filter(m => m.role === 'system');
      const otherMsgs = history.filter(m => m.role !== 'system');
      history = [...systemMsgs, ...otherMsgs.slice(-maxLength)];
    }
    
    // Save back
    await safeRedisSet(chatKey, history, 2592000); // 30 days
    
    return history;
    
  } finally {
    // Release lock if we acquired it
    try {
      const currentLock = await redis.get(lockKey);
      if (currentLock === lockValue) {
        await redis.del(lockKey);
      }
    } catch (e) {
      console.warn('⚠️ Lock release failed:', e.message);
    }
  }
}

// ============================================
// IMPROVED MEMORY MANAGEMENT WITH VERSIONING
// ============================================

// Normalize memory field names
function normalizeMemoryKey(key) {
  // Convert to lowercase and trim
  let normalized = key.toLowerCase().trim();
  
  // Map common variations to standard fields
  const keyMapping = {
    'ten': 'tên',
    'tên đầy đủ': 'tên',
    'họ tên': 'tên',
    'tuổi': 'tuổi',
    'tuoi': 'tuổi',
    'nghề': 'nghề nghiệp',
    'nghe': 'nghề nghiệp',
    'nghề nghiệp': 'nghề nghiệp',
    'nghe nghiep': 'nghề nghiệp',
    'công việc': 'nghề nghiệp',
    'cong viec': 'nghề nghiệp',
    'job': 'nghề nghiệp',
    'nơi ở': 'địa điểm',
    'noi o': 'địa điểm',
    'địa chỉ': 'địa điểm',
    'dia chi': 'địa điểm',
    'sống ở': 'địa điểm',
    'location': 'địa điểm',
    'sở thích': 'sở thích',
    'so thich': 'sở thích',
    'thích': 'sở thích',
    'hobby': 'sở thích',
    'hobbies': 'sở thích',
    'học vấn': 'học vấn',
    'hoc van': 'học vấn',
    'trường': 'học vấn',
    'truong': 'học vấn',
    'education': 'học vấn',
    'mối quan hệ': 'mối quan hệ',
    'quan hệ': 'mối quan hệ',
    'gia đình': 'gia đình',
    'gia dinh': 'gia đình',
    'family': 'gia đình',
    'mục tiêu': 'mục tiêu',
    'muc tieu': 'mục tiêu',
    'goal': 'mục tiêu',
    'goals': 'mục tiêu'
  };
  
  return keyMapping[normalized] || normalized;
}

async function updateMemory(memoryKey, updates) {
  if (!updates || Object.keys(updates).length === 0) {
    return null;
  }
  
  try {
    // Get current memory
    const currentMemory = await safeRedisGet(memoryKey, {
      data: {},
      version: 0,
      history: [],
      updatedAt: Date.now()
    });
    
    // Ensure structure
    if (!currentMemory.data) currentMemory.data = {};
    if (!currentMemory.history) currentMemory.history = [];
    if (!currentMemory.version) currentMemory.version = 0;
    
    // Normalize existing keys in memory (one-time migration)
    const normalizedData = {};
    for (const [key, value] of Object.entries(currentMemory.data)) {
      const normalizedKey = normalizeMemoryKey(key);
      // If multiple keys normalize to same field, keep the most recent/longest value
      if (!normalizedData[normalizedKey] || value.length > normalizedData[normalizedKey].length) {
        normalizedData[normalizedKey] = value;
      }
    }
    currentMemory.data = normalizedData;
    
    // Track changes with normalized keys
    const changes = [];
    for (const [key, newValue] of Object.entries(updates)) {
      const normalizedKey = normalizeMemoryKey(key);
      const oldValue = currentMemory.data[normalizedKey];
      
      // Skip if value hasn't actually changed
      if (oldValue === newValue) continue;
      
      // For arrays/lists (like hobbies), merge instead of replace
      if (normalizedKey === 'sở thích' && oldValue) {
        const oldHobbies = oldValue.split(',').map(h => h.trim().toLowerCase());
        const newHobbies = newValue.split(',').map(h => h.trim());
        const mergedHobbies = [...new Set([...oldHobbies, ...newHobbies.map(h => h.toLowerCase())])];
        const finalValue = mergedHobbies.map(h => 
          h.charAt(0).toUpperCase() + h.slice(1)
        ).join(', ');
        
        if (finalValue !== oldValue) {
          changes.push({
            field: normalizedKey,
            oldValue,
            newValue: finalValue,
            timestamp: Date.now()
          });
          currentMemory.data[normalizedKey] = finalValue;
        }
        continue;
      }
      
      changes.push({
        field: normalizedKey,
        oldValue,
        newValue,
        timestamp: Date.now()
      });
      currentMemory.data[normalizedKey] = newValue;
    }
    
    if (changes.length === 0) {
      return currentMemory;
    }
    
    // Update metadata
    currentMemory.version += 1;
    currentMemory.updatedAt = Date.now();
    
    // Keep last 10 changes in history
    currentMemory.history = [
      ...currentMemory.history.slice(-9),
      ...changes
    ];
    
    // Save with 90 days TTL
    await safeRedisSet(memoryKey, currentMemory, 7776000);
    
    console.log(`✅ Memory updated (v${currentMemory.version}): ${changes.length} changes`);
    return currentMemory;
    
  } catch (e) {
    console.error('❌ Memory update failed:', e.message);
    return null;
  }
}

// ============================================
// SMART HISTORY SUMMARIZATION
// ============================================

async function smartSummarizeHistory(history, keepRecent = 10) {
  if (history.length <= 20) return history;
  
  try {
    console.log('📝 Smart summarization started...');
    
    const recentMessages = history.slice(-keepRecent);
    const oldMessages = history.slice(0, -keepRecent);
    
    // Extract important info: code blocks, numbers, names, dates
    const importantPatterns = [
      /```[\s\S]*?```/g,  // Code blocks
      /\d{1,2}\/\d{1,2}\/\d{2,4}/g,  // Dates
      /\d+[.,]\d+/g,  // Numbers
      /[A-Z][a-z]+(?:\s[A-Z][a-z]+)+/g,  // Proper names
    ];
    
    let importantInfo = [];
    oldMessages.forEach(msg => {
      importantPatterns.forEach(pattern => {
        const matches = msg.content.match(pattern);
        if (matches) importantInfo.push(...matches);
      });
    });
    
    // Deduplicate
    importantInfo = [...new Set(importantInfo)].slice(0, 20);
    
    // Create summary with LLM
    const groq = createGroqClient();
    const summary = await groq.chat.completions.create({
      messages: [
        { 
          role: 'system', 
          content: 'Tóm tắt cuộc hội thoại thành 4-5 điểm chính. Giữ nguyên: số liệu, code, tên riêng, ngày tháng.' 
        },
        { 
          role: 'user', 
          content: `${oldMessages.slice(0, 20).map(m => `${m.role}: ${m.content}`).join('\n\n')}\n\nThông tin quan trọng: ${importantInfo.join(', ')}` 
        }
      ],
      model: MODELS.memory,
      temperature: 0.2,
      max_tokens: 400
    });
    
    const summaryText = summary.choices[0]?.message?.content || '';
    
    return [
      { 
        role: 'system', 
        content: `📋 Tóm tắt ${oldMessages.length} tin nhắn:\n${summaryText}\n\nDữ liệu quan trọng: ${importantInfo.slice(0, 10).join(', ')}`,
        timestamp: Date.now(),
        isSummary: true
      },
      ...recentMessages
    ];
    
  } catch (e) {
    console.warn('⚠️ Summarization failed:', e.message);
    // Fallback: just keep recent messages
    return history.slice(-15);
  }
}

// ============================================
// CLEANUP OLD CONVERSATIONS
// ============================================

async function cleanupOldConversations(userId) {
  try {
    // Get all chat keys for this user
    const pattern = `chat:${userId}:*`;
    const keys = await redis.keys(pattern);
    
    if (!keys || keys.length === 0) return;
    
    console.log(`🧹 Found ${keys.length} conversations for ${userId}`);
    
    // Get TTL for each key
    const ttls = await Promise.all(
      keys.map(async key => {
        try {
          const ttl = await redis.ttl(key);
          return { key, ttl };
        } catch {
          return { key, ttl: -1 };
        }
      })
    );
    
    // Delete expired or very old conversations
    let deletedCount = 0;
    for (const { key, ttl } of ttls) {
      if (ttl === -1 || ttl > 2592000) { // No TTL or > 30 days
        try {
          await redis.del(key);
          deletedCount++;
        } catch (e) {
          console.warn(`⚠️ Failed to delete ${key}:`, e.message);
        }
      }
    }
    
    if (deletedCount > 0) {
      console.log(`✅ Cleaned up ${deletedCount} old conversations`);
    }
    
  } catch (e) {
    console.error('❌ Cleanup failed:', e.message);
  }
}

// Run cleanup every 6 hours
setInterval(() => {
  // Get list of active users from recent requests (implement based on your needs)
  // For now, skip auto-cleanup
}, 21600000);

// ============================================
// GROQ & SEARCH SETUP (unchanged)
// ============================================

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
};

if (API_KEYS.length === 0) throw new Error('❌ Không tìm thấy GROQ_API_KEY!');

let lastGroqKeyIndex = -1;
function createGroqClient() {
  lastGroqKeyIndex = (lastGroqKeyIndex + 1) % API_KEYS.length;
  return new Groq({ apiKey: API_KEYS[lastGroqKeyIndex] });
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
  throw new Error(`❌ Hết ${maxRetries} API keys. Rate limit: ${lastError.message}`);
}

// [Rest of your existing helper functions: extractSearchKeywords, summarizeSearchResults, 
// searchWeb, analyzeIntent, needsWebSearch, extractMemory, deepThinking, buildSystemPrompt...]
// Keep them as-is, they work fine

// ============================================
// IMPROVED MAIN HANDLER
// ============================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { message, userId = 'default', conversationId = 'default' } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required and must be a string' });
    }
    
    if (message.length > 3000) {
      return res.status(400).json({ error: 'Message too long (max 3000 characters)' });
    }
    
    const chatKey = `chat:${userId}:${conversationId}`;
    const memoryKey = `memory:${userId}`;
    
    // Get history and memory in parallel
    const [historyData, memoryData] = await Promise.all([
      safeRedisGet(chatKey, []),
      safeRedisGet(memoryKey, { data: {}, version: 0, history: [], updatedAt: Date.now() })
    ]);
    
    let conversationHistory = Array.isArray(historyData) ? historyData : [];
    let userMemory = memoryData.data || {};
    
    // Validate history structure
    conversationHistory = conversationHistory.filter(msg => 
      msg && 
      typeof msg === 'object' && 
      msg.role && 
      msg.content && 
      ['user', 'assistant', 'system'].includes(msg.role)
    );
    
    // Analyze intent
    const intent = await analyzeIntent(message, conversationHistory);
    console.log('🎯 Intent:', intent.type, '| Complexity:', intent.complexity);
    
    // Smart summarization if history is too long
    if (conversationHistory.length > 20) {
      conversationHistory = await smartSummarizeHistory(conversationHistory, 12);
    }
    
    // Web search if needed
    let searchResults = null;
    let usedSearch = false;
    if (await needsWebSearch(message, intent)) {
      console.log('🔍 Web search triggered...');
      const keywords = await extractSearchKeywords(message);
      const rawResults = await searchWeb(keywords);
      if (rawResults) {
        searchResults = await summarizeSearchResults(rawResults, message);
        usedSearch = true;
      }
    }
    
    // Deep thinking for complex queries
    let deepThought = null;
    if (intent.needsDeepThinking && intent.complexity === 'complex') {
      deepThought = await deepThinking(message, { memory: userMemory, history: conversationHistory });
    }
    
    // Build system prompt
    const systemPrompt = buildSystemPrompt(userMemory, searchResults, intent, deepThought);
    
    // Adjust temperature
    let temperature = 0.7;
    if (intent.type === 'creative') temperature = 0.9;
    if (intent.type === 'technical') temperature = 0.5;
    if (intent.type === 'calculation') temperature = 0.3;
    
    // Call LLM
    const chatCompletion = await callGroqWithRetry({
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: message }
      ],
      model: MODELS.main,
      temperature,
      max_tokens: 2500,
      top_p: 0.9
    });
    
    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Xin lỗi, tôi không thể tạo phản hồi.';
    
    // Extract and update memory if personal info detected
    let memoryUpdated = false;
    const personalInfoPatterns = [
      /tôi (là|tên|tên là|họ|sinh năm|năm nay)\s+\w+/i,
      /mình (là|tên|tên là|họ|sinh năm|năm nay)\s+\w+/i,
      /(tôi|mình|em)\s+(làm|học|sống ở|ở|đang)\s+\w+/i,
      /(tôi|mình|em)\s+(thích|ghét|yêu|đam mê)\s+\w+/i,
      /(tôi|mình|em)\s+\d+\s+tuổi/i,
    ];
    
    const seemsPersonalInfo = personalInfoPatterns.some(p => p.test(message));
    
    if (seemsPersonalInfo && message.length > 15 && !message.trim().endsWith('?')) {
      const memoryExtraction = await extractMemory(message, userMemory);
      
      if (memoryExtraction.hasNewInfo && memoryExtraction.updates) {
        const updatedMemory = await updateMemory(memoryKey, memoryExtraction.updates);
        if (updatedMemory) {
          memoryUpdated = true;
          userMemory = updatedMemory.data;
        }
      }
    }
    
    // Atomically append to history
    conversationHistory = await appendToHistory(chatKey, message, assistantMessage);
    
    // Return response
    return res.status(200).json({
      success: true,
      message: assistantMessage,
      metadata: {
        userId,
        conversationId,
        historyLength: conversationHistory.length,
        memoryUpdated,
        memoryCount: Object.keys(userMemory).length,
        memoryVersion: memoryData.version,
        usedWebSearch: usedSearch,
        intent: intent.type,
        complexity: intent.complexity,
        usedDeepThinking: !!deepThought,
        redisHealthy,
        model: MODELS.main,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('❌ Handler Error:', error);
    
    let errMsg = error.message || 'Internal server error';
    let statusCode = 500;
    
    if (error.message?.includes('rate_limit')) {
      errMsg = '⚠️ Tất cả API keys đã vượt giới hạn. Vui lòng thử lại sau 1 phút.';
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
