import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    "[FATAL] DATABASE_URL no está seteado. " +
      "Copiá .env.example a .env.local y completá el connection string del rol mcp_auditor. " +
      "Ver README §Setup.",
  );
  process.exit(1);
}

// `sql` es la instancia única de postgres para toda la app.
// El MCP server stdio es single-process single-connection (PRD §7.5),
// no necesita pool grande.
export const sql = postgres(DATABASE_URL, {
  ssl: "require",      // Supabase obliga TLS.
  max: 1,               // 1 conexión es suficiente para uso interactivo.
  idle_timeout: 30,     // cerrar conexión inactiva tras 30s.
  connect_timeout: 10,  // fallar rápido si Supabase no responde.
});

// Cierre limpio cuando el cliente MCP (Claude Code) mata el subprocess.
async function gracefulShutdown(): Promise<void> {
  try {
    await sql.end({ timeout: 5 });
  } catch {
    // El proceso se está cerrando — ignorar errores de cierre.
  }
}

process.on("SIGINT", () => {
  void gracefulShutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void gracefulShutdown().then(() => process.exit(0));
});
