import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { createApp, type App } from "../src/app.js";

/**
 * Función de Vercel: todas las rutas llegan acá (ver vercel.json) y las atiende la misma
 * aplicación de Express que el servidor local. Diferencias con el servidor local:
 * - no hay temporizadores: el cron de Supabase llama a POST /api/cron/tick cada 5 minutos;
 * - el webhook de WhatsApp responde 200 a Meta y termina de procesar con waitUntil;
 * - lo que debe ser común a todas las instancias (mensajes ya procesados, límites, bandeja
 *   del simulador, demos) vive en Supabase.
 * La aplicación se arma una vez por instancia y se reutiliza entre pedidos.
 */
let ready: Promise<App> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= createApp({ serverless: true, defer: (work) => waitUntil(work) }).catch((err) => {
    ready = null; // el próximo pedido vuelve a intentar
    throw err;
  });
  try {
    const { app } = await ready;
    app(req as any, res as any);
  } catch (err) {
    console.error("[vercel]", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("El servidor no pudo iniciar. Revisá las variables de entorno en Vercel (ver los registros de la función).");
  }
}
