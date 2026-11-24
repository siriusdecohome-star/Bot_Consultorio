import { setDefaultClinic } from "../../clinics/context.js";
import { demoClinics } from "./index.js";

// Clínica por defecto fuera de un pedido (scripts, pruebas): la principal de ejemplo.
// El servidor la reemplaza por la que lee de la base al arrancar.
setDefaultClinic(demoClinics()[0]!);
