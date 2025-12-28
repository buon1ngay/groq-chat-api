import { getShortTermMemory } from './_memory'; // chỉnh đúng đường dẫn

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
    const history = await getShortTermMemory(
      userId,
      finalConversationId
    );

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

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
