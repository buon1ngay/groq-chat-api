import {
  getLongTermMemory,
  getSummary
} from './_memory';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false });
  }

  try {
    const { userId, conversationId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId required'
      });
    }

    const finalConversationId = conversationId || 'default';

    const [profile, summary] = await Promise.all([
      getLongTermMemory(userId),
      getSummary(userId, finalConversationId)
    ]);

    return res.status(200).json({
      success: true,
      profile,
      summary,
      profileFields: Object.keys(profile).length,
      hasSummary: !!summary
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
