// api/generate-image.js
// API Endpoint cho Image Generation
// Deploy này lên Vercel/Netlify cùng với chat.js

import { handleImageRequest } from '../utils/image-api.js';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Delegate to image-api handler
  return await handleImageRequest(req, res);
}
