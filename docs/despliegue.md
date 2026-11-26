# Guía de despliegue

Cómo pasar de la demo local a un servidor accesible desde internet, con una URL fija para el webhook de WhatsApp.

> ⚠ **Planes y precios cambian.** Los límites de los planes gratuitos (Render, Railway, Fly.io, Supabase, Cloudflare) y las reglas de Meta mencionados acá conviene verificarlos en la página oficial de cada servicio antes de decidir.

## 1. Dónde correr el servidor

El servidor es un proceso de Node.js que tiene que estar **siempre encendido**, por dos motivos:
- recibe los avisos de Meta al instante;
- cada 60 segundos envía recordatorios, ofertas de la lista de espera y reactivaciones.

| Opción | A favor | En contra |
|---|---|---|
| **Render / Railway** (servicio web conectado a GitHub) | Despliegue con cada push, HTTPS y dominio incluidos | En los planes gratuitos el servicio suele dormirse sin tráfico: el primer mensaje tarda y los avisos programados no corren mientras duerme. Para un cliente, usar el plan pago más chico. |
| **Fly.io** | Máquinas pequeñas siempre encendidas, buena latencia | Pide tarjeta; configuración por `fly.toml` |
| **VPS** (cualquier proveedor, Ubuntu + Node 20 + `pm2` o `systemd`) | Control total, costo fijo bajo | Hay que mantener el sistema y el HTTPS (Caddy o Nginx) |
| **PC propia + túnel con nombre de Cloudflare** | Gratis, URL fija | La PC tiene que quedar encendida; solo sirve para demos |

| **Vercel + cron de Supabase** (funciones sin servidor) | Plan gratuito sin «dormirse», HTTPS, despliegue con cada push | Sin procesos permanentes: el trabajo periódico lo dispara el cron de Supabase cada 5 minutos (ver la sección siguiente) |

**Recomendación:** para el portafolio y la demo pública, Vercel con el cron de Supabase. Para un consultorio real, Vercel (plan pago, que permite uso comercial) o un servidor siempre encendido (Render, Railway, VPS).

## 1 bis. Vercel paso a paso

El mismo código corre en Vercel sin cambios de configuración en el código:
- `api/index.ts` es la función, y `vercel.json` envía todas las rutas a ella. `public/` se sirve como archivos estáticos.
- No hay temporizadores. **Cada 5 minutos el cron de Supabase** llama a `POST /api/cron/tick`, que hace:
  - recordatorios, seguimientos y lista de espera;
  - cierre por inactividad;
  - borrado de las demos vencidas;
  - limpieza del estado compartido.
- **El webhook de WhatsApp** responde 200 a Meta al instante y termina de procesar con `waitUntil`.
- **Lo que tiene que ser común a todas las instancias vive en Supabase:**
  - los mensajes de Meta ya procesados (tabla `processed_messages`, para no responder dos veces);
  - los límites por IP (`rate_hits`);
  - la bandeja del simulador (`web_outbox`);
  - el conteo de demos.
- **Datos al día entre instancias:** si un pedido llega a una instancia que no conoce la clínica (por ejemplo, una demo creada en otra), la carga de la base. Además, relee cada clínica cada 20 segundos, para que se vean los cambios hechos desde el panel en otra instancia.
- **Documentos:** en Vercel se pueden subir hasta **3 MB** por documento. El cuerpo de un pedido tiene un máximo de 4,5 MB y el archivo viaja en base64.

Pasos:
1. **Supabase:** ejecutá el `supabase/schema.sql` actualizado (crea las tablas del estado compartido).
2. **Vercel:** Add New → Project → importá el repositorio de GitHub. El preset de framework queda en **Other**; el resto lo toma de `vercel.json`.
3. **Variables de entorno** (Settings → Environment Variables): las de la sección 4, más `CRON_SECRET`, un texto aleatorio largo generado con:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Vercel define `NODE_ENV=production`. Con ese valor el servidor no arranca si falta algo crítico, y el error se ve en los registros de la función.
4. **Región:** en Settings → Functions, elegí la región más cercana a la de tu proyecto de Supabase. Cada mensaje hace varias consultas a la base, así que la distancia se nota.
5. **Desplegá** y abrí `https://<tu-proyecto>.vercel.app/api/config`. Tiene que responder con las clínicas.
6. **Cron:** en Supabase, Project Settings → Vault → **Add new secret**, con el nombre `cron_secret` y el mismo valor de `CRON_SECRET`. Después ejecutá `supabase/cron.sql` en el SQL Editor, con la dirección de tu proyecto en lugar de `TU-PROYECTO`.
7. **Webhook de Meta:** cambiá la URL de devolución de llamada a `https://<tu-proyecto>.vercel.app/webhook/whatsapp` (sección 6).
8. **Prueba de varias instancias contra la base**, desde tu PC:

   ```powershell
   npm run test:vercel
   ```

> ⚠ **A verificar en la documentación de Vercel:** el plan Hobby es para uso personal y no comercial. También conviene confirmar la duración máxima de las funciones (en `vercel.json` está en 60 s) y el límite del cuerpo de los pedidos.

## 2. Supabase de producción (separado del de pruebas)

1. Creá un **proyecto nuevo** en Supabase para producción; el actual queda como entorno de pruebas. Anotá `SUPABASE_URL`, la clave pública (`SUPABASE_PUBLISHABLE_KEY`) y la clave secreta (`SUPABASE_SECRET_KEY`).
2. En el SQL Editor, ejecutá `supabase/schema.sql` completo. Si Supabase pregunta por RLS, elegí **Run and enable RLS**.
3. **Cargá la clínica real:**
   1. Editá `src/data/clinics/` con sus datos: nombre, dirección, horarios, tratamientos, precios y tono. También podés cargar la de ejemplo y editarla después desde el panel (pestaña Aprendizaje).
   2. Con las variables de producción en un archivo aparte, por ejemplo `.env.production`, que no se sube al repositorio, ejecutá:

      ```powershell
      $env:ENV_FILE=".env.production"; npm run seed -- --sin-ejemplos
      ```

      Esto guarda solo las clínicas, sin datos ficticios.
4. **Usuarios reales** (no uses `npm run seed:users`, que crea los usuarios de prueba):
   1. En Supabase, entrá a Authentication → Users → **Add user**, con su correo y una contraseña que elija la persona.
   2. Asigná la clínica y el rol en el SQL Editor:

      ```sql
      insert into clinic_members (user_id, clinic_id, role)
      select id, 'sonrisa-clara', 'admin' from auth.users where email = 'dueña@consultorio.com';
      ```

## 3. Google Calendar

- Usá un calendario propio del consultorio, compartido con la cuenta de servicio con permiso «Hacer cambios en eventos». El procedimiento es el de la [guía de cuentas](guia-cuentas-supabase-google.md).
- En la plataforma no hay archivos, así que la clave de la cuenta de servicio va en una variable. Para obtener el contenido en base64, en PowerShell:

  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("secrets\google-service-account.json")) | Set-Clipboard
  ```

  Pegalo en `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`. No lo compartas: es una credencial.

## 4. Variables de entorno en la plataforma

Cargalas en el panel del proveedor (Environment). Nunca en el repositorio.

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production`. Con este valor el servidor se niega a arrancar si falta algo crítico. |
| `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | Proveedor, clave y modelo (por ejemplo `claude-haiku-5-5` para bajar costos) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY` | Las del proyecto de **producción** |
| `GOOGLE_CALENDAR_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` | Calendario y clave |
| `WHATSAPP_TOKEN` (permanente), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_WABA_ID` | Canal WhatsApp |
| `PANEL_SESSION_SECRET` | Texto aleatorio largo, generado con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | Lo define la plataforma; no hace falta tocarlo |
| `CRON_SECRET` | Solo en Vercel: clave con la que el cron de Supabase llama a `/api/cron/tick` (guardala también en el Vault de Supabase) |

## 5. Crear el servicio (ejemplo con Render)

1. New → **Web Service** → conectá el repositorio de GitHub.
2. Completá la configuración:
   - **Runtime:** Node.
   - **Build command:** `npm ci`.
   - **Start command:** `npm start`.
   - **Health check path:** `/api/config`.
3. Cargá las variables del paso 4 y desplegá.
4. Revisá el registro (Logs). Tiene que mostrar las clínicas, `base: supabase · agenda: google` y la línea de WhatsApp sin advertencias. Si falta algo, el servidor lo dice y no arranca.

## 6. WhatsApp con URL fija

1. En Meta, entrá a la configuración de WhatsApp de la app (sección Webhook) y completá:
   - **URL de devolución de llamada:** `https://<tu-servicio>.onrender.com/webhook/whatsapp`.
   - **Token de verificación:** el mismo valor de `WHATSAPP_VERIFY_TOKEN`.
2. Suscribí el campo **messages** y corré `npm run wa:subscribe` (una vez por cuenta).
3. Usá el **token permanente** de un usuario del sistema. Está en la parte F de la [guía de Meta](guia-meta-whatsapp.md); el temporal vence a las 24 horas.
4. **Plantillas:** `npm run wa:templates -- --status` tiene que mostrarlas aprobadas. Sin plantillas aprobadas, los avisos solo llegan a quien escribió en las últimas 24 horas.
5. **Número real:** pasar del número de prueba a uno propio requiere verificar el negocio en Meta y cargar un método de pago. Conviene revisar los requisitos y precios vigentes en la documentación oficial de WhatsApp Business Platform.

## 7. Verificación final

- [ ] `https://<tu-servicio>/api/config` responde con las clínicas.
- [ ] Un mensaje de WhatsApp recibe respuesta y aparece en el panel, en Conversaciones.
- [ ] Una reserva crea el evento en Google Calendar con la etiqueta de la clínica.
- [ ] El login del panel funciona y recepción no ve Costos.
- [ ] `npm run check` con las variables de producción (`$env:ENV_FILE=".env.production"; npm run check`) da todo en verde.
- [ ] Entre la reserva y el recordatorio de 24 h el servicio no se durmió (revisar el plan).

## Alternativa sin servidor: túnel con nombre de Cloudflare

Para una demo prolongada desde tu PC, con URL fija:

1. Creá una cuenta gratuita de Cloudflare y agregá un dominio.
2. Creá y enrutá el túnel:

   ```powershell
   cloudflared tunnel login
   ```
   ```powershell
   cloudflared tunnel create bot-consultorio
   ```
   ```powershell
   cloudflared tunnel route dns bot-consultorio bot.tudominio.com
   ```
3. Arrancalo, con el servidor (`npm start`) corriendo:

   ```powershell
   cloudflared tunnel run --url http://localhost:3000 bot-consultorio
   ```

A diferencia del túnel rápido (`trycloudflare.com`), la dirección no cambia al reiniciar y no se da de baja sola. La PC tiene que quedar encendida.
