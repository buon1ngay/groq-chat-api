export async function getHistoryAPI(req, res) {
  try {
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
        role: msg.role,
        content: msg.content
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
      error: 'Internal server error'
    });
  }
}
