// Panel del consultorio: secciones en pestañas sobre la API /api/panel (siempre con la clínica elegida).
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => esc(s).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>");

// ---------------------------------------------------------------------
// Un solo formato de fechas en todo el panel: «mar 25/11», «14:30», «mar 25/11 14:30».
// Las fechas llegan en ISO (UTC) y se muestran en la zona horaria de la clínica.
// ---------------------------------------------------------------------
let TZ = undefined;
const parts = (iso) => new Date(iso);
const fTime = (iso) => parts(iso).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
const fDay = (iso) => {
  const d = parts(iso);
  const wd = d.toLocaleDateString("es", { weekday: "short", timeZone: TZ }).replace(".", "");
  const dm = d.toLocaleDateString("es", { day: "2-digit", month: "2-digit", timeZone: TZ });
  return `${wd} ${dm}`;
};
const fDateTime = (iso) => (iso ? `${fDay(iso)} ${fTime(iso)}` : "—");
const dayKeyOf = (iso) => parts(iso).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
/** Fecha corta para listas: «14:30» si es hoy, «ayer 14:30», o «mar 25/11». */
const fShort = (iso) => {
  if (!iso) return "—";
  const today = dayKeyOf(new Date().toISOString());
  const k = dayKeyOf(iso);
  if (k === today) return fTime(iso);
  const y = new Date(Date.now() - 864e5).toISOString();
  if (k === dayKeyOf(y)) return `ayer ${fTime(iso)}`;
  return fDay(iso);
};
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
};
const dateOnly = (ymd) => fDay(`${ymd}T12:00:00Z`);

const usd = (n, d = 4) => (n ? `USD ${n.toFixed(d)}` : "USD 0");
const ms = (n) => `${(n / 1000).toFixed(2)} s`;
const int = (n) => Number(n ?? 0).toLocaleString("es");
const pct = (x) => `${Math.round((x ?? 0) * 100)} %`;
const CH = { whatsapp: "WhatsApp", web: "Simulador", cli: "Consola", test: "Prueba" };
const STATUS = {
  confirmada: ["Confirmada", "ok"], pendiente: ["Pendiente", "wait"], cancelada: ["Cancelada", "bad"],
  reprogramada: ["Reprogramada", "muted"], asistio: ["Asistió", "info"], ausente: ["Ausente", "wait"],
};
const STATE = {
  esperando: ["Espera respuesta", "wait"], bot: ["Con el bot", "info"], persona: ["Con una persona", "ok"],
  pausada: ["Pausada", "muted"], cerrada: ["Cerrada", "muted"],
};
const FILTERS = [["activas", "Activas"], ["esperando", "Esperan respuesta"], ["bot", "Con el bot"], ["persona", "Con una persona"]];
const MORE_FILTERS = [["pausada", "Pausadas"], ["cerrada", "Cerradas"], ["todas", "Todas"]];
const ROLE = { admin: "Admin", recepcion: "Recepción" };
const REASON = { pedido_del_paciente: "Pidió una persona", consulta_clinica: "Consulta clínica", urgencia: "Urgencia", queja: "Queja", sin_informacion: "Sin información", tomada_desde_panel: "Tomada desde el panel", pausada: "Bot en pausa", otro: "Otro" };
const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
// Paleta de los gráficos (validada para la superficie oscura del panel): serie 1 azul, serie 2 naranja.
const SERIES = ["#3987e5", "#d95926"];

const state = {
  date: null, clinic: null, role: null, email: null, view: "bandeja",
  convFilter: "activas", showMore: false, openConv: null, convSig: "", profileDirty: false,
  patFilter: "todos", statsDays: 30, weekFrom: null, agDays: 7, agenda: null,
  knowledge: null, canEdit: false, testerSession: null,
};

/** Todas las llamadas llevan la clínica elegida (el servidor verifica que sea del usuario). */
async function api(path, opts) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`/api/panel${path}${state.clinic ? `${sep}clinic=${encodeURIComponent(state.clinic)}` : ""}`, opts);
  if (r.status === 401) { location.href = "/panel"; throw new Error("Sesión vencida"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const put = (path, body) => api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

let toastT;
function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2800);
}
const stamp = () => ($("#updated").textContent = `actualizado ${fTime(new Date().toISOString())}`);
const initials = (name) => String(name ?? "").replace(/[^\p{L} ]/gu, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const pill = ([label, cls]) => `<span class="pill ${cls}">${esc(label)}</span>`;
const statePill = (s) => pill(STATE[s] ?? [s, "muted"]);
const apptPill = (s) => pill(STATUS[s] ?? [s, "muted"]);
const empty = (text) => `<li class="empty">${esc(text)}</li>`;

// =====================================================================
// Pestañas
// =====================================================================
const loaders = {
  bandeja: () => loadInbox(),
  resumen: () => loadSummary(),
  agenda: () => loadAgenda(),
  profesionales: () => loadProfessionals(),
  pacientes: () => loadPatients(),
  seguimientos: () => loadFollowups(),
  estadisticas: () => loadStats(),
  costos: () => loadCosts(),
  aprendizaje: () => loadLearning(),
  guia: async () => {},
};

function showView(name) {
  if (!loaders[name] || ($(`.tabs [data-view="${name}"]`)?.hidden)) name = "bandeja";
  state.view = name;
  for (const b of $$(".tabs button")) b.classList.toggle("on", b.dataset.view === name);
  for (const v of $$("main .view")) v.hidden = v.dataset.view !== name;
  document.body.classList.toggle("inbox-mode", name === "bandeja");
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  loaders[name]().catch((e) => toast(e.message, true));
}
addEventListener("hashchange", () => {
  const v = location.hash.slice(1);
  if (v && v !== state.view) { closeDrawer(); showView(v); }
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

/** Abre una conversación en la bandeja (desde el resumen, la agenda o pacientes). */
function goToConversation(id) {
  closeDrawer();
  state.convFilter = "todas";
  state.showMore = true;
  state.openConv = id;
  showView("bandeja");
}

// =====================================================================
// Bandeja: lista · chat · ficha
// =====================================================================
let qTimer;
async function loadInbox() {
  const q = $("#conv-q").value.trim();
  const d = await api(`/conversations?filtro=${state.convFilter}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  renderFilters(d.counts);
  renderInboxList(d.conversations);
  setBadge(d.counts.esperando);
  stamp();
  if (state.openConv) await openConv(state.openConv, { keepScroll: true });
}

function renderFilters(counts) {
  const chip = ([f, label]) => `<button type="button" data-f="${f}" class="chip${state.convFilter === f ? " on" : ""}${f === "esperando" && counts[f] ? " alert" : ""}">${esc(label)} <span>${counts[f] ?? 0}</span></button>`;
  $("#conv-filter").innerHTML = FILTERS.map(chip).join("") + (state.showMore ? MORE_FILTERS.map(chip).join("") : "");
  $("#conv-more").textContent = state.showMore ? "Ocultar pausadas y cerradas" : `Ver pausadas y cerradas (${(counts.pausada ?? 0) + (counts.cerrada ?? 0)})`;
  $("#conv-more").setAttribute("aria-expanded", String(state.showMore));
}
$("#conv-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.convFilter = b.dataset.f;
  loadInbox().catch((err) => toast(err.message, true));
});
$("#conv-more").addEventListener("click", () => {
  state.showMore = !state.showMore;
  if (!state.showMore && MORE_FILTERS.some(([f]) => f === state.convFilter)) state.convFilter = "activas";
  loadInbox().catch((err) => toast(err.message, true));
});
$("#conv-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => loadInbox().catch(() => {}), 250); });

const WHO = { patient: "", bot: "Bot: ", human: "Recepción: " };
function renderInboxList(list) {
  $("#inbox").innerHTML = list.length ? list.map((c) => {
    const name = c.patient ?? c.phone ?? "Paciente";
    return `<li class="conv${c.id === state.openConv ? " on" : ""}${c.waiting ? " is-waiting" : ""}" data-id="${esc(c.id)}" tabindex="0">
      <div class="avatar">${esc(initials(name))}</div>
      <div class="conv-main">
        <div class="conv-top"><span class="who">${esc(name)}</span><span class="when">${esc(fShort(c.lastAt))}</span></div>
        <div class="last">${esc(WHO[c.lastRole] ?? "")}${esc(c.lastText)}</div>
        <div class="conv-meta">${statePill(c.state)}<span class="ch">${esc(CH[c.channel] ?? c.channel)}</span>${c.tags.slice(0, 2).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("")}</div>
      </div>
    </li>`;
  }).join("") : empty(state.convFilter === "esperando" ? "No hay conversaciones esperando respuesta. 🎉" : "No hay conversaciones con este filtro.");
}
$("#inbox").addEventListener("click", (e) => {
  const li = e.target.closest(".conv");
  if (li) openConv(li.dataset.id).catch((err) => toast(err.message, true));
});
$("#inbox").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.closest(".conv")) openConv(e.target.closest(".conv").dataset.id);
});

function setBadge(n) {
  $("#tab-waiting").textContent = n;
  $("#tab-waiting").classList.toggle("zero", !n);
}
async function refreshBadge() {
  try { setBadge((await api("/inbox/counts")).counts.esperando); } catch {}
}

async function openConv(id, { keepScroll = false } = {}) {
  const first = state.openConv !== id;
  state.openConv = id;
  for (const li of $$("#inbox .conv")) li.classList.toggle("on", li.dataset.id === id);
  $("#inbox-layout").dataset.pane = "chat";
  let c;
  try { c = await api(`/conversation/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); return; }
  if (state.openConv !== id) return;
  $("#chat-empty").hidden = true;
  $("#chat").hidden = false;
  const name = c.patient?.displayName ?? c.patient?.channelId ?? "Paciente";
  $("#c-avatar").textContent = initials(name);
  $("#c-title").textContent = name;
  $("#c-sub").innerHTML = [
    statePill(c.state),
    esc(CH[c.channel] ?? c.channel),
    c.assignedTo ? `atiende ${esc(c.assignedTo)}` : "",
    c.closedReason ? `cerrada (${esc(c.closedReason)})` : "",
  ].filter(Boolean).join(" · ");
  renderActions(c);
  const sig = `${c.id}:${c.messages.length}:${c.state}`;
  if (sig !== state.convSig || !keepScroll) {
    renderThread("#thread", c.messages);
    state.convSig = sig;
  }
  $("#reply-hint").textContent = c.state === "bot"
    ? "Al responder, la conversación pasa a una persona y el bot deja de contestar."
    : c.state === "cerrada" ? "Al responder, la conversación se reabre." : "";
  if (first || !state.profileDirty) renderProfile($("#profile"), c.patient, c.appointments, { conversationId: c.id });
}

function renderActions(c) {
  const b = (act, label, primary = false) => `<button class="btn small${primary ? "" : " ghost"}" data-act="${act}">${label}</button>`;
  let html = "";
  if (c.state === "cerrada") html = b("reopen", "↺ Reabrir", true);
  else if (c.state === "bot") html = b("takeover", "🙋 Tomar conversación", true) + b("pause", "⏸ Pausar bot") + b("close", "Cerrar");
  else if (c.state === "pausada" || (c.state === "esperando" && c.botPaused)) html = b("resume", "▶ Reanudar bot", true) + b("takeover", "🙋 Tomar conversación") + b("close", "Cerrar");
  else if (!c.assignedTo) html = b("takeover", "🙋 Tomar conversación", true) + b("release", "🤖 Devolver al bot") + b("close", "Cerrar");
  else html = b("release", "🤖 Devolver al bot", true) + b("close", "Cerrar");
  $("#c-actions").innerHTML = html;
}
$("#c-actions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !state.openConv) return;
  b.disabled = true;
  const id = encodeURIComponent(state.openConv);
  const MSG = {
    takeover: "Conversación tomada: el asistente deja de responder", release: "La conversación volvió al asistente",
    pause: "Asistente en pausa en esta conversación", resume: "Asistente reanudado", close: "Conversación cerrada", reopen: "Conversación reabierta",
  };
  try {
    if (b.dataset.act === "takeover") await post(`/conversation/${id}/takeover`);
    if (b.dataset.act === "release") await post(`/conversation/${id}/release`);
    if (b.dataset.act === "pause") await post(`/conversation/${id}/pause`, { paused: true });
    if (b.dataset.act === "resume") await post(`/conversation/${id}/pause`, { paused: false });
    if (b.dataset.act === "close") await post(`/conversation/${id}/close`);
    if (b.dataset.act === "reopen") await post(`/conversation/${id}/reopen`);
    toast(MSG[b.dataset.act]);
    await loadInbox();
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

const TAG = { reminder24: "⏰ Recordatorio 24 h", reminder2: "⏰ Recordatorio 2 h", followup: "📣 Seguimiento", waitlist_offer: "🔔 Oferta de lista de espera", reactivation: "📣 Invitación a control" };
function renderThread(sel, messages) {
  const el = $(sel);
  let lastDay = "";
  el.innerHTML = messages.map((m) => {
    const day = m.at ? dayKeyOf(m.at) : "";
    const sep = day && day !== lastDay ? `<div class="day-sep"><span>${esc(fDay(m.at))}</span></div>` : "";
    lastDay = day || lastDay;
    if (m.role === "system") return `${sep}<div class="b system">${esc(m.text)}${m.at ? ` · ${esc(fTime(m.at))}` : ""}</div>`;
    const author = m.role === "patient" ? "Paciente" : m.role === "bot" ? (m.meta ? `Asistente · ${TAG[m.meta.kind] ?? "aviso automático"}` : "Asistente") : `Recepción${m.by ? ` · ${m.by}` : ""}`;
    const opts = m.options?.length ? `<div class="b-options">${m.options.map((o) => `<span>${esc(o)}</span>`).join("")}</div>` : "";
    return `${sep}<div class="b ${m.role}"><span class="b-author">${esc(author)}</span>${fmt(m.text)}${opts}${m.at ? `<small>${esc(fTime(m.at))}</small>` : ""}</div>`;
  }).join("") || '<div class="b system">Sin mensajes.</div>';
  el.scrollTop = el.scrollHeight;
}

$("#reply").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#reply-text").value.trim();
  if (!text || !state.openConv) return;
  const btn = e.submitter ?? $("#reply button");
  btn.disabled = true;
  try {
    const r = await post(`/conversation/${encodeURIComponent(state.openConv)}/reply`, { text });
    $("#reply-text").value = "";
    toast(r.how === "omitido" ? "Mensaje guardado (paciente de ejemplo: no se envía)" : "Mensaje enviado al paciente");
    await loadInbox();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});
$("#chat-back").addEventListener("click", () => { $("#inbox-layout").dataset.pane = "list"; });
$("#show-profile").addEventListener("click", () => $("#inbox-layout").classList.add("profile-open"));
$("#hide-profile").addEventListener("click", () => $("#inbox-layout").classList.remove("profile-open"));

// =====================================================================
// Ficha del paciente (en la bandeja y en el panel lateral)
// =====================================================================
function renderProfile(root, p, appointments = [], { conversationId = null, conversations = [] } = {}) {
  state.profileDirty = false;
  if (!p) { root.innerHTML = '<p class="ib-empty-small">Sin datos del paciente.</p>'; return; }
  const now = new Date().toISOString();
  const next = appointments.filter((a) => a.start >= now && ["confirmada", "pendiente"].includes(a.status));
  const past = appointments.filter((a) => !(a.start >= now && ["confirmada", "pendiente"].includes(a.status))).reverse();
  const apptRow = (a) => `<li><span class="when">${esc(fDateTime(a.start))}</span><span class="tr">${esc(a.treatment)}${a.professional ? ` · ${esc(a.professional)}` : ""}</span>${apptPill(a.status)}${a.confirmed && a.status === "confirmada" ? '<span class="pill ok">✓ confirmó</span>' : ""}</li>`;
  root.innerHTML = `
    <form class="profile" data-patient="${esc(p.id)}">
      <div class="profile-head">
        <div class="avatar big">${esc(initials(p.displayName ?? "?"))}</div>
        <div><h3>${esc(p.displayName ?? "Sin nombre")}</h3>
          <p class="hint">${esc(CH[p.channel] ?? p.channel)} · cliente desde ${esc(fDay(p.createdAt))}${p.source ? ` · llegó por ${esc(p.source)}` : ""}</p></div>
      </div>
      <label>Nombre real <input name="name" value="${esc(p.name ?? "")}" placeholder="Lo pide el asistente al agendar" maxlength="80" /></label>
      <label>Nombre en WhatsApp <input value="${esc(p.profileName ?? "—")}" disabled title="Lo informa WhatsApp; puede no ser el nombre real" /></label>
      <label>Teléfono de contacto <input name="contactPhone" value="${esc(p.contactPhone)}" placeholder="+54 9 11 …" inputmode="tel" maxlength="24" /></label>
      <p class="hint">Identidad del canal: ${esc(p.channelId)}${p.channel === "whatsapp" ? " (el chat sigue por ese número)" : ""}</p>
      <div class="label">Etiquetas</div>
      <div class="tags-edit" data-tags>${p.tags.map((t) => `<span class="tag-chip">${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Quitar ${esc(t)}">×</button></span>`).join("")}
        <input data-newtag placeholder="+ etiqueta" maxlength="24" aria-label="Nueva etiqueta" /></div>
      <label>Notas internas <textarea name="notes" rows="3" maxlength="2000" placeholder="Solo las ve el equipo">${esc(p.notes)}</textarea></label>
      <div class="profile-save"><button class="btn small" type="submit">Guardar ficha</button><span class="hint" data-saved></span></div>
    </form>
    <div class="profile-sec"><h4>Próximos turnos</h4><ul class="appt-mini">${next.map(apptRow).join("") || empty("Sin turnos próximos.")}</ul></div>
    <div class="profile-sec"><h4>Historial</h4><ul class="appt-mini">${past.slice(0, 8).map(apptRow).join("") || empty("Sin turnos anteriores.")}</ul></div>
    ${conversations.length ? `<div class="profile-sec"><h4>Conversaciones</h4><ul class="appt-mini">${conversations.map((c) => `<li><span class="when">${esc(fShort(c.lastAt))}</span><span class="tr">${esc(CH[c.channel] ?? c.channel)}</span>${statePill(c.state)}<button class="btn ghost small" type="button" data-goconv="${esc(c.id)}">Abrir</button></li>`).join("")}</ul></div>` : ""}
    ${!conversationId && !conversations.length ? "" : ""}`;
}

function tagsOf(form) {
  return $$("[data-tags] .tag-chip", form).map((x) => x.firstChild.textContent.trim());
}
document.addEventListener("input", (e) => { if (e.target.closest("form.profile")) state.profileDirty = true; });
document.addEventListener("click", (e) => {
  const un = e.target.closest("[data-untag]");
  if (un) { un.parentElement.remove(); state.profileDirty = true; return; }
  const go = e.target.closest("[data-goconv]");
  if (go) goToConversation(go.dataset.goconv);
});
document.addEventListener("keydown", (e) => {
  const inp = e.target.closest?.("[data-newtag]");
  if (!inp || (e.key !== "Enter" && e.key !== ",")) return;
  e.preventDefault();
  const v = inp.value.replace(/,/g, "").trim();
  if (!v) return;
  const form = inp.closest("form.profile");
  if (!tagsOf(form).includes(v)) inp.insertAdjacentHTML("beforebegin", `<span class="tag-chip">${esc(v)}<button type="button" data-untag="${esc(v)}" aria-label="Quitar ${esc(v)}">×</button></span>`);
  inp.value = "";
  state.profileDirty = true;
});
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form.profile");
  if (!form) return;
  e.preventDefault();
  const pending = $("[data-newtag]", form).value.trim();
  const tags = [...tagsOf(form), ...(pending ? [pending] : [])];
  const body = { name: form.elements.name.value, contactPhone: form.elements.contactPhone.value, notes: form.elements.notes.value, tags };
  const btn = $("button[type=submit]", form);
  btn.disabled = true;
  try {
    await put(`/patient/${encodeURIComponent(form.dataset.patient)}`, body);
    state.profileDirty = false;
    $("[data-saved]", form).textContent = "Guardado ✓";
    toast("Ficha guardada: el cambio se ve en el chat, la agenda y la lista de pacientes");
    refreshCurrent();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

// =====================================================================
// Panel lateral genérico (turno de la agenda o ficha desde Pacientes)
// =====================================================================
function openDrawer(title, html) {
  $("#dr-title").textContent = title;
  $("#dr-body").innerHTML = html;
  $("#drawer").classList.add("show");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#drawer-bg").classList.add("show");
}
function closeDrawer() {
  $("#drawer").classList.remove("show");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#drawer-bg").classList.remove("show");
}
$("#dr-close").addEventListener("click", closeDrawer);
$("#drawer-bg").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

async function openPatient(id) {
  openDrawer("Ficha del paciente", '<p class="loading">Cargando ficha…</p>');
  try {
    const d = await api(`/patient/${encodeURIComponent(id)}`);
    renderProfile($("#dr-body"), d.patient, d.appointments, { conversations: d.conversations });
  } catch (err) { $("#dr-body").innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
}

const refreshCurrent = () => loaders[state.view]?.().catch(() => {});

// =====================================================================
// Resumen: lo urgente primero
// =====================================================================
async function loadSummary() {
  const d = await api(`/summary${state.date ? `?date=${state.date}` : ""}`);
  state.date ??= d.date;
  $("#date").value = d.date;
  stamp();
  setBadge(d.counts.esperando);
  const k = d.kpis;
  $("#kpis").innerHTML = kpiHtml([
    ["Esperan respuesta", k.waiting, k.waiting ? "abrí la bandeja para responder" : "nada pendiente", k.waiting > 0, "bandeja-esperando"],
    ["Citas del día", k.appointmentsToday, k.upcomingToday ? `${k.upcomingToday} por venir · ${k.unconfirmedToday} sin confirmar` : "ninguna por venir", false, "agenda"],
    ["Próximos 7 días", k.next7Days, "turnos activos", false, "agenda"],
    ["Lista de espera", k.waitlist, k.offersPending ? `${k.offersPending} oferta(s) enviada(s)` : "esperando un hueco", false, "agenda"],
    ["Leads sin turno", k.leadsWithoutAppointment, "llegaron por una promo", false, "pacientes"],
  ]);
  $("#urgent").innerHTML = d.waiting.length ? d.waiting.map((c) => `
    <li class="urgent-item" data-goconv="${esc(c.id)}" tabindex="0">
      <div class="avatar">${esc(initials(c.patient ?? c.phone))}</div>
      <div class="conv-main"><div class="conv-top"><span class="who">${esc(c.patient ?? c.phone)}</span><span class="when">espera ${esc(ago(c.since))}</span></div>
        <div class="last">${esc(c.lastText)}</div>
        <div class="conv-meta">${c.reason ? `<span class="pill ${c.reason === "urgencia" ? "bad" : "wait"}">${esc(REASON[c.reason] ?? c.reason)}</span>` : ""}<span class="ch">${esc(CH[c.channel] ?? c.channel)}</span></div></div>
      <button class="btn small" type="button">Responder</button>
    </li>`).join("") : empty("Nada urgente: ninguna conversación espera respuesta.");

  $("#appt-hint").textContent = dateOnly(d.date);
  const now = new Date().toISOString();
  $("#appts").innerHTML = d.appointments.length ? d.appointments.map((a) => {
    const active = a.status === "confirmada" || a.status === "pendiente";
    const soon = active && !a.confirmed && a.start > now;
    return `<li class="day-item${soon ? " needs" : ""}" data-appt="${esc(a.id)}" tabindex="0">
      <span class="time">${esc(fTime(a.start))}</span>
      <span class="who">${esc(a.patient)}<span class="ch">${esc(a.treatment)}</span></span>
      ${apptPill(a.status)}${active ? (a.confirmed ? '<span class="pill ok">✓ confirmó</span>' : '<span class="pill wait">sin confirmar</span>') : ""}
    </li>`;
  }).join("") : empty("No hay citas este día.");
  state.summaryAppts = d.appointments;

  const ho = $("#ho-count");
  ho.textContent = d.handoffs.length;
  ho.classList.toggle("zero", !d.handoffs.length);
  $("#handoffs").innerHTML = d.handoffs.length ? d.handoffs.map((h) => `
    <li class="ho">
      <div class="row"><strong>${esc(h.patient || "Paciente")}</strong><span class="pill ${h.reason === "urgencia" ? "bad" : "wait"}">${esc(REASON[h.reason] ?? h.reason)}</span></div>
      <p>${esc(h.summary)}</p>
      <div class="row"><span class="ch">${esc(CH[h.channel] ?? "")} · ${esc(fShort(h.createdAt))}</span>
        <div class="btns"><button class="btn ghost small" data-goconv="${esc(h.conversationId)}">Abrir chat</button><button class="btn small" data-resolve="${esc(h.id)}">Resuelta → vuelve al bot</button></div></div>
    </li>`).join("") : empty("Sin derivaciones abiertas.");

  $("#leads").innerHTML = d.leads.length ? d.leads.slice(0, 8).map((l) => `
    <li class="lead" data-goconv="${esc(l.conversationId)}"><div><strong>${esc(l.name ?? l.phone)}</strong><br><small>${esc(CH[l.channel] ?? l.channel)} · ${esc(l.source ?? "")} · ${esc(fShort(l.lastContact))}</small></div>
      <div>${l.followupSent ? '<span class="pill ok">Seguimiento enviado</span>' : '<span class="pill wait">Sin seguimiento</span>'}</div></li>`).join("")
    : empty("No hay leads pendientes.");

  for (const el of $$("[data-admin-block]")) el.hidden = !d.metrics;
  if (d.metrics) {
    const m = d.metrics;
    $("#m-provider").textContent = m.provider;
    $("#m-note").hidden = !m.estimated;
    $("#m-note").textContent = "Estimado con los datos de ejemplo (precios oficiales de Claude Haiku 5.5): no son mediciones. Los mensajes reales con IA se miden y reemplazan esta estimación.";
    const est = m.estimated ? " (estimado)" : "";
    $("#metrics").innerHTML = [
      ["Mensajes respondidos", int(m.turns)],
      [`Respuesta mediana${est}`, m.turns ? ms(m.medianLatencyMs) : "—"],
      [`Respuesta p95${est}`, m.turns ? ms(m.p95LatencyMs) : "—"],
      [`Costo por conversación${est}`, m.turns ? usd(m.avgCostPerConversation) : "—"],
    ].map(([l, v]) => `<div class="metric"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join("");
    renderTests(d.tests);
  }
}
const kpiHtml = (items) => items.map(([l, v, s, alert, go]) =>
  `<${go ? "button type=\"button\"" : "div"} class="kpi${alert ? " alert" : ""}"${go ? ` data-go="${go}"` : ""}><span>${esc(l)}</span><strong>${esc(v)}</strong><small>${esc(s ?? "")}</small></${go ? "button" : "div"}>`).join("");
$("#kpis").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (!b) return;
  if (b.dataset.go === "bandeja-esperando") { state.convFilter = "esperando"; showView("bandeja"); }
  else showView(b.dataset.go);
});
$("#appts").addEventListener("click", (e) => {
  const li = e.target.closest("[data-appt]");
  const a = li && state.summaryAppts?.find((x) => x.id === li.dataset.appt);
  if (a) openAppointment(a);
});
document.addEventListener("click", async (e) => {
  const res = e.target.closest("[data-resolve]");
  if (!res) return;
  res.disabled = true;
  try {
    await post(`/handoff/${encodeURIComponent(res.dataset.resolve)}/resolve`, { returnToBot: true });
    toast("Derivación resuelta: la conversación vuelve al asistente");
    refreshCurrent();
    refreshBadge();
  } catch (err) { toast(err.message, true); res.disabled = false; }
});
$("#date").addEventListener("change", (e) => { state.date = e.target.value; loadSummary(); });
$("#today").addEventListener("click", () => { state.date = null; loadSummary(); });

function renderTests(runs) {
  if (!runs?.length) {
    $("#tests").innerHTML = `<p class="empty">Todavía no se corrieron. Ejecute <code>npm run test:cases</code>.</p>`;
    return;
  }
  $("#tests").innerHTML = runs.map((r) => `
    <div class="test-run">
      <h4>${esc(r.provider)} — ${r.passed}/${r.total} OK <span>· respuesta media ${ms(r.avgTurnMs)} · costo/conversación ${usd(r.avgCostUsd)} · ${esc(fDateTime(r.runAt))}</span></h4>
      <div class="table-wrap"><table class="tbl">
        <tr><th>#</th><th>Caso</th><th>Esperado</th><th>Resultado</th><th>Mensajes</th><th>Tiempo medio</th></tr>
        ${r.cases.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.name)}</td><td class="ch">${esc(c.expected)}</td>
          <td>${c.passed ? '<span class="pill ok">✓ OK</span>' : `<span class="pill bad">✕ ${esc(c.details)}</span>`}</td>
          <td>${c.turns}</td><td>${ms(c.avgTurnMs)}</td></tr>`).join("")}
      </table></div>
    </div>`).join("");
}

// =====================================================================
// Agenda: grilla por horas (semana o día) con filtros y panel lateral
// =====================================================================
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const ROW_PX = 26; // alto de cada franja de 30 minutos

async function loadAgenda() {
  const d = await api(`/agenda?days=${state.agDays}${state.weekFrom ? `&from=${state.weekFrom}` : ""}`);
  state.weekFrom = d.from;
  state.agenda = d;
  const sel = $("#ag-treatment");
  const cur = sel.value;
  sel.innerHTML = `<option value="">Todos</option>` + [...new Set([...d.treatments, ...d.appointments.map((a) => a.treatment)])].map((t) => `<option>${esc(t)}</option>`).join("");
  sel.value = cur;
  const ps = $("#ag-prof");
  const curP = ps.value;
  ps.innerHTML = `<option value="">Todos</option>` + d.professionals.filter((p) => p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  ps.value = d.professionals.some((p) => p.id === curP) ? curP : "";
  $("#ag-legend").innerHTML = d.professionals.filter((p) => p.active).map((p) => `<span><i style="background:${esc(p.color)}"></i>${esc(p.name)}</span>`).join("");
  renderAgenda();
  stamp();
  loadWaitlist().catch(() => {});
}

function agendaFiltered() {
  const d = state.agenda;
  const tr = $("#ag-treatment").value;
  const st = $("#ag-status").value;
  const pr = $("#ag-prof").value;
  const showCancelled = $("#ag-cancelled").checked || st === "cancelada";
  return d.appointments.filter((a) =>
    (showCancelled || a.status !== "cancelada") &&
    (!tr || a.treatment === tr) &&
    (!pr || a.professionalId === pr) &&
    (!st || (st === "sin-confirmar" ? ["confirmada", "pendiente"].includes(a.status) && !a.confirmed : a.status === st)));
}

/** Bloques de atención (minutos) de un día: los del profesional cruzados con los de la clínica. */
function openBlocksFor(d, weekday, prof) {
  const clinic = (d.hours.find((h) => h.weekday === weekday)?.blocks ?? []).map(([a, b]) => [toMin(a), toMin(b)]);
  if (!prof) return clinic;
  const own = (prof.hours.find((h) => h.weekday === weekday)?.blocks ?? []).map(([a, b]) => [toMin(a), toMin(b)]);
  const out = [];
  for (const [a1, b1] of own) for (const [a2, b2] of clinic) { const a = Math.max(a1, a2), b = Math.min(b1, b2); if (a < b) out.push([a, b]); }
  return out;
}
/** Franja bloqueada por una excepción del profesional ese día (minutos), o null. */
function exceptionFor(d, profId, iso) {
  const e = d.exceptions.find((x) => x.professionalId === profId && x.fromDate <= iso && x.toDate >= iso);
  if (!e) return null;
  return { e, from: e.kind === "franja" ? toMin(e.fromTime) : 0, to: e.kind === "franja" ? toMin(e.toTime) : 24 * 60 };
}

/**
 * Vista semanal: una columna por día (con filtro por profesional y el color de cada uno).
 * Vista del día: una columna por profesional, con su horario y sus excepciones.
 */
function renderAgenda() {
  const d = state.agenda;
  if (!d) return;
  const days = Array.from({ length: d.days }, (_, i) => addDays(d.from, i));
  $("#wk-label").textContent = d.days === 1 ? dateOnly(days[0]) : `${dateOnly(days[0])} – ${dateOnly(days[days.length - 1])}`;
  const list = agendaFiltered();
  $("#ag-count").textContent = `${list.length} turno(s)`;
  const profById = new Map(d.professionals.map((p) => [p.id, p]));
  const pr = $("#ag-prof").value;
  const weekdayOf = (iso) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

  const cols = d.days === 1
    ? d.professionals.filter((p) => p.active && (!pr || p.id === pr)).map((p) => ({ iso: days[0], prof: p, key: p.id }))
    : days.map((iso) => ({ iso, prof: pr ? profById.get(pr) : null, key: iso }));

  // Rango de horas: de la apertura más temprana al cierre más tardío (y los turnos que queden afuera).
  const blocks = d.hours.flatMap((h) => h.blocks);
  let start = Math.min(...blocks.map((b) => toMin(b[0])), ...list.map((a) => toMin(a.time)), 9 * 60);
  let end = Math.max(...blocks.map((b) => toMin(b[1])), ...list.map((a) => toMin(a.endTime)), 13 * 60);
  start = Math.floor(start / 60) * 60;
  end = Math.ceil(end / 60) * 60;
  const step = 30;
  const rows = (end - start) / step;
  const y = (min) => ((Math.min(Math.max(min, start), end) - start) / step) * ROW_PX;
  const nowMin = toMin(fTime(new Date().toISOString()));

  const head = `<div class="cal-corner"></div>` + cols.map((c) => {
    const n = list.filter((a) => a.date === c.iso && (!c.prof || a.professionalId === c.prof.id) && a.status !== "cancelada").length;
    const count = `<small>${n ? `${n} turno${n > 1 ? "s" : ""}` : ""}</small>`;
    const exH = c.prof ? exceptionFor(d, c.prof.id, c.iso) : null;
    const exPill = exH ? `<em class="exc-pill" title="Excepción de agenda">⛔ ${esc(exH.e.reason)}${exH.e.kind === "franja" ? ` ${esc(exH.e.fromTime)}–${esc(exH.e.toTime)}` : ""}</em>` : "";
    if (d.days === 1) {
      return `<div class="cal-dayhead prof"><i class="dot-c" style="background:${esc(c.prof.color)}"></i><b>${esc(c.prof.name)}</b>${count}<span>${esc(c.prof.specialty)}</span>${exPill}</div>`;
    }
    return `<div class="cal-dayhead${c.iso === d.today ? " today" : ""}"><b>${esc(DAYS[weekdayOf(c.iso) - 1])}</b> <span>${esc(dateOnly(c.iso).split(" ")[1])}</span>${count}</div>`;
  }).join("");

  const times = Array.from({ length: rows }, (_, i) => {
    const m = start + i * step;
    return `<div class="cal-time" style="top:${i * ROW_PX}px">${m % 60 === 0 ? `${String(m / 60).padStart(2, "0")}:00` : ""}</div>`;
  }).join("");

  const body = cols.map((c) => {
    const open = openBlocksFor(d, weekdayOf(c.iso), c.prof);
    const openHtml = open.map(([a, b]) => `<div class="cal-open" style="top:${y(a)}px;height:${y(b) - y(a)}px"></div>`).join("");
    const ex = c.prof ? exceptionFor(d, c.prof.id, c.iso) : null;
    const exHtml = ex ? `<div class="cal-exc" style="top:${y(ex.from)}px;height:${Math.max(y(ex.to) - y(ex.from), 24)}px" title="${esc(ex.e.reason)}"></div>` : "";
    // Turnos que se superponen (p. ej. uno cancelado y otro nuevo a la misma hora) se reparten el ancho.
    const items = list.filter((a) => a.date === c.iso && (!c.prof || a.professionalId === c.prof.id))
      .map((a) => ({ a, s: toMin(a.time), e: Math.max(toMin(a.endTime), toMin(a.time) + 15) })).sort((x, z) => x.s - z.s);
    const lanes = [];
    for (const it of items) {
      let lane = lanes.findIndex((endAt) => endAt <= it.s);
      if (lane < 0) { lane = lanes.length; lanes.push(it.e); } else lanes[lane] = it.e;
      it.lane = lane;
    }
    for (const it of items) it.n = Math.max(1, ...items.filter((o) => o.s < it.e && o.e > it.s).map((o) => o.lane + 1));
    const appts = items.map(({ a, s, e, lane, n }) => {
      const active = a.status === "confirmada" || a.status === "pendiente";
      const color = profById.get(a.professionalId)?.color ?? "#25d366";
      const hit = active && ex && s < ex.to && e > ex.from;
      return `<button type="button" class="cal-appt st-${esc(a.status)}${active && !a.confirmed ? " unconfirmed" : ""}${hit ? " affected" : ""}" data-appt="${esc(a.id)}"
        style="--pc:${esc(color)};top:${y(s) + 1}px;height:${Math.max(y(e) - y(s) - 2, 20)}px;left:calc(${(lane / n) * 100}% + 2px);width:calc(${100 / n}% - 4px)"
        title="${esc(`${a.time}–${a.endTime} · ${a.patient} · ${a.treatment}${a.professional ? ` · ${a.professional}` : ""} · ${STATUS[a.status]?.[0] ?? a.status}`)}">
        <b>${esc(a.time)}</b> ${esc(a.patient)}<span>${esc(a.treatment)}${d.days === 7 && !c.prof && a.professional ? ` · ${esc(a.professional)}` : ""}</span></button>`;
    }).join("");
    const nowLine = c.iso === d.today && nowMin >= start && nowMin <= end ? `<div class="cal-now" style="top:${y(nowMin)}px"></div>` : "";
    const closed = !open.length ? `<span class="cal-closed">${c.prof ? "No atiende" : "Cerrado"}</span>` : "";
    return `<div class="cal-col${open.length ? "" : " closed"}${c.iso === d.today && d.days === 7 ? " today" : ""}" style="height:${rows * ROW_PX}px">${openHtml}${exHtml}${appts}${nowLine}${closed}</div>`;
  }).join("");

  $("#cal").innerHTML = cols.length ? `<div class="cal-grid" style="--days:${cols.length}">
      <div class="cal-head">${head}</div>
      <div class="cal-body"><div class="cal-times" style="height:${rows * ROW_PX}px">${times}</div>${body}</div>
    </div>` : '<p class="empty pad">No hay profesionales para mostrar.</p>';
  // La vista arranca cerca de la hora actual (o del primer turno), sin perder la cabecera.
  const scroller = $("#cal .cal-grid");
  if (!scroller) return;
  const first = list.filter((a) => a.status !== "cancelada").map((a) => toMin(a.time)).sort((a, b) => a - b)[0];
  const target = days.includes(d.today) ? nowMin - 60 : (first ?? start) - 30;
  scroller.scrollTop = Math.max(0, y(target));
}
["#ag-treatment", "#ag-status", "#ag-cancelled", "#ag-prof"].forEach((s) => $(s).addEventListener("change", renderAgenda));
segment("#ag-mode", (n) => {
  state.agDays = Number(n);
  state.weekFrom = state.agDays === 1 ? (state.agenda?.days === 7 && state.agenda.from <= state.agenda.today && addDays(state.agenda.from, 6) >= state.agenda.today ? state.agenda.today : state.weekFrom) : null;
  loadAgenda().catch((e) => toast(e.message, true));
});
$("#wk-prev").addEventListener("click", () => { state.weekFrom = addDays(state.weekFrom, -state.agDays); loadAgenda(); });
$("#wk-next").addEventListener("click", () => { state.weekFrom = addDays(state.weekFrom, state.agDays); loadAgenda(); });
$("#wk-today").addEventListener("click", () => { state.weekFrom = null; loadAgenda(); });
$("#cal").addEventListener("click", (e) => {
  const b = e.target.closest("[data-appt]");
  const a = b && state.agenda?.appointments.find((x) => x.id === b.dataset.appt);
  if (a) openAppointment(a);
});

/** Panel lateral de un turno: datos y acciones. */
function openAppointment(a) {
  const active = a.status === "confirmada" || a.status === "pendiente";
  const past = a.start < new Date().toISOString();
  const btn = (st, label, cls = "ghost") => `<button class="btn small ${cls}" data-st="${st}">${label}</button>`;
  openDrawer("Turno", `
    <div class="appt-detail" data-appt-id="${esc(a.id)}">
      <h4>${esc(a.patient)}</h4>
      <p class="big-when">${esc(fDateTime(a.start))} – ${esc(fTime(a.end))}</p>
      <dl>
        <dt>Tratamiento</dt><dd>${esc(a.treatment)}</dd>
        ${a.professional ? `<dt>Profesional</dt><dd>${esc(a.professional)}</dd>` : ""}
        <dt>Estado</dt><dd>${apptPill(a.status)} ${active ? (a.confirmed ? '<span class="pill ok">✓ confirmó el paciente</span>' : '<span class="pill wait">sin confirmar por el paciente</span>') : ""}</dd>
        <dt>Contacto</dt><dd>${esc(a.phone || "—")} · ${esc(CH[a.channel] ?? a.channel)}</dd>
        ${a.reminder24 !== undefined ? `<dt>Recordatorios</dt><dd>24 h ${a.reminder24 ? "✓" : "·"} · 2 h ${a.reminder2 ? "✓" : "·"}</dd>` : ""}
      </dl>
      ${active ? `<div class="btn-row">${!a.confirmed && !past ? btn("confirmada", "✓ Marcar confirmado", "") : ""}${past ? btn("asistio", "Asistió", "") + btn("ausente", "Ausente") : ""}${btn("cancelada", "Cancelar turno", "danger")}</div>` : ""}
      <div class="btn-row">
        ${a.conversationId ? `<button class="btn ghost small" data-goconv="${esc(a.conversationId)}">💬 Ver conversación</button>` : ""}
        <button class="btn ghost small" data-patient="${esc(a.patientId)}">👤 Ver ficha</button>
      </div>
      ${active ? '<p class="hint">Al cancelar, el horario se libera en el calendario y se ofrece a la lista de espera.</p>' : ""}
    </div>`);
}
$("#dr-body").addEventListener("click", async (e) => {
  const pb = e.target.closest("[data-patient]");
  if (pb) return openPatient(pb.dataset.patient);
  const b = e.target.closest("[data-st]");
  if (!b) return;
  const id = b.closest("[data-appt-id]").dataset.apptId;
  if (b.dataset.st === "cancelada" && !confirm("¿Cancelar este turno? El horario se libera en el calendario.")) return;
  b.disabled = true;
  try {
    const r = await post(`/appointment/${encodeURIComponent(id)}/status`, { status: b.dataset.st });
    toast(b.dataset.st === "cancelada" ? (r.offeredTo ? `Turno cancelado: se le ofreció a ${r.offeredTo} (lista de espera)` : "Turno cancelado: horario liberado") : "Turno actualizado");
    closeDrawer();
    refreshCurrent();
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

const WL = { esperando: ["Esperando", "wait"], ofrecido: ["Oferta enviada", "info"], aceptado: ["Tomó el turno", "ok"] };
const FR = { manana: "mañana", tarde: "tarde", cualquiera: "cualquier hora" };
async function loadWaitlist() {
  const d = await api("/waitlist");
  $("#wl-hint").textContent = `la oferta dura ${d.offerMinutes} min y pasa a la siguiente persona`;
  $("#waitlist").innerHTML = d.entries.length ? `<tr><th>Paciente</th><th>Tratamiento</th><th>Días</th><th>Franja</th><th>Estado</th><th>Anotado</th><th></th></tr>` +
    d.entries.map((e) => {
      const offered = e.status === "ofrecido" && e.offeredSlot ? ` · ${dateOnly(e.offeredSlot.slice(0, 10))} ${e.offeredSlot.slice(11)}` : "";
      return `<tr><td>${esc(e.patientName)}</td><td>${esc(e.treatment)}</td><td>${esc(dateOnly(e.fromDate))} – ${esc(dateOnly(e.toDate))}</td><td>${FR[e.franja] ?? e.franja}</td>
        <td><span class="pill ${(WL[e.status] ?? ["", "muted"])[1]}">${esc((WL[e.status] ?? [e.status])[0])}${esc(offered)}</span></td><td class="ch">${esc(fShort(e.createdAt))}</td>
        <td>${e.status === "aceptado" ? "" : `<button class="btn ghost small" data-wl-cancel="${esc(e.id)}">Quitar</button>`}</td></tr>`;
    }).join("") : `<tr><td class="empty">Nadie en lista de espera. El asistente anota a quien no encuentra un horario que le sirva.</td></tr>`;
}
$("#waitlist").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-wl-cancel]");
  if (!b || !confirm("¿Quitar a esta persona de la lista de espera?")) return;
  try { await post(`/waitlist/${encodeURIComponent(b.dataset.wlCancel)}/cancel`); loadWaitlist(); } catch (err) { toast(err.message, true); }
});

// =====================================================================
// Profesionales: horario, tratamientos con duración, calendario y excepciones
// =====================================================================
const KIND = { dia: "Día completo", franja: "Franja", rango: "Vacaciones" };
/** «Lun a Vie 09:00–13:00, 14:00–18:00 · Sáb 09:00–13:00»: agrupa los días seguidos con el mismo horario. */
const hoursText = (hours) => {
  const label = (i) => DAYS[i].slice(0, 3);
  const key = (i) => { const h = hours.find((x) => x.weekday === i + 1); return h ? h.blocks.map(([a, b]) => `${a}–${b}`).join(", ") : ""; };
  const out = [];
  for (let i = 0; i < 7; i++) {
    const k = key(i);
    if (!k) continue;
    let j = i;
    while (j + 1 < 7 && key(j + 1) === k) j++;
    const days = j > i + 1 ? `${label(i)} a ${label(j)}` : j === i + 1 ? `${label(i)} y ${label(j)}` : label(i);
    out.push(`${days} ${k}`);
    i = j;
  }
  return out.join(" · ") || "Sin horario cargado";
};

async function loadProfessionals() {
  const d = await api("/professionals");
  state.pros = d;
  $("#pr-mode").textContent = d.canEdit ? "Puede editar (admin)" : "Solo lectura: los edita el admin. Recepción sí carga excepciones.";
  $("#pr-add").hidden = !d.canEdit;
  const tName = (id) => d.treatments.find((t) => t.id === id)?.name ?? id;
  $("#pros").innerHTML = d.professionals.map((p) => `
    <article class="card pro${p.active ? "" : " inactive"}">
      <div class="pro-head"><i class="dot-c big" style="background:${esc(p.color)}"></i>
        <div><h3>${esc(p.name)}</h3><p class="hint">${esc(p.specialty)}</p></div>
        <span class="pill ${p.calendar === "google" ? "info" : "muted"}">${p.calendar === "google" ? "Google Calendar" : "Agenda interna"}</span>
      </div>
      <p class="pro-hours">${esc(hoursText(p.hours))}</p>
      <ul class="pro-tr">${p.treatments.map((t) => `<li>${esc(tName(t.id))} <span>${t.minutes} min</span></li>`).join("")}</ul>
      <div class="btn-row">${d.canEdit ? `<button class="btn ghost small" data-edit-pro="${esc(p.id)}">Editar</button>` : ""}<button class="btn ghost small" data-exc-for="${esc(p.id)}">+ Excepción</button>${p.active ? "" : '<span class="pill muted">Inactivo</span>'}</div>
    </article>`).join("") || '<p class="empty">Todavía no hay profesionales.</p>';

  const sel = $("#exc-form").elements.professionalId;
  const cur = sel.value;
  sel.innerHTML = d.professionals.filter((p) => p.active).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  if (cur) sel.value = cur;
  const name = (id) => d.professionals.find((p) => p.id === id)?.name ?? id;
  const when = (e) => e.kind === "rango" ? `${dateOnly(e.fromDate)} – ${dateOnly(e.toDate)}` : e.kind === "franja" ? `${dateOnly(e.fromDate)} · ${e.fromTime}–${e.toTime}` : dateOnly(e.fromDate);
  const rows = d.exceptions.filter((e) => !e.past);
  $("#exc-list").innerHTML = rows.length ? `<tr><th>Profesional</th><th>Cuándo</th><th>Tipo</th><th>Motivo</th><th>Turnos afectados</th><th></th></tr>` + rows.map((e) => `
    <tr><td>${esc(name(e.professionalId))}</td><td class="nowrap">${esc(when(e))}</td><td class="ch">${KIND[e.kind]}</td><td>${esc(e.reason)}</td>
      <td>${e.affected ? `<span class="pill ${e.notifiedAt ? "ok" : "wait"}">${e.affected} ${e.notifiedAt ? "· avisados" : "· sin avisar"}</span>` : '<span class="ch">ninguno</span>'}</td>
      <td class="nowrap">${e.affected ? `<button class="btn ghost small" data-exc-view="${esc(e.id)}">Ver turnos</button>` : ""}<button class="btn ghost small" data-exc-del="${esc(e.id)}" aria-label="Quitar excepción">Quitar</button></td></tr>`).join("")
    : `<tr><td class="empty">No hay excepciones cargadas. Cárguelas cuando un profesional no vaya a atender.</td></tr>`;
  stamp();
}

/** Turnos afectados con el botón para avisar por el bot. */
function affectedHtml(exceptionId, affected, notifiedAt) {
  if (!affected.length) return '<p class="note-box small">No hay turnos afectados: el bot ya no ofrece esos horarios.</p>';
  return `<div class="affected-box">
    <p><b>${affected.length} turno${affected.length > 1 ? "s" : ""} afectado${affected.length > 1 ? "s" : ""}.</b> El bot ya no ofrece esos horarios.</p>
    <ul class="appt-mini">${affected.map((a) => `<li><span class="when">${esc(fDateTime(a.start))}</span><span class="tr">${esc(a.patient)} · ${esc(a.treatment)}</span><span class="ch">${esc(CH[a.channel] ?? a.channel)}</span></li>`).join("")}</ul>
    <div class="btn-row"><button class="btn small" data-exc-notify="${esc(exceptionId)}">${notifiedAt ? "Volver a avisar" : "Avisar por el bot para reprogramar"}</button></div>
    <p class="hint">Cada paciente recibe un mensaje con los botones <i>Reprogramar · Cancelar turno</i>; si elige reprogramar, el bot le ofrece horarios nuevos.${notifiedAt ? ` Último aviso: ${esc(fDateTime(notifiedAt))}.` : ""}</p>
  </div>`;
}

let excKind = "dia";
segment("#exc-kind", (k) => {
  excKind = k;
  for (const el of $$("#exc-form [data-only]")) el.hidden = el.dataset.only !== k;
  $("#exc-form [data-label-from]").textContent = k === "rango" ? "Desde" : "Fecha";
});
$("#exc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = { professionalId: f.professionalId.value, kind: excKind, fromDate: f.fromDate.value, toDate: f.toDate.value, fromTime: f.fromTime.value, toTime: f.toTime.value, reason: f.reason.value };
  try {
    const r = await post("/exceptions", body);
    toast("Excepción cargada");
    $("#exc-result").innerHTML = affectedHtml(r.exception.id, r.affected, null);
    e.target.elements.reason.value = "";
    await loadProfessionals();
  } catch (err) { toast(err.message, true); }
});

document.addEventListener("click", async (e) => {
  const v = e.target.closest("[data-exc-view]");
  if (v) {
    const r = await api(`/exceptions/${encodeURIComponent(v.dataset.excView)}/affected`).catch((err) => toast(err.message, true));
    if (r) openDrawer("Turnos afectados", affectedHtml(r.exception.id, r.affected, r.exception.notifiedAt));
    return;
  }
  const n = e.target.closest("[data-exc-notify]");
  if (n) {
    n.disabled = true;
    try {
      const r = await post(`/exceptions/${encodeURIComponent(n.dataset.excNotify)}/notify`);
      toast(`Avisos: ${r.sent} enviado(s)${r.demo ? ` · ${r.demo} de ejemplo (quedan en el chat, sin envío)` : ""}${r.failed.length ? ` · ${r.failed.length} con error` : ""}`, !!r.failed.length);
      n.textContent = "Avisados ✓";
      refreshBadge();
      if (state.view === "profesionales") loadProfessionals();
    } catch (err) { toast(err.message, true); n.disabled = false; }
    return;
  }
  const del = e.target.closest("[data-exc-del]");
  if (del) {
    if (!confirm("¿Quitar esta excepción? El bot vuelve a ofrecer esos horarios.")) return;
    try { await api(`/exceptions/${encodeURIComponent(del.dataset.excDel)}`, { method: "DELETE" }); toast("Excepción quitada"); loadProfessionals(); } catch (err) { toast(err.message, true); }
    return;
  }
  const forP = e.target.closest("[data-exc-for]");
  if (forP) {
    $("#exc-form").elements.professionalId.value = forP.dataset.excFor;
    $("#exc-form").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#exc-form").elements.fromDate.focus();
    return;
  }
  const ed = e.target.closest("[data-edit-pro]");
  if (ed) return openProfessionalEditor(state.pros.professionals.find((p) => p.id === ed.dataset.editPro));
  if (e.target.closest("#pr-add")) return openProfessionalEditor(null);
});

/** Editor de un profesional (panel lateral). */
function openProfessionalEditor(p) {
  const d = state.pros;
  const isNew = !p;
  p ??= { id: "", name: "", specialty: "", color: "#59b8ff", calendar: "interno", active: true, hours: [], treatments: [] };
  const hoursVal = (i) => { const h = p.hours.find((x) => x.weekday === i + 1); return h ? h.blocks.map(([a, b]) => `${a}-${b}`).join(", ") : ""; };
  const mins = (id) => p.treatments.find((t) => t.id === id)?.minutes;
  openDrawer(isNew ? "Nuevo profesional" : "Editar profesional", `
    <form class="kb pro-form" id="pro-form" data-id="${esc(p.id)}">
      <label>Nombre <input name="name" value="${esc(p.name)}" required maxlength="80" placeholder="Dra. Nombre Apellido" /></label>
      <label>Especialidad <input name="specialty" value="${esc(p.specialty)}" required maxlength="80" /></label>
      <div class="two">
        <label>Color en la agenda <input type="color" name="color" value="${esc(p.color)}" /></label>
        <label>Calendario <select name="calendar"><option value="interno"${p.calendar === "interno" ? " selected" : ""}>Agenda interna</option><option value="google"${p.calendar === "google" ? " selected" : ""}>Google Calendar</option></select></label>
      </div>
      <label class="check"><input type="checkbox" name="active"${p.active ? " checked" : ""} /> Activo (el bot le ofrece turnos)</label>
      <fieldset><legend>Horario semanal</legend>
        <p class="hint">Se cruza con el horario de atención de la clínica. Vacío = no atiende ese día.</p>
        <div class="hours">${DAYS.map((dn, i) => `<span>${dn}</span><input data-weekday="${i + 1}" value="${esc(hoursVal(i))}" placeholder="ej.: 09:00-13:00, 14:00-18:00" aria-label="Horario del ${dn}" />`).join("")}</div>
      </fieldset>
      <fieldset><legend>Tratamientos que realiza</legend>
        <div class="tr-pick">${d.treatments.map((t) => `<label class="check"><input type="checkbox" data-tr="${esc(t.id)}"${mins(t.id) ? " checked" : ""} /> <span>${esc(t.name)}<small>${esc(t.specialty)}</small></span>
          <input type="number" min="10" max="240" step="5" data-min="${esc(t.id)}" value="${mins(t.id) ?? 30}" aria-label="Minutos de ${esc(t.name)}" /> min</label>`).join("")}</div>
      </fieldset>
      <div class="profile-save"><button class="btn" type="submit">Guardar</button><span class="hint">Rige para el bot desde el mensaje siguiente.</span></div>
    </form>`);
}
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("#pro-form");
  if (!form) return;
  e.preventDefault();
  const f = form.elements;
  const hours = [];
  for (const inp of form.querySelectorAll("[data-weekday]")) {
    const txt = inp.value.trim();
    if (!txt) continue;
    hours.push({ weekday: Number(inp.dataset.weekday), blocks: txt.split(/[,;]/).map((b) => b.trim()).filter(Boolean).map((b) => b.split(/\s*[-–a]\s*/).map((x) => x.padStart(5, "0"))) });
  }
  const treatments = [...form.querySelectorAll("[data-tr]")].filter((c) => c.checked).map((c) => ({ id: c.dataset.tr, minutes: Number(form.querySelector(`[data-min="${c.dataset.tr}"]`).value) }));
  const id = form.dataset.id || f.name.value.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/^(dra?)-/, "prof-").slice(0, 36) || `prof-${Date.now().toString(36)}`;
  try {
    await put(`/professionals/${encodeURIComponent(id)}`, { name: f.name.value, specialty: f.specialty.value, color: f.color.value, calendar: f.calendar.value, active: f.active.checked, hours, treatments });
    toast("Profesional guardado: el bot ya usa estos horarios");
    closeDrawer();
    loadProfessionals();
  } catch (err) { toast(err.message, true); }
});

// =====================================================================
// Seguimientos: reglas de recordatorios, seguimiento y reactivación
// =====================================================================
const RULE_KIND = {
  antes: ["⏰ Antes del turno", "horas antes"],
  despues: ["💬 Después del turno", "días después (si asistió)"],
  reactivacion: ["🔁 Reactivación", "días sin venir"],
  lead: ["📣 Lead de la promo", "horas sin respuesta"],
};
function ruleHtml(r, i, canEdit) {
  const [label, unit] = RULE_KIND[r.kind] ?? [r.kind, ""];
  const amount = r.kind === "antes" || r.kind === "lead" ? r.hours : r.days;
  const dis = canEdit ? "" : " disabled";
  const removable = canEdit && (r.kind === "antes" || r.kind === "despues");
  return `<div class="rule${r.active ? "" : " off"}" data-i="${i}" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}">
    <div class="rule-head">
      <label class="switch"><input type="checkbox" data-k="active"${r.active ? " checked" : ""}${dis} aria-label="Regla activa" /><span></span></label>
      <b>${esc(label)}</b>
      <label class="amount"><input type="number" data-k="amount" value="${esc(amount)}" min="1"${dis} aria-label="${esc(unit)}" /> ${esc(unit)}</label>
      ${r.kind === "reactivacion" ? `<label class="amount">cada <input type="number" data-k="repeatDays" value="${esc(r.repeatDays ?? 90)}" min="7"${dis} aria-label="Repetir cada días" /> días</label>` : ""}
      ${removable ? `<button type="button" class="icon" data-del-rule="${i}" aria-label="Quitar regla">✕</button>` : ""}
    </div>
    <label>Texto <textarea data-k="text" rows="3" maxlength="1024"${dis}>${esc(r.text)}</textarea></label>
    ${r.kind === "antes" ? `<label>Texto si ya confirmó (opcional, sin botones) <textarea data-k="textConfirmed" rows="2" maxlength="1024"${dis}>${esc(r.textConfirmed ?? "")}</textarea></label>` : ""}
    <div class="two">
      <label>Botones (hasta 3, separados por «|») <input data-k="buttons" value="${esc(r.buttons.join(" | "))}"${dis} /></label>
      <label>Plantilla de Meta (fuera de las 24 h) <input data-k="template" value="${esc(r.template)}"${dis} /></label>
    </div>
  </div>`;
}

async function loadFollowups() {
  const d = await api("/followups");
  state.followups = d;
  $("#fu-mode").textContent = d.canEdit ? "Puede editar (admin)" : "Solo lectura: lo edita el admin.";
  $("#fu-save").hidden = !d.canEdit;
  $("#fu-add").hidden = !d.canEdit;
  renderRules();
  const q = d.settings.quietHours;
  $("#fu-quiet-on").checked = !!q;
  $("#fu-quiet-from").value = q?.from ?? "21:00";
  $("#fu-quiet-to").value = q?.to ?? "08:00";
  $("#fu-offer").value = d.settings.waitlistOfferMinutes;
  for (const el of ["#fu-quiet-on", "#fu-quiet-from", "#fu-quiet-to", "#fu-offer"]) $(el).disabled = !d.canEdit;
  const ruleName = (id) => { const r = d.settings.rules.find((x) => x.id === id); return r ? `${r.hours} h antes` : id; };
  $("#fu-upcoming").innerHTML = d.upcoming.length ? d.upcoming.map((u) => `<li><span class="when">${esc(fDateTime(u.at))}</span><span class="tr">${esc(u.patient)} · turno ${esc(fDateTime(u.start))}</span><span class="pill muted">${esc(ruleName(u.ruleId))}</span>${u.demo ? '<span class="ch">ejemplo: no se envía</span>' : ""}</li>`).join("")
    : empty("No hay recordatorios programados para los próximos días.");
  stamp();
}
function renderRules() {
  const d = state.followups;
  const order = { antes: 0, despues: 1, lead: 2, reactivacion: 3 };
  const rules = d.settings.rules.map((r, i) => [r, i]).sort(([a], [b]) => order[a.kind] - order[b.kind] || (b.hours ?? 0) - (a.hours ?? 0));
  $("#fu-rules").innerHTML = rules.map(([r, i]) => ruleHtml(r, i, d.canEdit)).join("");
}
/** Lee lo que hay en pantalla y lo vuelve a poner en state.followups (para no perder cambios al agregar o quitar). */
function readRules() {
  const d = state.followups;
  for (const el of $$("#fu-rules .rule")) {
    const r = d.settings.rules[Number(el.dataset.i)];
    const v = (k) => el.querySelector(`[data-k="${k}"]`);
    r.active = v("active").checked;
    const amount = Number(v("amount").value);
    if (r.kind === "antes" || r.kind === "lead") r.hours = amount; else r.days = amount;
    if (r.kind === "reactivacion") r.repeatDays = Number(v("repeatDays").value);
    r.text = v("text").value;
    if (r.kind === "antes") { const tc = v("textConfirmed").value.trim(); if (tc) r.textConfirmed = tc; else delete r.textConfirmed; }
    r.buttons = v("buttons").value.split("|").map((x) => x.trim()).filter(Boolean);
    r.template = v("template").value.trim();
  }
}
document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-add-rule]");
  if (add && state.followups) {
    readRules();
    const kind = add.dataset.addRule;
    const n = Date.now().toString(36).slice(-4);
    state.followups.settings.rules.push(kind === "antes"
      ? { id: `antes-${n}`, kind, hours: 48, active: true, text: "Hola, {nombre}. Le recordamos su turno del *{cuando}* con {profesional}. ¿Nos confirma?", buttons: ["✅ Confirmo", "📅 Cambiar horario", "❌ Cancelar"], template: "recordatorio_turno" }
      : { id: `despues-${n}`, kind, days: 7, active: true, text: "Hola, {nombre} 👋 ¿Cómo sigue después de su {tratamiento}? Si necesita algo, escríbanos.", buttons: ["😊 Todo bien", "Tengo una consulta"], template: "seguimiento_post_turno" });
    renderRules();
    return;
  }
  const del = e.target.closest("[data-del-rule]");
  if (del && state.followups) {
    readRules();
    state.followups.settings.rules.splice(Number(del.dataset.delRule), 1);
    renderRules();
  }
});
$("#fu-rules").addEventListener("change", (e) => {
  const rule = e.target.closest(".rule");
  if (rule && e.target.dataset.k === "active") rule.classList.toggle("off", !e.target.checked);
});
$("#fu-save").addEventListener("click", async () => {
  const d = state.followups;
  if (!d?.canEdit) return;
  readRules();
  const settings = {
    ...d.settings,
    quietHours: $("#fu-quiet-on").checked ? { from: $("#fu-quiet-from").value, to: $("#fu-quiet-to").value } : null,
    waitlistOfferMinutes: Number($("#fu-offer").value),
  };
  const btn = $("#fu-save");
  btn.disabled = true;
  try {
    await put("/followups", { settings });
    toast("Seguimientos guardados: rigen desde la próxima revisión");
    loadFollowups();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

// =====================================================================
// Pacientes y consultas
// =====================================================================
async function loadPatients() {
  const q = $("#pat-q").value.trim();
  const d = await api(`/patients?tipo=${state.patFilter}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  $("#patients").innerHTML = d.patients.length ? `
    <tr><th>Paciente</th><th>Tipo</th><th>Etiquetas</th><th>Canal</th><th>Origen</th><th>Turnos</th><th>Próximo turno</th><th>Última visita</th><th>Último contacto</th><th></th></tr>
    ${d.patients.map((p) => `<tr data-patient-row="${esc(p.id)}" tabindex="0">
      <td><b>${esc(p.name ?? "Sin nombre")}</b><div class="ch">${esc(p.phone)}</div></td>
      <td>${p.type === "paciente" ? '<span class="pill ok">Con turno</span>' : '<span class="pill wait">Consulta</span>'}</td>
      <td>${p.tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("") || '<span class="ch">—</span>'}</td>
      <td class="ch">${esc(CH[p.channel] ?? p.channel)}</td>
      <td class="ch">${esc(p.source ?? "—")}</td>
      <td>${p.appointments}${p.cancelled ? ` <span class="ch">(${p.cancelled} canc.)</span>` : ""}</td>
      <td>${esc(p.nextAppointment ? fDateTime(p.nextAppointment) : "—")}</td>
      <td class="ch">${esc(p.lastVisit ? fDay(p.lastVisit) : "—")}</td>
      <td class="ch">${esc(fShort(p.lastContact))}</td>
      <td class="nowrap">${p.conversationId ? `<button class="btn ghost small" data-goconv="${esc(p.conversationId)}">Chat</button>` : ""}</td>
    </tr>`).join("")}` : `<tr><td class="empty">No hay pacientes para mostrar.</td></tr>`;
  stamp();
  loadReactivation().catch(() => {});
}
$("#patients").addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  const tr = e.target.closest("[data-patient-row]");
  if (tr) openPatient(tr.dataset.patientRow);
});
async function loadReactivation() {
  const d = await api("/reactivation");
  $("#re-hint").textContent = `sin visitas hace ${d.months} meses o más y sin turno próximo`;
  $("#reactivation").innerHTML = d.candidates.length ? `<tr><th>Paciente</th><th>Última visita</th><th>Hace</th><th>Canal</th><th>Última invitación</th><th></th></tr>` +
    d.candidates.map((c) => `<tr><td>${esc(c.name ?? "Sin nombre")}<div class="ch">${esc(c.phone)}</div></td>
      <td>${esc(dateOnly(c.lastVisit))} <span class="ch">· ${esc(c.lastTreatment)}</span></td><td>${c.monthsAgo} meses</td>
      <td class="ch">${esc(CH[c.channel] ?? c.channel)}</td><td class="ch">${c.lastInvitation ? esc(fShort(c.lastInvitation)) : "—"}</td>
      <td><button class="btn ghost small" data-react="${esc(c.patientId)}">Invitar ahora</button></td></tr>`).join("")
    : `<tr><td class="empty">No hay pacientes para reactivar.</td></tr>`;
}
$("#reactivation").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-react]");
  if (!b) return;
  b.disabled = true;
  try { await post(`/reactivation/${encodeURIComponent(b.dataset.react)}`); toast("Invitación enviada al paciente"); loadReactivation(); }
  catch (err) { toast(err.message, true); b.disabled = false; }
});
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
  tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - 10)}px`;
}
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(e, t.dataset.tip);
  else tip.hidden = true;
});

/** Barras verticales por día; varias series se dibujan lado a lado. Una sola escala. */
function barChart(sel, daily, series) {
  const W = 640, H = 220, padL = 28, padB = 22, padT = 8;
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
      svg += `<path d="M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - padB} Z" fill="${s.color}"/>`;
    });
    svg += `<rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padB - padT}" data-tip="${esc(`<b>${dateOnly(d.date)}</b><br>${series.map((s) => `${s.label}: <b>${d[s.key]}</b>`).join("<br>")}`)}"/>`;
    if (i % labelEvery === 0) svg += `<text class="axis" x="${padL + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${d.date.slice(8, 10)}/${d.date.slice(5, 7)}</text>`;
  });
  $(sel).innerHTML = svg + "</svg>";
}

async function loadStats() {
  const s = await api(`/stats?days=${state.statsDays}`);
  $("#stats-kpis").innerHTML = kpiHtml([
    ["Consultas", int(s.totals.consultas), `últimos ${s.days} días`],
    ["Pacientes nuevos", int(s.totals.pacientesNuevos), `${int(s.conversion.leadsPromo)} llegaron por campañas`],
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
    <div class="big-split">
      <div><strong>${pct(r.bot / r.total)}</strong><span>resueltas por el asistente (${int(r.bot)})</span></div>
      <div><strong>${pct(r.traspasadas / r.total)}</strong><span>pasaron a una persona (${int(r.traspasadas)})</span></div>
    </div>
    <div class="split">
      ${r.bot ? `<div style="flex:${r.bot};background:${SERIES[0]}" data-tip="${esc(`Resueltas por el bot: <b>${r.bot}</b> (${pct(r.bot / r.total)})`)}"></div>` : ""}
      ${r.traspasadas ? `<div style="flex:${r.traspasadas};background:${SERIES[1]}" data-tip="${esc(`Traspasadas a una persona: <b>${r.traspasadas}</b> (${pct(r.traspasadas / r.total)})`)}"></div>` : ""}
    </div>
    <div class="legend"><span><i style="background:${SERIES[0]}"></i>Bot</span><span><i style="background:${SERIES[1]}"></i>Persona</span></div>`
    : '<p class="empty">Sin conversaciones en el período.</p>';

  const maxT = Math.max(1, ...s.tratamientos.map((t) => t.count));
  $("#ch-tratamientos").innerHTML = s.tratamientos.length ? s.tratamientos.map((t) => `
    <div class="hbar" data-tip="${esc(`${t.name}: <b>${t.count}</b> turnos`)}"><span>${esc(t.name)}</span>
      <div class="track"><div class="fill" style="width:${(t.count / maxT) * 100}%;background:${SERIES[0]}"></div></div><span class="v">${t.count}</span></div>`).join("")
    : '<p class="empty">Sin turnos en el período.</p>';

  $("#stats-table").innerHTML = `<tr><th>Día</th><th>Consultas</th><th>Pacientes nuevos</th><th>Agendados</th><th>Cancelados</th></tr>` +
    [...s.daily].reverse().map((d) => `<tr><td>${esc(dateOnly(d.date))}</td><td>${d.consultas}</td><td>${d.pacientesNuevos}</td><td>${d.turnosAgendados}</td><td>${d.turnosCancelados}</td></tr>`).join("");
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
  const m = c.currentMonth;
  note.hidden = !(c.onlyMock || c.simulated || !c.months.length);
  note.textContent = c.simulated
    ? `Los datos de ejemplo tienen costos ESTIMADOS con los precios oficiales de Claude Haiku 5.5 (figuran como «estimado»): no son mediciones. Medido este mes: ${usd(m.measuredUsd)}. Cada mensaje real con IA registra sus tokens y su costo medido.`
    : c.months.length
      ? "Hasta ahora respondió el modo sin IA (reglas), que no tiene costo. Con LLM_PROVIDER=claude u openai, cada mensaje registra sus tokens y su costo."
      : "Todavía no hay mensajes registrados en esta clínica.";
  const monthName = new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString("es", { month: "long", year: "numeric", timeZone: "UTC" });
  const est = m.estimated ? " (estimado)" : "";
  $("#cost-kpis").innerHTML = kpiHtml([
    [`Costo del mes${est}`, usd(m.costToDate), `${monthName} · día ${Math.ceil(m.daysElapsed)} de ${m.daysInMonth}`],
    [`Proyección a fin de mes${est}`, usd(m.projectedCost), "si sigue el ritmo actual"],
    ["Conversaciones del mes", int(m.conversations), `proyección ${int(m.projectedConversations)}`],
    [`Costo por conversación${est}`, m.conversations ? usd(m.costToDate / m.conversations) : "—", "promedio del mes"],
  ]);
  $("#cost-months").innerHTML = c.months.length ? `<tr><th>Mes</th><th>Conversaciones</th><th>Mensajes</th><th>Tokens entrada</th><th>Tokens salida</th><th>Caché</th><th>Costo</th><th>Por conversación</th></tr>` +
    c.months.map((r) => `<tr><td>${esc(r.month)}${r.estimatedUsd ? ' <span class="pill muted">estimado</span>' : ""}</td><td>${int(r.conversations)}</td><td>${int(r.turns)}</td><td>${int(r.inputTokens)}</td><td>${int(r.outputTokens)}</td><td>${int(r.cacheReadTokens)}</td><td>${usd(r.costUsd)}</td><td>${usd(r.costPerConversation)}</td></tr>`).join("")
    : `<tr><td class="empty">Sin datos.</td></tr>`;
  $("#cost-models").innerHTML = c.byModel.length ? `<tr><th>Proveedor · modelo</th><th>Mensajes</th><th>Costo</th></tr>` +
    c.byModel.map((r) => `<tr><td>${esc(r.model)}</td><td>${int(r.turns)}</td><td>${usd(r.costUsd)}</td></tr>`).join("")
    : `<tr><td class="empty">Sin datos.</td></tr>`;
  stamp();
}

// =====================================================================
// Aprendizaje: conocimiento, menú, documentos y probador
// =====================================================================
const form = $("#kb-form");
async function loadLearning() {
  const [k, docs] = await Promise.all([api("/knowledge"), api("/documents")]);
  state.knowledge = k.knowledge;
  state.canEdit = k.canEdit;
  fillKnowledge(k.knowledge);
  form.setAttribute("aria-disabled", String(!k.canEdit));
  for (const el of form.querySelectorAll("input, textarea, button, select")) el.disabled = !k.canEdit;
  $("#kb-mode").textContent = k.canEdit ? "Puede editar (admin)" : "Solo lectura: lo edita el admin. El probador sí lo puede usar.";
  $("#doc-upload").hidden = !docs.canEdit;
  renderDocs(docs.documents, docs.canEdit);
  if (!state.testerSession) newTester();
  stamp();
}

function fillKnowledge(k) {
  const set = (name, v) => { form.elements[name].value = v ?? ""; };
  for (const f of ["name", "phone", "address", "reference", "email", "payments", "insurance", "hoursText", "cancellationPolicy", "emergencies", "tone"]) set(f, k[f]);
  set("promoName", k.promo?.name);
  set("promoDetail", k.promo?.detail);
  form.elements.menuEnabled.checked = !!k.menu?.enabled;
  set("menuIntro", k.menu?.intro ?? "¿En qué le puedo ayudar? Elija una opción o escríbame su consulta.");
  set("menuButton", k.menu?.button ?? "Ver opciones");
  $("#kb-hours").innerHTML = DAYS.map((d, i) => {
    const h = (k.hours ?? []).find((x) => x.weekday === i + 1);
    const v = h ? h.blocks.map(([a, b]) => `${a}-${b}`).join(", ") : "";
    return `<span>${d}</span><input data-weekday="${i + 1}" value="${esc(v)}" placeholder="Cerrado · ej.: 09:00-13:00, 14:00-18:00" aria-label="Horario del ${d}" />`;
  }).join("");
  $("#kb-treatments").innerHTML = "";
  for (const t of k.treatments ?? []) addTreatment(t);
  $("#kb-faq").innerHTML = "";
  for (const f of k.faq ?? []) addFaq(f);
  $("#kb-menu").innerHTML = "";
  for (const o of k.menu?.options ?? []) addOption(o);
}
function addTreatment(t = {}) {
  const row = document.createElement("div");
  row.className = "row-t";
  row.innerHTML = `<input data-k="name" placeholder="Tratamiento" value="${esc(t.name)}" aria-label="Tratamiento" /><input data-k="price" placeholder="Precio" value="${esc(t.price)}" aria-label="Precio" />
    <input data-k="duration" placeholder="Duración" value="${esc(t.duration)}" aria-label="Duración" /><input data-k="notes" placeholder="Notas" value="${esc(t.notes)}" aria-label="Notas" />
    <button type="button" class="del" aria-label="Quitar">✕</button>`;
  $("#kb-treatments").append(row);
}
function addFaq(f = {}) {
  const row = document.createElement("div");
  row.className = "row-f";
  row.innerHTML = `<input data-k="q" placeholder="Pregunta" value="${esc(f.q)}" aria-label="Pregunta" /><input data-k="a" placeholder="Respuesta" value="${esc(f.a)}" aria-label="Respuesta" />
    <button type="button" class="del" aria-label="Quitar">✕</button>`;
  $("#kb-faq").append(row);
}
function addOption(o = {}) {
  if ($("#kb-menu").children.length >= 10) return toast("WhatsApp admite hasta 10 opciones en una lista", true);
  const row = document.createElement("div");
  row.className = "row-m";
  row.dataset.id = o.id ?? "";
  row.innerHTML = `<input data-k="label" placeholder="Título (hasta 24)" maxlength="24" value="${esc(o.label)}" aria-label="Título de la opción" />
    <input data-k="description" placeholder="Descripción (opcional)" maxlength="72" value="${esc(o.description)}" aria-label="Descripción" />
    <select data-k="kind" aria-label="Tipo"><option value="consulta"${o.kind !== "respuesta" ? " selected" : ""}>Consulta</option><option value="respuesta"${o.kind === "respuesta" ? " selected" : ""}>Respuesta fija</option></select>
    <input data-k="text" placeholder="Qué entiende el asistente / texto de la respuesta" value="${esc(o.text)}" aria-label="Texto" />
    <button type="button" class="del" aria-label="Quitar">✕</button>`;
  $("#kb-menu").append(row);
}
$("#add-treatment").addEventListener("click", () => addTreatment());
$("#add-faq").addEventListener("click", () => addFaq());
$("#add-option").addEventListener("click", () => addOption());
form.addEventListener("click", (e) => { const d = e.target.closest(".del"); if (d && state.canEdit) d.parentElement.remove(); });

const slug = (s, i) => (s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `opcion-${i + 1}`);
function readKnowledge() {
  const v = (n) => form.elements[n].value.trim();
  const rows = (sel) => [...$(sel).children].map((r) => Object.fromEntries([...r.querySelectorAll("input, select")].map((i) => [i.dataset.k, i.value.trim()])));
  const hours = [];
  for (const inp of $("#kb-hours").querySelectorAll("input")) {
    const txt = inp.value.trim();
    if (!txt) continue;
    const blocks = txt.split(/[,;]/).map((b) => b.trim()).filter(Boolean).map((b) => b.split(/\s*[-–a]\s*/).map((x) => x.padStart(5, "0")));
    hours.push({ weekday: Number(inp.dataset.weekday), blocks });
  }
  const used = new Set();
  const options = [...$("#kb-menu").children].map((r, i) => {
    const o = Object.fromEntries([...r.querySelectorAll("input, select")].map((x) => [x.dataset.k, x.value.trim()]));
    let id = r.dataset.id || slug(o.label, i);
    while (used.has(id)) id = `${id}-${i}`;
    used.add(id);
    return { id, label: o.label, ...(o.description ? { description: o.description } : {}), kind: o.kind, text: o.text };
  }).filter((o) => o.label || o.text);
  return {
    ...state.knowledge,
    name: v("name"), phone: v("phone"), address: v("address"), reference: v("reference"), email: v("email"),
    payments: v("payments"), insurance: v("insurance"), hoursText: v("hoursText"),
    cancellationPolicy: v("cancellationPolicy"), emergencies: v("emergencies"), tone: v("tone") || undefined,
    promo: { name: v("promoName"), detail: v("promoDetail") },
    hours,
    treatments: rows("#kb-treatments").filter((t) => t.name).map((t) => ({ name: t.name, price: t.price || "consultar", duration: t.duration || "30 min", notes: t.notes || "" })),
    faq: rows("#kb-faq").filter((f) => f.q && f.a),
    menu: { enabled: form.elements.menuEnabled.checked, intro: v("menuIntro"), button: v("menuButton") || "Ver opciones", options },
  };
}
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.canEdit) return;
  const btn = $("#kb-save");
  btn.disabled = true;
  try {
    const k = readKnowledge();
    await put("/knowledge", { knowledge: k });
    state.knowledge = k;
    toast("Guardado: el asistente ya responde con estos datos");
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
});

function renderDocs(list, canEdit) {
  $("#docs").innerHTML = list.length ? list.map((d) => `<li><div>📄 <b>${esc(d.name)}</b><div class="ch">${(d.sizeBytes / 1024).toFixed(0)} KB · ${d.chunks} fragmentos · ${esc(fShort(d.createdAt))}</div></div>
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
  $("#tester-thread").innerHTML = '<div class="b system">Escriba un mensaje para probar al asistente (por ejemplo «Hola» para ver el menú).</div>';
  $("#tester-tools").textContent = "";
}
$("#tester-reset").addEventListener("click", newTester);
function testerSay(text) {
  const th = $("#tester-thread");
  th.insertAdjacentHTML("beforeend", `<div class="b patient"><span class="b-author">Paciente</span>${fmt(text)}</div><div class="b system" id="tester-wait">escribiendo…</div>`);
  th.scrollTop = th.scrollHeight;
  return post("/tester", { text, session: state.testerSession }).then((r) => {
    $("#tester-wait")?.remove();
    r.messages.forEach((m, i) => {
      const ui = i === r.messages.length - 1 ? r.interactive : null;
      const opts = ui ? (ui.buttons ?? ui.list.rows.map((x) => x.title)) : [];
      th.insertAdjacentHTML("beforeend", `<div class="b bot"><span class="b-author">Asistente</span>${fmt(m)}${opts.length ? `<div class="b-options">${opts.map((o) => `<button type="button" data-try="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}</div>`);
    });
    if (!r.messages.length) th.insertAdjacentHTML("beforeend", '<div class="b system">(sin respuesta)</div>');
    $("#tester-tools").textContent = r.tools.length ? `Herramientas usadas: ${r.tools.join(", ")}` : "Respondió sin herramientas";
    th.scrollTop = th.scrollHeight;
  }).catch((err) => {
    $("#tester-wait")?.remove();
    th.insertAdjacentHTML("beforeend", `<div class="b system">${esc(err.message)}</div>`);
  });
}
$("#tester-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#tester-text");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  testerSay(text);
});
$("#tester-thread").addEventListener("click", (e) => {
  const b = e.target.closest("[data-try]");
  if (b) testerSay(b.dataset.try);
});

// =====================================================================
// Exportar a CSV: descarga directa (la cookie de sesión viaja sola; el servidor verifica clínica y rol)
// =====================================================================
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-export]");
  if (!b) return;
  const p = new URLSearchParams({ clinic: state.clinic ?? "" });
  if (b.dataset.export === "estadisticas") p.set("days", String(state.statsDays));
  location.href = `/api/panel/export/${b.dataset.export}?${p}`;
});
// =====================================================================
// Inicio: usuario, clínicas y rol
// =====================================================================
async function init() {
  const me = await api("/me");
  let saved = null;
  try { saved = localStorage.getItem("panel-clinic"); } catch {}
  state.clinic = me.clinics.some((c) => c.id === saved) ? saved : me.clinics[0]?.id ?? null;
  state.email = me.email;
  const sel = $("#clinic");
  sel.innerHTML = me.clinics.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  sel.value = state.clinic ?? "";
  $("#clinic-pick").hidden = me.clinics.length < 2;
  const applyClinic = async () => {
    const c = me.clinics.find((x) => x.id === state.clinic);
    state.role = c?.role ?? null;
    $("#who").textContent = `${me.email} · ${ROLE[state.role] ?? ""}`;
    $("#clinic-name").textContent = c?.name ?? "Panel del consultorio";
    document.title = `Panel · ${c?.name ?? ""}`;
    $("#open-sim").href = `/?clinica=${encodeURIComponent(state.clinic ?? "")}`;
    for (const b of $$(".tabs [data-admin]")) b.hidden = state.role !== "admin";
    try { TZ = (await (await fetch(`/api/config?clinica=${encodeURIComponent(state.clinic ?? "")}`)).json()).timezone ?? undefined; } catch {}
  };
  await applyClinic();
  sel.addEventListener("change", async () => {
    state.clinic = sel.value;
    try { localStorage.setItem("panel-clinic", state.clinic); } catch {}
    Object.assign(state, { date: null, weekFrom: null, testerSession: null, openConv: null, convSig: "", agenda: null });
    closeDrawer();
    $("#chat").hidden = true;
    $("#chat-empty").hidden = false;
    $("#profile").innerHTML = '<p class="ib-empty-small">La ficha del paciente aparece al abrir una conversación.</p>';
    await applyClinic();
    showView(state.view);
    refreshBadge();
  });
  showView(location.hash.slice(1) || "bandeja");
  // El contador de la pestaña se carga siempre, aunque se abra otra sección primero.
  refreshBadge();
  // Refresco automático de las vistas en vivo (sin pisar lo que se está escribiendo).
  setInterval(() => {
    const typing = document.activeElement?.closest?.("form.profile, #reply, .kb");
    if (state.view === "bandeja" && !typing) loadInbox().catch(() => {});
    else if (["resumen", "agenda"].includes(state.view) && !$("#drawer").classList.contains("show")) refreshCurrent();
    else refreshBadge();
  }, 10000);
}
init().catch((e) => ($("#updated").textContent = `error: ${e.message}`));
