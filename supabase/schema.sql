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
  whatsapp_phone_number_id  text unique,                 -- null = sin WhatsApp real (solo simulador)
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
  name        text,
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

-- Defensa contra la doble reserva, POR CLÍNICA: la base rechaza dos turnos activos en el
-- mismo horario de la misma clínica, aunque dos pedidos lleguen a la vez por canales distintos.
-- Dos clínicas distintas sí pueden tener un turno a la misma hora.
create unique index if not exists appointments_no_double_booking
  on appointments (clinic_id, start_at) where status in ('confirmada','pendiente');
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
  foreach t in array array['patients','conversations','appointments','handoffs'] loop
    execute format('drop policy if exists %I on %I', t || '_team', t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (clinic_id in (select public.my_clinic_ids()))
         with check (clinic_id in (select public.my_clinic_ids()))',
      t || '_team', t);
  end loop;
end $$;

-- Costos (tokens y USD): solo el admin.
drop policy if exists turn_metrics_admin on turn_metrics;
create policy turn_metrics_admin on turn_metrics for select to authenticated using (public.is_clinic_admin(clinic_id));

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
grant select, insert, update, delete on patients, conversations, appointments, handoffs to authenticated;
grant select, update on clinics to authenticated;
grant select on clinic_members, turn_metrics, test_results to authenticated;
revoke all on all tables in schema public from anon;
grant execute on function public.my_clinic_ids(), public.is_clinic_admin(text) to authenticated;
