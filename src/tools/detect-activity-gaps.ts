// Tool MCP: detect_activity_gaps
// ---
// Detecta ventanas de tiempo en HORARIO PICO donde no entró ningún pedido.
// Es la señal más fuerte de abandono operativo: ausencia de pedidos un
// viernes a las 8pm = el cajero no está usando el sistema.
//
// Contrato completo en PRD §5.2.
// Enfoque: traemos los timestamps con un SELECT simple y calculamos los
// huecos en TypeScript. Para una pizzería (cientos de pedidos) es más
// performante y MUCHO más legible que SQL con generate_series.

import { z } from "zod";

import { sql } from "../db.ts";
import { COLOMBIA_OFFSET, PEAK_HOURS, T_ORDERS, TZ } from "../constants.ts";
import { toErrorResult, toSuccessResult, type McpToolResult } from "../lib/errors.ts";
import { addDays, colombiaDateStr, parseRange } from "../lib/ranges.ts";

// Texto que el agente lee para decidir cuándo invocar la tool (RULES §3).
export const detectActivityGapsDescription =
  "Detecta ventanas de horario pico (viernes/sábado/domingo) donde no entró " +
  "ningún pedido en Pizza Demo. Úsala para responder si el sistema se está " +
  "usando en los momentos que importan, o si hubo abandono operativo. Es la " +
  "señal más fuerte de que el cliente dejó de usar el sistema (más fuerte que " +
  "contar pedidos: ausencia en pico = renuncia). NO la uses para conteos ni " +
  "totales — para eso existe query_orders.";

// =====================================================================
// Schema de input
// =====================================================================

export const detectActivityGapsInputSchema = {
  preset: z
    .enum(["semana", "mes"])
    .optional()
    .describe(
      "Rango pre-definido (semana = últimos 7 días, mes = últimos 30). Default: semana. Mutuamente excluyente con from/to.",
    ),
  from: z
    .string()
    .optional()
    .describe("Inicio del rango en ISO 8601. Requiere `to`."),
  to: z
    .string()
    .optional()
    .describe("Fin del rango en ISO 8601. Requiere `from`."),
  window_hours: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe(
      "Tamaño mínimo (en horas) de un hueco para considerarlo silencio. Default 2. Un hueco menor a esto se considera actividad normal entre pedidos.",
    ),
};

type Input = {
  preset?: "semana" | "mes";
  from?: string;
  to?: string;
  window_hours?: number;
};

// =====================================================================
// Shape del output
// =====================================================================

type Gap = {
  start: string;
  end: string;
  duration_hours: number;
  weekday: string;
};

type Output = {
  range: { from: string; to: string; timezone: string; label: string };
  window_hours: number;
  peak_hours_definition: Record<string, string>;
  gaps: Gap[];
  total_peak_hours: number;
  total_silent_hours: number;
  silence_pct: number;
};

// Nombres de día indexados por getUTCDay() (0=domingo).
const DAY_NAME = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];

const MS_PER_HOUR = 3_600_000;

// =====================================================================
// Handler
// =====================================================================

export async function handleDetectActivityGaps(input: Input): Promise<McpToolResult> {
  try {
    // Default a "semana" si no se especificó ningún rango.
    const noRange =
      input.preset === undefined &&
      input.from === undefined &&
      input.to === undefined;
    const range = parseRange(
      noRange
        ? { preset: "semana" }
        : { preset: input.preset, from: input.from, to: input.to },
    );

    const windowHours = input.window_hours ?? 2;
    const windowMs = windowHours * MS_PER_HOUR;

    // 1. Traer los timestamps de TODOS los pedidos del rango (orden ascendente).
    const rows = await sql<{ created_at: Date }[]>`
      SELECT created_at
      FROM ${sql(T_ORDERS)}
      WHERE created_at >= ${range.from} AND created_at <= ${range.to}
      ORDER BY created_at ASC
    `;
    const timestamps = rows.map((r) => r.created_at.getTime());

    // 2. Recorrer día por día; para cada día con horario pico, buscar huecos.
    const gaps: Gap[] = [];
    let totalPeakHours = 0;
    let totalSilentHours = 0;

    for (const day of iterateDays(range.from, range.to)) {
      // getUTCDay() de mediodía-UTC de ese día = día de la semana correcto
      // (Colombia es UTC-5, mediodía UTC sigue siendo el mismo día calendario).
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      const peak = PEAK_HOURS[weekday];
      if (!peak) continue; // ese día no es horario pico → silencio no es señal

      // Límites del pico ese día, como instantes UTC.
      const peakStart = new Date(`${day}T${peak.start}:00${COLOMBIA_OFFSET}`).getTime();
      const peakEnd = new Date(`${day}T${peak.end}:00${COLOMBIA_OFFSET}`).getTime();

      // Recortar al rango efectivamente pedido (por si arranca/termina a mitad).
      const start = Math.max(peakStart, range.from.getTime());
      const end = Math.min(peakEnd, range.to.getTime());
      if (start >= end) continue;

      totalPeakHours += (end - start) / MS_PER_HOUR;

      // Pedidos que cayeron dentro de esta ventana de pico.
      const inWindow = timestamps.filter((t) => t >= start && t <= end);

      // Recorrer los huecos:
      //   [start → primer pedido], [entre pedidos], [último pedido → end].
      // Un hueco >= windowMs cuenta como silencio.
      let cursor = start;
      for (const t of inWindow) {
        if (t - cursor >= windowMs) {
          gaps.push(buildGap(cursor, t, weekday));
          totalSilentHours += (t - cursor) / MS_PER_HOUR;
        }
        cursor = Math.max(cursor, t);
      }
      // Hueco final entre el último pedido y el cierre del pico.
      if (end - cursor >= windowMs) {
        gaps.push(buildGap(cursor, end, weekday));
        totalSilentHours += (end - cursor) / MS_PER_HOUR;
      }
    }

    // 3. Definición legible del horario pico (derivada de constants, no hardcoded).
    const peakHoursDef: Record<string, string> = {};
    for (const [dayNum, window] of Object.entries(PEAK_HOURS)) {
      if (window) {
        const name = DAY_NAME[Number(dayNum)] ?? dayNum;
        peakHoursDef[name] = `${window.start}-${window.end}`;
      }
    }

    const output: Output = {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        timezone: TZ,
        label: range.label,
      },
      window_hours: windowHours,
      peak_hours_definition: peakHoursDef,
      gaps,
      total_peak_hours: round1(totalPeakHours),
      total_silent_hours: round1(totalSilentHours),
      silence_pct:
        totalPeakHours > 0 ? round1((totalSilentHours / totalPeakHours) * 100) : 0,
    };

    return toSuccessResult(output);
  } catch (err) {
    return toErrorResult(err);
  }
}

// =====================================================================
// Helpers internos
// =====================================================================

/** Genera los días YYYY-MM-DD (hora Colombia) entre `from` y `to`, inclusive. */
function* iterateDays(from: Date, to: Date): Generator<string> {
  let cursor = colombiaDateStr(from);
  const last = colombiaDateStr(to);
  // Tope de seguridad: ~1 año, evita loop infinito si algo sale mal.
  let safety = 0;
  while (cursor <= last && safety < 400) {
    yield cursor;
    cursor = addDays(cursor, 1);
    safety++;
  }
}

function buildGap(startMs: number, endMs: number, weekday: number): Gap {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    duration_hours: round1((endMs - startMs) / MS_PER_HOUR),
    weekday: DAY_NAME[weekday] ?? String(weekday),
  };
}

/** Redondea a 1 decimal sin librerías. Ej: 2.4666 → 2.5 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
