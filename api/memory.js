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

    const profileKey = `user:profile:${userId}`;
    const summaryKey = `summary:${userId}:${finalConversationId}`;

    const [profile, summary] = await Promise.all([
      redis.hgetall(profileKey),
      redis.get(summaryKey)
    ]);

    return res.status(200).json({
      success: true,
      profile: profile || {},
      summary: summary || '',
      profileCount: profile ? Object.keys(profile).length : 0
    });

  } catch (error) {
    console.error('Memory API error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
