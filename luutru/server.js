const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
app.use(express.json());

// ===== CẤU HÌNH =====
const BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE'; // Lấy từ @BotFather
const CHAT_ID = 'YOUR_CHAT_ID_HERE'; // ID chat lưu file
const PORT = process.env.PORT || 3000;

const upload = multer({ dest: 'uploads/' });

// ===== 1. UPLOAD FILE =====
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const { userId, fileName } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        // Đổi tên file theo format: userId_fileName
        const uniqueFileName = `${userId}_${fileName}`;

        // Upload lên Telegram
        const formData = new FormData();
        formData.append('chat_id', CHAT_ID);
        formData.append('document', fs.createReadStream(file.path), {
            filename: uniqueFileName
        });
        formData.append('caption', `📁 User: ${userId}\n📄 File: ${fileName}\n🕐 ${new Date().toLocaleString('vi-VN')}`);

        const response = await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`,
            formData,
            { headers: formData.getHeaders() }
        );

        // Xóa file tạm
        fs.unlinkSync(file.path);

        if (response.data.ok) {
            res.json({
                success: true,
                fileId: response.data.result.document.file_id,
                fileName: fileName,
                size: response.data.result.document.file_size,
                uploadTime: new Date().toISOString()
            });
        } else {
            res.status(500).json({ success: false, error: response.data.description });
        }

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== 2. DOWNLOAD FILE =====
app.post('/api/download', async (req, res) => {
    try {
        const { fileId } = req.body;

        if (!fileId) {
            return res.status(400).json({ success: false, error: 'fileId required' });
        }

        // Lấy đường dẫn file từ Telegram
        const filePathResponse = await axios.get(
            `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
        );

        if (!filePathResponse.data.ok) {
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        const filePath = filePathResponse.data.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        // Download file từ Telegram
        const fileResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const content = Buffer.from(fileResponse.data).toString('utf-8');

        res.json({
            success: true,
            content: content
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== 3. LIST FILES CỦA USER =====
app.post('/api/list', async (req, res) => {
    try {
        const { userId } = req.body;

        // Lấy lịch sử tin nhắn từ chat
        const response = await axios.get(
            `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`
        );

        if (!response.data.ok) {
            return res.status(500).json({ success: false, error: 'Cannot fetch updates' });
        }

        // Lọc file của user
        const userFiles = [];
        const updates = response.data.result;

        for (const update of updates) {
            if (update.message && update.message.document) {
                const doc = update.message.document;
                const caption = update.message.caption || '';
                
                // Check nếu file thuộc user này
                if (caption.includes(`User: ${userId}`)) {
                    userFiles.push({
                        fileId: doc.file_id,
                        fileName: doc.file_name,
                        size: doc.file_size,
                        uploadTime: new Date(update.message.date * 1000).toISOString()
                    });
                }
            }
        }

        res.json({
            success: true,
            files: userFiles
        });

    } catch (error) {
        console.error('List error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== 4. DELETE FILE =====
app.post('/api/delete', async (req, res) => {
    try {
        const { messageId } = req.body;

        const response = await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`,
            {
                chat_id: CHAT_ID,
                message_id: messageId
            }
        );

        res.json({
            success: response.data.ok
        });

    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== 5. HEALTH CHECK =====
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Telegram File Storage API',
        timestamp: new Date().toISOString()
    });
});

// ===== START SERVER =====
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Telegram Bot Token: ${BOT_TOKEN.substring(0, 10)}...`);
    console.log(`💬 Chat ID: ${CHAT_ID}`);
});

// ===== PACKAGE.JSON =====
/*
{
  "name": "telegram-file-storage",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "axios": "^1.6.0",
    "form-data": "^4.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
