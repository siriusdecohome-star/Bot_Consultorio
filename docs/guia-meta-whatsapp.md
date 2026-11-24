# Guía: WhatsApp Cloud API con el número de prueba de Meta

Objetivo: que el bot responda en **tu WhatsApp personal** usando el número de prueba gratuito que da Meta.
Tiempo estimado: 30–45 minutos. **Nunca pegues tokens ni claves en el chat:** van solo en el `.env`.

> ⚠️ **Verificar en la documentación oficial** (Meta cambia pantallas y reglas seguido):
> - La versión vigente de la Graph API (el proyecto usa `v23.0` por defecto, en `WHATSAPP_GRAPH_VERSION`).
> - Los límites del número de prueba: hasta **5 destinatarios** verificados y solo para pruebas.
> - Los nombres exactos de los menús de Meta for Developers y Business Manager.
>
> Documentación: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started

---

## Cómo funciona

```
Tu WhatsApp ──► Meta ──(webhook HTTPS)──► túnel ──► tu PC (npm run dev, puerto 3000) ──► bot
Tu WhatsApp ◄── Meta ◄──(Graph API + token)───────────────────────────────────────────┘
```

Meta necesita una **URL pública HTTPS** para avisarle al bot de cada mensaje. Como el bot corre en tu PC, usamos un **túnel** (Parte C).

---

## Parte A — Crear la app en Meta for Developers

1. Entrá a https://developers.facebook.com con tu cuenta de Facebook y tocá **Comenzar** (o **Mis apps**). Si es la primera vez, te pide registrarte como desarrollador (verificación por SMS o correo).
2. **Mis apps → Crear app**.
3. Caso de uso: elegí **"Conectarse con clientes a través de WhatsApp"** (si aparece la pantalla de tipos de app, elegí **Negocios / Business**).
4. Nombre: `Bot Consultorio Demo`. Correo de contacto: el tuyo.
5. Si te pide un **portfolio comercial (Business Manager)**, creá uno nuevo con un nombre genérico (por ejemplo "Portafolio Demo"). No hace falta verificar la empresa para usar el número de prueba.
6. Al terminar, en el panel de la app aparece **WhatsApp** en el menú izquierdo. Si no, tocá **Agregar producto → WhatsApp → Configurar**.

## Parte B — Número de prueba, destinatario y datos para el `.env`

1. Abrí **WhatsApp → Configuración de la API** (o **API Setup**).
2. En **De (From)** ya aparece un **número de prueba** que asigna Meta. Debajo vas a ver:
   - **Identificador del número de teléfono** (Phone number ID) → va en `WHATSAPP_PHONE_NUMBER_ID`.
   - **Token de acceso temporal** (botón *Generar token*) → va en `WHATSAPP_TOKEN`. **Dura ~24 horas**; sirve para probar hoy. El permanente está en la Parte E.
3. En **Para (To)** tocá **Administrar lista de números de teléfono** → **Agregar número**:
   - Escribí tu WhatsApp personal con código de país (por ejemplo `+54 9 11 …` o `+591 7…`).
   - Te llega un código por WhatsApp: ingresalo para verificarlo.
4. Prueba rápida desde Meta: con tu número elegido en **Para**, tocá **Enviar mensaje**. Te debería llegar la plantilla *hello_world* desde el número de prueba. **Guardá ese chat** en tu WhatsApp.
5. Clave secreta de la app: menú **Configuración de la app → Básica → Clave secreta de la app → Mostrar** → va en `WHATSAPP_APP_SECRET`.

Completá en el `.env` (el `WHATSAPP_VERIFY_TOKEN` ya lo generé yo, no lo cambies):

```
WHATSAPP_TOKEN=EAAG...            ← token temporal o permanente
WHATSAPP_PHONE_NUMBER_ID=1234...  ← identificador, no el número
WHATSAPP_APP_SECRET=abcd...
```

Verificá:

```powershell
npm run check
```

Debe mostrar `✅ WhatsApp: token válido, número +1 555…`.

## Parte C — Túnel: una URL pública hacia tu PC

Elegí **una** de estas opciones.

**Opción 1 — Cloudflare Tunnel (recomendada, sin cuenta).** Requiere instalar `cloudflared` (~60 MB):

```powershell
winget install --id Cloudflare.cloudflared
```

Con el bot corriendo (`npm run dev`), en otra terminal:

```powershell
cloudflared tunnel --url http://localhost:3000
```

Copiá la URL que muestra, del tipo `https://palabras-al-azar.trycloudflare.com`. **Cambia cada vez que lo ejecutás**: si lo reiniciás, actualizá la URL en Meta (Parte D).

**Opción 2 — Reenvío de puertos de VS Code (sin instalar nada).** En VS Code: panel **Puertos** → **Reenviar un puerto** → `3000` → clic derecho → **Visibilidad del puerto → Pública**. Pide iniciar sesión con GitHub. Copiá la **dirección reenviada** (`https://…devtunnels.ms`). Al abrirla por primera vez puede mostrar una página de aviso; Meta igual suele poder verificar el webhook, pero si falla, usá la opción 1.

## Parte D — Configurar el webhook en Meta

1. En la app: **WhatsApp → Configuración** (o **Configuration**) → sección **Webhook** → **Editar**.
2. **URL de devolución de llamada:** `https://TU-URL-DEL-TUNEL/webhook/whatsapp`
3. **Token de verificación:** copiá el valor de `WHATSAPP_VERIFY_TOKEN` de tu `.env`.
4. Tocá **Verificar y guardar**. En la terminal del bot debe aparecer `[whatsapp] webhook verificado por Meta`.
5. En **Campos del webhook**, activá la suscripción a **messages**.

## Parte E — Probar

1. Con `npm run dev` y el túnel corriendo, escribí desde tu WhatsApp al número de prueba (en el chat donde te llegó *hello_world*): `Hola, vi la promo`.
2. El bot responde con el aviso de privacidad y la promo. En la terminal vas a ver `← 5491•••455: Hola…` y `→ … 2 mensaje(s)`.
3. Pedí un turno: se reserva en Google Calendar y lo ves en el simulador (http://localhost:3000) en verde.

> Como **vos le escribís primero**, se abre la "ventana de 24 h" y el bot puede responder con mensajes libres. Para escribirle primero a un paciente (recordatorios, seguimiento de leads) se necesitan **plantillas aprobadas**: eso se arma en la etapa 5.

## Parte F — Token permanente (para no renovarlo cada 24 h)

1. Abrí **Configuración del negocio** (https://business.facebook.com/settings) del portfolio que creaste.
2. **Usuarios → Usuarios del sistema → Agregar**. Nombre: `bot-consultorio`. Rol: **Administrador**.
3. Con el usuario seleccionado: **Asignar activos** → **Apps** → elegí `Bot Consultorio Demo` → permiso **Control total** (o *Administrar app*) → Guardar.
4. Asigná también la **cuenta de WhatsApp** (WhatsApp Business Account de prueba) con control total, si aparece la opción.
5. **Generar nuevo token** → app `Bot Consultorio Demo` → Vencimiento: **Nunca** → permisos:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
6. Copiá el token **una sola vez** (no se vuelve a mostrar) y reemplazá `WHATSAPP_TOKEN` en el `.env`. Ejecutá `npm run check`.

---

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `Verificar y guardar` falla | El bot o el túnel no están corriendo, la URL no termina en `/webhook/whatsapp`, o el token de verificación no coincide. |
| El bot no responde y la terminal no muestra nada | Falta suscribir el campo **messages** (Parte D.5) o cambió la URL del túnel. |
| Terminal: `aviso con firma inválida` | `WHATSAPP_APP_SECRET` no es la clave secreta de **esta** app. |
| Error `190` | Token vencido (el temporal dura 24 h). |
| Error `131030` (destinatario no permitido) | El número no está en la lista de la Parte B.3. Con números de Argentina (`549…`) o México (`521…`) el bot reintenta solo con la variante sin el dígito móvil. |
| Error `131047` | Pasaron más de 24 h desde tu último mensaje: escribí vos primero de nuevo. |
