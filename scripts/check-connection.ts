// Script de diagnóstico — verifica que el DATABASE_URL conecta y puede leer `orders`.
// NO es parte del MCP server; es solo una herramienta de debug.
// Uso: bun run check-db

import { sql } from "../src/db.ts";

try {
  const [ping] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  console.log("✅ Conexión OK. Hora del server de DB:", ping?.now);

  const [orders] = await sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM orders`;
  console.log(`✅ Lectura de 'orders' OK. Total de pedidos en la DB: ${orders?.total}`);

  console.log("\n🎉 Todo listo. Ahora podés correr:  bun run inspect");
} catch (err) {
  console.error("❌ Falló la conexión o la lectura:");
  console.error("   ", err instanceof Error ? err.message : String(err));
  console.error("\nRevisá el DATABASE_URL en .env.local (rol, password, host, puerto).");
  console.error("Si la conexión directa falla, probá el host del 'Session pooler' de Supabase.");
} finally {
  await sql.end({ timeout: 5 });
}
