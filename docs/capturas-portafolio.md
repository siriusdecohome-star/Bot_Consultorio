# Capturas para las tarjetas del portafolio de Workana

**Ya generadas** en `docs/img/` (1440×900, escala 1,5, datos ficticios). Se regeneran con `npm run capturas`.

| # | Archivo | Texto de la tarjeta |
|---|---|---|
| 1 | `simulador.png` (portada) | **Asistente de WhatsApp con IA para clínicas.** Responde al instante, agenda sobre la agenda real y confirma. |
| 2 | `panel-conversaciones.png` | **Bandeja para el equipo.** Ve qué conversación espera respuesta, la toma, pausa el bot o la devuelve. |
| 3 | `panel-agenda.png` | **Agenda y lista de espera.** Si alguien cancela, el hueco se ofrece solo a quien esperaba. |
| 4 | `panel-aprendizaje.png` | **Le enseña sin programar.** Precios, horarios, preguntas y documentos PDF; el cambio rige al instante. |
| 5 | `panel-estadisticas.png` | **Estadísticas:** consultas por día, conversión, bot vs persona y tratamientos más pedidos. |
| 6 | `panel-costos.png` | **Costo de la IA bajo control:** tokens y USD por conversación, por mes y proyección. |
| 7 | `panel-resumen.png` | **Resumen del día:** citas, derivaciones abiertas, leads y rendimiento. |
| 8 | `panel-pacientes.png` | **Pacientes y consultas,** con reactivación de los que no vuelven y exportación a Excel. |

**Para completar a mano:**

| # | Qué capturar | Cómo |
|---|---|---|
| 9 | La misma conversación en **WhatsApp real** (celular o WhatsApp Desktop) | Escribile al número de prueba. Tapá tu número y tu foto de perfil. |
| 10 | Diagrama de arquitectura | Página 2 del [caso de estudio](caso-de-estudio.pdf) o el diagrama Mermaid del README en GitHub. |

**Formato:** horizontal 16:9. Revisá en Workana el tamaño recomendado al subirlas. **Nunca** muestres el `.env`, claves, contraseñas ni teléfonos reales: el panel ya los enmascara.

## Texto para la descripción del proyecto en Workana

> Asistente de WhatsApp con IA para clínicas dentales, pensado como MVP de una plataforma SaaS de atención. Responde consultas con la información de cada clínica y sus documentos, agenda turnos sobre la disponibilidad real de Google Calendar (sin dobles reservas), envía recordatorios con botones para confirmar o cancelar, ofrece automáticamente los huecos de las cancelaciones a una lista de espera, reactiva a los pacientes que no vuelven y deriva a una persona con el contexto.
>
> Panel para el equipo con login y roles (admin y recepción): bandeja de conversaciones con traspaso y pausa del bot, agenda, pacientes, estadísticas, costos de la IA por conversación con proyección mensual, zona de aprendizaje (editar precios, horarios, preguntas y tono, subir PDF/Word, probador) y exportación a Excel. Multiempresa: cada clínica con sus datos separados en la base (Supabase con RLS).
>
> Stack: Node.js, TypeScript, Express, Claude u OpenAI (intercambiable, con function calling), WhatsApp Cloud API, Google Calendar API, Supabase (PostgreSQL, Auth, RLS). Más de 80 pruebas automatizadas, entorno de pruebas separado de producción y guía de despliegue. Demo con datos ficticios.

**Habilidades para etiquetar:** Node.js · TypeScript · Inteligencia Artificial · Chatbots · WhatsApp API · Google Calendar API · Supabase · PostgreSQL · SaaS · Automatización.
