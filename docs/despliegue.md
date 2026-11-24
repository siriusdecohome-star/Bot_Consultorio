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

**Recomendación:** para un portafolio o una demo, Render. Para un consultorio real, el plan pago chico de Render o Railway, o un VPS.

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
