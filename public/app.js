// Simulador web: imita un chat de WhatsApp y muestra la agenda en vivo.
// Habla con el mismo motor del bot que usa WhatsApp, a través de /api/chat.

const $ = (s) => document.querySelector(s);
const chat = $("#chat");
const input = $("#input");
const sendBtn = $("#send");
const params = new URLSearchParams(location.search);
const source = params.get("source") ?? "promo-noviembre";

const state = {
  sessionId: null,
  busy: false,
  lastSide: null,
  totalCost: 0,
  weekFrom: null,     // lunes de la semana visible (YYYY-MM-DD)
  prevAgenda: null,   // Map slot -> {kind, id} del render anterior
  provider: "",
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
  el.innerHTML = `${fmt(text)}<span class="meta">${hhmm()}${side === "out" ? TICKS : ""}</span>`;
  chat.appendChild(el);
  state.lastSide = side;
  chat.scrollTop = chat.scrollHeight;
  return el;
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
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, text, source }),
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
      bubble(m, "in", { notice: isNotice });
    }
    showMetrics(data);
    // Resaltar en la agenda lo que cambió en este mensaje (reserva, cancelación o cambio).
    const tools = data.tools ?? [];
    const added = [...tools].reverse().find((t) => t.when)?.when ?? null;
    const freed = [...tools].reverse().find((t) => t.freed)?.freed ?? null;
    if (added || freed) {
      state.weekFrom = mondayOf((added ?? freed).slice(0, 10));
      await loadAgenda({ mark: { added, freed } });
    }
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
    data = await (await fetch(url)).json();
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
$("#btn-new").addEventListener("click", newSession);
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
    const cfg = await (await fetch("/api/config")).json();
    state.provider = cfg.provider;
    $("#wa-name").textContent = cfg.clinic.replace("Clínica Dental ", "");
    const cal = cfg.calendar === "google" ? "Google Calendar" : "agenda en memoria";
    $("#agenda-source").innerHTML = `<span class="live-dot"></span> ${cal} · se actualiza con cada reserva`;
    $("#subtitle").textContent = `Demo con datos ficticios · IA: ${cfg.provider} · base: ${cfg.store}`;
  } catch {}
  if (params.get("modo") === "grabacion") $("#btn-rec").click();
  await newSession();
  await loadAgenda();
  setInterval(() => !state.busy && loadAgenda({ announce: true }), 20000); // refresca si alguien edita el calendario a mano
})();
