// src/inferencer/llm.js (optional enrichment via LLM)
const fetch = require("node-fetch");

async function enrichWithLLM({ url, html, text, seedCapsule, model }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const prompt = `
  Convert this webpage into a JSON-LD AgentNet capsule.
  Use conservative inference; only fill missing fields.
  URL: ${url}
  Seed capsule:
  ${JSON.stringify(seedCapsule, null, 2)}
  `;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: "system", content: "You output pure JSON-LD capsules." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content;
  return JSON.parse(raw);
}

module.exports = { enrichWithLLM };
