const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Xử lý OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Chỉ cho phép POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Chỉ chấp nhận POST request' });
  }

  try {
    // Parse request body
    let body;
    
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch (e) {
        return res.status(400).json({ 
          error: 'Invalid JSON format'
        });
      }
    } else {
      body = req.body;
    }

    // Lấy dữ liệu từ request
    const { 
      prompt, 
      model = 'llama-3.3-70b-versatile', // Model mặc định
      temperature = 0.7, 
      top_p = 0.9,
      max_tokens = 4096
    } = body || {};

    // Kiểm tra prompt
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
      return res.status(400).json({ 
        error: 'Prompt không hợp lệ'
      });
    }

    // Lấy API key
    const GROQ_API_KEY = process.env.GROQ_API_KEY_1;
    
    if (!GROQ_API_KEY) {
      return res.status(500).json({ 
        error: 'API key chưa được cấu hình'
      });
    }

    // Gọi Groq API
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: parseFloat(temperature),
        top_p: parseFloat(top_p),
        max_tokens: parseInt(max_tokens),
        stream: false
      })
    });

    const groqData = await groqResponse.json();

    // Kiểm tra lỗi từ Groq
    if (groqData.error) {
      console.error('Groq API Error:', groqData.error);
      return res.status(500).json({ 
        error: 'Lỗi từ Groq API',
        details: groqData.error.message || 'Unknown error'
      });
    }

    // Groq trả về format giống OpenAI, trả luôn
    return res.status(200).json(groqData);

  } catch (error) {
    console.error('Server Error:', error);
    return res.status(500).json({ 
      error: 'Lỗi server',
      details: error.message
    });
  }
};
