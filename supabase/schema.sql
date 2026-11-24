-- Esquema del bot de citas (demo con datos ficticios).
-- Ejecutar completo en Supabase → SQL Editor. Se puede volver a ejecutar sin errores.

create table if not exists patients (
  id          text primary key,
  phone       text not null unique,
  name        text,
  channel     text not null,
  source      text,                       -- origen del lead, p. ej. 'promo-noviembre'
  created_at  timestamptz not null default now()
);

create table if not exists conversations (
  id             text primary key,
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

create table if not exists appointments (
  id                    text primary key,
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

-- Defensa contra la doble reserva: la base rechaza dos turnos activos en el mismo horario,
-- aunque dos pedidos lleguen al mismo tiempo desde canales distintos.
create unique index if not exists appointments_no_double_booking
  on appointments (start_at) where status in ('confirmada','pendiente');

create index if not exists appointments_start_idx on appointments (start_at);
create index if not exists appointments_patient_idx on appointments (patient_id);

create table if not exists handoffs (
  id               text primary key,
  conversation_id  text not null references conversations(id) on delete cascade,
  patient_id       text not null references patients(id) on delete cascade,
  reason           text not null,
  summary          text not null,
  status           text not null default 'abierta' check (status in ('abierta','resuelta')),
  created_at       timestamptz not null default now()
);

-- Métricas por turno de conversación: tiempo de respuesta, tokens y costo.
create table if not exists turn_metrics (
  id                 bigserial primary key,
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

-- Resultados de las pruebas automatizadas (etapa 6).
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

-- Seguridad: RLS activado y sin políticas = nadie accede con la clave pública.
-- El backend usa la clave secreta, que saltea RLS.
alter table patients      enable row level security;
alter table conversations enable row level security;
alter table appointments  enable row level security;
alter table handoffs      enable row level security;
alter table turn_metrics  enable row level security;
alter table test_results  enable row level security;

-- Permisos: los proyectos nuevos de Supabase no otorgan acceso automático a las
-- tablas creadas por SQL. Se habilita SOLO al rol del backend (service_role),
-- que es el que usa la clave secreta. anon/authenticated quedan sin acceso.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
