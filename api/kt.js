import Groq from "groq-sdk";

export async function GET() {
  const result = {
    timestamp: Date.now(),
    groq: [],
    serper: null,
    tavily: null
  };

  const API_KEYS = (process.env.GROQ_API_KEYS || "").split(",").map(k => k.trim());
  const serperKey = process.env.SERPER_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  // ==== CHECK GROQ KEYS ====
  for (let i = 0; i < API_KEYS.length; i++) {
    const key = API_KEYS[i];
    try {
      const client = new Groq({ apiKey: key });
      await client.models.list(); // cực nhẹ
      result.groq.push({ keyIndex: i, status: "OK" });
    } catch (e) {
      result.groq.push({
        keyIndex: i,
        status: "ERROR",
        error: e.message.substring(0, 120)
      });
    }
  }

  // ==== CHECK SERPER ====
  if (serperKey) {
    try {
      const resp = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": serperKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: "test" })
      });
      result.serper = resp.ok ? "OK" : `ERROR: ${resp.status}`;
    } catch (e) {
      result.serper = `ERROR: ${e.message}`;
    }
  }

  // ==== CHECK TAVILY ====
  if (tavilyKey) {
    try {
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: "test"
        })
      });
      result.tavily = resp.ok ? "OK" : `ERROR: ${resp.status}`;
    } catch (e) {
      result.tavily = `ERROR: ${e.message}`;
    }
  }

  return new Response(JSON.stringify(result, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}
