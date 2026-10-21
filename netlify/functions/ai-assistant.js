import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// ── Settings ────────────────────────────────────────────────────────────────
const ALLOWED_ROLES = new Set(["patient", "doctor", "admin"]);
const MAX_MESSAGE_CHARS = 2000;
const MAX_BODY_BYTES = 8 * 1024; // the 2000-char limit above fits comfortably
const GROQ_TIMEOUT_MS = 20000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Used only if the GROQ_MODEL environment variable is not set.
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const SYSTEM_PROMPT =
  "You are SmartHeal's hospital information assistant. " +
  "Answer general questions about navigating hospital portals " +
  "and hospital services. Do not diagnose conditions, prescribe " +
  "medication, or claim to access medical records. Do not ask " +
  "for passwords, OTPs, or unnecessary sensitive health details. " +
  "For urgent or emergency symptoms, advise contacting local " +
  "emergency services or a qualified healthcare professional. " +
  "Be clear, polite, and concise.";

// ── Helpers ─────────────────────────────────────────────────────────────────

// Thrown for server-side setup problems (missing/invalid environment variables).
// `problems` is a list of fixed-text messages that never contain a secret value.
class ConfigError extends Error {
  constructor(problems) {
    super("Invalid server configuration");
    this.problems = problems;
  }
}

function reply(status, body) {
  return Response.json(body, { status, headers: HEADERS });
}

// SAFE LOGGING: only pass fixed stage names and non-sensitive codes here.
// Never pass tokens, API keys, the user's message, Firestore data, or error
// messages from libraries (they can echo input back).
function log(stage, details = {}, level = "error") {
  console[level](`[ai-assistant] ${stage} ${JSON.stringify(details)}`);
}

// Checks ALL required environment variables at once and reports every problem
// together (fixed text only, never the values themselves).
function readConfig() {
  const problems = [];

  // Firebase service account (only needed if Firebase is not initialised yet).
  let serviceAccount;
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw || !raw.trim()) {
      problems.push("FIREBASE_SERVICE_ACCOUNT is not set");
    } else {
      try {
        serviceAccount = JSON.parse(raw);
      } catch {
        // Deliberately discard the original error: JSON.parse messages can
        // include a snippet of the text it failed on.
        problems.push("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
      }
      if (
        serviceAccount &&
        (typeof serviceAccount.project_id !== "string" ||
          typeof serviceAccount.client_email !== "string" ||
          typeof serviceAccount.private_key !== "string")
      ) {
        problems.push(
          "FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key"
        );
        serviceAccount = undefined;
      }
    }
  }

  // Groq API key.
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    problems.push("GROQ_API_KEY is not set or is empty in the function environment");
  } else if (!/^[A-Za-z0-9_.-]+$/.test(apiKey)) {
    problems.push("GROQ_API_KEY contains spaces, quotes or line breaks");
  }

  // Groq model name (optional variable, has a default).
  const model = (process.env.GROQ_MODEL || DEFAULT_MODEL).trim();
  if (!/^[a-z0-9][a-z0-9._\/-]*$/i.test(model)) {
    problems.push("GROQ_MODEL has an invalid format");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { serviceAccount, apiKey, model };
}

// Initialised lazily inside the request so a missing/invalid variable produces
// a clear, safe error instead of crashing the function at load time.
function initFirebase(serviceAccount) {
  if (getApps().length > 0) return;
  try {
    initializeApp({ credential: cert(serviceAccount) });
  } catch {
    throw new ConfigError(["FIREBASE_SERVICE_ACCOUNT credentials were rejected by Firebase Admin"]);
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method !== "POST") {
    return reply(405, { error: "Method not allowed" });
  }

  try {
    const { serviceAccount, apiKey, model } = readConfig();
    initFirebase(serviceAccount);

    // 1. Authenticate: the browser must send a valid Firebase ID token.
    const match = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/);
    if (!match) {
      return reply(401, { error: "Please sign in first." });
    }

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(match[1]);
    } catch (err) {
      log("token_rejected", { code: err?.code });
      return reply(401, { error: "Your session has expired. Please sign in again." });
    }

    // 2. Authorize: the account must have an allowed role in users/{uid}.
    const userSnap = await getFirestore().collection("users").doc(decoded.uid).get();
    const role = userSnap.exists ? userSnap.data()?.role : undefined;
    if (!ALLOWED_ROLES.has(role)) {
      return reply(403, { error: "Your account doesn't have portal access." });
    }

    // 3. Read and validate the request body.
    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return reply(413, { error: "Your message is too large." });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return reply(400, { error: "Request body must be valid JSON." });
    }

    const message = body?.message;
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > MAX_MESSAGE_CHARS
    ) {
      return reply(400, {
        error: `Enter a message of up to ${MAX_MESSAGE_CHARS} characters.`,
      });
    }

    // 4. Call Groq (OpenAI-compatible Chat Completions) with a timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: message.trim() },
          ],
          max_completion_tokens: 250,
        }),
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        log("groq_timeout", { model });
        return reply(504, {
          error: "The assistant took too long to respond. Please try again.",
        });
      }
      log("groq_network_error", { model, name: err?.name });
      return reply(502, { error: "The AI assistant is temporarily unavailable." });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let upstreamType;
      let upstreamCode;
      let upstreamMessage;

      try {
        const errorBody = await response.json();
        upstreamType = errorBody?.error?.type;
        upstreamCode = errorBody?.error?.code;

        const msg = errorBody?.error?.message;
        if (typeof msg === "string") {
          upstreamMessage = msg.slice(0, 300);
        }
      } catch {
        // ignore: the error body is only used for short diagnostic fields
      }

      // Separate Groq-side problems from our own configuration problems.
      const status = response.status;
      const kind =
        status === 401 || status === 403 ? "auth_check_GROQ_API_KEY"
        : status === 404 ? "model_not_found_check_GROQ_MODEL"
        : status === 400 || status === 422 ? "bad_request_or_model"
        : status === 429 ? "rate_limit"
        : status >= 500 ? "groq_server_error"
        : "other";

      log("groq_http_error", {
        kind,
        model,
        httpStatus: status,
        upstreamType,
        upstreamCode,
        upstreamMessage,
      });
      if (response.status === 429) {
        return reply(503, {
          error: "The assistant is busy right now. Please try again in a minute.",
        });
      }
      return reply(502, { error: "The AI assistant is temporarily unavailable." });
    }

    // 5. Extract the answer from choices[0].message.content.
    const result = await response.json();
    const choice = result?.choices?.[0];
    const content = choice?.message?.content;
    const answer = typeof content === "string" ? content.trim() : "";

    if (!answer) {
      log("groq_empty_answer", {
        model,
        finishReason: choice?.finish_reason,
      });
      return reply(502, { error: "No response was generated. Please try again." });
    }

    if (choice?.finish_reason && choice.finish_reason !== "stop") {
      log("groq_unusual_finish", { model, finishReason: choice.finish_reason }, "warn");
    }

    return reply(200, { answer });
  } catch (err) {
    if (err instanceof ConfigError) {
      log("config_error", { problems: err.problems });
      return reply(500, {
        error: "The assistant is not configured correctly. Please contact the administrator.",
      });
    }
    log("unexpected_error", { name: err?.name, code: err?.code });
    return reply(500, { error: "The assistant couldn't process your request." });
  }
};