# Guion del video (90 s)

**Objetivo:** que un dueño de clínica, o quien publica un proyecto de SaaS de atención, entienda en un minuto y medio cuatro cosas:
- el asistente atiende y agenda sobre la agenda real;
- recupera los huecos de las cancelaciones;
- el equipo lo controla desde un panel;
- le puede enseñar cosas nuevas sin programar.

**Formato:** horizontal 1920×1080 (Workana, LinkedIn). Para Reels o TikTok, recortar al teléfono en 1080×1920 (variante al final).
**Duración objetivo:** 90 s (rango 75–100 s).

## Preparación (10 minutos)

1. **Datos:**
   - Con Supabase: `npm run seed` carga las dos clínicas, 30 días de datos ficticios y el PDF de ejemplo.
   - Sin Supabase: `npm run dev:test` ya arranca con todo eso.
2. **Navegador:** Chrome a pantalla completa (F11), zoom 100 %, con dos pestañas:
   - **Simulador:** `http://localhost:3000/?modo=grabacion`.
   - **Panel:** `http://localhost:3000/panel`. Entrá con `admin@sonrisaclara.demo.test`; la contraseña está en `DEMO_PASS_ADMIN_SONRISA` del `.env`.
3. **Modo sin IA:** grabá con `LLM_PROVIDER=mock`, así los textos salen siempre iguales. Para mostrar la IA real, usá `claude` y ensayá una vez antes.
4. **Entre tomas:** tocá **↺ Nueva conversación**, arriba a la derecha en modo grabación.
5. **Grabación:** OBS o la grabadora de Windows (Win + Alt + R), a 30 fps.

## Tomas

| # | Tiempo | En pantalla | Acción | Texto en pantalla | Voz en off |
|---|---|---|---|---|---|
| 1 | 0:00–0:05 | Simulador vacío | Nada (gancho) | **«Su clínica responde WhatsApp a las 23:00. Sin usted.»** | «¿Cuántos pacientes se pierden porque nadie contestó a tiempo?» |
| 2 | 0:05–0:20 | Chat + agenda | «Vi la promo» → «Quiero sacar un turno para el jueves a la tarde» → «2» → «Ana Pérez» | «Solo ofrece horarios libres de su agenda real» | «El asistente responde al instante, consulta la agenda real y reserva. El turno aparece en verde en el calendario.» |
| 3 | 0:20–0:32 | Dos pestañas del simulador | Pestaña B: «Quiero turno el jueves a la mañana» → «Anóteme en la lista de espera». Pestaña A: «Quiero cancelar mi turno». Volver a B: llega 🔔 con **Lo tomo** | «Cancelación → el hueco se ofrece a la lista de espera» | «Si alguien cancela, el horario se ofrece solo a quien estaba esperando. Un toque y el turno es suyo.» |
| 4 | 0:32–0:40 | Simulador | Botón **⏰ Recordatorio** → botones Confirmo · Cambiar · Cancelar | «Recordatorios 24 h y 2 h antes» | «Un día antes recuerda el turno, con botones para confirmar o cambiar.» |
| 5 | 0:40–0:52 | Panel → **Conversaciones** | Abrir la que «Espera respuesta» → mostrar **Tomar / Pausar / Devolver al bot** | «Su equipo toma la conversación cuando hace falta» | «Recepción ve todo en una bandeja y toma la conversación, o pausa el bot, en un clic.» |
| 6 | 0:52–1:05 | Panel → **Aprendizaje** | Cambiar un precio y **Guardar** → en el probador: «Después del blanqueamiento, ¿puedo tomar café?» | «Le enseña cosas nuevas sin programar» | «El consultorio edita precios y horarios, sube sus documentos, y el asistente responde con eso al instante.» |
| 7 | 1:05–1:17 | Panel → **Estadísticas** → **Costos** | Pasar el mouse por un gráfico; mostrar costo por conversación y proyección | «Consultas, conversión y costo de la IA» | «Estadísticas de cada día y cuánto cuesta cada conversación: centavos.» |
| 8 | 1:17–1:25 | Panel | Cambiar el selector de **Clínica** a Altamira | «Multiempresa: cada clínica, sus datos» | «Y es multiempresa: cada clínica con sus datos, protegidos en la base.» |
| 9 | 1:25–1:30 | Placa final | — | **«Asistente de WhatsApp con IA · Agenda · Panel · Multiempresa»** · tu nombre · «Demo con datos ficticios» | «¿Lo quiere para su clínica? Escríbame.» |

## Consejos de edición

- **Cortes:** recortá las esperas de «escribiendo…» a ~0,5 s, pero dejá visibles los toques (botones, sugerencias, guardar): son la acción.
- **Zoom suave** (110–120 %):
  - sobre el turno verde de la toma 2;
  - sobre la oferta 🔔 de la toma 3;
  - sobre la respuesta del probador de la toma 6.
- **Subtítulos:** el texto en pantalla de cada toma, en el tercio inferior; la mayoría mira sin sonido.
- **Música:** suave, sin voz, bajo la locución.
- **Qué no mostrar:** el `.env`, la terminal con claves, las contraseñas ni números de teléfono reales.

## Variante corta (30 s, para Reels)

Tomas 1 → 2 → 3 → 6 → 9, solo el teléfono y el probador (recortado 9:16), con el texto en pantalla como subtítulos.
