import Groq from "groq-sdk";

const GROQ_KEYS = (process.env.GROQ_API_KEYS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const SERPER_KEY = process.env.SERPER_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;

const TIMEOUT = 8000;

function timeoutPromise(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms)
  );
}

async function checkGroqKey(apiKey, index) {
  const client = new Groq({ apiKey });

  try {
    const r = await Promise.race([
      client.models.list(),
      timeoutPromise(TIMEOUT)
    ]);

    return {
      keyIndex: index,
      status: "OK",
      models: r?.data?.length || 0
    };
  } catch (e) {
    let err = e.message || "unknown";

    if (err.includes("quota")) err = "quota_exceeded";
    if (err.includes("401")) err = "unauthorized";
    if (err.includes("timeout")) err = "timeout";

    return {
      keyIndex: index,
      status: "ERROR",
      error: err
    };
  }
}

async function checkSerper() {
  if (!SERPER_KEY) return "NO_KEY";

  try {
    const r = await Promise.race([
      fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: "ping" })
      }),
      timeoutPromise(TIMEOUT)
    ]);

    return r.ok ? "OK" : `ERROR_${r.status}`;
  } catch (e) {
    return `ERROR_${e.message.substring(0, 50)}`;
  }
}

async function checkTavily() {
  if (!TAVILY_KEY) return "NO_KEY";

  try {
    const r = await Promise.race([
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: TAVILY_KEY,
          query: "ping"
        })
      }),
      timeoutPromise(TIMEOUT)
    ]);

    return r.ok ? "OK" : `ERROR_${r.status}`;
  } catch (e) {
    return `ERROR_${e.message.substring(0, 50)}`;
  }
}

export async function GET() {
  const groqStatus = [];

  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[i];
    groqStatus.push(await checkGroqKey(key, i));
  }

  const serperStatus = await checkSerper();
  const tavilyStatus = await checkTavily();

  return new Response(
    JSON.stringify(
      {
        timestamp: Date.now(),
        groq: groqStatus,
        serper: serperStatus,
        tavily: tavilyStatus
      },
      null,
      2
    ),
    {
      headers: { "Content-Type": "application/json" }
    }
  );
}
