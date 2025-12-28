import {
  setData,
  setHashData
} from './_redis';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ success: false });
  }

  try {
    const { userId, conversationId, type } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId required'
      });
    }

    const finalConversationId = conversationId || 'default';

    if (type === 'history' || type === 'all') {
      await setData(
        `chat:${userId}:${finalConversationId}`,
        JSON.stringify([]),
        1
      );
    }

    if (type === 'profile' || type === 'all') {
      await setHashData(
        `user:profile:${userId}`,
        {},
        1
      );
    }

    if (type === 'summary' || type === 'all') {
      await setData(
        `summary:${userId}:${finalConversationId}`,
        '',
        1
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Đã xóa dữ liệu thành công',
      clearedType: type
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
