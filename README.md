# Bot de citas con IA para consultorios odontológicos (demo)

Asistente que atiende pacientes por WhatsApp: responde consultas, agenda, reprograma, cancela y deriva a una persona. **Proyecto de portafolio con datos ficticios.**

> Estado: **Etapa 1 lista** (esqueleto y motor con herramientas). El README completo llega en la etapa 7.

## Probar en 1 minuto (sin claves)

```powershell
npm install
npm run smoke   # conversación guionada con verificaciones
npm run chat    # chat por consola
```

Por defecto `LLM_PROVIDER=mock`: un motor de reglas que usa las mismas herramientas que la IA, sin costo.

## Simulador web (etapa 3)

```powershell
npm run dev     # abre http://localhost:3000
```

Chat con aspecto de WhatsApp dentro de un marco de celular, más la agenda de la semana en vivo (Google Calendar o memoria). Al reservar, el turno se ilumina en verde; al cancelar, el horario parpadea en rojo y queda libre.

- **Modo grabación:** oculta los controles para grabar la pantalla (también con `?modo=grabacion`).
- **Origen del lead:** `?source=promo-noviembre` (valor por defecto) queda guardado en el paciente.
- **Límite de uso:** 40 mensajes cada 10 minutos por IP (`WEB_MAX_MSGS_PER_10MIN`), para cuidar el saldo de la API si se comparte el link.

## WhatsApp Cloud API (etapa 4)

Seguí [docs/guia-meta-whatsapp.md](docs/guia-meta-whatsapp.md): app en Meta for Developers, número de prueba, tu WhatsApp como destinatario, túnel HTTPS y webhook en `/webhook/whatsapp`.

```powershell
npm run test:whatsapp   # prueba el canal con avisos simulados y firmados (sin llamar a Meta)
```

El webhook valida la firma `X-Hub-Signature-256`, responde 200 al instante, ignora avisos repetidos y procesa los mensajes de cada paciente en orden.

## Recordatorios y seguimiento (etapa 5)

El servidor revisa la agenda cada 60 s (`REMINDERS_INTERVAL_SEC`):

| Aviso | Cuándo | Botones |
|---|---|---|
| Recordatorio 24 h | Faltan ≤ 24 h (se omite si se reservó con menos de 24 h) | ✅ Confirmo · 📅 Cambiar horario · ❌ Cancelar |
| Recordatorio 2 h | Faltan ≤ 2 h | ✅ Confirmo · ❌ Cancelar (sin botones si ya confirmó) |
| Seguimiento de lead | Llegó por una promo, no agendó y no escribe hace `FOLLOWUP_AFTER_HOURS` (20 h) | 📅 Sí, buscar turno · Más adelante |

- **Confirmar** y **Más adelante** se resuelven sin IA (instantáneo, sin costo). **Cancelar** libera el horario y ofrece reprogramar; **Cambiar horario** ofrece horarios y mueve el turno.
- Cada aviso se marca como enviado: no se repite aunque el servidor se reinicie.
- En WhatsApp, si pasaron más de 24 h desde el último mensaje del paciente, Meta solo permite **plantillas aprobadas**: el bot cambia solo a la plantilla (`npm run wa:templates` las crea en Meta).

```powershell
npm run test:reminders            # 10 casos con reloj simulado (lunes → miércoles)
npm run remind -- --latest        # recordatorio YA a la última conversación de WhatsApp (para el video)
npm run remind -- --followup      # seguimiento YA a la última conversación de WhatsApp
```

En el simulador: botones **⏰ Recordatorio** y **📣 Seguimiento** (siguen disponibles, casi invisibles, en modo grabación).

## Usar IA real

1. Copiar `.env.example` a `.env`.
2. Poner `LLM_PROVIDER=claude` y la clave en `ANTHROPIC_API_KEY` (u `openai` + `OPENAI_API_KEY`).
3. `npm run chat`.

## Conectar Supabase y Google Calendar (etapa 2)

Seguí [docs/guia-cuentas-supabase-google.md](docs/guia-cuentas-supabase-google.md) y después:

```powershell
npm run check   # verifica IA, Supabase y Google Calendar sin mostrar claves
npm run seed    # carga turnos de ejemplo ficticios en el calendario
```

Si falta alguna credencial, el bot usa memoria para esa parte y la demo sigue funcionando.

## Estructura

```
src/
  bot/engine.ts        motor único (todos los canales pasan por acá)
  bot/tools.ts         herramientas: horarios, crear/cancelar/reprogramar cita, derivar
  bot/systemPrompt.ts  reglas y tono del asistente
  llm/                 proveedores intercambiables: claude | openai | mock
  services/            agenda, base de datos y fechas (en memoria por ahora)
  data/                base de conocimiento y datos de ejemplo ficticios
tests/smoke.ts         prueba de punta a punta
```
