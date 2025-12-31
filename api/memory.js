import { getLongTermMemory, getSummary } from '../chat.js';

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
    
    // Lấy profile và summary
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
    console.error('❌ Get memory error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error' 
    });
  }
}
