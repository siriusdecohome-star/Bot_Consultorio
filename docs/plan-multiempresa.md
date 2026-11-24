# Plan del multiempresa (punto 5) — para aprobar antes de tocar el código

**Objetivo:** dos clínicas ficticias con datos separados en la misma instalación, que es la base del MVP SaaS. La seguridad la hace la propia base (RLS) para los usuarios del panel.

| | Clínica A | Clínica B |
|---|---|---|
| Nombre | Clínica Dental Sonrisa Clara (la actual) | Centro Odontológico Altamira (nueva, ficticia) |
| `slug` | `sonrisa-clara` | `altamira` |
| WhatsApp | Número de prueba de Meta (real) | Solo simulador |
| Agenda | Calendario principal, eventos etiquetados `clinic=sonrisa-clara` | Mismo calendario, eventos etiquetados `clinic=altamira` y con otro color |
| Zona horaria | America/La_Paz | America/La_Paz (el campo es por clínica) |
| Tratamientos y precios | Los actuales | Otros distintos, para que se note la separación |

## 1. Tablas

**Nuevas:**

```sql
clinics (
  id text primary key,                 -- 'sonrisa-clara', 'altamira'
  name text not null,
  timezone text not null,
  slot_minutes int not null default 30,
  whatsapp_phone_number_id text unique, -- null = sin WhatsApp real (Clínica B)
  calendar_tag text not null,           -- etiqueta de sus eventos en Google Calendar
  knowledge jsonb not null,             -- horarios, tratamientos, precios, FAQ, tono (el punto 3 le pone editor)
  created_at timestamptz default now()
)

clinic_members (
  user_id uuid references auth.users(id) on delete cascade,
  clinic_id text references clinics(id) on delete cascade,
  role text not null check (role in ('admin','recepcion')),
  primary key (user_id, clinic_id)
)
```

**Las tablas que ya existen suman `clinic_id text not null references clinics(id)`:** `patients`, `conversations`, `appointments`, `handoffs`, `turn_metrics`. Las tres primeras ya tienen una columna `id` propia (`patients.id`, `conversations.id`, `appointments.id`), así que alcanza con agregar la columna y su índice. `test_results` queda global, porque son corridas de prueba del sistema.

**Cambios de claves:**
- `patients.phone unique` pasa a `unique (clinic_id, phone)`. La misma persona puede ser paciente de las dos clínicas sin que se mezclen sus datos.
- Los id de paciente y conversación llevan la clínica como prefijo (`altamira:wa:591…`), para que no choquen.

## 2. Índice de doble reserva por clínica

```sql
-- antes
create unique index appointments_no_double_booking on appointments (start_at)
  where status in ('confirmada','pendiente');
-- después
create unique index appointments_no_double_booking on appointments (clinic_id, start_at)
  where status in ('confirmada','pendiente');
```

- Las dos clínicas pueden tener un turno a la misma hora, pero ninguna puede tener dos turnos en el mismo horario.
- Se mantiene el supuesto actual de un sillón por clínica. Si una clínica tiene varios profesionales, más adelante se agrega `dentist_id` al índice.
- El candado en memoria pasa a ser por clínica.

## 3. RLS (seguridad por clínica)

- Una función `my_clinic_ids()` (`security definer`) devuelve las clínicas de `auth.uid()` según `clinic_members`.
- Políticas para el rol `authenticated` en cada tabla: `clinic_id in (select my_clinic_ids())`.
- Acciones solo para admin: editar `clinics` (conocimiento, tono, horarios), ver Costos y gestionar usuarios. La recepcionista ve conversaciones, agenda, pacientes y estadísticas de su clínica.
- **El bot y el webhook siguen usando la clave secreta (`service_role`), que se saltea el RLS**, porque no hay un usuario logueado cuando escribe un paciente. Por eso el código del servidor filtra siempre por `clinic_id`, y hay una prueba que lo verifica.

## 4. Login del panel con Supabase Auth

- Hay cuatro usuarios ficticios: `admin@sonrisaclara.demo.test`, `recepcion@sonrisaclara.demo.test`, `admin@altamira.demo.test` y `recepcion@altamira.demo.test`.
- **Cómo se crean:** un script (`npm run seed:users`) los crea con la API de administración de Supabase, con el correo ya confirmado y sin enviar mails. Genera las contraseñas y las guarda en el `.env` como `DEMO_*_PASSWORD`. Nunca van al repositorio ni al chat.
- **Cómo entra un usuario:** el servidor inicia la sesión en Supabase y guarda el token en una cookie `httpOnly`. Después, el panel consulta Supabase con ese token, así que el RLS se aplica de verdad.
- **El selector de clínica** del panel solo muestra las clínicas del usuario, y el admin puede tener más de una.
- En el modo en memoria (entorno de pruebas) los mismos usuarios y roles salen de la carga de ejemplo, y el filtro se aplica en el código.
- `PANEL_USER` y `PANEL_PASSWORD` se eliminan.

## 5. Webhook por número

- **Cómo se elige la clínica:** cada aviso de Meta trae `metadata.phone_number_id`, que se busca en `clinics.whatsapp_phone_number_id`.
- **Desde qué número se responde:** desde el mismo que recibió el mensaje. `WHATSAPP_PHONE_NUMBER_ID` del `.env` solo se usa para cargar la Clínica A en la carga de ejemplo.
- **Número desconocido:** se responde 200 a Meta y se registra en el log, sin contestar al paciente.
- **El token y la clave secreta de la app siguen siendo globales** (una sola app de Meta). En un SaaS real cada clínica conectaría su número con Embedded Signup y tendría su propio token. Lo dejo documentado como paso siguiente.

## 6. Lo que cambia en el resto del código

- **Simulador:** suma un selector de clínica (`/?clinica=altamira`) y cada clínica tiene su propia agenda y conversación.
- **Motor, herramientas y prompt:** reciben la clínica. El prompt se arma con el conocimiento de esa clínica y queda en la caché por separado para cada una.
- **Agenda:**
  - La Clínica A ve como ocupados sus eventos y los eventos sin etiqueta del calendario (como hoy).
  - La Clínica B ve solo los suyos.
  - Los eventos de cada una se crean con su etiqueta y su color.
- **Recordatorios y seguimientos:** recorren todas las clínicas, cada una con su zona horaria y su número.
- **`src/data/knowledge.ts`:** deja de ser la fuente en vivo. Queda como contenido de la carga de ejemplo de la Clínica A, y se suma `knowledge-altamira.ts`.

## 7. Datos y migración

- Los datos actuales se pierden. Hay un `supabase/reset.sql` que borra las tablas y `schema.sql` las vuelve a crear con `clinic_id`.
- **Qué hacés vos:** ejecutar `reset.sql` y `schema.sql` en el SQL Editor de Supabase.
- **Qué hago yo después:** `npm run seed` (las dos clínicas y sus turnos), `npm run seed:users` y las pruebas.
- Los 30 días de datos de ejemplo quedan para el punto 7, como acordamos.

## 8. Pruebas

- Las 8 pruebas de escenarios, las 12 de WhatsApp y las 10 de recordatorios siguen corriendo sobre la Clínica A.
- **Pruebas nuevas:**
  - El mismo teléfono en las dos clínicas da dos pacientes distintos.
  - La misma hora en las dos clínicas se puede reservar, y la doble reserva dentro de una misma clínica se rechaza.
  - El webhook con el número de la Clínica A va a la A, y con un número desconocido se ignora.
  - **Contra Supabase real:** la recepcionista de la A no ve nada de la B, no puede editar la configuración y no ve Costos.

## 9. Qué cambia de lo entregado hasta la etapa 7

- **`schema.sql` y `seed.sql`:** se rehacen.
- **Panel:** el login pasa a ser con usuario de Supabase y se elimina el usuario único. Los indicadores y la tabla de pruebas actuales siguen, dentro del panel nuevo del punto 2.
- **README, caso de estudio en PDF, guion y capturas:** se actualizan en el punto 8, y el PDF se vuelve a generar.
- **No cambia:** WhatsApp real de la Clínica A, recordatorios con botones, plantillas, la regla contra la doble reserva, los proveedores de IA ni el modo sin IA.
