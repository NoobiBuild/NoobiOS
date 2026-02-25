const AI_SETTINGS_KEY = "noobi_ai_settings_v2";

export function defaultAiSettings() {
  return {
    enabled: false,
    autoRefine: false,
    provider: "openai",
    model: "",
    endpoint: "",
    headersJson: "",
    rememberKey: false,
    apiKey: ""
  };
}

export function loadAiSettings() {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (!raw) return defaultAiSettings();
    const obj = JSON.parse(raw);
    return { ...defaultAiSettings(), ...obj };
  } catch {
    return defaultAiSettings();
  }
}

export function saveAiSettings(s) {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({ ...defaultAiSettings(), ...s }));
}

export function clearAiSettings() {
  localStorage.removeItem(AI_SETTINGS_KEY);
}

export function getAiReadyState() {
  const s = loadAiSettings();
  if (!s.enabled) return { enabled: false, ready: false, reason: "disabled" };
  if (s.provider === "openai_compat") return { enabled: true, ready: true, reason: "local_compat_ok" };
  if (!s.apiKey && !s.rememberKey) return { enabled: true, ready: false, reason: "missing_key" };
  if (s.rememberKey && !s.apiKey) return { enabled: true, ready: false, reason: "missing_key" };
  return { enabled: true, ready: true, reason: "ok" };
}

function replaceKeyPlaceholders(headersJson, key) {
  if (!headersJson) return {};
  try {
    return JSON.parse(headersJson.replaceAll("{{KEY}}", key));
  } catch {
    return {};
  }
}

export async function aiCall({ provider, model, endpoint, apiKey, headersJson }, system, user, contextObj) {
  const key = apiKey || "";
  const extraHeaders = replaceKeyPlaceholders(headersJson, key);
  const ctxStr = JSON.stringify(contextObj);

  if (provider === "openai") {
    const url = endpoint || "https://api.openai.com/v1/chat/completions";
    const body = {
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `CONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }
      ],
      temperature: 0.2
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `OpenAI error (${res.status})`);
    return json?.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "anthropic") {
    const url = endpoint || "https://api.anthropic.com/v1/messages";
    const body = {
      model: model || "claude-3-5-sonnet-20240620",
      max_tokens: 1200,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: `CONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }]
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Anthropic error (${res.status})`);
    return (json?.content || []).map(x => x?.text || "").join("\n");
  }

  if (provider === "gemini") {
    const m = model || "gemini-1.5-flash";
    const url = endpoint
      || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [
        { role: "user", parts: [{ text: `${system}\n\nCONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }] }
      ],
      generationConfig: { temperature: 0.2 }
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Gemini error (${res.status})`);
    return json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
  }

  if (provider === "openai_compat") {
    const url = endpoint || "http://localhost:11434/v1/chat/completions";
    const body = {
      model: model || "llama3.1",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `CONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }
      ],
      temperature: 0.2
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "Authorization": `Bearer ${key}` } : {}), ...extraHeaders },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `OpenAI-compatible error (${res.status})`);
    return json?.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "custom") {
    if (!endpoint) throw new Error("Custom provider needs an endpoint URL");
    const body = { system, user, context: contextObj, model };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`Custom error (${res.status})`);
    try {
      const j = JSON.parse(txt);
      return j.text || j.output || txt;
    } catch {
      return txt;
    }
  }

  throw new Error("Unsupported provider");
}

export function tryParseJsonFromText(txt) {
  const direct = txt.trim();
  if (direct.startsWith("{") && direct.endsWith("}")) {
    try { return JSON.parse(direct); } catch {}
  }
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}