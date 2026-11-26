-- ============================================================
-- Trabajo periódico en Vercel: cada 5 minutos Supabase llama a POST /api/cron/tick.
-- Hace los recordatorios, seguimientos, la lista de espera, el cierre por inactividad,
-- el borrado de las demos vencidas y la limpieza del estado compartido.
-- (El cron de Vercel en el plan gratuito corre una vez por día: por eso se usa el de Supabase.)
--
-- Antes de ejecutar:
-- 1) Guardá el mismo valor que pusiste en CRON_SECRET (variables de entorno de Vercel) en el
--    Vault de Supabase con el nombre «cron_secret»: Project Settings → Vault → Add new secret.
--    Así la clave no queda escrita en este archivo ni en el repositorio.
-- 2) Reemplazá TU-PROYECTO por la dirección de tu despliegue en Vercel.
-- Se puede volver a ejecutar: reemplaza la tarea si ya existía.
-- ============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('bot-consultorio-tick')
where exists (select 1 from cron.job where jobname = 'bot-consultorio-tick');

select cron.schedule(
  'bot-consultorio-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://TU-PROYECTO.vercel.app/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Para revisar las últimas ejecuciones:
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select status_code, content from net._http_response order by created desc limit 5;
