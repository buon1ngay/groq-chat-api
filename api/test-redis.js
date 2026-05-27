import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    // Test SET
    await redis.set('test-key', 'hello');
    
    // Test GET
    const value = await redis.get('test-key');
    
    // Test GET kami:songs
    const songs = await redis.get('kami:songs');
    
    res.status(200).json({
      env_url: process.env.UPSTASH_REDIS_URL ? 'SET' : 'MISSING',
      env_token: process.env.UPSTASH_REDIS_TOKEN ? 'SET' : 'MISSING',
      test_value: value,
      songs_exists: songs !== null,
      songs_type: songs ? typeof songs : 'null',
      songs_preview: songs ? JSON.stringify(songs).substring(0, 200) : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
