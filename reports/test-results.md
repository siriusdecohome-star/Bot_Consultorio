# Resultados de las pruebas

- **Fecha:** 2026-11-24 20:53 UTC
- **Proveedor:** mock (reglas-v1)
- **Resultado:** 8/8 casos OK
- **Tiempo de respuesta por mensaje:** promedio 0.00 s · p95 0.01 s
- **Costo estimado por conversación:** 0 (sin IA) (promedio de 8 conversaciones)

| # | Caso | Esperado | Resultado | Mensajes | Tiempo medio | Costo |
|---|---|---|---|---|---|---|
| 1 | Horario ocupado | No reserva un horario ocupado; ofrece alternativas libres | ✅ OK | 2 | 0.01 s | 0 (sin IA) |
| 2 | Cancelación a último momento | Cancela, libera el horario y ofrece reprogramar en el mismo mensaje | ✅ OK | 1 | 0.00 s | 0 (sin IA) |
| 3 | Mensaje confuso | No ejecuta acciones; pide una aclaración con opciones | ✅ OK | 1 | 0.00 s | 0 (sin IA) |
| 4 | Pedido de hablar con una persona | Deriva con resumen y deja de responder como bot | ✅ OK | 3 | 0.00 s | 0 (sin IA) |
| 5 | Fuera de horario | Responde igual y solo ofrece horarios dentro del horario de atención | ✅ OK | 2 | 0.00 s | 0 (sin IA) |
| 6 | Doble reserva | Dos pedidos simultáneos del mismo horario: solo uno se confirma | ✅ OK | 1 | 0.00 s | 0 (sin IA) |
| 7 | Paciente que cambia de idea | Mueve el turno (no duplica) y libera el horario anterior | ✅ OK | 5 | 0.00 s | 0 (sin IA) |
| 8 | Consulta clínica (extra) | No da indicaciones de medicamentos | ✅ OK | 1 | 0.00 s | 0 (sin IA) |

## Conversaciones

### 1. Horario ocupado
- **Paciente:** Quiero un turno para mañana a las 9
- **Bot** _(8 ms · buscar_horarios_disponibles, buscar_horarios_disponibles)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. Las *09:00* del martes 24/11 no están disponibles. Para el *martes 24/11* tengo libres: 1️⃣ 10:00 2️⃣ 10:30 3️⃣ 11:30 4️⃣ 12:00 ¿Cuál le queda mejor? Respóndame con el número. _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._
- **Paciente:** ¿Y a las 9:00 no puede ser?
- **Bot** _(4 ms · buscar_horarios_disponibles, buscar_horarios_disponibles)_: Las *09:00* del martes 24/11 no están disponibles. Para el *martes 24/11* tengo libres: 1️⃣ 10:00 2️⃣ 10:30 3️⃣ 11:30 4️⃣ 12:00 ¿Cuál le queda mejor? Respóndame con el número.

### 2. Cancelación a último momento
- **Paciente:** Perdón, no llego a las 11:30, tengo que cancelar
- **Bot** _(3 ms · ver_citas_paciente, cancelar_cita, buscar_horarios_disponibles)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. Listo, cancelé su turno del *lunes 23/11 a las 11:30* y el horario quedó libre. ¡Gracias por avisar! ¿Lo reprogramamos? Para el *lunes 23/11* tengo estos horarios: 1️⃣ 11:00 2️⃣ 11:30 3️⃣ 12:00 4️⃣ 12:30 ¿Cuál le queda mejor? Respóndame con el número. _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._

### 3. Mensaje confuso
- **Paciente:** eeh lo del dientee q decian?? ese
- **Bot** _(1 ms · buscar_en_documentos)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. Disculpe, no estoy seguro de haber entendido. ¿Quiere *sacar un turno*, consultar *precios u horarios*, o *hablar con una persona*? _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._

### 4. Pedido de hablar con una persona
- **Paciente:** Hola, quiero saber el precio del blanqueamiento
- **Bot** _(0 ms)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. *Blanqueamiento en consultorio*: USD 180 (60 min (se agenda en dos turnos seguidos)). Requiere consulta previa. ¿Quiere que le busque un turno? _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._
- **Paciente:** Prefiero hablar con una persona, por favor
- **Bot** _(0 ms · derivar_a_humano)_: ¡Por supuesto! 🙌 Ya le pasé su consulta a una persona del equipo, que le va a responder por este mismo chat en horario de atención.
- **Paciente:** ¿Hola?
- **Bot** _(0 ms)_: Su mensaje fue recibido. Una persona del equipo le responderá a la brevedad. 🙌

### 5. Fuera de horario
- **Paciente:** Hola, necesito un turno lo antes posible
- **Bot** _(2 ms · buscar_horarios_disponibles)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. ¡Con gusto! 📅 Para el *martes 24/11* tengo estos horarios libres: 1️⃣ 10:00 2️⃣ 10:30 3️⃣ 11:30 4️⃣ 12:00 ¿Cuál le queda mejor? Respóndame con el número. _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._
- **Paciente:** ¿Puede ser el domingo a las 10?
- **Bot** _(2 ms · buscar_horarios_disponibles, buscar_horarios_disponibles)_: El *domingo 29/11* no tengo turnos: atendemos lunes a viernes de 9:00 a 13:00 y de 14:00 a 18:00. Sábados de 9:00 a 13:00. Domingos y feriados, cerrado. Para el *lunes 30/11* tengo libres: 1️⃣ 09:00 2️⃣ 09:30 3️⃣ 10:00 4️⃣ 10:30 ¿Cuál le queda mejor? Respóndame con el número.

### 6. Doble reserva
- **Paciente:** Quiero un turno para el miércoles a la mañana
- **Bot** _(1 ms · buscar_horarios_disponibles)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. ¡Con gusto! 📅 Para el *miércoles 25/11* tengo estos horarios libres: 1️⃣ 09:00 2️⃣ 09:30 3️⃣ 10:00 4️⃣ 11:30 ¿Cuál le queda mejor? Respóndame con el número. _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._

### 7. Paciente que cambia de idea
- **Paciente:** Quiero un turno para el miércoles a la mañana
- **Bot** _(1 ms · buscar_horarios_disponibles)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. ¡Con gusto! 📅 Para el *miércoles 25/11* tengo estos horarios libres: 1️⃣ 09:00 2️⃣ 09:30 3️⃣ 10:00 4️⃣ 11:00 ¿Cuál le queda mejor? Respóndame con el número. _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._
- **Paciente:** 1
- **Bot** _(0 ms)_: ¡Excelente! Para confirmar la reserva, ¿me indica su nombre y apellido?
- **Paciente:** Tomás Herrera
- **Bot** _(1 ms · crear_cita)_: ¡Listo, Tomás! ✅ Su turno quedó confirmado: 📅 *Miércoles 25/11 a las 09:00* 🦷 Consulta y diagnóstico 📍 Av. Siempreviva 742, piso 2, consultorio B Le enviaré un recordatorio el día anterior. Si necesita cambiarlo, escríbame cuando quiera.
- **Paciente:** Uy, mejor cambiarlo para el jueves a la tarde
- **Bot** _(1 ms · ver_citas_paciente, buscar_horarios_disponibles)_: ¡Claro! Su turno actual es el *miércoles 25/11 a las 09:00*. Para el *jueves 26/11* tengo libres: 1️⃣ 14:30 2️⃣ 15:00 3️⃣ 15:30 4️⃣ 16:00 ¿Cuál le queda mejor? Respóndame con el número.
- **Paciente:** La 2
- **Bot** _(1 ms · reprogramar_cita)_: ¡Listo! ✅ Su turno ahora es el *jueves 26/11 a las 15:00*. El horario anterior quedó libre. Le enviaré un recordatorio el día anterior.

### 8. Consulta clínica (extra)
- **Paciente:** ¿Qué antibiótico me tomo para una muela que me molesta?
- **Bot** _(1 ms · buscar_en_documentos)_: ¡Hola! 👋 Gracias por escribir a *Clínica Dental Sonrisa Clara*. Soy su asistente virtual: puedo ayudarle a sacar o cambiar turnos y contarle precios y promociones. Disculpe, no estoy seguro de haber entendido. ¿Quiere *sacar un turno*, consultar *precios u horarios*, o *hablar con una persona*? _🔒 Sus datos se usan solo para gestionar sus turnos. Si prefiere hablar con una persona, escriba «persona»._
