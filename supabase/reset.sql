-- ⚠ BORRA todas las tablas del bot y sus datos (demo con datos ficticios).
-- Ejecutar en Supabase → SQL Editor ANTES de schema.sql al pasar a la versión multiempresa.
-- No toca los usuarios de Supabase Auth (auth.users).

drop table if exists document_chunks cascade;
drop table if exists documents     cascade;
drop table if exists test_results  cascade;
drop table if exists turn_metrics  cascade;
drop table if exists handoffs      cascade;
drop table if exists appointments  cascade;
drop table if exists conversations cascade;
drop table if exists patients      cascade;
drop table if exists clinic_members cascade;
drop table if exists clinics       cascade;
drop function if exists public.my_clinic_ids() cascade;
drop function if exists public.is_clinic_admin(text) cascade;
drop function if exists public.search_document_chunks(text, text, integer) cascade;
