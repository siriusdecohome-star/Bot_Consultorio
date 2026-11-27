// Simulador web: imita un chat de WhatsApp y muestra la agenda en vivo.
// Habla con el mismo motor del bot que usa WhatsApp, a través de /api/chat.

const $ = (s) => document.querySelector(s);
const chat = $("#chat");
const input = $("#input");
const sendBtn = $("#send");
const params = new URLSearchParams(location.search);
const source = params.get("source") ?? "promo-noviembre";
// Multiempresa: la clínica va en la URL (?clinica=altamira); sin indicar, la principal.
const clinicId = params.get("clinica") ?? "";
/** Agrega la clínica elegida a una ruta de la API. */
const api = (url) => (clinicId ? `${url}${url.includes("?") ? "&" : "?"}clinic=${encodeURIComponent(clinicId)}` : url);

const state = {
  sessionId: null,
  busy: false,
  lastSide: null,
  totalCost: 0,
  weekFrom: null,     // lunes de la semana visible (YYYY-MM-DD)
  prevAgenda: null,   // Map slot -> {kind, id} del render anterior
  provider: "",
  line: null,         // línea simulada a la que escribe el paciente (id)
};

// ---------- Utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (d = new Date()) => d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", hour12: false });
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Formato estilo WhatsApp: *negrita* y _cursiva_. */
const fmt = (s) => esc(s).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>");

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7; // 0 = lunes
  return addDays(iso, -wd);
}
const DAY = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
function prettySlot(key) {
  const d = new Date(`${key.slice(0, 10)}T00:00:00Z`);
  const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  return `${days[d.getUTCDay()]} ${key.slice(8, 10)}/${key.slice(5, 7)} ${key.slice(11, 16)}`;
}

// ---------- Chat ----------
const TICKS = `<svg class="ticks" viewBox="0 0 18 11" width="16" height="11"><path fill="currentColor" d="M11.1.6 4.9 7.7 2.3 5.2 1.2 6.3l3.8 3.6 7.2-8.3-1.1-1Zm4 0L8.9 7.7l-.9-.8-1 1.2 2 1.8 7.2-8.3-1.1-1Z"/></svg>`;

function bubble(text, side, opts = {}) {
  const el = document.createElement("div");
  el.className = `msg ${side}${state.lastSide !== side ? " first" : ""}${opts.notice ? " notice" : ""}${opts.error ? " error" : ""}`;
  let html = fmt(text);
  // Demo pública: las opciones numeradas (1️⃣ …) se pueden tocar, además de escribir el número.
  if (side === "in" && document.body.classList.contains("public-demo")) {
    html = html.replace(/(^|\n)([1-9])\uFE0F\u20E3 ([^\n]*)/g, (_, pre, n, label) => `${pre}<button type="button" class="opt" data-opt="${n}">${n}\uFE0F\u20E3 ${label}</button>`);
  }
  el.innerHTML = `${html}<span class="meta">${hhmm()}${side === "out" ? TICKS : ""}</span>`;
  if (side === "in" && !opts.notice) state.lastBot = text;
  chat.appendChild(el);
  state.lastSide = side;
  chat.scrollTop = chat.scrollHeight;
  return el;
}

/** Mensaje del bot con botones de respuesta rápida (recordatorios, seguimiento). */
function bubbleWithButtons(text, buttons) {
  const wrap = document.createElement("div");
  wrap.className = "msg-wrap";
  const el = document.createElement("div");
  el.className = `msg in${state.lastSide !== "in" ? " first" : ""} has-buttons`;
  el.innerHTML = `${fmt(text)}<span class="meta">${hhmm()}</span>`;
  wrap.appendChild(el);
  for (const title of buttons) {
    const b = document.createElement("button");
    b.className = "reply-btn";
    b.textContent = title;
    b.addEventListener("click", () => {
      wrap.querySelectorAll(".reply-btn").forEach((x) => (x.disabled = true));
      send(title);
    });
    wrap.appendChild(b);
  }
  chat.appendChild(wrap);
  state.lastSide = "in";
  chat.scrollTop = chat.scrollHeight;
}

/** Mensajes que el bot envía por su cuenta: se consultan cada pocos segundos. */
async function pollOutbox() {
  if (!state.sessionId || state.busy) return;
  try {
    const r = await fetch(api(`/api/outbox?sessionId=${encodeURIComponent(state.sessionId)}`));
    const { messages } = await r.json();
    for (const m of messages ?? []) {
      setTyping(true);
      await sleep(350);
      setTyping(false);
      if (m.buttons?.length) bubbleWithButtons(m.text, m.buttons);
      else bubble(m.text, "in");
      if (/^\S+ \*Recepción:\*/u.test(m.text)) { state.humanSeen = true; tourCoach(); }
    }
  } catch {}
}

async function demo(path, okMsg) {
  const r = await fetch(api(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: state.sessionId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast(data.error ?? "No se pudo enviar", true);
  toast(okMsg);
  pollOutbox();
}

let typingEl = null;
function setTyping(on) {
  $("#wa-status").textContent = on ? "escribiendo…" : "en línea";
  if (on && !typingEl) {
    typingEl = document.createElement("div");
    typingEl.className = "typing";
    typingEl.innerHTML = "<i></i><i></i><i></i>";
    chat.appendChild(typingEl);
    chat.scrollTop = chat.scrollHeight;
  } else if (!on && typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

// Cola: como en WhatsApp, se puede escribir mientras el bot responde;
// los mensajes se muestran al instante y se procesan en orden.
const queue = [];
function send(text) {
  text = text.trim();
  if (!text) return;
  input.value = "";
  queue.push({ text, out: bubble(text, "out") });
  if (!state.busy) processQueue();
}
async function processQueue() {
  state.busy = true;
  while (queue.length) {
    const { text, out } = queue.shift();
    await deliver(text, out);
  }
  state.busy = false;
}

async function deliver(text, out) {
  await sleep(350);
  out.querySelector(".ticks")?.classList.add("read"); // "leído"
  setTyping(true);
  const t0 = performance.now();
  try {
    const res = await fetch(api("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, text, source, ...(state.line ? { line: state.line } : {}) }),
    });
    const data = await res.json();
    // Un mínimo de "escribiendo…" para que se vea natural (también en el video).
    const wait = 700 - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
    setTyping(false);
    if (!res.ok) {
      bubble(data.error ?? "Hubo un problema. Intente nuevamente.", "in", { error: true });
      return;
    }
    for (let i = 0; i < data.messages.length; i++) {
      const m = data.messages[i];
      const isNotice = m.startsWith("🔒");
      if (i > 0) {
        setTyping(true);
        await sleep(Math.min(1200, 300 + m.length * 6));
        setTyping(false);
      }
      // Menú inicial: botones (hasta 3) o lista de WhatsApp, en el último mensaje.
      const ui = i === data.messages.length - 1 ? data.interactive : null;
      const opts = ui ? (ui.buttons ?? ui.list?.rows.map((r) => r.title) ?? []) : [];
      if (opts.length) bubbleWithButtons(m, opts);
      else bubble(m, "in", { notice: isNotice });
    }
    showMetrics(data);
    if (data.metric?.conversationId) state.convId = data.metric.conversationId;
    // Resaltar en la agenda lo que cambió en este mensaje (reserva, cancelación o cambio).
    const tools = data.tools ?? [];
    const added = [...tools].reverse().find((t) => t.when)?.when ?? null;
    const freed = [...tools].reverse().find((t) => t.freed)?.freed ?? null;
    if (added || freed) {
      state.weekFrom = mondayOf((added ?? freed).slice(0, 10));
      await loadAgenda({ mark: { added, freed } });
    }
    const t = tourGet();
    if (t?.clinic === clinicId && t.step === "chat-book") {
      if (added) tourSet({ step: "chat-done", conv: state.convId });
      else if (state.convId && !t.conv) tourSet({ conv: state.convId });
    }
    tourCoach();
  } catch (err) {
    setTyping(false);
    bubble("Sin conexión con el servidor. ¿Está corriendo npm run dev?", "in", { error: true });
  }
}

function showMetrics(data) {
  const m = data.metric;
  const isMock = state.provider.startsWith("mock");
  if (!m) {
    $("#m-lat").textContent = "—";
    return;
  }
  state.totalCost += m.costUsd;
  $("#m-lat").textContent = `${(m.latencyMs / 1000).toFixed(2)} s`;
  $("#m-cost").textContent = isMock ? "USD 0 (sin IA)" : `USD ${m.costUsd.toFixed(4)}`;
  $("#m-total").textContent = isMock ? "USD 0 (sin IA)" : `USD ${state.totalCost.toFixed(4)}`;
  const tools = data.tools ?? [];
  $("#m-tools").innerHTML = tools.length
    ? tools.map((t) => `<span class="tool-chip">${esc(t.name)} · ${t.ms} ms</span>`).join("")
    : "ninguna (respuesta directa)";
}

async function newSession() {
  queue.length = 0;
  const r = await fetch("/api/session", { method: "POST" });
  state.sessionId = (await r.json()).sessionId;
  state.totalCost = 0;
  state.lastSide = null;
  chat.innerHTML = '<div class="day-pill">Hoy</div>';
  for (const id of ["#m-lat", "#m-cost", "#m-total", "#m-tools"]) $(id).textContent = "—";
  input.focus();
}

// ---------- Agenda ----------
let toastTimer;
function toast(text, warn = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("warn", warn);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

/**
 * mark: cambios conocidos de este mensaje ({added, freed}).
 * announce: en el refresco periódico, avisa de cambios hechos fuera del chat (p. ej. a mano en Google Calendar).
 */
async function loadAgenda({ announce = false, mark = null } = {}) {
  const url = state.weekFrom ? `/api/agenda?from=${state.weekFrom}` : "/api/agenda";
  let data;
  try {
    data = await (await fetch(api(url))).json();
  } catch {
    return;
  }
  if (!data.events) return;
  if (state.weekFrom !== data.from) state.prevAgenda = null;
  state.weekFrom = data.from;
  renderAgenda(data, announce, mark);
}

function renderAgenda(data, announce, mark) {
  const grid = $("#grid");
  const days = [...Array(6)].map((_, i) => addDays(data.from, i)); // lunes a sábado
  $("#wk-label").textContent = `${days[0].slice(8, 10)}/${days[0].slice(5, 7)} – ${days[5].slice(8, 10)}/${days[5].slice(5, 7)}`;

  // Filas de 30 min entre la primera apertura y el último cierre
  const times = [];
  for (let m = 9 * 60; m < 18 * 60; m += 30) times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

  // Mapa de ocupación: "YYYY-MM-DDTHH:mm" -> evento
  const occ = new Map();
  for (const e of data.events) {
    for (let k = e.start; k < e.end; ) {
      occ.set(k, e);
      const [d, t] = k.split("T");
      let [h, mi] = t.split(":").map(Number);
      mi += 30; if (mi >= 60) { h++; mi -= 60; }
      k = `${d}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
    }
  }
  const isOpen = (day, t) => {
    const wd = ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const h = data.hours.find((x) => x.weekday === wd);
    return !!h && h.blocks.some(([a, b]) => t >= a && t < b);
  };

  const prev = mark ? null : state.prevAgenda; // con `mark` se resalta exactamente lo informado
  const next = new Map();
  const html = ['<div></div>'];
  days.forEach((d, i) => {
    html.push(`<div class="gh${d === data.today ? " today" : ""}">${DAY[i]}<b>${d.slice(8, 10)}</b></div>`);
  });
  let added = null, removed = null;
  for (const t of times) {
    html.push(`<div class="gt">${t}</div>`);
    for (const d of days) {
      const key = `${d}T${t}`;
      const e = occ.get(key);
      const cls = ["cell"];
      let label = "";
      if (!isOpen(d, t)) cls.push("closed");
      if (key < data.now) cls.push("past");
      if (e) {
        cls.push(e.kind === "bot" ? "bot" : "busy");
        label = e.kind === "bot" ? (e.patient ?? e.title) : "";
        next.set(key, e.id);
        if ((prev && !prev.has(key) && e.kind === "bot") || mark?.added === key) { cls.push("new"); added = key; }
      } else if ((prev && prev.has(key)) || mark?.freed === key) {
        cls.push("gone"); removed = key;
      }
      const now = data.now.slice(0, 10) === d && data.now.slice(11) >= t && data.now.slice(11) < addMin(t, 30);
      if (now) cls.push("now");
      html.push(`<div class="${cls.join(" ")}" title="${esc(e ? `${e.title}${e.patient ? " · " + e.patient : ""}` : key.replace("T", " "))}">${esc(label)}</div>`);
    }
  }
  grid.innerHTML = html.join("");
  state.prevAgenda = next;

  if (mark) {
    // El horario liberado puede estar en otra semana: se avisa igual.
    added ??= mark.added;
    removed ??= mark.freed;
  }
  if (announce || mark) {
    if (added && removed) toast(`↻ Turno movido al ${prettySlot(added)}. El horario anterior quedó libre.`);
    else if (added) toast(`✓ Turno reservado: ${prettySlot(added)}`);
    else if (removed) toast(`✕ Turno cancelado: ${prettySlot(removed)}. Horario liberado.`, true);
  }
}
function addMin(t, n) {
  let [h, m] = t.split(":").map(Number);
  m += n; h += Math.floor(m / 60); m %= 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ---------- Controles ----------
$("#form").addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
$("#quick").addEventListener("click", (e) => { const q = e.target.closest("button")?.dataset.q; if (q) send(q); });
chat.addEventListener("click", (e) => { const b = e.target.closest(".opt"); if (b && !state.busy) send(b.dataset.opt); });
$("#btn-new").addEventListener("click", newSession);
$("#btn-remind").addEventListener("click", () => demo("/api/demo/remind", "⏰ Recordatorio enviado al paciente"));
$("#btn-followup").addEventListener("click", () => demo("/api/demo/followup", "📣 Seguimiento enviado al lead"));
$("#wk-prev").addEventListener("click", () => { state.weekFrom = addDays(state.weekFrom, -7); state.prevAgenda = null; loadAgenda(); });
$("#wk-next").addEventListener("click", () => { state.weekFrom = addDays(state.weekFrom, 7); state.prevAgenda = null; loadAgenda(); });
$("#tg-agenda").addEventListener("change", (e) => $("#agenda-col").classList.toggle("hidden", !e.target.checked));
$("#tg-metrics").addEventListener("change", (e) => $("#metrics").classList.toggle("hidden", !e.target.checked));
$("#tg-chips").addEventListener("change", (e) => $("#quick").classList.toggle("hidden", !e.target.checked));
$("#btn-rec").addEventListener("click", () => {
  const on = document.body.classList.toggle("rec");
  $("#btn-rec").classList.toggle("on", on);
  $("#metrics").classList.toggle("hidden", on || !$("#tg-metrics").checked);
});

setInterval(() => ($("#clock").textContent = hhmm()), 15000);
$("#clock").textContent = hhmm();

// ---------- Inicio ----------
(async () => {
  try {
    const cfg = await (await fetch(api("/api/config"))).json();
    state.provider = cfg.provider;
    $("#wa-name").textContent = cfg.clinic.replace(/^(Clínica Dental|Centro Odontológico) /, "");
    document.title = `${cfg.clinic} · Asistente de turnos`;
    const sel = $("#clinic-sel");
    sel.innerHTML = cfg.clinics.map((c) => `<option value="${esc(c.id)}"${c.id === cfg.clinicId ? " selected" : ""}>${esc(c.name)}${c.whatsapp ? " · WhatsApp" : ""}</option>`).join("");
    sel.addEventListener("change", () => {
      const p = new URLSearchParams(location.search);
      p.set("clinica", sel.value);
      location.search = p.toString();
    });
    // Líneas simuladas: el paciente elige a qué número escribe (p. ej. la línea de ortodoncia del Dr. Ríos).
    const lines = cfg.lines ?? [];
    const short = cfg.clinic.replace(/^(Clínica Dental|Centro Odontológico) /, "");
    const lineSel = $("#line-sel");
    const fromUrl = lines.find((l) => l.id === params.get("linea"));
    state.line = (fromUrl ?? lines[0])?.id ?? null;
    lineSel.innerHTML = lines.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
    lineSel.value = state.line ?? "";
    $("#line-pick").hidden = lines.length < 2;
    const showLine = () => {
      const l = lines.find((x) => x.id === state.line);
      $("#wa-name").textContent = lines.length > 1 && l ? `${short} · ${l.name}` : short;
    };
    showLine();
    lineSel.addEventListener("change", () => { state.line = lineSel.value; showLine(); input.focus(); });
    const cal = cfg.calendar === "google" ? "Google Calendar" : "agenda en memoria";
    $("#agenda-source").innerHTML = `<span class="live-dot"></span> ${cal} · se actualiza con cada reserva`;
    $("#subtitle").textContent = `Demo con datos ficticios · IA: ${cfg.provider} · base: ${cfg.store}`;
    // Demo pública (clínica temporal o recorrido): una sola aclaración, sin detalles técnicos.
    if (cfg.demo || params.get("recorrido") === "1") {
      document.body.classList.add("public-demo");
      $("#subtitle").textContent = "En esta demo el chat es una simulación para que lo pruebes sin WhatsApp. En tu negocio funciona por WhatsApp real.";
      $("#tg-agenda").checked = false;
      $("#agenda-col").classList.add("hidden");
      document.title = "Chat del paciente · demo";
      // El teléfono entra completo: la página arranca desplazada hasta él (el menú de arriba queda fuera de vista).
      requestAnimationFrame(() => document.querySelector(".phone").scrollIntoView({ block: "start" }));
      $("#tg-metrics").checked = false;
      $("#metrics").classList.add("hidden");
    }
  } catch {}
  if (params.get("modo") === "grabacion") $("#btn-rec").click();
  await newSession();
  tourCoach();
  await loadAgenda();
  setInterval(() => !state.busy && loadAgenda({ announce: true }), 20000);
  setInterval(pollOutbox, 3000); // refresca si alguien edita el calendario a mano
})();

// =====================================================================
// Recorrido guiado: la parte que pasa en esta pestaña (el chat del paciente).
// Comparte con el panel el estado «recorrido» de localStorage.
// =====================================================================
const TOUR_KEY = "recorrido";
function tourGet() { try { return JSON.parse(localStorage.getItem(TOUR_KEY) ?? "null"); } catch { return null; } }
function tourSet(patch) {
  const t = { ...(tourGet() ?? {}), ...patch };
  try { localStorage.setItem(TOUR_KEY, JSON.stringify(t)); } catch {}
  tourCoach();
  return t;
}
const coach = { raf: 0, target: null };
/** Qué tiene que hacer ahora el paciente, según el paso y lo último que dijo el asistente. */
function coachFor(t) {
  const last = state.lastBot ?? "";
  if (t.step === "chat-book") {
    if (/nombre y apellido/i.test(last)) return { target: "#form", focus: true, title: "Escribí tu nombre y apellido", text: "Inventá uno, por ejemplo «Ana Pérez», y tocá enviar. El asistente lo guarda en la ficha del paciente." };
    if (/especialidad/i.test(last)) return { target: "#chat .msg.in:has(.opt)", title: "Elegí la especialidad", text: "Tocá una opción (o escribí su número)." };
    if (/con quién prefiere/i.test(last)) return { target: "#chat .msg.in:has(.opt)", title: "Elegí el profesional", text: "Tocá con quién querés atenderte." };
    if (/[1-4]\uFE0F\u20E3 [^\n]*\d\d:\d\d/u.test(last)) return { target: "#chat .msg.in:has(.opt)", title: "Elegí un horario", text: "Tocá el que prefieras." };
    if (!state.convId) return { target: '#quick [data-q^="Quiero sacar"]', title: "Pedí un turno", text: "Sos un paciente que escribe por WhatsApp. Tocá «Sacar turno» para empezar." };
    return { target: ".phone", title: "Seguí la conversación", text: "Respondele al asistente hasta que confirme el turno. Si te perdés, tocá «Sacar turno»." };
  }
  if (t.step === "chat-done") return { title: "✅ ¡Turno reservado!", text: "Ahora volvé a la pestaña «Panel» (la del administrador): ahí vas a ver tu conversación y tu turno del lado de tu equipo.", action: "Ir al panel" };
  if (state.humanSeen && (t.step === "chat-see" || t.step === "back-bot")) {
    return { target: "#chat .msg.in", title: "Este mensaje lo escribió una persona", text: "Lo mandaste vos desde el panel: así responde tu equipo cuando toma una conversación. Volvé a la pestaña «Panel» para seguir.", advance: t.step === "chat-see" ? "back-bot" : null, action: "Ir al panel" };
  }
  if (t.step === "chat-see") return { title: "Esperando tu mensaje…", text: "Cuando lo envíes desde el panel, aparece acá." };
  return { title: "El recorrido sigue en la pestaña «Panel»", text: "Volvé a esa pestaña para continuar.", action: "Ir al panel", small: true };
}
function tourCoach() {
  const t = tourGet();
  let card = document.getElementById("coach");
  if (!t || t.clinic !== clinicId || t.step === "fin" || t.step === "welcome") {
    card?.remove(); document.getElementById("coach-layer")?.remove(); cancelAnimationFrame(coach.raf); return;
  }
  const c = coachFor(t);
  if (c.advance && !document.hidden) setTimeout(() => { if (tourGet()?.step === "chat-see") tourSet({ step: c.advance }); }, 0);
  if (!card) {
    card = document.createElement("div");
    card.id = "coach";
    card.className = "coach";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    document.body.appendChild(card);
  }
  card.classList.toggle("small", !!c.small);
  card.innerHTML = `<span class="coach-step">Recorrido guiado</span><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p>${c.action ? `<button type="button" class="coach-btn${c.small ? "" : " pulse"}" data-coach="panel">${esc(c.action)} ↗</button><p class="coach-hint" hidden>Si no cambió sola, tocá la pestaña <b>«Panel»</b> arriba, en la barra del navegador. ⬆</p>` : ""}`;
  coach.target = c.target ?? null;
  if (c.focus) setTimeout(() => input.focus(), 50);
  window.name = "chat-demo"; // así el panel puede traer esta pestaña al frente sin recargarla
  coachBlink(document.hidden && t.step === "chat-see" && !state.humanSeenShown);
  cancelAnimationFrame(coach.raf);
  coachFollow();
}
function coachFollow() {
  const card = document.getElementById("coach");
  if (!card) return;
  let layer = document.getElementById("coach-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "coach-layer";
    layer.innerHTML = '<div class="tl-hole"></div>' + ["t", "r", "b", "l"].map((k) => `<div class="tl-block" data-b="${k}"></div>`).join("");
    document.body.appendChild(layer);
  }
  const el = coach.target ? [...document.querySelectorAll(coach.target)].at(-1) : null;
  const W = innerWidth, H = innerHeight, pad = 6;
  const b = el?.getBoundingClientRect();
  // Si el elemento señalado quedó fuera de la pantalla (teléfono más alto que la ventana), se lo trae a la vista.
  if (el && b && b.width && (b.bottom > H - 8 || b.top < 0) && coach.scrolledTo !== el) {
    coach.scrolledTo = el;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const r = b && b.width ? { x: Math.max(0, b.left - pad), y: Math.max(0, b.top - pad), w: b.width + pad * 2, h: b.height + pad * 2 } : null;
  layer.classList.toggle("no-target", !r);
  layer.classList.toggle("off", card.classList.contains("small"));
  if (r) {
    Object.assign(layer.querySelector(".tl-hole").style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const set = (k, css) => Object.assign(layer.querySelector(`[data-b="${k}"]`).style, css);
    set("t", { left: "0", top: "0", width: "100%", height: `${r.y}px` });
    set("b", { left: "0", top: `${r.y + r.h}px`, width: "100%", height: `${Math.max(0, H - r.y - r.h)}px` });
    set("l", { left: "0", top: `${r.y}px`, width: `${r.x}px`, height: `${r.h}px` });
    set("r", { left: `${r.x + r.w}px`, top: `${r.y}px`, width: `${Math.max(0, W - r.x - r.w)}px`, height: `${r.h}px` });
  }
  // La tarjeta va al costado del teléfono (o arriba/abajo en pantallas angostas).
  const phone = document.querySelector(".phone")?.getBoundingClientRect();
  const cw = card.offsetWidth, ch = card.offsetHeight;
  if (phone && phone.right + cw + 32 < W) {
    card.style.left = `${phone.right + 24}px`;
    card.style.top = `${Math.min(Math.max(16, (r?.y ?? phone.top + 120) - 20), H - ch - 16)}px`;
  } else {
    card.style.left = `${Math.max(8, (W - cw) / 2)}px`;
    card.style.top = `${r && r.y > H / 2 ? 12 : H - ch - 12}px`;
  }
  coach.raf = requestAnimationFrame(coachFollow);
}
/** Título que parpadea en esta pestaña cuando hay que venir a mirarla. */
function coachBlink(on) {
  clearInterval(coach.blink);
  const base = "Chat del paciente · demo";
  document.title = base;
  if (!on) return;
  let alt = false;
  coach.blink = setInterval(() => { alt = !alt; document.title = alt ? `👉 Mirá acá · ${base}` : base; }, 900);
}
document.body.addEventListener("click", (e) => {
  const b = e.target.closest("[data-coach]");
  if (!b) return;
  // Trae al frente la pestaña del panel sin recargarla (se llama «panel-demo»); si se cerró, la abre.
  try {
    const w = window.open("", "panel-demo");
    if (w && w.location.href === "about:blank") w.location.href = "/panel#bandeja";
    w?.focus();
  } catch { window.open("/panel#bandeja", "panel-demo"); }
  // Por si el navegador no cambia de pestaña solo: se indica dónde tocar.
  const hint = b.parentElement.querySelector(".coach-hint");
  if (hint) hint.hidden = false;
  b.textContent = "Volvé a la pestaña «Panel» ⬆";
});
addEventListener("storage", (e) => { if (e.key === TOUR_KEY) tourCoach(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { tourCoach(); return; }
  if (state.humanSeen) state.humanSeenShown = true;
  pollOutbox();
  tourCoach();
});
