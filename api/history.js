// api/history.js

// ⚠️ IMPORT TRỰC TIẾP TỪ chat.js
// vì toàn bộ memory logic đang nằm ở đó
import {
  getShortTermMemory
} from './chat';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const { userId, conversationId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing userId'
      });
    }

    const finalConversationId = conversationId || 'default';

    const history = await getShortTermMemory(
      userId,
      finalConversationId
    );

    const safeHistory = Array.isArray(history) ? history : [];

    return res.status(200).json({
      success: true,
      userId,
      conversationId: finalConversationId,
      total: safeHistory.length,
      history: safeHistory.map((msg, index) => ({
        id: `${finalConversationId}_${index}`,
        role: msg.role,
        content: msg.content
      }))
    });

  } catch (error) {
    console.error('❌ HISTORY ERROR:', error);

    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}
