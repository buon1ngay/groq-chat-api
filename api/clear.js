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

async function deleteData(key) {
  if (redis) {
    return await redis.del(key);
  } else {
    memoryStore.delete(key);
    return true;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ 
      success: false,
      error: 'Method not allowed. Use DELETE.' 
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

    // Delete chat history
    const chatKey = `chat:${userId}:${finalConversationId}`;
    await deleteData(chatKey);

    // Delete summary
    const summaryKey = `summary:${userId}:${finalConversationId}`;
    await deleteData(summaryKey);

    // Delete extract tracker
    const extractKey = `last_extract:${userId}:${finalConversationId}`;
    await deleteData(extractKey);

    console.log(`🗑️ Cleared history for ${userId}:${finalConversationId}`);

    return res.status(200).json({
      success: true,
      message: 'History cleared successfully',
      userId: userId,
      conversationId: finalConversationId,
      storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory'
    });

  } catch (error) {
    console.error('❌ Clear error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
