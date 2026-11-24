# Capturas para las tarjetas del portafolio de Workana

**Antes de capturar:** `npm run seed`, `npm run dev`, Chrome a pantalla completa (F11), zoom 100 %. Usá la herramienta Recortes de Windows (Win + Shift + S) y guardá en PNG en `docs/img/`.
**Formato:** horizontal 16:9 (por ejemplo, 1600×900). Revisá en Workana el tamaño recomendado de imagen del portafolio al subirlas.
**Nunca** muestres el `.env`, tokens, la contraseña del panel ni números de teléfono reales (el panel ya los enmascara).

## Orden sugerido (la primera es la portada del proyecto)

| # | Archivo | Qué capturar | Cómo dejarlo listo | Texto de la tarjeta |
|---|---|---|---|---|
| 1 | `01-portada.png` | Simulador: teléfono + agenda, con una reserva recién hecha | `/?modo=grabacion`, «Vi la promo» → «Quiero sacar un turno para mañana a la tarde» → «2» → «Ana Pérez». Capturar con el turno en verde. | **Bot de citas con IA para consultorios.** Atiende WhatsApp, agenda sobre Google Calendar y confirma al instante. |
| 2 | `02-conversacion.png` | Primer mensaje: saludo, promo y aviso de privacidad | Nueva conversación → «Vi la promo». Recortar solo el teléfono. | **Responde al instante, 24/7.** Precios, horarios y promo desde la base de conocimiento del consultorio. |
| 3 | `03-horarios-libres.png` | Lista de horarios 1️⃣ 2️⃣ 3️⃣ 4️⃣ con la agenda al lado | Pedir un día con turnos ocupados (los grises) para que se note que solo ofrece los libres. | **Solo ofrece horarios libres.** Consulta la agenda real; imposible la doble reserva. |
| 4 | `04-recordatorio.png` | Recordatorio con botones Confirmo · Cambiar horario · Cancelar | Con un turno reservado, tocar **⏰ Recordatorio**. | **Recordatorios automáticos 24 h y 2 h antes,** con confirmación en un toque. |
| 5 | `05-cancelacion.png` | Cancelación → horario liberado → nuevos horarios + aviso rojo en la agenda | En el recordatorio tocar **❌ Cancelar**; capturar mientras aparece el aviso «Turno cancelado… Horario liberado». | **Cancelaciones que se reprograman solas.** El horario se libera y el bot ofrece otro día. |
| 6 | `06-whatsapp-real.png` | La misma conversación en WhatsApp (celular o WhatsApp Desktop) | Escribirle al número de prueba. Tapar tu número y foto de perfil. | **Funciona en WhatsApp real** (WhatsApp Cloud API de Meta). |
| 7 | `07-panel.png` | Panel: indicadores, citas del día y derivaciones | `/panel` con al menos una cita confirmada y una derivación abierta (escribir «Quiero hablar con una persona» en el simulador). | **Panel para recepción:** citas, confirmaciones, conversaciones y derivaciones en un lugar. |
| 8 | `08-panel-conversacion.png` | Detalle de una conversación con la respuesta de recepción | En el panel abrir una conversación y responder como recepción. | **Derivación a una persona** con el contexto completo de la conversación. |
| 9 | `09-pruebas.png` | Tabla de pruebas 8/8 | Sección «Pruebas automatizadas» del panel, o `reports/test-results.md` en VS Code. | **Probado con casos reales:** horario ocupado, doble reserva, cancelación de último momento y más. |
| 10 | `10-arquitectura.png` | Diagrama de arquitectura | Página 2 del caso de estudio (`docs/caso-de-estudio.pdf`) o el diagrama Mermaid del README en GitHub. | **Arquitectura:** Node.js + TypeScript, IA intercambiable (Claude/OpenAI), Supabase y Google Calendar. |

## Texto para la descripción del proyecto en Workana

> Bot de WhatsApp con IA para consultorios odontológicos que reciben pacientes por promociones. Responde consultas con la información del consultorio, agenda turnos sobre la disponibilidad real de Google Calendar (sin dobles reservas), envía recordatorios 24 h y 2 h antes con botones para confirmar o cancelar, reprograma las cancelaciones automáticamente, hace seguimiento de los leads que no agendaron y deriva a una persona con el contexto. Incluye panel para recepción y simulador web.
>
> Stack: Node.js, TypeScript, Express, Claude u OpenAI (intercambiable), WhatsApp Cloud API, Google Calendar API, Supabase (PostgreSQL). Pruebas automatizadas de los casos críticos y medición de tiempo de respuesta y costo por conversación. Demo con datos ficticios.

**Habilidades para etiquetar:** Node.js · TypeScript · Inteligencia Artificial · Chatbots · WhatsApp API · Google Calendar API · Supabase · PostgreSQL · Automatización.

## Ya disponible

- `docs/img/simulador.png`: captura del simulador (teléfono + agenda) generada automáticamente; sirve como portada provisoria.
