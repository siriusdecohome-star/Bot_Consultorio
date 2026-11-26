-- Esquema del bot de citas, versión multiempresa (demo con datos ficticios).
-- Ejecutar completo en Supabase → SQL Editor. Se puede volver a ejecutar sin errores.
-- Si venía de la versión anterior (una sola clínica), ejecutar antes reset.sql.

-- ============================================================
-- Clínicas y usuarios del panel
-- ============================================================

create table if not exists clinics (
  id                        text primary key,            -- slug: 'sonrisa-clara', 'altamira'
  name                      text not null,
  timezone                  text not null,
  slot_minutes              integer not null default 30,
  whatsapp_phone_number_id  text unique,                 -- obsoleta: los números van en whatsapp_lines (se migra abajo)
  calendar_tag              text not null unique,        -- etiqueta `clinic` de sus eventos en Google Calendar
  is_primary                boolean not null default false,
  calendar_color            text not null default '10',
  knowledge                 jsonb not null,              -- horarios, tratamientos, precios, FAQ y tono
  created_at                timestamptz not null default now()
);

-- Qué usuario (Supabase Auth) trabaja en qué clínica y con qué rol.
create table if not exists clinic_members (
  user_id    uuid not null references auth.users(id) on delete cascade,
  clinic_id  text not null references clinics(id) on delete cascade,
  role       text not null check (role in ('admin','recepcion')),
  created_at timestamptz not null default now(),
  primary key (user_id, clinic_id)
);

-- ============================================================
-- Datos de cada clínica: todas las tablas llevan clinic_id
-- ============================================================

create table if not exists patients (
  id          text primary key,
  clinic_id   text not null references clinics(id) on delete cascade,
  phone       text not null,
  name        text,                       -- nombre real (lo pide el bot o lo corrige recepción)
  profile_name  text,                     -- nombre del perfil de WhatsApp (puede no ser el real)
  contact_phone text,                     -- teléfono de contacto editable (phone es la identidad del canal)
  notes       text not null default '',
  tags        text[] not null default '{}',
  channel     text not null,
  source      text,                       -- origen del lead, p. ej. 'promo-noviembre'
  created_at  timestamptz not null default now(),
  -- La misma persona puede ser paciente de dos clínicas: el teléfono es único por clínica.
  unique (clinic_id, phone)
);

create table if not exists conversations (
  id             text primary key,
  clinic_id      text not null references clinics(id) on delete cascade,
  patient_id     text not null references patients(id) on delete cascade,
  channel        text not null,
  llm_provider   text not null default '',
  llm_state      jsonb not null default '[]'::jsonb,   -- historial nativo del modelo (append-only)
  messages       jsonb not null default '[]'::jsonb,   -- mensajes legibles para el panel
  privacy_shown  boolean not null default false,
  handed_off     boolean not null default false,
  assigned_to    text,                                 -- quién tomó la conversación
  closed_at      timestamptz,                          -- cerrada (inactividad, turno confirmado/cancelado o a mano)
  closed_reason  text check (closed_reason in ('inactividad','turno_confirmado','turno_cancelado','manual')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (patient_id, channel)
);
create index if not exists conversations_clinic_idx on conversations (clinic_id, updated_at desc);

create table if not exists appointments (
  id                    text primary key,
  clinic_id             text not null references clinics(id) on delete cascade,
  patient_id            text not null references patients(id) on delete cascade,
  patient_name          text not null,
  treatment             text not null,
  start_at              timestamptz not null,
  end_at                timestamptz not null,
  status                text not null check (status in ('confirmada','pendiente','cancelada','reprogramada','asistio','ausente')),
  calendar_event_id     text not null default '',
  confirmed_by_patient  boolean not null default false,
  reminder24_sent       boolean not null default false,
  reminder2_sent        boolean not null default false,
  created_at            timestamptz not null default now()
);

-- La defensa contra la doble reserva es POR PROFESIONAL (ver «Multidoctores» más abajo):
-- dos profesionales pueden atender a la misma hora; uno solo, no.
create index if not exists appointments_clinic_start_idx on appointments (clinic_id, start_at);
create index if not exists appointments_patient_idx on appointments (patient_id);

create table if not exists handoffs (
  id               text primary key,
  clinic_id        text not null references clinics(id) on delete cascade,
  conversation_id  text not null references conversations(id) on delete cascade,
  patient_id       text not null references patients(id) on delete cascade,
  reason           text not null,
  summary          text not null,
  status           text not null default 'abierta' check (status in ('abierta','resuelta')),
  created_at       timestamptz not null default now()
);
create index if not exists handoffs_clinic_idx on handoffs (clinic_id, created_at desc);

-- Métricas por turno de conversación: tiempo de respuesta, tokens y costo.
create table if not exists turn_metrics (
  id                 bigserial primary key,
  clinic_id          text not null references clinics(id) on delete cascade,
  conversation_id    text not null,
  provider           text not null,
  model              text not null,
  latency_ms         integer not null,
  input_tokens       integer not null,
  output_tokens      integer not null,
  cache_read_tokens  integer not null,
  cost_usd           numeric(10,6) not null,
  model_calls        integer not null,
  tools              text[] not null default '{}',
  at                 timestamptz not null default now()
);
create index if not exists turn_metrics_clinic_idx on turn_metrics (clinic_id, at desc);

-- Resultados de las pruebas automatizadas: son del sistema, no de una clínica.
create table if not exists test_results (
  id            bigserial primary key,
  run_id        text not null,
  case_name     text not null,
  provider      text not null,
  model         text not null,
  passed        boolean not null,
  details       text,
  latency_ms    integer,
  cost_usd      numeric(10,6),
  created_at    timestamptz not null default now()
);

-- ============================================================
-- Panel y zona de aprendizaje (puntos 2 y 3). Con "if not exists" para poder
-- ejecutar el archivo otra vez sobre una base ya creada sin perder datos.
-- ============================================================

-- Pausa manual del bot en una conversación (sin derivarla).
alter table conversations add column if not exists bot_paused boolean not null default false;
-- Fecha de cancelación, para las estadísticas.
alter table appointments add column if not exists cancelled_at timestamptz;

-- Bandeja y ficha del paciente (etapa «bandeja, ficha y UX»).
alter table patients add column if not exists profile_name text;
alter table patients add column if not exists contact_phone text;
alter table patients add column if not exists notes text not null default '';
alter table patients add column if not exists tags text[] not null default '{}';
alter table conversations add column if not exists assigned_to text;
alter table conversations add column if not exists closed_at timestamptz;
alter table conversations add column if not exists closed_reason text;

-- Seguimientos (etapa 3): reglas por clínica y reglas ya enviadas por turno (sin envíos dobles).
alter table clinics add column if not exists settings jsonb;          -- reglas, horario de silencio, lista de espera
alter table appointments add column if not exists reminders_sent text[] not null default '{}';

-- Demo pública (etapa 4): clínicas temporales por visita, que se borran solas.
alter table clinics add column if not exists expires_at timestamptz;   -- null = clínica real
alter table clinics add column if not exists demo_owner text;          -- huella (hash) de la IP que la creó, para el límite diario

-- ============================================================
-- Multidoctores: profesionales, excepciones de agenda y doble reserva por profesional.
-- ============================================================
create extension if not exists btree_gist;

create table if not exists professionals (
  id          text not null,
  clinic_id   text not null references clinics(id) on delete cascade,
  name        text not null,
  specialty   text not null,
  color       text not null default '#25d366',
  hours       jsonb not null default '[]'::jsonb,    -- horario semanal: [{weekday, blocks: [["09:00","13:00"]]}]
  treatments  jsonb not null default '[]'::jsonb,    -- tratamientos que realiza: [{id, minutes}]
  calendar    text not null default 'interno' check (calendar in ('google','interno')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (clinic_id, id)
);

create table if not exists professional_exceptions (
  id               text primary key,
  clinic_id        text not null references clinics(id) on delete cascade,
  professional_id  text not null,
  kind             text not null check (kind in ('dia','franja','rango')),
  from_date        date not null,
  to_date          date not null,
  from_time        text,            -- solo en «franja», HH:mm local
  to_time          text,
  reason           text not null,
  created_by       text not null,
  notified_at      timestamptz,     -- cuándo se avisó por el bot a los pacientes afectados
  created_at       timestamptz not null default now(),
  foreign key (clinic_id, professional_id) references professionals (clinic_id, id) on delete cascade
);
create index if not exists professional_exceptions_by_clinic on professional_exceptions (clinic_id, from_date);

alter table appointments add column if not exists professional_id text;
-- Doble reserva por profesional: la base rechaza dos turnos activos del mismo profesional
-- que se SUPERPONGAN (no solo que empiecen igual: cada tratamiento dura distinto).
drop index if exists appointments_no_double_booking;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_no_double_booking_professional') then
    alter table appointments add constraint appointments_no_double_booking_professional
      exclude using gist (clinic_id with =, professional_id with =, tstzrange(start_at, end_at, '[)') with &&)
      where (status in ('confirmada','pendiente'));
  end if;
end $$;

-- Lista de espera (punto 4): si se libera un horario dentro del rango y la franja,
-- se le ofrece a la primera persona en espera.
create table if not exists waitlist (
  id              text primary key,
  clinic_id       text not null references clinics(id) on delete cascade,
  patient_id      text not null references patients(id) on delete cascade,
  patient_name    text not null,
  treatment       text not null,
  from_date       date not null,
  to_date         date not null,
  franja          text not null check (franja in ('manana','tarde','cualquiera')),
  status          text not null default 'esperando' check (status in ('esperando','ofrecido','aceptado','cancelado')),
  offered_slot    text,           -- horario ofrecido ahora, hora local YYYY-MM-DDTHH:mm
  offered_at      timestamptz,
  declined_slots  text[] not null default '{}',
  professional_id text,           -- null = cualquiera que haga el tratamiento
  created_at      timestamptz not null default now()
);
create index if not exists waitlist_clinic_status_idx on waitlist (clinic_id, status, created_at);

-- Documentos que sube el consultorio (PDF/Word/texto), ya convertidos a texto.
create table if not exists documents (
  id          text primary key,
  clinic_id   text not null references clinics(id) on delete cascade,
  name        text not null,
  mime        text not null,
  size_bytes  integer not null,
  chunks      integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Fragmentos de cada documento con su índice de búsqueda de texto en español.
-- Es búsqueda de texto (palabras), no vectores: ver README → "Documentos y búsqueda".
create table if not exists document_chunks (
  id           bigserial primary key,
  document_id  text not null references documents(id) on delete cascade,
  clinic_id    text not null references clinics(id) on delete cascade,
  ord          integer not null,
  content      text not null,
  tsv          tsvector generated always as (to_tsvector('spanish', content)) stored
);
create index if not exists document_chunks_tsv_idx on document_chunks using gin (tsv);
create index if not exists document_chunks_clinic_idx on document_chunks (clinic_id);

-- Los fragmentos más relevantes de una clínica para una consulta.
-- `q` llega con los términos unidos por "or" (si no, websearch_to_tsquery exige todos).
-- Corre con los permisos de quien llama: con el token de un usuario aplica el RLS.
create or replace function public.search_document_chunks(cid text, q text, max_results integer default 3)
returns table (document_id text, name text, content text, rank real)
language sql stable set search_path = public as $$
  select c.document_id, d.name, c.content, ts_rank(c.tsv, websearch_to_tsquery('spanish', q)) as rank
  from document_chunks c
  join documents d on d.id = c.document_id
  where c.clinic_id = cid and c.tsv @@ websearch_to_tsquery('spanish', q)
  order by rank desc
  limit greatest(1, least(max_results, 10))
$$;

-- ============================================================
-- Seguridad por clínica (RLS)
-- ============================================================
-- El panel consulta la base con el token del usuario (rol `authenticated`):
-- las políticas limitan cada fila a las clínicas del usuario.
-- El bot, el webhook y los recordatorios usan la clave secreta (`service_role`),
-- que saltea el RLS; por eso el código del servidor filtra siempre por clinic_id.

-- Clínicas del usuario conectado. `security definer` evita que la política de
-- clinic_members se llame a sí misma.
create or replace function public.my_clinic_ids()
returns setof text language sql stable security definer set search_path = public as $$
  select clinic_id from clinic_members where user_id = auth.uid()
$$;

create or replace function public.is_clinic_admin(cid text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from clinic_members where user_id = auth.uid() and clinic_id = cid and role = 'admin')
$$;

alter table clinics        enable row level security;
alter table clinic_members enable row level security;
alter table patients       enable row level security;
alter table conversations  enable row level security;
alter table appointments   enable row level security;
alter table handoffs       enable row level security;
alter table turn_metrics   enable row level security;
alter table test_results   enable row level security;
alter table waitlist       enable row level security;
alter table waitlist add column if not exists professional_id text;
alter table professionals            enable row level security;
alter table professional_exceptions  enable row level security;

-- ============================================================
-- Líneas de WhatsApp: una clínica puede tener varios números (Cloud API) y líneas simuladas
-- (simulador de la demo). El webhook elige clínica y línea por el número que recibió el mensaje.
-- ============================================================
create table if not exists whatsapp_lines (
  id               text primary key,
  clinic_id        text not null references clinics(id) on delete cascade,
  name             text not null,                    -- lo que ve el equipo: «Recepción», «Ortodoncia · Dr. Ríos»
  kind             text not null check (kind in ('cloud','simulada')),
  phone_number_id  text unique,                      -- «Identificador del número de teléfono» de Meta (solo cloud)
  display_phone    text,
  professional_id  text,                             -- línea de un profesional (opcional)
  area             text,                             -- línea de un área (opcional, texto libre)
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  check (kind = 'simulada' or phone_number_id is not null),
  foreign key (clinic_id, professional_id) references professionals (clinic_id, id) on delete set null (professional_id)
);
create index if not exists whatsapp_lines_by_clinic on whatsapp_lines (clinic_id);
alter table whatsapp_lines enable row level security;
-- Migración: el número que estaba en clinics pasa a ser la línea «Recepción».
insert into whatsapp_lines (id, clinic_id, name, kind, phone_number_id)
  select id || '-recepcion', id, 'Recepción', 'cloud', whatsapp_phone_number_id from clinics where whatsapp_phone_number_id is not null
  on conflict do nothing;
-- Línea de cada conversación (y la última de cada paciente): la respuesta y los avisos salen por ahí.
alter table conversations add column if not exists line_id text references whatsapp_lines(id) on delete set null;
alter table patients      add column if not exists line_id text references whatsapp_lines(id) on delete set null;

-- ============================================================
-- Estado común a todas las instancias (Vercel): lo usa solo el servidor, con la clave secreta.
-- RLS activado y sin políticas: el panel (authenticated) y anon no pueden leerlo.
-- ============================================================
-- Mensajes de WhatsApp ya procesados: Meta reintenta los avisos y no hay que responder dos veces.
create table if not exists processed_messages (
  id  text primary key,
  at  timestamptz not null default now()
);
-- Límites de uso por IP (chat del simulador y login del panel).
create table if not exists rate_hits (
  key  text not null,
  at   timestamptz not null default now()
);
create index if not exists rate_hits_by_key on rate_hits (key, at);
-- Bandeja del simulador: mensajes que el bot envía por su cuenta (recordatorios, ofertas) a una sesión web.
create table if not exists web_outbox (
  id          bigserial primary key,
  box         text not null,            -- «clínica|sesión»
  message     jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists web_outbox_by_box on web_outbox (box);
alter table processed_messages enable row level security;
alter table rate_hits          enable row level security;
alter table web_outbox         enable row level security;

-- Las políticas se recrean para que el archivo se pueda volver a ejecutar.
drop policy if exists clinics_read  on clinics;
drop policy if exists clinics_admin on clinics;
create policy clinics_read  on clinics for select to authenticated using (id in (select public.my_clinic_ids()));
-- Solo el admin edita la configuración y el conocimiento de su clínica.
create policy clinics_admin on clinics for update to authenticated
  using (public.is_clinic_admin(id)) with check (public.is_clinic_admin(id));

drop policy if exists members_read on clinic_members;
create policy members_read on clinic_members for select to authenticated
  using (user_id = auth.uid() or public.is_clinic_admin(clinic_id));

-- Pacientes, conversaciones, turnos y derivaciones: todo el equipo de la clínica (admin y recepción).
do $$
declare t text;
begin
  foreach t in array array['patients','conversations','appointments','handoffs','waitlist','professional_exceptions'] loop
    execute format('drop policy if exists %I on %I', t || '_team', t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (clinic_id in (select public.my_clinic_ids()))
         with check (clinic_id in (select public.my_clinic_ids()))',
      t || '_team', t);
  end loop;
end $$;

-- Profesionales: todo el equipo los ve; solo el admin los edita.
drop policy if exists professionals_read  on professionals;
drop policy if exists professionals_admin on professionals;
create policy professionals_read  on professionals for select to authenticated using (clinic_id in (select public.my_clinic_ids()));
create policy professionals_admin on professionals for all to authenticated
  using (public.is_clinic_admin(clinic_id)) with check (public.is_clinic_admin(clinic_id));

-- Documentos: todo el equipo los lee (el probador y el bot los usan); solo el admin los sube o borra.
alter table documents       enable row level security;
alter table document_chunks enable row level security;
drop policy if exists documents_read  on documents;
drop policy if exists documents_admin on documents;
drop policy if exists chunks_read     on document_chunks;
drop policy if exists chunks_admin    on document_chunks;
create policy documents_read  on documents for select to authenticated using (clinic_id in (select public.my_clinic_ids()));
create policy documents_admin on documents for all to authenticated
  using (public.is_clinic_admin(clinic_id)) with check (public.is_clinic_admin(clinic_id));
create policy chunks_read  on document_chunks for select to authenticated using (clinic_id in (select public.my_clinic_ids()));
create policy chunks_admin on document_chunks for all to authenticated
  using (public.is_clinic_admin(clinic_id)) with check (public.is_clinic_admin(clinic_id));

-- Costos (tokens y USD): solo el admin.
drop policy if exists turn_metrics_admin on turn_metrics;
create policy turn_metrics_admin on turn_metrics for select to authenticated using (public.is_clinic_admin(clinic_id));

-- Líneas de WhatsApp: el equipo las ve; se dan de alta con la clave secreta (seed o alta de un número).
drop policy if exists whatsapp_lines_read on whatsapp_lines;
create policy whatsapp_lines_read on whatsapp_lines for select to authenticated using (clinic_id in (select public.my_clinic_ids()));

-- Resultados de pruebas: lectura para cualquier usuario del panel.
drop policy if exists test_results_read on test_results;
create policy test_results_read on test_results for select to authenticated using (true);

-- ============================================================
-- Permisos
-- ============================================================
-- Los proyectos nuevos de Supabase no otorgan acceso automático a las tablas creadas
-- por SQL. service_role (clave secreta): todo. authenticated (panel): lo que permitan
-- las políticas de arriba. anon (clave pública sin sesión): nada.
grant usage on schema public to service_role, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant select, insert, update, delete on patients, conversations, appointments, handoffs, waitlist, professional_exceptions, professionals to authenticated;
grant select, update on clinics to authenticated;
grant select on clinic_members, turn_metrics, test_results, whatsapp_lines to authenticated;
grant select, insert, delete on documents, document_chunks to authenticated;
grant usage, select on sequence document_chunks_id_seq to authenticated;
revoke all on all tables in schema public from anon;
grant execute on function public.my_clinic_ids(), public.is_clinic_admin(text) to authenticated;
grant execute on function public.search_document_chunks(text, text, integer) to authenticated, service_role;
