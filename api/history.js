// GET /api/history - Lấy lịch sử chat
export async function getHistoryAPI(req, res) {
  try {
    const { userId, conversationId } = req.query;
    
    const finalConversationId = conversationId || 'default';
    const history = await getShortTermMemory(userId, finalConversationId);
    
    return res.status(200).json({
      success: true,
      history: history.map((msg, index) => ({
        id: index,
        role: msg.role,
        content: msg.content,
        isUser: msg.role === 'user'
      })),
      total: history.length
    });
  } catch (error) {
    console.error('Get history error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
