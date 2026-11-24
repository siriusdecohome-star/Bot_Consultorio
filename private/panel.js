// Panel de gestión: lee /api/panel/summary y se actualiza solo cada 15 s.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => esc(s).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>");
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
};
const usd = (n) => (n ? `USD ${n.toFixed(4)}` : "USD 0");
const ms = (n) => `${(n / 1000).toFixed(2)} s`;
const CH = { whatsapp: "WhatsApp", web: "Simulador", cli: "Consola", test: "Prueba" };
const STATUS = {
  confirmada: ["Confirmada", "ok"], pendiente: ["Pendiente", "wait"], cancelada: ["Cancelada", "bad"],
  reprogramada: ["Reprogramada", "muted"], asistio: ["Asistió", "ok"], ausente: ["Ausente", "bad"],
};

let state = { date: null, openConv: null, clinic: null };
const ROLE = { admin: "Admin", recepcion: "Recepción" };

/** Todas las llamadas llevan la clínica elegida (el servidor verifica que sea del usuario). */
async function api(path, opts) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`/api/panel${path}${state.clinic ? `${sep}clinic=${encodeURIComponent(state.clinic)}` : ""}`, opts);
  if (r.status === 401) { location.href = "/panel"; throw new Error("Sesión vencida"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}

let toastT;
function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2800);
}

async function load() {
  let d;
  try {
    d = await api(`/summary${state.date ? `?date=${state.date}` : ""}`);
  } catch (e) {
    $("#updated").textContent = `error: ${e.message}`;
    return;
  }
  state.date ??= d.date;
  $("#clinic-name").textContent = d.clinic.name;
  document.title = `Panel · ${d.clinic.name}`;
  $("#date").value = d.date;
  $("#updated").textContent = `actualizado ${new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`;
  renderKpis(d);
  renderAppts(d);
  renderConvs(d.conversations);
  renderHandoffs(d.handoffs);
  renderLeads(d.leads);
  state.role = d.role;
  renderMetrics(d.metrics);
  renderTests(d.tests);
}

function renderKpis({ kpis: k, metrics: m }) {
  const items = [
    ["Citas del día", k.appointmentsToday, `${k.confirmedToday} confirmadas`],
    ["Próximos 7 días", k.next7Days, "turnos activos"],
    ["Cancelaciones del día", k.cancelledToday, "horarios liberados"],
    ["Derivaciones abiertas", k.openHandoffs, "esperan a una persona", k.openHandoffs > 0],
    ["Leads sin turno", k.leadsWithoutAppointment, "de la promo"],
  ];
  // Tiempos y costos: solo para el admin.
  if (m) items.push(
    ["Respuesta (mediana)", m.turns ? ms(m.medianLatencyMs) : "—", m.turns ? `p95 ${ms(m.p95LatencyMs)}` : "sin datos"],
    ["Costo por conversación", m.turns ? usd(m.avgCostPerConversation) : "—", m.provider],
  );
  $("#kpis").innerHTML = items.map(([l, v, s, alert]) =>
    `<div class="kpi${alert ? " alert" : ""}"><span>${l}</span><strong>${esc(v)}</strong><small>${esc(s)}</small></div>`).join("");
}

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

function renderConvs(list) {
  $("#convs").innerHTML = list.length ? list.map((c) => {
    const name = c.patient ?? c.phone ?? "Paciente";
    const initials = name.replace(/[^\p{L} ]/gu, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
    return `<li class="conv" data-id="${esc(c.id)}">
      <div class="avatar">${esc(initials)}</div>
      <div style="min-width:0"><div class="who">${esc(name)} <span class="ch">· ${esc(CH[c.channel] ?? c.channel)}${c.source ? ` · ${esc(c.source)}` : ""}</span></div>
        <div class="last">${esc(c.lastText)}</div></div>
      <div class="meta">${ago(c.lastAt)}${c.handedOff ? '<span class="pill wait">Con una persona</span>' : '<span class="pill info">Bot</span>'}</div>
    </li>`;
  }).join("") : `<li class="empty">Todavía no hay conversaciones.</li>`;
}

function renderHandoffs(list) {
  const open = list.filter((h) => h.status === "abierta").length;
  const badge = $("#ho-count");
  badge.textContent = open;
  badge.classList.toggle("zero", !open);
  const REASON = { pedido_del_paciente: "Pidió una persona", consulta_clinica: "Consulta clínica", urgencia: "Urgencia", queja: "Queja", sin_informacion: "Sin información", otro: "Otro" };
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
    <li class="lead"><div><strong>${esc(l.name ?? l.phone)}</strong><br><small>${esc(CH[l.channel] ?? l.channel)} · ${ago(l.lastContact)}</small></div>
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

// ---------- Detalle de conversación ----------
async function openConv(id) {
  state.openConv = id;
  let c;
  try { c = await api(`/conversation/${encodeURIComponent(id)}`); } catch (e) { return toast(e.message, true); }
  $("#d-title").textContent = c.patient.name ?? c.patient.phone ?? "Paciente";
  $("#d-sub").textContent = `${CH[c.channel] ?? c.channel}${c.patient.source ? ` · ${c.patient.source}` : ""} · ${c.handedOff ? "atendida por una persona" : "atendida por el bot"}`;
  $("#d-appts").innerHTML = c.appointments.length
    ? c.appointments.map((a) => { const [l, cls] = STATUS[a.status] ?? [a.status, "muted"]; return `<span class="pill ${cls}">${esc(a.when)} · ${l}${a.confirmed ? " ✓" : ""}</span>`; }).join("")
    : '<span class="ch">Sin turnos</span>';
  const TAG = { reminder24: "⏰ Recordatorio 24 h", reminder2: "⏰ Recordatorio 2 h", followup: "📣 Seguimiento" };
  $("#thread").innerHTML = c.messages.map((m) => `
    <div class="b ${m.role}">${m.meta ? `<span class="tag">${TAG[m.meta.kind] ?? ""}</span><br>` : m.role === "human" ? '<span class="tag">👩‍⚕️ Recepción</span><br>' : ""}${fmt(m.text)}
      <small>${new Date(m.at).toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></div>`).join("");
  $("#drawer").classList.add("show");
  $("#drawer-bg").classList.add("show");
  $("#thread").scrollTop = $("#thread").scrollHeight;
}
function closeConv() {
  state.openConv = null;
  $("#drawer").classList.remove("show");
  $("#drawer-bg").classList.remove("show");
}

document.addEventListener("click", async (e) => {
  const conv = e.target.closest(".conv");
  if (conv) return openConv(conv.dataset.id);
  const open = e.target.closest("[data-open]");
  if (open) return openConv(open.dataset.open);
  const res = e.target.closest("[data-resolve]");
  if (res) {
    res.disabled = true;
    try {
      await api(`/handoff/${encodeURIComponent(res.dataset.resolve)}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnToBot: true }),
      });
      toast("Derivación resuelta: la conversación vuelve al asistente");
      load();
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
    const r = await api(`/conversation/${encodeURIComponent(state.openConv)}/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    $("#reply-text").value = "";
    toast(r.how === "omitido" ? "Guardado (ese canal no tiene envío activo)" : "Mensaje enviado al paciente");
    openConv(state.openConv);
  } catch (err) { toast(err.message, true); }
});
$("#date").addEventListener("change", (e) => { state.date = e.target.value; load(); });
$("#today").addEventListener("click", () => { state.date = null; load(); });

/** Sección (tarjeta) que contiene un elemento: para ocultar las que no corresponden al rol. */
function sectionOf(sel) {
  return $(sel).closest("section, .card") ?? $(sel);
}

/** Usuario y clínicas: el selector aparece solo si trabaja en más de una. */
async function init() {
  const me = await api("/me");
  let saved = null;
  try { saved = localStorage.getItem("panel-clinic"); } catch {}
  state.clinic = me.clinics.some((c) => c.id === saved) ? saved : me.clinics[0]?.id ?? null;
  const sel = $("#clinic");
  sel.innerHTML = me.clinics.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  sel.value = state.clinic ?? "";
  $("#clinic-pick").hidden = me.clinics.length < 2;
  const showWho = () => {
    const role = me.clinics.find((c) => c.id === state.clinic)?.role;
    $("#who").textContent = `${me.email} · ${ROLE[role] ?? ""}`;
  };
  showWho();
  sel.addEventListener("change", () => {
    state.clinic = sel.value;
    try { localStorage.setItem("panel-clinic", state.clinic); } catch {}
    showWho();
    state.openConv = null;
    load();
  });
  await load();
  setInterval(() => !state.openConv && load(), 15000);
}
init().catch((e) => ($("#updated").textContent = `error: ${e.message}`));
