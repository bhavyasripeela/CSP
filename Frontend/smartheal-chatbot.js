/* ════════════════════════════════════════════════════════════════════════════
   SmartHeal AI chat widget
   Shared by the patient, doctor and admin dashboards.

   Usage (one line per dashboard, just before </body>):
     <script type="module" src="smartheal-chatbot.js" data-portal="patient"
             data-mobile-bottom="84px"></script>

   • Talks only to POST /.netlify/functions/ai-assistant with the signed-in
     user's Firebase ID token. No API keys live in this file.
   • All text from the user or the model is written with textContent / text
     nodes. innerHTML is used only for the constant, trusted shell markup.
   • The UI lives in a Shadow DOM so dashboard CSS can't leak in or out.
   ════════════════════════════════════════════════════════════════════════════ */
import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

const ENDPOINT = "/.netlify/functions/ai-assistant";
const LOGIN_URL = "loginn_fixed.html";
const MAX_CHARS = 2000; // must match the backend limit
const REQUEST_TIMEOUT_MS = 30000; // backend gives Gemini 20 s; allow overhead

const scriptEl = document.querySelector('script[type="module"][src*="smartheal-chatbot"]');
const PORTAL = (scriptEl && scriptEl.dataset.portal) || "portal";
const MOBILE_BOTTOM = (scriptEl && scriptEl.dataset.mobileBottom) || "20px";
const PORTAL_LABEL = { patient: "Patient portal", doctor: "Doctor portal", admin: "Admin portal" }[PORTAL] || "SmartHeal portal";

const SUGGESTIONS = [
  "What should I bring to a hospital visit?",
  "How do OPD queue tokens usually work?",
  "What does a triage nurse do?",
];

// ── Auth ────────────────────────────────────────────────────────────────────
// Wait for Firebase Auth to restore the persisted session before deciding
// whether anyone is signed in (auth.currentUser is null until that finishes).
function waitForAuthState() {
  if (typeof auth.authStateReady === "function") return auth.authStateReady();
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, () => { off(); resolve(); });
  });
}
const authReady = waitForAuthState().catch(() => {});

class ChatError extends Error {
  constructor(message, { retryable = false, needsLogin = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.needsLogin = needsLogin;
  }
}

async function getIdToken(forceRefresh = false) {
  await authReady;
  const user = auth.currentUser;
  if (!user) {
    throw new ChatError("You're not signed in. Please sign in again to use SmartHeal AI.", { needsLogin: true });
  }
  try {
    return await user.getIdToken(forceRefresh); // refreshes automatically if expired
  } catch {
    throw new ChatError("Your session has expired. Please sign in again.", { needsLogin: true });
  }
}

async function postMessage(token, message, signal) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, data };
}

// Returns the answer string or throws a ChatError with a user-safe message.
async function askAssistant(message, outerSignal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  outerSignal.addEventListener("abort", onOuterAbort);

  try {
    let token = await getIdToken(false);
    let r = await postMessage(token, message, ctrl.signal);

    if (r.status === 401) {
      // Token may have just expired or been revoked: refresh once and retry.
      token = await getIdToken(true);
      r = await postMessage(token, message, ctrl.signal);
      if (r.status === 401) {
        throw new ChatError("Your session has expired. Please sign in again.", { needsLogin: true });
      }
    }

    const serverMsg = r.data && typeof r.data.error === "string" ? r.data.error : "";

    if (r.ok) {
      const answer = r.data && typeof r.data.answer === "string" ? r.data.answer.trim() : "";
      if (!answer) throw new ChatError("The assistant sent an empty reply. Please try again.", { retryable: true });
      return answer;
    }
    if (r.status === 400 || r.status === 413) throw new ChatError(serverMsg || "That message couldn't be sent. Please shorten it and try again.");
    if (r.status === 403) throw new ChatError(serverMsg || "Your account doesn't have portal access.");
    if (r.status === 404) throw new ChatError("The assistant service wasn't found on this server. (Running locally? Start the site with “netlify dev”.)");
    throw new ChatError(serverMsg || "The assistant is temporarily unavailable. Please try again.", { retryable: true });
  } catch (err) {
    if (err instanceof ChatError) throw err;
    if (outerSignal.aborted) throw err; // user cleared the chat: caller ignores this
    if (timedOut) throw new ChatError("The assistant took too long to respond. Please try again.", { retryable: true });
    throw new ChatError("Couldn't reach the assistant. Check your connection and try again.", { retryable: true });
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

// ── Safe rich-text rendering (no innerHTML) ─────────────────────────────────
// Handles the small Markdown subset Gemini commonly returns: paragraphs,
// bullet / numbered lists, **bold**, `code`, and # headings. Everything is
// created with createElement + textContent, so markup in a reply is inert.
function makeEl(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function appendInline(parent, text) {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      parent.appendChild(makeEl("strong", null, part.slice(2, -2)));
    } else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      parent.appendChild(makeEl("code", null, part.slice(1, -1)));
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function renderRich(container, text) {
  container.textContent = "";
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let para = [];
  let list = null;
  let listTag = "";

  const flushPara = () => {
    if (!para.length) return;
    const p = makeEl("p");
    appendInline(p, para.join("\n"));
    container.appendChild(p);
    para = [];
  };
  const flushList = () => { list = null; listTag = ""; };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);

    if (!line.trim()) { flushPara(); flushList(); continue; }

    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (!list || listTag !== tag) {
        list = makeEl(tag);
        listTag = tag;
        container.appendChild(list);
      }
      const li = makeEl("li");
      appendInline(li, (bullet || numbered)[1]);
      list.appendChild(li);
      continue;
    }

    flushList();
    if (heading) {
      flushPara();
      const p = makeEl("p", "heading");
      appendInline(p, heading[1]);
      container.appendChild(p);
      continue;
    }
    para.push(line);
  }
  flushPara();
}

// ── Styles ──────────────────────────────────────────────────────────────────
const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

.root {
  --c-teal: #0E7C7B;
  --c-bg: var(--card, var(--white, #132030));
  --c-surface: var(--surface, #0D1B2A);
  --c-text: var(--text, #E8F1F8);
  --c-muted: var(--text-2, #7A9BB5);
  --c-amber: var(--amber, #F0A500);
  --c-border: rgba(14, 124, 123, 0.28);
  --bottom-narrow: ${MOBILE_BOTTOM};
  font-family: 'DM Sans', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--c-text);
}
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ── Launcher ── */
.fab {
  position: fixed; right: 20px; bottom: 20px; z-index: 250;
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  min-width: 52px; height: 52px; padding: 0 16px;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 26px;
  background: linear-gradient(135deg, #0E7C7B 0%, #0b5f66 100%);
  color: #fff; cursor: pointer;
  font: 600 14px/1 'Syne', 'DM Sans', sans-serif; letter-spacing: 0.1px;
  box-shadow: 0 8px 26px rgba(14,124,123,0.45), 0 2px 6px rgba(0,0,0,0.35);
  transition: transform .15s ease, box-shadow .15s ease;
}
.fab:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(14,124,123,0.55), 0 2px 6px rgba(0,0,0,0.35); }
.fab:focus-visible, .icon-btn:focus-visible, .send:focus-visible, .chip:focus-visible, .act:focus-visible, .log:focus-visible {
  outline: 2px solid var(--c-amber); outline-offset: 2px;
}
.fab svg { width: 22px; height: 22px; flex: none; }
.fab-label { display: none; white-space: nowrap; }

/* ── Panel ── */
.panel {
  position: fixed; right: 20px; bottom: 84px; z-index: 250;
  width: 392px; max-width: calc(100vw - 32px);
  height: min(600px, calc(100vh - 110px)); height: min(600px, calc(100dvh - 110px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 20px;
  box-shadow: 0 24px 64px rgba(0,0,0,0.55), 0 0 0 1px rgba(14,124,123,0.12);
  animation: rise .22s ease-out;
}
@keyframes rise { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }

.head {
  display: flex; align-items: center; gap: 11px; padding: 14px 14px 13px 16px;
  background: linear-gradient(135deg, rgba(14,124,123,0.30), rgba(26,95,191,0.16));
  border-bottom: 1px solid var(--c-border);
}
.avatar {
  flex: none; width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center;
  background: linear-gradient(135deg, #0E7C7B, #0b5f66); color: #fff;
}
.avatar svg { width: 20px; height: 20px; }
.titles { flex: 1; min-width: 0; }
.title { font: 700 15px/1.2 'Syne', 'DM Sans', sans-serif; color: var(--c-text); }
.subtitle { font-size: 12px; color: var(--c-muted); margin-top: 2px; }
.icon-btn {
  flex: none; width: 32px; height: 32px; display: grid; place-items: center; cursor: pointer;
  border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--c-muted);
  transition: background .15s, color .15s;
}
.icon-btn:hover { background: rgba(255,255,255,0.08); color: var(--c-text); }
.icon-btn svg { width: 18px; height: 18px; }

/* ── Messages ── */
.log {
  flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 10px;
  background: var(--c-surface); overscroll-behavior: contain; scroll-behavior: smooth;
}
.msg { max-width: 88%; padding: 10px 13px; border-radius: 16px; word-wrap: break-word; overflow-wrap: anywhere; }
.msg p { margin: 0; white-space: pre-line; }
.msg p + p, .msg p + ul, .msg p + ol, .msg ul + p, .msg ol + p, .msg ul + ul, .msg ol + ol { margin-top: 8px; }
.msg ul, .msg ol { margin: 0; padding-left: 20px; }
.msg li + li { margin-top: 3px; }
.msg .heading, .msg strong { font-weight: 700; }
.msg code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; padding: 1px 5px; border-radius: 5px; background: rgba(255,255,255,0.09); }
.msg.bot { align-self: flex-start; background: var(--c-bg); border: 1px solid var(--c-border); border-bottom-left-radius: 5px; }
.msg.me  { align-self: flex-end; color: #fff; background: linear-gradient(135deg, #0E7C7B, #0b5f66); border-bottom-right-radius: 5px; }
.msg.me p { white-space: pre-wrap; }
.msg.err { align-self: flex-start; background: rgba(224,85,85,0.12); border: 1px solid rgba(224,85,85,0.45); border-bottom-left-radius: 5px; }
.err-text { color: #ffb4b4; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
.act {
  cursor: pointer; padding: 6px 12px; border-radius: 999px; font: 600 12.5px/1.2 'DM Sans', sans-serif;
  border: 1px solid rgba(224,85,85,0.6); background: transparent; color: #ffd0d0; text-decoration: none;
}
.act:hover { background: rgba(224,85,85,0.2); }

.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
.chip {
  cursor: pointer; text-align: left; padding: 7px 12px; border-radius: 999px;
  font: 500 12.5px/1.3 'DM Sans', sans-serif; color: var(--c-text);
  background: rgba(14,124,123,0.14); border: 1px solid var(--c-border);
}
.chip:hover { background: rgba(14,124,123,0.28); }

.typing { display: inline-flex; gap: 5px; align-items: center; height: 16px; }
.typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--c-teal); opacity: .35; animation: blink 1.2s infinite ease-in-out; }
.typing i:nth-child(2) { animation-delay: .18s; }
.typing i:nth-child(3) { animation-delay: .36s; }
@keyframes blink { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }

/* ── Composer ── */
.composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px 6px; background: var(--c-bg); border-top: 1px solid var(--c-border); position: relative; }
.input {
  flex: 1; resize: none; min-height: 40px; max-height: 120px; padding: 9px 12px; border-radius: 14px;
  border: 1px solid var(--c-border); background: var(--c-surface); color: var(--c-text);
  font: 400 14px/1.45 'DM Sans', sans-serif; outline: none;
}
.input::placeholder { color: var(--c-muted); }
.input:focus { border-color: var(--c-teal); box-shadow: 0 0 0 3px rgba(14,124,123,0.2); }
.input:disabled { opacity: .6; cursor: not-allowed; }
.send {
  flex: none; width: 40px; height: 40px; border-radius: 13px; border: 0; cursor: pointer; display: grid; place-items: center;
  background: linear-gradient(135deg, #0E7C7B, #0b5f66); color: #fff; transition: opacity .15s, transform .15s;
}
.send:hover:not(:disabled) { transform: translateY(-1px); }
.send:disabled { opacity: .45; cursor: not-allowed; }
.send svg { width: 18px; height: 18px; }
.count { position: absolute; right: 64px; top: -9px; font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--c-bg); color: var(--c-amber); border: 1px solid var(--c-border); }
.foot { margin: 0; padding: 2px 14px 11px; font-size: 11px; line-height: 1.4; color: var(--c-muted); background: var(--c-bg); }

/* ── Small screens: bottom sheet, icon-only launcher ── */
@media (max-width: 599px) {
  .fab { right: 14px; bottom: var(--bottom-narrow); }
  .fab.hide-small { display: none; }
  .panel {
    right: 0; left: 0; bottom: 0; width: 100%; max-width: 100%;
    height: 82vh; height: 82dvh; max-height: 680px;
    border-radius: 20px 20px 0 0; border-left: 0; border-right: 0; border-bottom: 0;
  }
  .foot { padding-bottom: calc(11px + env(safe-area-inset-bottom, 0px)); }
  .input { font-size: 16px; } /* stops iOS zooming into the field */
}
@media (min-width: 1024px) {
  .fab { right: 28px; bottom: 28px; padding: 0 20px 0 16px; }
  .fab-label { display: inline; }
  .panel { right: 28px; bottom: 92px; }
}
@media (prefers-reduced-motion: reduce) {
  .panel { animation: none; }
  .log { scroll-behavior: auto; }
  .typing i { animation: none; opacity: .7; }
  .fab, .send { transition: none; }
}
`;

// ── Constant, trusted shell markup (contains no dynamic text) ────────────────
const SHELL = `
<div class="root">
  <button type="button" class="fab" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel" title="Ask SmartHeal AI">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.7 8.7 0 0 1-3.6-.8L3 21l1.9-5.1A8.4 8.4 0 1 1 21 11.5z"/><path d="M12 8v6M9 11h6"/></svg>
    <span class="fab-label">Ask SmartHeal AI</span>
  </button>

  <section class="panel" id="panel" role="dialog" aria-label="SmartHeal AI assistant" hidden>
    <header class="head">
      <div class="avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></div>
      <div class="titles">
        <div class="title">SmartHeal AI</div>
        <div class="subtitle"></div>
      </div>
      <button type="button" class="icon-btn" data-act="clear" aria-label="Start a new chat" title="New chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
      <button type="button" class="icon-btn" data-act="close" aria-label="Minimize chat" title="Minimize">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </header>

    <div class="log" role="log" aria-live="polite" aria-relevant="additions" tabindex="0"></div>

    <form class="composer" autocomplete="off">
      <span class="count" hidden></span>
      <label class="vh" for="msg">Message SmartHeal AI</label>
      <textarea id="msg" class="input" rows="1" maxlength="${MAX_CHARS}" placeholder="Type your question…"></textarea>
      <button type="submit" class="send" aria-label="Send message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
      </button>
    </form>
    <p class="foot">General information only — not medical advice, diagnosis or prescriptions. In an emergency, call your local emergency number (112 in India).</p>
  </section>
</div>`;

// ── Mount ───────────────────────────────────────────────────────────────────
function mount() {
  if (document.getElementById("smartheal-ai-host")) return; // idempotent

  const host = document.createElement("div");
  host.id = "smartheal-ai-host";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  const wrap = document.createElement("div");
  wrap.innerHTML = SHELL; // constant trusted markup only
  shadow.append(style, wrap.firstElementChild);
  document.body.appendChild(host);

  const $ = (sel) => shadow.querySelector(sel);
  const fab = $(".fab");
  const panel = $(".panel");
  const log = $(".log");
  const form = $(".composer");
  const input = $(".input");
  const sendBtn = $(".send");
  const count = $(".count");
  $(".subtitle").textContent = `Hospital info & ${PORTAL_LABEL.toLowerCase()} help`;

  let isOpen = false;
  let pending = false;
  let abortCtrl = null;
  let runId = 0;
  let typingEl = null;

  // ----- helpers -----
  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  function addBot(text) {
    const m = makeEl("div", "msg bot");
    renderRich(m, text);
    log.appendChild(m);
    scrollDown();
    return m;
  }
  function addMe(text) {
    const m = makeEl("div", "msg me");
    m.appendChild(makeEl("p", null, text));
    log.appendChild(m);
    scrollDown();
  }
  function addError(err, retryText) {
    const m = makeEl("div", "msg err");
    m.setAttribute("role", "alert");
    m.appendChild(makeEl("p", "err-text", err.message));
    const actions = makeEl("div", "actions");
    if (err.needsLogin) {
      const a = makeEl("a", "act", "Sign in again");
      a.href = LOGIN_URL;
      actions.appendChild(a);
    }
    if (err.retryable && retryText) {
      const b = makeEl("button", "act", "Try again");
      b.type = "button";
      b.addEventListener("click", () => { m.remove(); send(retryText, { echo: false }); });
      actions.appendChild(b);
    }
    if (actions.childNodes.length) m.appendChild(actions);
    log.appendChild(m);
    scrollDown();
  }
  function showTyping() {
    typingEl = makeEl("div", "msg bot");
    const dots = makeEl("span", "typing");
    dots.append(makeEl("i"), makeEl("i"), makeEl("i"));
    typingEl.append(dots, makeEl("span", "vh", "SmartHeal AI is typing"));
    log.appendChild(typingEl);
    scrollDown();
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  function setPending(on) {
    pending = on;
    input.disabled = on;
    sendBtn.disabled = on;
    log.setAttribute("aria-busy", on ? "true" : "false");
    if (!on && isOpen) input.focus();
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    const n = input.value.length;
    count.hidden = n < MAX_CHARS - 200;
    count.textContent = `${n}/${MAX_CHARS}`;
  }

  function welcome() {
    log.textContent = "";
    addBot(
      `Hi, I'm SmartHeal AI. I can help with general hospital information and finding your way around the ${PORTAL_LABEL.toLowerCase()}.\n\n` +
      "I can't diagnose conditions, recommend medication, or see your medical records."
    );
    const chips = makeEl("div", "chips");
    for (const s of SUGGESTIONS) {
      const c = makeEl("button", "chip", s);
      c.type = "button";
      c.addEventListener("click", () => send(s));
      chips.appendChild(c);
    }
    log.appendChild(chips);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    panel.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    fab.classList.add("hide-small");
    scrollDown();
    input.focus();
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    fab.classList.remove("hide-small");
    fab.focus();
  }

  function newChat() {
    runId++; // ignore any reply still in flight
    if (abortCtrl) abortCtrl.abort();
    hideTyping();
    setPending(false);
    input.value = "";
    resizeInput();
    welcome();
  }

  async function send(rawText, { echo = true } = {}) {
    const text = String(rawText).trim();
    if (!text || pending) return; // blocks duplicate submissions
    if (text.length > MAX_CHARS) {
      addError(new ChatError(`Please keep your message under ${MAX_CHARS} characters.`));
      return;
    }
    setPending(true); // set before any await
    const chips = log.querySelector(".chips");
    if (chips) chips.remove();
    if (echo) addMe(text);
    input.value = "";
    resizeInput();
    showTyping();

    const myRun = ++runId;
    abortCtrl = new AbortController();
    try {
      const answer = await askAssistant(text, abortCtrl.signal);
      if (myRun !== runId) return;
      hideTyping();
      addBot(answer);
    } catch (err) {
      if (myRun !== runId) return;
      hideTyping();
      addError(err instanceof ChatError ? err : new ChatError("Something went wrong. Please try again.", { retryable: true }), text);
    } finally {
      if (myRun === runId) { abortCtrl = null; setPending(false); }
    }
  }

  // ----- events -----
  fab.addEventListener("click", () => (isOpen ? close() : open()));
  shadow.querySelector('[data-act="close"]').addEventListener("click", close);
  shadow.querySelector('[data-act="clear"]').addEventListener("click", newChat);
  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen) close(); });

  welcome();
  window.SmartHealChatbot = { open, close, toggle: () => (isOpen ? close() : open()) };
}

if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount, { once: true });
