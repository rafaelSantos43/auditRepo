import { z } from "zod";

// MCP tool result shape (subset que usamos — el SDK acepta más).
type McpTextContent = { type: "text"; text: string };
export type McpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

/**
 * Envuelve cualquier error en el shape de result que MCP espera.
 * NUNCA tira excepciones al stdio — siempre devuelve `isError: true`.
 *
 * Ver RULES §5 (contrato de errores).
 */
export function toErrorResult(err: unknown): McpToolResult {
  let text: string;

  if (err instanceof z.ZodError) {
    const issues = err.issues
      .map((i) => {
        const path = i.path.length > 0 ? i.path.join(".") : "(root)";
        return `${path}: ${i.message}`;
      })
      .join("; ");
    text = `Error de validación de input: ${issues}`;
  } else if (err instanceof Error) {
    text = `Error: ${err.message}`;
  } else {
    text = `Error desconocido: ${String(err)}`;
  }

  // Log a stderr para debug local. Stdout queda libre para el protocolo MCP.
  console.error("[tool-error]", text);

  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

/**
 * Envuelve un payload exitoso en el shape de result que MCP espera.
 * El payload se serializa a JSON (NO markdown — ver RULES §1 + PRD §5.2).
 */
export function toSuccessResult(payload: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
