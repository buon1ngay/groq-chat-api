// pages/api/memory.js

import { getLongTermMemory, getSummary } from '../../lib/memory'; 
// ⬆️ sửa path nếu file lib của cậu chủ nằm chỗ khác

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({
        success: false,
        error: 'Method not allowed'
      });
    }

    const { userId, conversationId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId'
      });
    }

    const finalConversationId = conversationId || 'default';

    const [profile, summary] = await Promise.all([
      getLongTermMemory(userId),
      getSummary(userId, finalConversationId)
    ]);

    return res.status(200).json({
      success: true,
      profile: profile || {},
      summary: summary || '',
      profileCount: profile ? Object.keys(profile).length : 0
    });

  } catch (error) {
    console.error('Get memory error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
