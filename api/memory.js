// GET /api/memory - Lấy bộ nhớ profile
export async function getMemoryAPI(req, res) {
  try {
    const { userId, conversationId } = req.query;
    
    const finalConversationId = conversationId || 'default';
    
    const [profile, summary] = await Promise.all([
      getLongTermMemory(userId),
      getSummary(userId, finalConversationId)
    ]);
    
    return res.status(200).json({
      success: true,
      profile: profile,
      summary: summary,
      profileCount: Object.keys(profile).length
    });
  } catch (error) {
    console.error('Get memory error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
