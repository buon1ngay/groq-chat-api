import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { userId, conversationId } = req.query;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    const finalConversationId = conversationId || 'default';
    const key = `chat:${userId}:${finalConversationId}`;

    let history = await redis.get(key);

    if (!history) {
      return res.status(200).json({
        success: true,
        history: [],
        total: 0
      });
    }

    if (typeof history === 'string') {
      history = JSON.parse(history);
    }

    if (!Array.isArray(history)) history = [];

    return res.status(200).json({
      success: true,
      history: history.map((msg, index) => ({
        id: `${finalConversationId}_${index}`,
        role: msg.role,
        content: msg.content
      })),
      total: history.length
    });

  } catch (error) {
    console.error('History API error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
