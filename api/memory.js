import { Redis } from '@upstash/redis';

let redis = null;
const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;

if (REDIS_ENABLED) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  } catch (error) {
    console.error('❌ Redis initialization error:', error);
  }
}

const memoryStore = new Map();

async function getData(key) {
  if (redis) {
    return await redis.get(key);
  } else {
    const item = memoryStore.get(key);
    if (!item) return null;
    if (item.expires && Date.now() > item.expires) {
      memoryStore.delete(key);
      return null;
    }
    return item.value;
  }
}

async function getHashData(key) {
  if (redis) {
    return await redis.hgetall(key);
  } else {
    const item = memoryStore.get(key);
    if (!item) return {};
    if (item.expires && Date.now() > item.expires) {
      memoryStore.delete(key);
      return {};
    }
    return item.value || {};
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ 
      success: false,
      error: 'Method not allowed' 
    });
  }

  try {
    const { userId, conversationId } = req.query;

    if (!userId || !userId.startsWith('user_')) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid userId format' 
      });
    }

    const finalConversationId = conversationId || 'default';

    // Load profile
    const profileKey = `user:profile:${userId}`;
    const profile = await getHashData(profileKey);

    // Load summary
    const summaryKey = `summary:${userId}:${finalConversationId}`;
    const summary = await getData(summaryKey);

    console.log(`📊 Memory loaded for ${userId}`);

    return res.status(200).json({
      success: true,
      userId: userId,
      conversationId: finalConversationId,
      profile: profile || {},
      summary: summary || '',
      storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory'
    });

  } catch (error) {
    console.error('❌ Memory error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
