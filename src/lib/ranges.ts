// Parseo y validación de rangos temporales para las tools del MCP.
// Todas las fechas se interpretan en zona America/Bogota (UTC-5 fijo, sin DST).
// Output: { from: Date, to: Date } en UTC, listo para usar en queries SQL.

import { COLOMBIA_OFFSET, TZ } from "../constants.ts";

// --- Tipos ---

export type RangePreset = "hoy" | "ayer" | "semana" | "mes";

export type RangeInput = {
  preset?: RangePreset;
  from?: string;
  to?: string;
};

export type ResolvedRange = {
  from: Date;
  to: Date;
  /** Etiqueta humana, útil para serializar de vuelta al cliente. */
  label: string;
};

// --- API pública ---

/**
 * Convierte un RangeInput en `{ from, to }` UTC.
 * Tira `Error` con mensaje legible si el input es inválido.
 * NO devuelve isError: true — eso es responsabilidad del caller (handler de tool).
 */
export function parseRange(input: RangeInput): ResolvedRange {
  const hasPreset = input.preset !== undefined;
  const hasManual = input.from !== undefined || input.to !== undefined;

  if (hasPreset && hasManual) {
    throw new Error("Especificá solo `preset` o el par `from`+`to`, no ambos.");
  }
  if (!hasPreset && !hasManual) {
    throw new Error(
      "Falta el rango: especificá `preset` (hoy|ayer|semana|mes) o el par `from`+`to`.",
    );
  }

  if (hasPreset) {
    return resolvePreset(input.preset!);
  }

  // Manual: ambos campos obligatorios.
  if (input.from === undefined || input.to === undefined) {
    throw new Error(
      "Si usás rango manual, `from` Y `to` son obligatorios (ISO 8601).",
    );
  }

  const from = new Date(input.from);
  const to = new Date(input.to);

  if (Number.isNaN(from.getTime())) {
    throw new Error(
      `Formato de \`from\` inválido: "${input.from}". Usá ISO 8601 (ej: 2026-05-21T00:00:00Z o 2026-05-21).`,
    );
  }
  if (Number.isNaN(to.getTime())) {
    throw new Error(`Formato de \`to\` inválido: "${input.to}". Usá ISO 8601.`);
  }
  if (from > to) {
    throw new Error("`from` es posterior a `to`.");
  }

  return {
    from,
    to,
    label: `${input.from} → ${input.to} (manual)`,
  };
}

// --- Helpers internos ---

function resolvePreset(preset: RangePreset): ResolvedRange {
  const today = colombiaDateStr(new Date());

  switch (preset) {
    case "hoy":
      return {
        from: startOfDay(today),
        to: endOfDay(today),
        label: `hoy (${today}, ${TZ})`,
      };

    case "ayer": {
      const yesterday = addDays(today, -1);
      return {
        from: startOfDay(yesterday),
        to: endOfDay(yesterday),
        label: `ayer (${yesterday}, ${TZ})`,
      };
    }

    case "semana": {
      // Últimos 7 días incluyendo hoy: today-6 .. today.
      const start = addDays(today, -6);
      return {
        from: startOfDay(start),
        to: endOfDay(today),
        label: `últimos 7 días (${start} → ${today}, ${TZ})`,
      };
    }

    case "mes": {
      // Últimos 30 días incluyendo hoy.
      const start = addDays(today, -29);
      return {
        from: startOfDay(start),
        to: endOfDay(today),
        label: `últimos 30 días (${start} → ${today}, ${TZ})`,
      };
    }
  }
}

/**
 * Formatea un Date (instante UTC) como ISO 8601 en hora de Colombia, con el
 * offset -05:00 explícito. Ej: 16:19 UTC → "2026-05-22T11:19:38-05:00".
 * Muestra la hora local Y queda inequívoco/parseable (no como un "...Z" UTC).
 */
export function toColombiaISO(date: Date): string {
  // Colombia es UTC-5 fijo: restamos 5h al instante y leemos los componentes
  // UTC del resultado, que ahora representan el reloj de pared de Colombia.
  const shifted = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  const y = shifted.getUTCFullYear();
  const mo = p(shifted.getUTCMonth() + 1);
  const d = p(shifted.getUTCDate());
  const h = p(shifted.getUTCHours());
  const mi = p(shifted.getUTCMinutes());
  const s = p(shifted.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${COLOMBIA_OFFSET}`;
}

/** Devuelve YYYY-MM-DD del día (en America/Bogota) de un Date dado. */
export function colombiaDateStr(d: Date): string {
  // en-CA da formato YYYY-MM-DD, robusto y portable.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/** Suma `days` a un YYYY-MM-DD y devuelve el resultado en el mismo formato. */
export function addDays(dateStr: string, days: number): string {
  // Mediodía UTC del día base para evitar edge cases de bordes de día.
  const base = new Date(`${dateStr}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function startOfDay(dateStr: string): Date {
  // 00:00:00 en hora de Colombia → Date UTC.
  return new Date(`${dateStr}T00:00:00${COLOMBIA_OFFSET}`);
}

function endOfDay(dateStr: string): Date {
  // 23:59:59.999 en hora de Colombia → Date UTC.
  return new Date(`${dateStr}T23:59:59.999${COLOMBIA_OFFSET}`);
}
