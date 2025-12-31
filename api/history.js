import { getShortTermMemory } from '../chat.js';

export default async function handler(req, res) {
  // Chỉ chấp nhận GET
  if (req.method !== 'GET') {
    return res.status(405).json({ 
      success: false, 
      error: 'Method not allowed' 
    });
  }

  try {
    const { userId, conversationId } = req.query;
    
    // Validate
    if (!userId || !userId.startsWith('user_')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid userId format' 
      });
    }
    
    const finalConversationId = conversationId || 'default';
    
    // Lấy lịch sử từ Redis/Memory
    const history = await getShortTermMemory(userId, finalConversationId);
    
    // Format response
    const formattedHistory = history.map((msg, index) => ({
      id: index,
      role: msg.role,
      content: msg.content,
      isUser: msg.role === 'user'
    }));
    
    return res.status(200).json({
      success: true,
      history: formattedHistory,
      total: formattedHistory.length
    });
    
  } catch (error) {
    console.error('❌ Get history error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error' 
    });
  }
}
