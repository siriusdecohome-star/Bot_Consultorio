# Guía: crear las cuentas de Supabase y Google Calendar

Las dos son gratuitas y no piden tarjeta. Tiempo estimado: 20–30 minutos.
**Nunca pegues claves en el chat:** van solo en el archivo `.env` (que no se sube al repositorio).

> Las pantallas de Supabase y Google Cloud cambian seguido. Si algún nombre de menú no coincide, buscá la opción equivalente o avisame y lo revisamos en la documentación oficial.

---

## Parte A — Supabase (base de datos)

### A1. Crear la cuenta y el proyecto

1. Entrá a https://supabase.com y tocá **Start your project**. Podés registrarte con GitHub o con correo.
2. Si te pide crear una **Organization**, poné un nombre (por ejemplo "Portafolio") y elegí el plan **Free**.
3. Tocá **New project** y completá:
   - **Name:** `bot-consultorio`
   - **Database password:** generá una y guardala en tu gestor de contraseñas. El bot no la usa, pero sirve si algún día te conectás a la base directamente.
   - **Region:** la más cercana, por ejemplo **South America (São Paulo)**.
4. Tocá **Create new project** y esperá 1–2 minutos a que termine de prepararse.

### A2. Crear las tablas

1. En el menú izquierdo, abrí **SQL Editor** y tocá **New query**.
2. Abrí en VS Code el archivo `supabase/schema.sql` del proyecto, copiá todo su contenido y pegalo en el editor.
3. Tocá **Run**. Si Supabase avisa de operaciones destructivas o de RLS, elegí **Run and enable RLS**: las operaciones «destructivas» solo recrean las políticas. Debería aparecer *Success. No rows returned*.
4. Comprobá en **Table Editor** que aparezcan, entre otras, las tablas `clinics`, `clinic_members`, `patients`, `conversations`, `appointments`, `waitlist` y `documents`.
5. Los datos de ejemplo se cargan después desde la terminal, con `npm run seed` (clínicas y 30 días ficticios) y `npm run seed:users` (usuarios del panel).

> Las tablas tienen **RLS por clínica**: con la clave pública y sin sesión no se lee nada. El panel consulta con la sesión de cada usuario y solo ve sus clínicas; el backend usa la clave secreta.

### A3. Copiar la URL y las claves

1. Abrí **Project Settings** (el engranaje) → **API Keys** (o **Data API**, según la versión).
2. Copiá la **Project URL** (tiene la forma `https://xxxx.supabase.co`). Está en **Data API** o en el botón **Connect** de la parte superior.
3. Copiá la **clave secreta**:
   - En proyectos nuevos se llama **Secret key** y empieza con `sb_secret_...`. Si no existe, tocá **Create new secret key**.
   - En proyectos viejos se llama **service_role** (pestaña *Legacy API keys*). También sirve.
4. Copiá también la **clave pública** (**Publishable key**, empieza con `sb_publishable_...`; en proyectos viejos, **anon**). La usa el login del panel; las consultas van con la sesión de cada usuario, así que no da acceso a datos.
5. Pegá las tres en tu `.env`:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SECRET_KEY=sb_secret_xxxxxxxx
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxx
```

> ⚠️ La clave secreta saltea toda la seguridad de la base. Solo va en el backend (`.env`), nunca en el navegador ni en el repositorio.

> ℹ️ En el plan gratuito, Supabase **pausa el proyecto tras ~1 semana sin actividad**. Se reactiva desde el panel con **Restore project**. Conviene abrirlo antes de mostrarle la demo a un cliente.

---

## Parte B — Google Calendar (agenda del consultorio)

El bot usa una **cuenta de servicio**: un "usuario robot" de Google que puede editar un calendario que vos le compartas. Así no hace falta iniciar sesión con tu cuenta personal.

### B1. Crear un calendario de prueba

1. Entrá a https://calendar.google.com con tu cuenta de Google.
2. En el menú izquierdo, junto a **Otros calendarios**, tocá **+** → **Crear un calendario**.
3. Nombre: `Consultorio Demo`. Zona horaria: **(GMT-03:00) Buenos Aires** (o la que uses en `CLINIC_TIMEZONE`).
4. Tocá **Crear calendario**. Lo vas a compartir en el paso B5.

### B2. Crear el proyecto en Google Cloud

1. Entrá a https://console.cloud.google.com con la misma cuenta.
2. Si es la primera vez, aceptá los términos. **No hace falta activar la prueba gratuita ni cargar tarjeta.**
3. Arriba, en el selector de proyectos, tocá **Proyecto nuevo**.
4. Nombre: `bot-consultorio`. Ubicación: **Sin organización**. Tocá **Crear** y seleccioná el proyecto.

### B3. Activar la API de Google Calendar

1. Menú ☰ → **APIs y servicios** → **Biblioteca**.
2. Buscá **Google Calendar API**, abrila y tocá **Habilitar**.

### B4. Crear la cuenta de servicio y su clave

1. Menú ☰ → **IAM y administración** → **Cuentas de servicio** → **Crear cuenta de servicio**.
2. Nombre: `bot-agenda`. Tocá **Crear y continuar**.
3. En **Permisos (opcional)** y **Acceso de principales** no agregues nada: tocá **Continuar** y **Listo**. Los permisos los da el calendario compartido, no Google Cloud.
4. Copiá el **correo** de la cuenta de servicio (algo como `bot-agenda@bot-consultorio-12345.iam.gserviceaccount.com`).
5. Abrí la cuenta de servicio → pestaña **Claves** → **Agregar clave** → **Crear clave nueva** → **JSON** → **Crear**. Se descarga un archivo `.json`.
6. Creá la carpeta `secrets` dentro del proyecto (ya está en `.gitignore`) y mové el archivo ahí con el nombre `google-service-account.json`.

> Si aparece el error *"La creación de claves de cuentas de servicio está inhabilitada"*, tu cuenta pertenece a una organización con esa política activa. Con una cuenta personal de Gmail no debería pasar; avisame si ocurre.

### B5. Compartir el calendario con la cuenta de servicio

1. Volvé a Google Calendar → pasá el mouse sobre **Consultorio Demo** → **⋮** → **Configuración y uso compartido**.
2. En **Compartir con personas o grupos específicos**, tocá **Agregar personas o grupos**.
3. Pegá el correo de la cuenta de servicio y elegí el permiso **Hacer cambios en eventos**. Tocá **Enviar**.
4. En la misma página, bajá hasta **Integrar el calendario** y copiá el **ID del calendario** (algo como `abc123...@group.calendar.google.com`).

### B6. Completar el `.env`

```
GOOGLE_CALENDAR_ID=abc123...@group.calendar.google.com
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=secrets/google-service-account.json
```

---

## Parte C — Verificar que todo funciona

En la carpeta del proyecto:

```powershell
npm run check
```

Muestra ✅ o ❌ para Supabase y para Google Calendar, con el motivo si algo falla. Si todo está en verde:

```powershell
npm run seed
```

Carga turnos de ejemplo ficticios en el calendario `Consultorio Demo` para que la agenda se vea realista. Se puede ejecutar varias veces: borra los turnos de ejemplo anteriores antes de crear los nuevos.

## Qué pasa si no completo algo

El bot elige solo qué usar según el `.env`:

| Falta | El bot usa |
|---|---|
| `SUPABASE_URL` o `SUPABASE_SECRET_KEY` | Base en memoria (se borra al reiniciar) |
| `GOOGLE_CALENDAR_ID` o la clave JSON | Agenda en memoria |

Así la demo funciona siempre, aunque falte alguna cuenta.
