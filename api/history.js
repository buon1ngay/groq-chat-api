// pages/api/history.js

import { getShortTermMemory } from '../../lib/memory';
// ⬆️ sửa path nếu lib nằm chỗ khác

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

    const history = await getShortTermMemory(userId, finalConversationId);
    const safeHistory = Array.isArray(history) ? history : [];

    return res.status(200).json({
      success: true,
      history: safeHistory.map((msg, index) => ({
        id: `${finalConversationId}_${index}`,
        role: msg.role || 'assistant',
        content: msg.content || ''
      })),
      total: safeHistory.length
    });

  } catch (error) {
    console.error('Get history error:', {
      userId: req.query?.userId,
      conversationId: req.query?.conversationId,
      error
    });

    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
