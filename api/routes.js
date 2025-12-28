// ========== API ENDPOINTS MỚI ==========

// 1. GET /api/history - Lấy lịch sử chat
export async function getHistoryHandler(req, res) {
  try {
    const { userId, conversationId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }
    
    const finalConversationId = conversationId || 'default';
    const history = await getShortTermMemory(userId, finalConversationId);
    
    // Format lại để dễ hiển thị
    const formattedHistory = history.map((msg, index) => ({
      id: index,
      role: msg.role,
      content: msg.content,
      isUser: msg.role === 'user'
    }));
    
    return res.status(200).json({
      success: true,
      history: formattedHistory,
      totalMessages: formattedHistory.length
    });
  } catch (error) {
    console.error('Get history error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// 2. GET /api/memory - Lấy bộ nhớ/profile
export async function getMemoryHandler(req, res) {
  try {
    const { userId, conversationId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }
    
    const finalConversationId = conversationId || 'default';
    
    const [profile, summary] = await Promise.all([
      getLongTermMemory(userId),
      getSummary(userId, finalConversationId)
    ]);
    
    return res.status(200).json({
      success: true,
      profile: profile,
      summary: summary,
      profileFields: Object.keys(profile).length,
      hasSummary: !!summary
    });
  } catch (error) {
    console.error('Get memory error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// 3. DELETE /api/clear - Xóa dữ liệu
export async function clearDataHandler(req, res) {
  try {
    const { userId, conversationId, type } = req.body;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }
    
    const finalConversationId = conversationId || 'default';
    
    if (type === 'history' || type === 'all') {
      await setData(`chat:${userId}:${finalConversationId}`, JSON.stringify([]), 1);
    }
    
    if (type === 'profile' || type === 'all') {
      await setHashData(`user:profile:${userId}`, {}, 1);
    }
    
    if (type === 'summary' || type === 'all') {
      await setData(`summary:${userId}:${finalConversationId}`, '', 1);
    }
    
    return res.status(200).json({
      success: true,
      message: 'Đã xóa dữ liệu thành công',
      clearedType: type
    });
  } catch (error) {
    console.error('Clear data error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
