// Renders one poll from /api/polls/:slug. Every user-supplied string goes
// through textContent, never innerHTML.

import { applyTheme, confetti, reducedMotion } from "/theme.js";

const app = document.getElementById("app");
const progressBar = document.getElementById("progress");
const [, , slug, view] = location.pathname.split("/");
const doneKey = `qn:done:${slug}`;
const mineKey = `qn:mine:${slug}`;

applyTheme(slug || "questionnaire");

function respondentId() {
  try {
    let id = localStorage.getItem("qn:rid");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("qn:rid", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function notice(icon, title, body, extra) {
  app.replaceChildren(
    el("section", { class: "notice" },
      icon ? el("div", { class: "badge", "aria-hidden": "true", text: icon }) : null,
      el("h1", { text: title }),
      body ? el("p", { class: "lede", text: body }) : null),
    extra || null,
  );
}

async function api(path, options) {
  try {
    const res = await fetch(path, options);
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// ------------------------------------------------------------------ results

function countUp(node, to, suffix) {
  if (reducedMotion() || to === 0) return (node.textContent = `${to}${suffix}`);
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / 1000);
    node.textContent = `${Math.round(to * (1 - Math.pow(1 - p, 3)))}${suffix}`;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function resultsView(poll, results, mine) {
  const box = el("section", { class: "card", style: "--i:1" });
  const total = el("span", { class: "result-note" });
  box.append(el("div", { class: "results-head" }, el("h2", { text: mine ? "You and everyone else" : "Results so far" }), total));
  total.textContent = `${results.total} ${results.total === 1 ? "response" : "responses"}`;
  const bars = [];

  for (const q of results.questions) {
    const block = el("div", { class: "result-q" }, el("h3", { text: q.title }));
    const yours = mine ? mine[q.id] : undefined;
    const picked = new Set(Array.isArray(yours) ? yours.map(String) : yours !== undefined ? [String(yours)] : []);
    const rows = [];
    if (q.options) {
      const known = new Set(q.options.map((o) => o.label));
      for (const o of q.options) rows.push({ label: o.label, count: o.count, mine: picked.has(o.label) });
      if (q.other) rows.push({ label: "Other", count: q.other.count, mine: [...picked].some((p) => !known.has(p)) });
    } else if (q.distribution) {
      for (const d of q.distribution) rows.push({ label: q.type === "rating" ? "★".repeat(d.value) : String(d.value), count: d.count, mine: picked.has(String(d.value)) });
    }

    if (rows.length) {
      const denom = q.type === "multiple" ? Math.max(q.answered, 1) : Math.max(rows.reduce((s, r) => s + r.count, 0), 1);
      for (const r of rows) {
        const pct = Math.round((r.count / denom) * 100);
        const fill = el("i");
        const value = el("b");
        const bar = el("div", { class: `bar${r.mine ? " mine" : ""}${r.mine && pct < 35 ? " low" : ""}` },
          fill,
          el("div", {}, el("span", {}, r.label, r.mine ? el("span", { class: "you", text: "You" }) : null), value));
        block.append(bar);
        bars.push({ fill, value, pct, count: r.count });
      }
      if (q.average !== undefined && q.average !== null) block.append(el("p", { class: "result-note", text: `Average ${q.average}${q.type === "rating" ? ` out of ${rows.length}` : ""}` }));
    } else {
      block.append(el("p", { class: "result-note", text: `${q.answered} written ${q.answered === 1 ? "answer" : "answers"}` }));
    }
    if (yours !== undefined && (q.type === "text" || q.type === "paragraph")) {
      block.append(el("div", { class: "your-text" }, el("small", { text: "Your answer" }), String(yours)));
    } else if (yours !== undefined && q.other && !q.options.some((o) => picked.has(o.label))) {
      block.append(el("div", { class: "your-text" }, el("small", { text: "Your answer" }), [...picked].join(", ")));
    }
    box.append(block);
  }

  // Bars grow in once the card is on screen.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const b of bars) {
      b.fill.style.width = `${b.pct}%`;
      countUp(b.value, b.pct, `% · ${b.count}`);
    }
  }));
  return box;
}

function readMine() {
  try {
    return JSON.parse(read(mineKey) || "null");
  } catch {
    return null;
  }
}

async function showDone(poll, results, celebrate) {
  const message = poll.confirmationMessage || "Thanks for taking part. Here's how everyone answered.";
  const mine = readMine();
  const extra = el("div");
  if (!results && poll.showResults !== "never") {
    const r = await api(`/api/polls/${slug}/results?respondentId=${encodeURIComponent(respondentId())}`);
    if (r.ok) results = r.data;
  }
  if (results && poll.showResults !== "never") extra.append(resultsView(poll, results, mine));
  if (poll.allowMultipleResponses && poll.open) {
    extra.append(el("div", { class: "actions", style: "justify-content:center" },
      el("button", { class: "btn secondary", text: "Answer again", onclick: () => { store(doneKey, null); renderForm(poll); window.scrollTo({ top: 0, behavior: "smooth" }); } })));
  }
  progressBar.style.width = "100%";
  notice("✓", "Thank you!", poll.showResults === "never" ? (poll.confirmationMessage || "Your answers are in.") : message, extra);
  window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  if (celebrate) confetti();
}

// --------------------------------------------------------------------- form

function questionCard(q, index, state, onChange) {
  const card = el("fieldset", { class: "card", id: `q-${q.id}`, style: `--i:${index}` });
  card.append(el("div", { class: "q-num", "aria-hidden": "true", text: String(index + 1).padStart(2, "0") }));
  card.append(el("legend", {}, q.title, q.required ? el("span", { class: "req", "aria-hidden": "true", text: "*" }) : null));
  if (q.description) card.append(el("p", { class: "q-desc", text: q.description }));
  const name = `q_${q.id}`;

  if (q.type === "single" || q.type === "multiple") {
    if (q.type === "multiple") card.append(el("p", { class: "q-hint", text: q.maxSelections ? `Choose up to ${q.maxSelections}` : "Choose all that apply" }));
    const list = el("div", { class: "choices" });
    const kind = q.type === "single" ? "radio" : "checkbox";
    const sync = () => {
      const checked = [...list.querySelectorAll("input[data-opt]:checked")].map((i) => i.value);
      const otherBox = list.querySelector("input[data-other]");
      const otherText = list.querySelector(".other-input");
      if (otherBox && otherBox.checked && otherText.value.trim()) checked.push(otherText.value.trim());
      state[q.id] = q.type === "single" ? checked[0] : checked;
      if (q.maxSelections) {
        const full = checked.length >= q.maxSelections;
        list.querySelectorAll("input[type=checkbox]").forEach((i) => { if (!i.checked) i.disabled = full; });
      }
      onChange(q.id);
    };
    const ripple = (e) => {
      const label = e.currentTarget;
      const rect = label.getBoundingClientRect();
      if (e.clientX) label.style.setProperty("--x", `${e.clientX - rect.left}px`);
    };
    for (const opt of q.options) {
      list.append(el("label", { class: "choice", onpointerdown: ripple },
        el("input", { type: kind, name, value: opt, "data-opt": true, onchange: sync }),
        el("span", { text: opt })));
    }
    if (q.allowOther) {
      const box = el("input", { type: kind, name, "data-other": true, "aria-label": "Other", onchange: sync });
      const text = el("input", { type: "text", class: "other-input", placeholder: "Something else…", maxlength: "200", "aria-label": "Other answer",
        oninput: () => { if (!box.checked) box.click(); else sync(); } });
      list.append(el("label", { class: "choice", onpointerdown: ripple }, box, text));
    }
    card.append(list);
  } else if (q.type === "text" || q.type === "paragraph") {
    const input = q.type === "text"
      ? el("input", { type: "text", name, maxlength: "500", placeholder: "Type your answer", "aria-label": q.title })
      : el("textarea", { name, maxlength: "5000", placeholder: "Type your answer", "aria-label": q.title });
    input.addEventListener("input", () => { state[q.id] = input.value.trim(); onChange(q.id); });
    card.append(input);
  } else {
    const stars = q.type === "rating";
    const min = stars ? 1 : q.min ?? 0;
    const max = q.max ?? (stars ? 5 : 10);
    const row = el("div", { class: `scale${stars ? " stars" : ""}`, role: "group", "aria-label": q.title });
    const buttons = [];
    for (let v = min; v <= max; v++) {
      const b = el("button", { type: "button", "aria-pressed": "false", "aria-label": stars ? `${v} of ${max}` : String(v), text: stars ? "★" : String(v) });
      b.addEventListener("click", () => {
        state[q.id] = v;
        buttons.forEach((x, i) => {
          const value = min + i;
          x.setAttribute("aria-pressed", String(value === v));
          if (stars) {
            x.classList.remove("on");
            if (value <= v) {
              x.style.setProperty("--s", String(i));
              void x.offsetWidth; // restart the pop
              x.classList.add("on");
            }
          }
        });
        onChange(q.id);
      });
      buttons.push(b);
      row.append(b);
    }
    card.append(row);
    if (!stars && (q.minLabel || q.maxLabel)) {
      card.append(el("div", { class: "scale-labels" }, el("span", { text: q.minLabel || "" }), el("span", { text: q.maxLabel || "" })));
    }
  }
  return card;
}

function isAnswered(v) {
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
}

function setError(card, message) {
  card.querySelector(".q-error")?.remove();
  card.classList.remove("invalid");
  if (message) {
    void card.offsetWidth; // replay the shake
    card.classList.add("invalid");
    card.append(el("p", { class: "q-error", role: "alert", text: message }));
  }
}

let turnstileToken = "";
function loadTurnstile(siteKey, mount) {
  window.onQnTurnstile = () => {
    window.turnstile.render(mount, {
      sitekey: siteKey,
      appearance: "interaction-only",
      callback: (t) => { turnstileToken = t; },
      "expired-callback": () => { turnstileToken = ""; },
    });
  };
  document.head.append(el("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onQnTurnstile&render=explicit", async: true }));
}

function renderForm(poll) {
  const state = {};
  const cards = new Map();
  const onChange = (id) => {
    const done = poll.questions.filter((q) => isAnswered(state[q.id])).length;
    progressBar.style.width = `${Math.round((done / poll.questions.length) * 100)}%`;
    const card = cards.get(id);
    card.classList.toggle("answered", isAnswered(state[id]));
    if (isAnswered(state[id]) && card.classList.contains("invalid")) setError(card, "");
  };

  const form = el("form", { novalidate: true });
  poll.questions.forEach((q, i) => {
    const card = questionCard(q, i, state, onChange);
    cards.set(q.id, card);
    form.append(card);
  });
  const honeypot = el("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off" });
  form.append(el("label", { class: "hp", "aria-hidden": "true" }, "Leave this empty", honeypot));
  const challenge = el("div");
  form.append(challenge);
  if (poll.turnstileSiteKey) loadTurnstile(poll.turnstileSiteKey, challenge);

  const submitBtn = el("button", { class: "btn", type: "submit", text: "Send my answers" });
  const formError = el("span", { class: "form-error", role: "alert" });
  form.append(el("div", { class: "actions", style: `--i:${poll.questions.length}` }, submitBtn, formError));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";
    let first = null;
    for (const q of poll.questions) {
      const missing = q.required && !isAnswered(state[q.id]);
      setError(cards.get(q.id), missing ? "This one needs an answer." : "");
      if (missing && !first) first = cards.get(q.id);
    }
    if (first) {
      first.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    const answers = {};
    for (const q of poll.questions) if (isAnswered(state[q.id])) answers[q.id] = state[q.id];
    const r = await api(`/api/polls/${slug}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers, respondentId: respondentId(), website: honeypot.value, turnstileToken }),
    });
    submitBtn.disabled = false;
    submitBtn.textContent = "Send my answers";
    if (r.ok) {
      store(doneKey, "1");
      store(mineKey, JSON.stringify(answers));
      return showDone(poll, r.data.results, true);
    }
    const err = r.data?.error;
    if (err?.code === "already_responded") {
      store(doneKey, "1");
      return showDone(poll);
    }
    if (err?.code === "invalid_answers" && err.details) {
      for (const [id, msg] of Object.entries(err.details)) if (cards.has(id)) setError(cards.get(id), msg);
    }
    if (window.turnstile && poll.turnstileSiteKey) window.turnstile.reset();
    formError.textContent = err?.message || "We couldn't send that. Check your connection and try again.";
  });

  const head = el("header", { class: "poll-head" }, el("div", { class: "eyebrow", text: poll.questions.length === 1 ? "Quick poll" : "Questionnaire" }), el("h1", { text: poll.title }));
  if (poll.description) head.append(el("p", { class: "lede", text: poll.description }));
  const meta = [`${poll.questions.length} ${poll.questions.length === 1 ? "question" : "questions"}`];
  if (poll.questions.some((q) => q.required)) meta.push("* required");
  if (poll.closesAt) meta.push(`Closes ${new Date(poll.closesAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`);
  head.append(el("p", { class: "meta", text: meta.join(" · ") }));
  app.replaceChildren(head, form);
  progressBar.style.width = "0";
}

async function main() {
  if (!slug) return notice("?", "No poll here", "Check the link you were sent.");
  const r = await api(`/api/polls/${encodeURIComponent(slug)}`);
  if (r.status === 404) return notice("?", "Poll not found", "This link may be mistyped, or the poll was taken down.");
  if (!r.ok) return notice("!", "Couldn't load this poll", "Check your connection and refresh the page.");
  const poll = r.data;
  document.title = poll.title;
  if (poll.theme) applyTheme(slug, poll.theme);

  if (view === "results") {
    const res = await api(`/api/polls/${slug}/results?respondentId=${encodeURIComponent(respondentId())}`);
    if (!res.ok) return notice("", poll.title, res.data?.error?.message || "Results aren't available.");
    app.replaceChildren(el("header", { class: "poll-head" }, el("div", { class: "eyebrow", text: "Results" }), el("h1", { text: poll.title })), resultsView(poll, res.data, readMine()));
    progressBar.style.width = "100%";
    return;
  }
  if (!poll.open) {
    const extra = el("div");
    if (poll.showResults === "public") {
      const res = await api(`/api/polls/${slug}/results`);
      if (res.ok) extra.append(resultsView(poll, res.data, readMine()));
    }
    return notice("", poll.title, "This poll is closed and isn't taking responses anymore.", extra);
  }
  if (read(doneKey)) return showDone(poll);
  renderForm(poll);
}

main();
