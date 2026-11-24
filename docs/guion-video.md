# Guion del video (75 s)

**Objetivo:** que un dueño de consultorio entienda en un minuto que el bot atiende, agenda sobre su agenda real, recuerda los turnos y recupera las cancelaciones solo.
**Formato:** horizontal 1920×1080 (para Workana y LinkedIn). Para Reels/TikTok, recortar al teléfono 1080×1920.
**Duración objetivo:** 75 s (rango 60–90 s).

## Preparación (5 minutos)

1. `npm run seed` → la agenda de la semana tiene turnos de ejemplo en gris.
2. `npm run dev` y abrir `http://localhost:3000/?modo=grabacion` en Chrome a pantalla completa (F11): queda solo el **teléfono a la izquierda y la agenda a la derecha**.
3. Para que los textos salgan siempre iguales, grabar con `LLM_PROVIDER=mock`. Para mostrar la IA real, usar `claude` y ensayar una vez (las respuestas varían un poco).
4. Toca **↺ Nueva conversación** entre tomas (el botón queda casi invisible en modo grabación: está arriba a la derecha).
5. Grabar con OBS o la grabadora de Windows (Win + Alt + R), 30 fps.

> Toma alternativa con WhatsApp real: WhatsApp Desktop a la izquierda y Google Calendar (vista semana) a la derecha. Los mensajes son los mismos.

## Tomas

| # | Tiempo | En pantalla | Acción | Texto en pantalla | Voz en off |
|---|---|---|---|---|---|
| 1 | 0:00–0:06 | Teléfono con el chat vacío + agenda | Nada (gancho) | **«Su consultorio responde WhatsApp a las 23:00. Sin usted.»** | «¿Cuántos pacientes de su promo se pierden porque nadie contestó a tiempo?» |
| 2 | 0:06–0:16 | Chat | Tocar la sugerencia **«Vi la promo»** | «Responde al instante, con la info del consultorio» | «Este asistente responde al instante: precios, horarios, la promo vigente…» |
| 3 | 0:16–0:30 | Chat + agenda | Escribir **«Quiero sacar un turno para mañana a la tarde»** | «Solo ofrece horarios libres de su agenda real» | «…y agenda. Consulta su Google Calendar y solo ofrece horarios libres.» |
| 4 | 0:30–0:40 | Chat + **agenda que se ilumina** | Responder **«2»** y luego **«Ana Pérez»** | «✓ Turno reservado → se llena la agenda» | «El paciente elige, deja su nombre y el turno aparece en la agenda. Sin doble reserva.» |
| 5 | 0:40–0:50 | Chat | Tocar **⏰ Recordatorio** (arriba a la derecha) | «Recordatorio automático 24 h antes» | «Un día antes le recuerda el turno, con botones para confirmar, cambiar o cancelar.» |
| 6 | 0:50–1:02 | Chat + **agenda (rojo → verde)** | Tocar **❌ Cancelar** en el recordatorio y después **«1»** | «Cancela → libera el horario → reprograma solo» | «Si cancela, el horario se libera al instante y el bot le ofrece otro día. Un turno perdido se recupera solo.» |
| 7 | 1:02–1:10 | Panel `/panel` | Mostrar KPIs, citas del día y una derivación | «Panel para recepción · derivación a una persona» | «Recepción ve todo en un panel y toma la conversación cuando hace falta.» |
| 8 | 1:10–1:15 | Placa final | — | **«Bot de citas con IA · WhatsApp + Google Calendar»** · tu nombre · «Demo con datos ficticios» | «¿Lo quiere para su consultorio? Escríbame.» |

## Consejos de edición

- **Cortes en las esperas:** recortar el «escribiendo…» a ~0,5 s; dejar visibles los toques (botones, sugerencias): son la acción.
- **Zoom suave** (110–120 %) sobre la agenda en la toma 4 y en la toma 6, cuando el horario se ilumina en verde o parpadea en rojo.
- **Subtítulos** con el texto en pantalla de cada toma, en el tercio inferior y en negrita; la mayoría mira sin sonido.
- **Música:** suave y sin voz, bajo la locución.
- No mostrar el `.env`, la terminal con tokens ni números de teléfono reales.

## Variante corta (30 s, para Reels)

Tomas 1 → 3 → 4 → 6 → 8, solo el teléfono (recortado 9:16), con el texto en pantalla como subtítulos y sin voz.
