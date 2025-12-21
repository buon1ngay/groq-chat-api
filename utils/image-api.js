// ============================================
// FREE IMAGE GENERATION MODULE
// Hỗ trợ: Hugging Face + Multiple providers
// Features: Auto-retry, Cache, Failover
// ============================================

import axios from 'axios';

// ============ CONFIG ============

const IMAGE_CONFIG = {
  CACHE_TTL_MINUTES: 30,           // Cache ảnh 30 phút
  REQUEST_TIMEOUT: 15000,          // 15s timeout
  MAX_RETRIES: 3,                  // Retry tối đa 3 lần
  RETRY_DELAY: 2000,               // Đợi 2s giữa các retry
  MAX_CACHE_SIZE: 50               // Lưu tối đa 50 ảnh trong cache
};

// Providers config (ưu tiên từ trên xuống)
const PROVIDERS = [
  {
    name: 'HuggingFace-FLUX',
    endpoint: 'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
    apiKey: process.env.HUGGINGFACE_API_KEY,
    enabled: true,
    priority: 1,
    description: 'FLUX.1 Schnell - Nhanh nhất, chất lượng cao'
  },
  {
    name: 'HuggingFace-SD3',
    endpoint: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-3-medium',
    apiKey: process.env.HUGGINGFACE_API_KEY,
    enabled: true,
    priority: 2,
    description: 'Stable Diffusion 3 - Balanced'
  },
  {
    name: 'HuggingFace-SDXL',
    endpoint: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
    apiKey: process.env.HUGGINGFACE_API_KEY,
    enabled: true,
    priority: 3,
    description: 'SDXL - Stable, reliable'
  }
];

// ============ IN-MEMORY CACHE ============

class ImageCache {
  constructor() {
    this.cache = new Map();
    this.accessCount = new Map();
  }

  getCacheKey(prompt, provider) {
    // Normalize prompt để tối ưu cache hit
    const normalized = prompt.toLowerCase().trim().replace(/\s+/g, ' ');
    return `${provider}:${normalized}`;
  }

  get(prompt, provider) {
    const key = this.getCacheKey(prompt, provider);
    const cached = this.cache.get(key);

    if (!cached) return null;

    // Check expiry
    const age = Date.now() - cached.timestamp;
    const maxAge = IMAGE_CONFIG.CACHE_TTL_MINUTES * 60 * 1000;

    if (age > maxAge) {
      this.cache.delete(key);
      this.accessCount.delete(key);
      return null;
    }

    // Update access count
    this.accessCount.set(key, (this.accessCount.get(key) || 0) + 1);

    console.log(`✅ Cache HIT: ${prompt.substring(0, 30)}... (${provider})`);
    return cached.imageData;
  }

  set(prompt, provider, imageData) {
    const key = this.getCacheKey(prompt, provider);

    // Giới hạn cache size - xóa item ít dùng nhất
    if (this.cache.size >= IMAGE_CONFIG.MAX_CACHE_SIZE) {
      this.evictLeastUsed();
    }

    this.cache.set(key, {
      imageData,
      timestamp: Date.now(),
      prompt,
      provider
    });

    this.accessCount.set(key, 1);

    console.log(`💾 Cached: ${prompt.substring(0, 30)}... (${provider})`);
  }

  evictLeastUsed() {
    let minAccess = Infinity;
    let leastUsedKey = null;

    for (const [key, count] of this.accessCount.entries()) {
      if (count < minAccess) {
        minAccess = count;
        leastUsedKey = key;
      }
    }

    if (leastUsedKey) {
      this.cache.delete(leastUsedKey);
      this.accessCount.delete(leastUsedKey);
      console.log(`🗑️ Evicted cache: ${leastUsedKey.substring(0, 50)}...`);
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: IMAGE_CONFIG.MAX_CACHE_SIZE,
      totalAccesses: Array.from(this.accessCount.values()).reduce((a, b) => a + b, 0)
    };
  }

  clear() {
    this.cache.clear();
    this.accessCount.clear();
    console.log('🧹 Cache cleared');
  }
}

const imageCache = new ImageCache();

// ============ HELPER FUNCTIONS ============

function getAvailableProviders() {
  return PROVIDERS.filter(p => p.enabled && p.apiKey)
    .sort((a, b) => a.priority - b.priority);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ RETRY WITH BACKOFF ============

async function retryWithBackoff(fn, providerName, maxRetries = IMAGE_CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      
      // Kiểm tra lỗi có thể retry không
      const isRetryable = 
        error.response?.status === 503 ||  // Service unavailable
        error.response?.status === 429 ||  // Rate limit
        error.code === 'ECONNABORTED' ||   // Timeout
        error.message?.includes('timeout');

      if (!isRetryable || isLastAttempt) {
        throw error;
      }

      // Exponential backoff: 2s, 4s, 8s...
      const delay = IMAGE_CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`⚠️ ${providerName} failed (attempt ${attempt}/${maxRetries}). Retry in ${delay}ms...`);
      console.log(`   Error: ${error.message}`);
      
      await sleep(delay);
    }
  }
}

// ============ HUGGING FACE IMAGE GENERATION ============

async function generateWithHuggingFace(prompt, provider) {
  if (!provider.apiKey) {
    throw new Error(`${provider.name}: API key not configured`);
  }

  return await retryWithBackoff(async () => {
    console.log(`🎨 Generating with ${provider.name}...`);

    const response = await axios.post(
      provider.endpoint,
      { inputs: prompt },
      {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: IMAGE_CONFIG.REQUEST_TIMEOUT
      }
    );

    // Check if response is image
    const contentType = response.headers['content-type'];
    if (!contentType?.includes('image')) {
      // Nếu trả về JSON error
      const text = Buffer.from(response.data).toString('utf-8');
      throw new Error(`Not an image response: ${text.substring(0, 100)}`);
    }

    // Convert to base64
    const base64 = Buffer.from(response.data).toString('base64');
    const imageData = `data:image/png;base64,${base64}`;

    console.log(`✅ ${provider.name} success!`);

    return {
      imageData,
      provider: provider.name,
      timestamp: Date.now(),
      cached: false
    };

  }, provider.name);
}

// ============ SMART GENERATION WITH FAILOVER ============

async function generateImage(prompt, options = {}) {
  const {
    preferredProvider = null,
    skipCache = false
  } = options;

  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('Prompt is required and must be a non-empty string');
  }

  const cleanPrompt = prompt.trim();

  // Get available providers
  const providers = getAvailableProviders();

  if (providers.length === 0) {
    throw new Error('No image generation providers configured. Please set HUGGINGFACE_API_KEY.');
  }

  // Ưu tiên provider được chỉ định
  let sortedProviders = [...providers];
  if (preferredProvider) {
    const preferred = providers.find(p => p.name === preferredProvider);
    if (preferred) {
      sortedProviders = [preferred, ...providers.filter(p => p.name !== preferredProvider)];
    }
  }

  console.log(`🔍 Available providers: ${sortedProviders.map(p => p.name).join(', ')}`);

  // Try each provider with failover
  const errors = [];

  for (const provider of sortedProviders) {
    try {
      // Check cache first (unless skipCache)
      if (!skipCache) {
        const cached = imageCache.get(cleanPrompt, provider.name);
        if (cached) {
          return {
            imageData: cached,
            provider: provider.name,
            timestamp: Date.now(),
            cached: true
          };
        }
      }

      // Generate new image
      const result = await generateWithHuggingFace(cleanPrompt, provider);

      // Cache the result
      imageCache.set(cleanPrompt, provider.name, result.imageData);

      return result;

    } catch (error) {
      console.error(`❌ ${provider.name} failed:`, error.message);
      errors.push({
        provider: provider.name,
        error: error.message
      });

      // Continue to next provider
      continue;
    }
  }

  // All providers failed
  throw new Error(
    `All providers failed:\n${errors.map(e => `- ${e.provider}: ${e.error}`).join('\n')}`
  );
}

// ============ ENHANCED PROMPT (Optional) ============

/**
 * Tự động cải thiện prompt để ra ảnh đẹp hơn
 */
function enhancePrompt(userPrompt) {
  // Nếu prompt đã chi tiết (>50 từ), không cần enhance
  if (userPrompt.split(' ').length > 50) {
    return userPrompt;
  }

  // Thêm quality keywords
  const qualityKeywords = [
    'high quality',
    'detailed',
    '8k resolution',
    'professional photography'
  ];

  // Random chọn 1-2 keywords
  const selected = qualityKeywords
    .sort(() => Math.random() - 0.5)
    .slice(0, 2);

  return `${userPrompt}, ${selected.join(', ')}`;
}

// ============ BATCH GENERATION (Optional) ============

async function generateBatch(prompts, options = {}) {
  const results = [];
  const errors = [];

  for (const prompt of prompts) {
    try {
      const result = await generateImage(prompt, options);
      results.push({
        prompt,
        success: true,
        ...result
      });
    } catch (error) {
      errors.push({
        prompt,
        success: false,
        error: error.message
      });
    }
  }

  return {
    results,
    errors,
    stats: {
      total: prompts.length,
      success: results.length,
      failed: errors.length
    }
  };
}

// ============ EXPORTS ============

export {
  generateImage,
  generateBatch,
  enhancePrompt,
  imageCache,
  getAvailableProviders,
  IMAGE_CONFIG
};

// ============ API ROUTE HANDLER ============

export async function handleImageRequest(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false,
      error: 'Method not allowed' 
    });
  }

  try {
    const { 
      prompt, 
      userId,
      enhancePrompt: shouldEnhance = false,
      preferredProvider = null
    } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Prompt is required and must be a string'
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    console.log(`🎨 Image request from ${userId}: "${prompt.substring(0, 50)}..."`);

    // Enhance prompt nếu được yêu cầu
    const finalPrompt = shouldEnhance ? enhancePrompt(prompt) : prompt;

    if (shouldEnhance) {
      console.log(`✨ Enhanced prompt: "${finalPrompt}"`);
    }

    // Generate image
    const result = await generateImage(finalPrompt, { preferredProvider });

    return res.status(200).json({
      success: true,
      imageData: result.imageData,
      provider: result.provider,
      cached: result.cached,
      prompt: finalPrompt,
      originalPrompt: prompt,
      timestamp: result.timestamp,
      stats: {
        cacheSize: imageCache.getStats().size,
        cacheHitRate: imageCache.getStats().totalAccesses / (imageCache.getStats().size || 1)
      }
    });

  } catch (error) {
    console.error('❌ Image generation error:', error);

    return res.status(500).json({
      success: false,
      error: error.message,
      availableProviders: getAvailableProviders().map(p => p.name)
    });
  }
}
