// Panel del consultorio: secciones en pestañas sobre la API /api/panel (siempre con la clínica elegida).
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => esc(s).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>");
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
};
const usd = (n, d = 4) => (n ? `USD ${n.toFixed(d)}` : "USD 0");
const ms = (n) => `${(n / 1000).toFixed(2)} s`;
const int = (n) => Number(n ?? 0).toLocaleString("es");
const pct = (x) => `${Math.round((x ?? 0) * 100)} %`;
const CH = { whatsapp: "WhatsApp", web: "Simulador", cli: "Consola", test: "Prueba" };
const STATUS = {
  confirmada: ["Confirmada", "ok"], pendiente: ["Pendiente", "wait"], cancelada: ["Cancelada", "bad"],
  reprogramada: ["Reprogramada", "muted"], asistio: ["Asistió", "info"], ausente: ["Ausente", "wait"],
};
const CONV = { bot: ["Bot", "info"], persona: ["Con una persona", "wait"], pausada: ["Bot en pausa", "muted"] };
const ROLE = { admin: "Admin", recepcion: "Recepción" };
const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
// Paleta de los gráficos (validada para la superficie oscura del panel): serie 1 azul, serie 2 naranja.
const SERIES = ["#3987e5", "#d95926"];

const state = { date: null, openConv: null, clinic: null, role: null, view: "resumen", convFilter: "todas", patFilter: "todos", statsDays: 30, weekFrom: null, knowledge: null, canEdit: false, testerSession: null };

/** Todas las llamadas llevan la clínica elegida (el servidor verifica que sea del usuario). */
async function api(path, opts) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`/api/panel${path}${state.clinic ? `${sep}clinic=${encodeURIComponent(state.clinic)}` : ""}`, opts);
  if (r.status === 401) { location.href = "/panel"; throw new Error("Sesión vencida"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

let toastT;
function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2800);
}
const stamp = () => ($("#updated").textContent = `actualizado ${new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`);
function sectionOf(sel) {
  return $(sel).closest("section.card, .card") ?? $(sel);
}
const initials = (name) => name.replace(/[^\p{L} ]/gu, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

// =====================================================================
// Pestañas
// =====================================================================
const loaders = {
  resumen: () => loadSummary(),
  conversaciones: () => loadInbox(),
  agenda: () => loadAgenda(),
  pacientes: () => loadPatients(),
  estadisticas: () => loadStats(),
  costos: () => loadCosts(),
  aprendizaje: () => loadLearning(),
  guia: async () => {},
};

function showView(name) {
  if (!loaders[name] || ($(`.tabs [data-view="${name}"]`)?.hidden)) name = "resumen";
  state.view = name;
  for (const b of $$(".tabs button")) b.classList.toggle("on", b.dataset.view === name);
  for (const v of $$("main .view")) v.hidden = v.dataset.view !== name;
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  loaders[name]().catch((e) => toast(e.message, true));
}
addEventListener("hashchange", () => {
  const v = location.hash.slice(1);
  if (v && v !== state.view) { closeConv(); showView(v); }
});
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) showView(b.dataset.view);
});

/** Segmentos de filtros (botones con data-f o data-d). */
function segment(sel, onPick) {
  $(sel).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    for (const x of $(sel).querySelectorAll("button")) x.classList.toggle("on", x === b);
    onPick(b.dataset.f ?? b.dataset.d);
  });
}

// =====================================================================
// Resumen
// =====================================================================
async function loadSummary() {
  const d = await api(`/summary${state.date ? `?date=${state.date}` : ""}`);
  state.date ??= d.date;
  $("#date").value = d.date;
  stamp();
  renderKpis(d);
  renderAppts(d);
  renderConvs("#convs", d.conversations.slice(0, 8).map((c) => ({ ...c, status: c.handedOff ? "persona" : "bot" })));
  renderHandoffs(d.handoffs);
  renderLeads(d.leads);
  renderMetrics(d.metrics);
  renderTests(d.tests);
}

function renderKpis({ kpis: k, metrics: m }) {
  const items = [
    ["Citas del día", k.appointmentsToday, `${k.confirmedToday} confirmadas`],
    ["Próximos 7 días", k.next7Days, "turnos activos"],
    ["Cancelaciones del día", k.cancelledToday, "horarios liberados"],
    ["Derivaciones abiertas", k.openHandoffs, "esperan a una persona", k.openHandoffs > 0],
    ["Leads sin turno", k.leadsWithoutAppointment, "de las promos"],
  ];
  // Tiempos y costos: solo para el admin.
  if (m) items.push(
    ["Respuesta (mediana)", m.turns ? ms(m.medianLatencyMs) : "—", m.turns ? `p95 ${ms(m.p95LatencyMs)}` : "sin datos"],
    ["Costo por conversación", m.turns ? usd(m.avgCostPerConversation) : "—", m.provider],
  );
  $("#kpis").innerHTML = kpiHtml(items);
}
const kpiHtml = (items) => items.map(([l, v, s, alert]) =>
  `<div class="kpi${alert ? " alert" : ""}"><span>${esc(l)}</span><strong>${esc(v)}</strong><small>${esc(s ?? "")}</small></div>`).join("");

function renderAppts({ appointments: list, date }) {
  $("#appt-hint").textContent = new Date(`${date}T12:00:00`).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  if (!list.length) {
    $("#appts").innerHTML = `<tr><td class="empty">No hay citas este día.</td></tr>`;
    return;
  }
  $("#appts").innerHTML = `
    <tr><th>Hora</th><th>Paciente</th><th>Tratamiento</th><th>Estado</th><th>Asistencia</th><th>Recordatorios</th><th>Canal</th></tr>
    ${list.map((a) => {
      const [label, cls] = STATUS[a.status] ?? [a.status, "muted"];
      const active = a.status === "confirmada" || a.status === "pendiente";
      return `<tr>
        <td class="time">${esc(a.time)}</td>
        <td>${esc(a.patient)}<div class="ch">${esc(a.phone)}</div></td>
        <td>${esc(a.treatment)}</td>
        <td><span class="pill ${cls}">${label}</span></td>
        <td>${active ? (a.confirmed ? '<span class="pill ok">✓ Confirmó</span>' : '<span class="pill wait">Sin confirmar</span>') : "—"}</td>
        <td class="checks">24 h ${a.reminder24 ? "<b>✓</b>" : "·"} &nbsp; 2 h ${a.reminder2 ? "<b>✓</b>" : "·"}</td>
        <td class="ch">${esc(CH[a.channel] ?? a.channel)}</td>
      </tr>`;
    }).join("")}`;
}

function renderConvs(sel, list) {
  $(sel).innerHTML = list.length ? list.map((c) => {
    const name = c.patient ?? c.phone ?? "Paciente";
    const [label, cls] = CONV[c.status] ?? CONV.bot;
    return `<li class="conv" data-id="${esc(c.id)}">
      <div class="avatar">${esc(initials(name))}</div>
      <div style="min-width:0"><div class="who">${esc(name)} <span class="ch">· ${esc(CH[c.channel] ?? c.channel)}${c.source ? ` · ${esc(c.source)}` : ""}</span></div>
        <div class="last">${c.waiting ? '<span class="waiting">● Espera respuesta · </span>' : ""}${esc(c.lastText)}</div></div>
      <div class="meta">${ago(c.lastAt)}<span class="pill ${cls}">${label}</span></div>
    </li>`;
  }).join("") : `<li class="empty">No hay conversaciones para mostrar.</li>`;
}

function renderHandoffs(list) {
  const open = list.filter((h) => h.status === "abierta").length;
  const badge = $("#ho-count");
  badge.textContent = open;
  badge.classList.toggle("zero", !open);
  const REASON = { pedido_del_paciente: "Pidió una persona", consulta_clinica: "Consulta clínica", urgencia: "Urgencia", queja: "Queja", sin_informacion: "Sin información", tomada_desde_panel: "Tomada desde el panel", otro: "Otro" };
  $("#handoffs").innerHTML = list.length ? list.slice(0, 12).map((h) => `
    <li class="ho ${h.status === "abierta" ? "open" : ""}">
      <div class="row"><strong>${esc(h.patient || "Paciente")}</strong>
        <span class="pill ${h.status === "abierta" ? (h.reason === "urgencia" ? "bad" : "wait") : "muted"}">${esc(REASON[h.reason] ?? h.reason)}</span></div>
      <p>${esc(h.summary)}</p>
      <div class="row"><span class="ch">${esc(CH[h.channel] ?? "")} · ${ago(h.createdAt)}</span>
        <div class="btns">
          <button class="btn ghost small" data-open="${esc(h.conversationId)}">Ver chat</button>
          ${h.status === "abierta" ? `<button class="btn small" data-resolve="${esc(h.id)}">Resuelta → vuelve al bot</button>` : '<span class="pill muted">Resuelta</span>'}
        </div></div>
    </li>`).join("") : `<li class="empty">Sin derivaciones.</li>`;
}

function renderLeads(list) {
  $("#leads").innerHTML = list.length ? list.slice(0, 10).map((l) => `
    <li class="lead"><div><strong>${esc(l.name ?? l.phone)}</strong><br><small>${esc(CH[l.channel] ?? l.channel)} · ${esc(l.source ?? "")} · ${ago(l.lastContact)}</small></div>
      <div>${l.followupSent ? '<span class="pill ok">Seguimiento enviado</span>' : '<span class="pill wait">Pendiente</span>'}</div></li>`).join("")
    : `<li class="empty">No hay leads pendientes.</li>`;
}

function renderMetrics(m) {
  sectionOf("#metrics").hidden = !m;
  if (!m) return;
  $("#m-provider").textContent = m.provider;
  const items = [
    ["Mensajes respondidos", m.turns],
    ["Respuesta mediana", m.turns ? ms(m.medianLatencyMs) : "—"],
    ["Respuesta p95", m.turns ? ms(m.p95LatencyMs) : "—"],
    ["Costo por mensaje", m.turns ? usd(m.avgCostPerTurn) : "—"],
  ];
  $("#metrics").innerHTML = items.map(([l, v]) => `<div class="metric"><span>${l}</span><strong>${esc(v)}</strong></div>`).join("");
}

function renderTests(runs) {
  sectionOf("#tests").hidden = state.role !== "admin";
  if (!runs?.length) {
    $("#tests").innerHTML = `<p class="empty">Todavía no se corrieron. Ejecute <code>npm run test:cases</code>.</p>`;
    return;
  }
  $("#tests").innerHTML = runs.map((r) => `
    <div class="test-run">
      <h4>${esc(r.provider)} — ${r.passed}/${r.total} OK <span>· respuesta media ${ms(r.avgTurnMs)} · costo/conversación ${usd(r.avgCostUsd)} · ${new Date(r.runAt).toLocaleString("es")}</span></h4>
      <div class="table-wrap"><table class="tbl">
        <tr><th>#</th><th>Caso</th><th>Esperado</th><th>Resultado</th><th>Mensajes</th><th>Tiempo medio</th></tr>
        ${r.cases.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.name)}</td><td class="ch">${esc(c.expected)}</td>
          <td>${c.passed ? '<span class="pill ok">✓ OK</span>' : `<span class="pill bad">✕ ${esc(c.details)}</span>`}</td>
          <td>${c.turns}</td><td>${ms(c.avgTurnMs)}</td></tr>`).join("")}
      </table></div>
    </div>`).join("");
}

// =====================================================================
// Conversaciones: bandeja + detalle con traspaso y pausa
// =====================================================================
let qTimer;
async function loadInbox() {
  const q = $("#conv-q").value.trim();
  const d = await api(`/conversations?estado=${state.convFilter}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  renderConvs("#inbox", d.conversations);
  stamp();
}
async function refreshWaiting() {
  try {
    const d = await api("/conversations?estado=esperando");
    const n = d.conversations.length;
    $("#tab-waiting").textContent = n;
    $("#tab-waiting").classList.toggle("zero", !n);
  } catch {}
}
segment("#conv-filter", (f) => { state.convFilter = f; loadInbox(); });
$("#conv-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(loadInbox, 250); });

async function openConv(id) {
  state.openConv = id;
  let c;
  try { c = await api(`/conversation/${encodeURIComponent(id)}`); } catch (e) { return toast(e.message, true); }
  $("#d-title").textContent = c.patient.name ?? c.patient.phone ?? "Paciente";
  $("#d-sub").textContent = `${CH[c.channel] ?? c.channel}${c.patient.source ? ` · ${c.patient.source}` : ""} · ${c.patient.phone}`;
  const [label, cls] = CONV[c.status] ?? CONV.bot;
  $("#d-actions").innerHTML = `<span class="state pill ${cls}">${label}</span>` + (c.status === "bot"
    ? `<button class="btn small" data-act="takeover">🙋 Tomar conversación</button><button class="btn ghost small" data-act="pause">⏸ Pausar bot</button>`
    : c.status === "pausada"
      ? `<button class="btn small" data-act="resume">▶ Reanudar bot</button><button class="btn ghost small" data-act="takeover">🙋 Tomar conversación</button>`
      : `<button class="btn small" data-act="release">🤖 Devolver al bot</button>`);
  $("#d-appts").innerHTML = c.appointments.length
    ? c.appointments.map((a) => { const [l, k] = STATUS[a.status] ?? [a.status, "muted"]; return `<span class="pill ${k}">${esc(a.when)} · ${l}${a.confirmed ? " ✓" : ""}</span>`; }).join("")
    : '<span class="ch">Sin turnos</span>';
  renderThread("#thread", c.messages);
  $("#drawer").classList.add("show");
  $("#drawer-bg").classList.add("show");
}
function renderThread(sel, messages) {
  const TAG = { reminder24: "⏰ Recordatorio 24 h", reminder2: "⏰ Recordatorio 2 h", followup: "📣 Seguimiento" };
  $(sel).innerHTML = messages.map((m) => `
    <div class="b ${m.role}">${m.meta ? `<span class="tag">${TAG[m.meta.kind] ?? ""}</span><br>` : m.role === "human" ? '<span class="tag">👩‍⚕️ Recepción</span><br>' : ""}${fmt(m.text)}
      ${m.at ? `<small>${new Date(m.at).toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</small>` : ""}</div>`).join("");
  $(sel).scrollTop = $(sel).scrollHeight;
}
function closeConv() {
  state.openConv = null;
  $("#drawer").classList.remove("show");
  $("#drawer-bg").classList.remove("show");
}
const refreshCurrent = () => loaders[state.view]?.().catch(() => {});

$("#d-actions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !state.openConv) return;
  b.disabled = true;
  const id = encodeURIComponent(state.openConv);
  const MSG = { takeover: "Conversación tomada: el asistente deja de responder", release: "La conversación volvió al asistente", pause: "Asistente en pausa en esta conversación", resume: "Asistente reanudado" };
  try {
    if (b.dataset.act === "takeover") await post(`/conversation/${id}/takeover`);
    if (b.dataset.act === "release") await post(`/conversation/${id}/release`);
    if (b.dataset.act === "pause") await post(`/conversation/${id}/pause`, { paused: true });
    if (b.dataset.act === "resume") await post(`/conversation/${id}/pause`, { paused: false });
    toast(MSG[b.dataset.act]);
    await openConv(state.openConv);
    refreshCurrent();
    refreshWaiting();
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

document.addEventListener("click", async (e) => {
  const conv = e.target.closest(".conv");
  if (conv) return openConv(conv.dataset.id);
  const open = e.target.closest("[data-open]");
  if (open) return openConv(open.dataset.open);
  const res = e.target.closest("[data-resolve]");
  if (res) {
    res.disabled = true;
    try {
      await post(`/handoff/${encodeURIComponent(res.dataset.resolve)}/resolve`, { returnToBot: true });
      toast("Derivación resuelta: la conversación vuelve al asistente");
      refreshCurrent();
      refreshWaiting();
    } catch (err) { toast(err.message, true); res.disabled = false; }
  }
});
$("#d-close").addEventListener("click", closeConv);
$("#drawer-bg").addEventListener("click", closeConv);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeConv());
$("#reply").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#reply-text").value.trim();
  if (!text || !state.openConv) return;
  try {
    const r = await post(`/conversation/${encodeURIComponent(state.openConv)}/reply`, { text });
    $("#reply-text").value = "";
    toast(r.how === "omitido" ? "Guardado (ese canal no tiene envío activo)" : "Mensaje enviado al paciente");
    openConv(state.openConv);
  } catch (err) { toast(err.message, true); }
});
$("#date").addEventListener("change", (e) => { state.date = e.target.value; loadSummary(); });
$("#today").addEventListener("click", () => { state.date = null; loadSummary(); });

// =====================================================================
// Agenda semanal
// =====================================================================
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function loadAgenda() {
  const d = await api(`/agenda${state.weekFrom ? `?from=${state.weekFrom}` : ""}`);
  state.weekFrom = d.from;
  const days = Array.from({ length: 7 }, (_, i) => addDays(d.from, i));
  const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("es", { day: "numeric", month: "short", timeZone: "UTC" });
  $("#wk-label").textContent = `${fmtDay(days[0])} – ${fmtDay(days[6])}`;
  $("#week").innerHTML = days.map((iso, i) => {
    const list = d.appointments.filter((a) => a.date === iso);
    const open = d.hours.some((h) => h.weekday === i + 1);
    return `<div class="day${iso === d.today ? " today" : ""}${open ? "" : " closed"}">
      <h3>${DAYS[i]} <span>${fmtDay(iso)}</span></h3>
      ${list.length ? list.map((a) => {
        const [label, cls] = STATUS[a.status] ?? [a.status, "muted"];
        const active = a.status === "confirmada" || a.status === "pendiente";
        return `<div class="appt ${a.status}">
          <div><b>${esc(a.time)}</b> · ${esc(a.patient)}</div>
          <div class="tr">${esc(a.treatment)}</div>
          <div><span class="pill ${cls}">${label}</span>${a.confirmed && active ? ' <span class="pill ok">✓ confirmó</span>' : ""}</div>
          ${active ? `<div class="acts" data-appt="${esc(a.id)}"><button data-st="asistio">Asistió</button><button data-st="ausente">Ausente</button><button data-st="cancelada">Cancelar</button></div>` : ""}
        </div>`;
      }).join("") : `<span class="ch">${open ? "Sin turnos" : "Cerrado"}</span>`}
    </div>`;
  }).join("");
  stamp();
}
$("#week").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-st]");
  if (!b) return;
  const id = b.closest("[data-appt]").dataset.appt;
  if (b.dataset.st === "cancelada" && !confirm("¿Cancelar este turno? El horario se libera en el calendario.")) return;
  try {
    await post(`/appointment/${encodeURIComponent(id)}/status`, { status: b.dataset.st });
    toast(b.dataset.st === "cancelada" ? "Turno cancelado: horario liberado" : "Asistencia registrada");
    loadAgenda();
  } catch (err) { toast(err.message, true); }
});
$("#wk-prev").addEventListener("click", () => { state.weekFrom = addDays(state.weekFrom, -7); loadAgenda(); });
$("#wk-next").addEventListener("click", () => { state.weekFrom = addDays(state.weekFrom, 7); loadAgenda(); });
$("#wk-today").addEventListener("click", () => { state.weekFrom = null; loadAgenda(); });

// =====================================================================
// Pacientes y consultas
// =====================================================================
async function loadPatients() {
  const q = $("#pat-q").value.trim();
  const d = await api(`/patients?tipo=${state.patFilter}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  $("#patients").innerHTML = d.patients.length ? `
    <tr><th>Paciente</th><th>Tipo</th><th>Canal</th><th>Origen</th><th>Turnos</th><th>Próximo turno</th><th>Última visita</th><th>Último contacto</th><th></th></tr>
    ${d.patients.map((p) => `<tr>
      <td>${esc(p.name ?? "Sin nombre")}<div class="ch">${esc(p.phone)}</div></td>
      <td>${p.type === "paciente" ? '<span class="pill ok">Con turno</span>' : '<span class="pill wait">Consulta</span>'}</td>
      <td class="ch">${esc(CH[p.channel] ?? p.channel)}</td>
      <td class="ch">${esc(p.source ?? "—")}</td>
      <td>${p.appointments}${p.cancelled ? ` <span class="ch">(${p.cancelled} canc.)</span>` : ""}</td>
      <td>${esc(p.nextAppointment ?? "—")}</td>
      <td class="ch">${esc(p.lastVisit ?? "—")}</td>
      <td class="ch">${ago(p.lastContact)}</td>
      <td>${p.conversationId ? `<button class="btn ghost small" data-open="${esc(p.conversationId)}">Ver chat</button>` : ""}</td>
    </tr>`).join("")}` : `<tr><td class="empty">No hay pacientes para mostrar.</td></tr>`;
  stamp();
}
segment("#pat-filter", (f) => { state.patFilter = f; loadPatients(); });
$("#pat-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(loadPatients, 250); });

// =====================================================================
// Estadísticas (gráficos SVG propios, con tooltip)
// =====================================================================
const tip = $("#chart-tip");
function showTip(e, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
}
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(e, t.dataset.tip);
  else tip.hidden = true;
});
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Barras verticales por día; varias series se dibujan lado a lado. Una sola escala. */
function barChart(sel, daily, series) {
  const W = 640, H = 200, padL = 28, padB = 22, padT = 8;
  const max = Math.max(1, ...daily.flatMap((d) => series.map((s) => d[s.key])));
  const nice = max <= 5 ? max : Math.ceil(max / 5) * 5;
  const slot = (W - padL) / daily.length;
  const gap = 2;
  const bw = Math.max(2, (slot - 4) / series.length - gap);
  const y = (v) => H - padB - (v / nice) * (H - padB - padT);
  const ticks = [0, nice / 2, nice].map((v) => Math.round(v));
  const labelEvery = Math.ceil(daily.length / 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(" y "))} por día">`;
  for (const t of ticks) svg += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`;
  daily.forEach((d, i) => {
    const x0 = padL + i * slot + 2;
    series.forEach((s, j) => {
      const v = d[s.key];
      if (!v) return;
      const x = x0 + j * (bw + gap), top = y(v), h = H - padB - top, r = Math.min(4, bw / 2, h);
      // Extremo de datos redondeado (4 px), anclado a la base.
      svg += `<path d="M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - padB} Z" fill="${s.color}"/>`;
    });
    svg += `<rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padB - padT}" data-tip="${esc(`<b>${dayLabel(d.date)}</b><br>${series.map((s) => `${s.label}: <b>${d[s.key]}</b>`).join("<br>")}`)}"/>`;
    if (i % labelEvery === 0) svg += `<text class="axis" x="${padL + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${new Date(`${d.date}T12:00:00Z`).toLocaleDateString("es", { day: "numeric", month: "numeric", timeZone: "UTC" })}</text>`;
  });
  $(sel).innerHTML = svg + "</svg>";
}

async function loadStats() {
  const s = await api(`/stats?days=${state.statsDays}`);
  $("#stats-kpis").innerHTML = kpiHtml([
    ["Consultas", int(s.totals.consultas), `últimos ${s.days} días`],
    ["Pacientes nuevos", int(s.totals.pacientesNuevos), `${int(s.conversion.leadsPromo)} por promos`],
    ["Turnos agendados", int(s.totals.turnosAgendados), "reservas nuevas"],
    ["Turnos cancelados", int(s.totals.turnosCancelados), "horarios liberados"],
    ["Conversión", pct(s.conversion.tasa), `${s.conversion.conTurno} de ${s.conversion.pacientesNuevos} nuevos reservaron`],
    ["Resueltas por el bot", s.resolucion.total ? pct(s.resolucion.bot / s.resolucion.total) : "—", `${s.resolucion.traspasadas} traspasadas`],
  ]);
  barChart("#ch-consultas", s.daily, [{ key: "consultas", label: "Consultas", color: SERIES[0] }]);
  barChart("#ch-turnos", s.daily, [
    { key: "turnosAgendados", label: "Agendados", color: SERIES[0] },
    { key: "turnosCancelados", label: "Cancelados", color: SERIES[1] },
  ]);
  $("#lg-turnos").innerHTML = `<span><i style="background:${SERIES[0]}"></i>Agendados</span><span><i style="background:${SERIES[1]}"></i>Cancelados</span>`;

  const r = s.resolucion;
  $("#res-hint").textContent = `${r.total} conversaciones`;
  $("#ch-resolucion").innerHTML = r.total ? `
    <div class="split">
      ${r.bot ? `<div style="flex:${r.bot};background:${SERIES[0]}" data-tip="${esc(`Resueltas por el bot: <b>${r.bot}</b> (${pct(r.bot / r.total)})`)}"></div>` : ""}
      ${r.traspasadas ? `<div style="flex:${r.traspasadas};background:${SERIES[1]}" data-tip="${esc(`Traspasadas a una persona: <b>${r.traspasadas}</b> (${pct(r.traspasadas / r.total)})`)}"></div>` : ""}
    </div>
    <div class="legend"><span><i style="background:${SERIES[0]}"></i>Bot ${r.bot} · ${pct(r.bot / r.total)}</span><span><i style="background:${SERIES[1]}"></i>Persona ${r.traspasadas} · ${pct(r.traspasadas / r.total)}</span></div>`
    : '<p class="empty">Sin conversaciones en el período.</p>';

  const maxT = Math.max(1, ...s.tratamientos.map((t) => t.count));
  $("#ch-tratamientos").innerHTML = s.tratamientos.length ? s.tratamientos.map((t) => `
    <div class="hbar" data-tip="${esc(`${t.name}: <b>${t.count}</b> turnos`)}"><span>${esc(t.name)}</span>
      <div class="track"><div class="fill" style="width:${(t.count / maxT) * 100}%;background:${SERIES[0]}"></div></div><span class="v">${t.count}</span></div>`).join("")
    : '<p class="empty">Sin turnos en el período.</p>';

  $("#stats-table").innerHTML = `<tr><th>Día</th><th>Consultas</th><th>Pacientes nuevos</th><th>Agendados</th><th>Cancelados</th></tr>` +
    [...s.daily].reverse().map((d) => `<tr><td>${dayLabel(d.date)}</td><td>${d.consultas}</td><td>${d.pacientesNuevos}</td><td>${d.turnosAgendados}</td><td>${d.turnosCancelados}</td></tr>`).join("");
  stamp();
}
segment("#stats-range", (d) => { state.statsDays = Number(d); loadStats(); });

// =====================================================================
// Costos (solo admin)
// =====================================================================
async function loadCosts() {
  const c = await api("/costs");
  $("#cost-provider").textContent = `IA actual: ${c.provider}`;
  const note = $("#cost-note");
  note.hidden = !(c.onlyMock || !c.months.length);
  note.textContent = c.months.length
    ? "Hasta ahora respondió el modo sin IA (reglas), que no tiene costo. Con LLM_PROVIDER=claude u openai, cada mensaje registra sus tokens y su costo."
    : "Todavía no hay mensajes registrados en esta clínica.";
  const m = c.currentMonth;
  const monthName = new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString("es", { month: "long", year: "numeric", timeZone: "UTC" });
  $("#cost-kpis").innerHTML = kpiHtml([
    ["Costo del mes", usd(m.costToDate), `${monthName} · día ${Math.ceil(m.daysElapsed)} de ${m.daysInMonth}`],
    ["Proyección a fin de mes", usd(m.projectedCost), `si sigue el ritmo actual`],
    ["Conversaciones del mes", int(m.conversations), `proyección ${int(m.projectedConversations)}`],
    ["Costo por conversación", m.conversations ? usd(m.costToDate / m.conversations) : "—", "promedio del mes"],
  ]);
  $("#cost-months").innerHTML = c.months.length ? `<tr><th>Mes</th><th>Conversaciones</th><th>Mensajes</th><th>Tokens entrada</th><th>Tokens salida</th><th>Caché</th><th>Costo</th><th>Por conversación</th></tr>` +
    c.months.map((r) => `<tr><td>${esc(r.month)}</td><td>${int(r.conversations)}</td><td>${int(r.turns)}</td><td>${int(r.inputTokens)}</td><td>${int(r.outputTokens)}</td><td>${int(r.cacheReadTokens)}</td><td>${usd(r.costUsd)}</td><td>${usd(r.costPerConversation)}</td></tr>`).join("")
    : `<tr><td class="empty">Sin datos.</td></tr>`;
  $("#cost-models").innerHTML = c.byModel.length ? `<tr><th>Proveedor · modelo</th><th>Mensajes</th><th>Costo</th></tr>` +
    c.byModel.map((r) => `<tr><td>${esc(r.model)}</td><td>${int(r.turns)}</td><td>${usd(r.costUsd)}</td></tr>`).join("")
    : `<tr><td class="empty">Sin datos.</td></tr>`;
  stamp();
}

// =====================================================================
// Aprendizaje: conocimiento, documentos y probador
// =====================================================================
const form = $("#kb-form");
async function loadLearning() {
  const [k, docs] = await Promise.all([api("/knowledge"), api("/documents")]);
  state.knowledge = k.knowledge;
  state.canEdit = k.canEdit;
  fillKnowledge(k.knowledge);
  form.setAttribute("aria-disabled", String(!k.canEdit));
  for (const el of form.querySelectorAll("input, textarea, button")) el.disabled = !k.canEdit;
  $("#kb-mode").textContent = k.canEdit ? "Puede editar (admin)" : "Solo lectura: lo edita el admin. El probador sí lo puede usar.";
  $("#doc-upload").hidden = !docs.canEdit;
  renderDocs(docs.documents, docs.canEdit);
  if (!state.testerSession) newTester();
  stamp();
}

function fillKnowledge(k) {
  const set = (name, v) => { form.elements[name].value = v ?? ""; };
  for (const f of ["name", "phone", "address", "reference", "email", "payments", "insurance", "hoursText", "cancellationPolicy", "emergencies", "tone"]) set(f, k[f]);
  set("professionals", (k.professionals ?? []).join("\n"));
  set("promoName", k.promo?.name);
  set("promoDetail", k.promo?.detail);
  $("#kb-hours").innerHTML = DAYS.map((d, i) => {
    const h = (k.hours ?? []).find((x) => x.weekday === i + 1);
    const v = h ? h.blocks.map(([a, b]) => `${a}-${b}`).join(", ") : "";
    return `<span>${d}</span><input data-weekday="${i + 1}" value="${esc(v)}" placeholder="Cerrado · ej.: 09:00-13:00, 14:00-18:00" />`;
  }).join("");
  $("#kb-treatments").innerHTML = "";
  for (const t of k.treatments ?? []) addTreatment(t);
  $("#kb-faq").innerHTML = "";
  for (const f of k.faq ?? []) addFaq(f);
}
function addTreatment(t = {}) {
  const row = document.createElement("div");
  row.className = "row-t";
  row.innerHTML = `<input data-k="name" placeholder="Tratamiento" value="${esc(t.name)}" /><input data-k="price" placeholder="Precio" value="${esc(t.price)}" />
    <input data-k="duration" placeholder="Duración" value="${esc(t.duration)}" /><input data-k="notes" placeholder="Notas" value="${esc(t.notes)}" />
    <button type="button" class="del" aria-label="Quitar">✕</button>`;
  $("#kb-treatments").append(row);
}
function addFaq(f = {}) {
  const row = document.createElement("div");
  row.className = "row-f";
  row.innerHTML = `<input data-k="q" placeholder="Pregunta" value="${esc(f.q)}" /><input data-k="a" placeholder="Respuesta" value="${esc(f.a)}" />
    <button type="button" class="del" aria-label="Quitar">✕</button>`;
  $("#kb-faq").append(row);
}
$("#add-treatment").addEventListener("click", () => addTreatment());
$("#add-faq").addEventListener("click", () => addFaq());
form.addEventListener("click", (e) => { const d = e.target.closest(".del"); if (d && state.canEdit) d.parentElement.remove(); });

function readKnowledge() {
  const v = (n) => form.elements[n].value.trim();
  const rows = (sel) => [...$(sel).children].map((r) => Object.fromEntries([...r.querySelectorAll("input")].map((i) => [i.dataset.k, i.value.trim()])));
  const hours = [];
  for (const inp of $("#kb-hours").querySelectorAll("input")) {
    const txt = inp.value.trim();
    if (!txt) continue;
    const blocks = txt.split(/[,;]/).map((b) => b.trim()).filter(Boolean).map((b) => b.split(/\s*[-–a]\s*/).map((x) => x.padStart(5, "0")));
    hours.push({ weekday: Number(inp.dataset.weekday), blocks });
  }
  return {
    ...state.knowledge,
    name: v("name"), phone: v("phone"), address: v("address"), reference: v("reference"), email: v("email"),
    payments: v("payments"), insurance: v("insurance"), hoursText: v("hoursText"),
    cancellationPolicy: v("cancellationPolicy"), emergencies: v("emergencies"), tone: v("tone") || undefined,
    professionals: v("professionals").split("\n").map((x) => x.trim()).filter(Boolean),
    promo: { name: v("promoName"), detail: v("promoDetail") },
    hours,
    treatments: rows("#kb-treatments").filter((t) => t.name).map((t) => ({ name: t.name, price: t.price || "consultar", duration: t.duration || "30 min", notes: t.notes || "" })),
    faq: rows("#kb-faq").filter((f) => f.q && f.a),
  };
}
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.canEdit) return;
  const btn = $("#kb-save");
  btn.disabled = true;
  try {
    const k = readKnowledge();
    await api("/knowledge", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ knowledge: k }) });
    state.knowledge = k;
    toast("Guardado: el asistente ya responde con estos datos");
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

function renderDocs(list, canEdit) {
  $("#docs").innerHTML = list.length ? list.map((d) => `<li><div>📄 <b>${esc(d.name)}</b><div class="ch">${(d.sizeBytes / 1024).toFixed(0)} KB · ${d.chunks} fragmentos · ${ago(d.createdAt)}</div></div>
    ${canEdit ? `<button class="btn ghost small" data-del-doc="${esc(d.id)}">Quitar</button>` : ""}</li>`).join("")
    : '<li class="empty">Todavía no hay documentos.</li>';
}
$("#doc-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast("El archivo supera los 8 MB", true);
  const up = $("#doc-upload");
  up.classList.add("busy");
  up.querySelector("span").textContent = "Procesando…";
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const r = await post("/documents", { name: file.name, mime: file.type, dataBase64: btoa(bin) });
    toast(`Documento cargado: ${r.document.chunks} fragmentos para la búsqueda`);
    const docs = await api("/documents");
    renderDocs(docs.documents, docs.canEdit);
  } catch (err) { toast(err.message, true); }
  up.classList.remove("busy");
  up.querySelector("span").textContent = "📄 Subir documento";
});
$("#docs").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del-doc]");
  if (!b || !confirm("¿Quitar este documento? El asistente dejará de usarlo.")) return;
  try {
    await api(`/documents/${encodeURIComponent(b.dataset.delDoc)}`, { method: "DELETE" });
    const docs = await api("/documents");
    renderDocs(docs.documents, docs.canEdit);
  } catch (err) { toast(err.message, true); }
});
$("#doc-search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#doc-q").value.trim();
  if (!q) return;
  const r = await api(`/documents/search?q=${encodeURIComponent(q)}`);
  $("#doc-results").innerHTML = r.results.length
    ? r.results.map((h) => `<div class="hit-doc"><b>${esc(h.name)}</b>\n${esc(h.content.slice(0, 400))}${h.content.length > 400 ? "…" : ""}</div>`).join("")
    : '<p class="empty">No encontró nada para esa búsqueda.</p>';
});

function newTester() {
  state.testerSession = `t${Math.random().toString(36).slice(2, 10)}`;
  $("#tester-thread").innerHTML = '<div class="b system">Escriba un mensaje para probar al asistente.</div>';
  $("#tester-tools").textContent = "";
}
$("#tester-reset").addEventListener("click", newTester);
$("#tester-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#tester-text");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const th = $("#tester-thread");
  th.insertAdjacentHTML("beforeend", `<div class="b patient">${fmt(text)}</div><div class="b system" id="tester-wait">escribiendo…</div>`);
  th.scrollTop = th.scrollHeight;
  try {
    const r = await post("/tester", { text, session: state.testerSession });
    $("#tester-wait")?.remove();
    for (const m of r.messages) th.insertAdjacentHTML("beforeend", `<div class="b bot">${fmt(m)}</div>`);
    if (!r.messages.length) th.insertAdjacentHTML("beforeend", '<div class="b system">(sin respuesta)</div>');
    $("#tester-tools").textContent = r.tools.length ? `Herramientas usadas: ${r.tools.join(", ")}` : "Respondió sin herramientas";
  } catch (err) {
    $("#tester-wait")?.remove();
    th.insertAdjacentHTML("beforeend", `<div class="b system">${esc(err.message)}</div>`);
  }
  th.scrollTop = th.scrollHeight;
});

// =====================================================================
// Inicio: usuario, clínicas y rol
// =====================================================================
async function init() {
  const me = await api("/me");
  let saved = null;
  try { saved = localStorage.getItem("panel-clinic"); } catch {}
  state.clinic = me.clinics.some((c) => c.id === saved) ? saved : me.clinics[0]?.id ?? null;
  const sel = $("#clinic");
  sel.innerHTML = me.clinics.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  sel.value = state.clinic ?? "";
  $("#clinic-pick").hidden = me.clinics.length < 2;
  const applyClinic = () => {
    const c = me.clinics.find((x) => x.id === state.clinic);
    state.role = c?.role ?? null;
    $("#who").textContent = `${me.email} · ${ROLE[state.role] ?? ""}`;
    $("#clinic-name").textContent = c?.name ?? "";
    document.title = `Panel · ${c?.name ?? ""}`;
    $("#open-sim").href = `/?clinica=${encodeURIComponent(state.clinic ?? "")}`;
    for (const b of $$(".tabs [data-admin]")) b.hidden = state.role !== "admin";
  };
  applyClinic();
  sel.addEventListener("change", () => {
    state.clinic = sel.value;
    try { localStorage.setItem("panel-clinic", state.clinic); } catch {}
    Object.assign(state, { date: null, weekFrom: null, testerSession: null, openConv: null });
    closeConv();
    applyClinic();
    showView(state.view);
    refreshWaiting();
  });
  showView(location.hash.slice(1) || "resumen");
  refreshWaiting();
  // Refresco automático de las vistas en vivo (no mientras se lee una conversación o se edita).
  setInterval(() => {
    if (state.openConv) return;
    if (["resumen", "conversaciones", "agenda"].includes(state.view)) refreshCurrent();
    refreshWaiting();
  }, 15000);
}
init().catch((e) => ($("#updated").textContent = `error: ${e.message}`));
