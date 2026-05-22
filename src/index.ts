// Entry point del MCP server (Pizza Demo Auditor).
// Crea el server, registra las tools + el resource, y conecta el transport stdio.
// NO contiene lógica de negocio — solo cableado (RULES §2).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  handleQueryOrders,
  queryOrdersDescription,
  queryOrdersInputSchema,
} from "./tools/query-orders.ts";
import {
  detectActivityGapsDescription,
  detectActivityGapsInputSchema,
  handleDetectActivityGaps,
} from "./tools/detect-activity-gaps.ts";
import {
  readSchemaResource,
  schemaResourceConfig,
  SCHEMA_RESOURCE_URI,
} from "./resources/schema.ts";

const server = new McpServer({
  name: "pizza-demo-auditor",
  version: "1.0.0",
});

// --- Tools ---

server.registerTool(
  "query_orders",
  {
    description: queryOrdersDescription,
    inputSchema: queryOrdersInputSchema,
  },
  (args) => handleQueryOrders(args),
);

server.registerTool(
  "detect_activity_gaps",
  {
    description: detectActivityGapsDescription,
    inputSchema: detectActivityGapsInputSchema,
  },
  (args) => handleDetectActivityGaps(args),
);

// --- Resources ---

server.registerResource(
  "pizza-demo-schema",
  SCHEMA_RESOURCE_URI,
  schemaResourceConfig,
  (uri) => readSchemaResource(uri),
);

// --- Conectar el transport stdio ---
// stdout queda reservado para el protocolo MCP; todo log va a stderr.

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  "[pizza-demo-auditor] MCP server listo (stdio). " +
    "Tools: query_orders, detect_activity_gaps. Resource: pizza-demo://schema.",
);
