-- Datos de ejemplo FICTICIOS. Ejecutar después de schema.sql.
-- Los turnos se crean relativos a la fecha actual, así la demo siempre tiene datos "de hoy".
-- Se puede volver a ejecutar: primero borra los datos demo anteriores.

delete from patients where id like 'demo_%';

insert into patients (id, phone, name, channel, source) values
  ('demo_p1', '+5491100001001', 'Lucía Fernández (demo)', 'whatsapp', 'promo-noviembre'),
  ('demo_p2', '+5491100001002', 'Carlos Gómez (demo)',    'whatsapp', 'promo-noviembre'),
  ('demo_p3', '+5491100001003', 'Sofía Martínez (demo)',  'web',      null),
  ('demo_p4', '+5491100001004', 'Diego Romero (demo)',    'whatsapp', 'promo-noviembre'),
  ('demo_p5', '+5491100001005', null,                     'whatsapp', 'promo-noviembre'); -- lead que no agendó

-- Turnos (hora local de Buenos Aires, UTC-3)
insert into appointments (id, patient_id, patient_name, treatment, start_at, end_at, status, confirmed_by_patient) values
  ('demo_c1', 'demo_p1', 'Lucía Fernández (demo)', 'Limpieza + control (Promo)',
     (current_date + time '15:00') at time zone 'America/Argentina/Buenos_Aires',
     (current_date + time '15:30') at time zone 'America/Argentina/Buenos_Aires', 'confirmada', true),
  ('demo_c2', 'demo_p2', 'Carlos Gómez (demo)', 'Consulta y diagnóstico',
     (current_date + 1 + time '12:00') at time zone 'America/Argentina/Buenos_Aires',
     (current_date + 1 + time '12:30') at time zone 'America/Argentina/Buenos_Aires', 'confirmada', false),
  ('demo_c3', 'demo_p3', 'Sofía Martínez (demo)', 'Consulta de ortodoncia',
     (current_date + 2 + time '17:00') at time zone 'America/Argentina/Buenos_Aires',
     (current_date + 2 + time '17:30') at time zone 'America/Argentina/Buenos_Aires', 'confirmada', false),
  ('demo_c4', 'demo_p4', 'Diego Romero (demo)', 'Arreglo de caries',
     (current_date - 1 + time '10:00') at time zone 'America/Argentina/Buenos_Aires',
     (current_date - 1 + time '10:30') at time zone 'America/Argentina/Buenos_Aires', 'cancelada', false);

insert into conversations (id, patient_id, channel, llm_provider, messages, privacy_shown) values
  ('demo_v5', 'demo_p5', 'whatsapp', 'mock',
   '[{"role":"patient","text":"Hola, cuánto sale la limpieza de la promo?","at":"2026-11-20T13:00:00Z"},
     {"role":"bot","text":"Promo Sonrisa Noviembre: limpieza + consulta de control a USD 29. ¿Le reservo un turno?","at":"2026-11-20T13:00:02Z"}]'::jsonb,
   true);
