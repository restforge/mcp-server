import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerHealthPing(server: McpServer, version: string): void {
  server.registerTool(
    'health_ping',
    {
      title: 'Health Ping',
      description: `Simple smoke test tool to verify the MCP server is up and responsive.
Not related to RESTForge operations — purely for verifying MCP transport.

USE WHEN:
- Verifying that the MCP server itself is reachable and responsive
- Checking if the server can receive and respond to tool calls
- Diagnosing whether a problem is in the MCP transport layer or in a specific tool
- The user asks things like "ping the MCP server", "is the MCP server alive",
  "cek MCP server", "MCP server jalan tidak", "test the MCP connection",
  "apakah MCP-nya nyala", "smoke test the server"

DO NOT USE FOR:
- Validating the RESTForge license or database connection -> use 'setup_validate_config'
- Reading the active configuration of a project -> use 'setup_read_env'
- Anything related to RESTForge state, configuration, or project setup

This tool runs in-process: it does not touch the filesystem, network, or any RESTForge component.
Output: "pong" with ISO 8601 timestamp and server version, plus the optional echoed message.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "verify the MCP server is responsive", "validate the configuration").
- Speak in plain language. Confirm that the MCP server is responsive and report the timestamp and server version.
- Keep the reply concise; this is a smoke test, not a diagnostic dump.`,
      inputSchema: {
        message: z
          .string()
          .optional()
          .describe('Optional message to echo back in the response'),
      },
      annotations: {
        title: 'Health Ping',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ message }) => {
      const timestamp = new Date().toISOString();

      // Success: one-line summary + labeled facts per §3.5.
      const facts = [
        `Response: pong`,
        `Timestamp: ${timestamp}`,
        `Server version: ${version}`,
      ];
      if (message) {
        facts.push(`Echo: ${message}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: `MCP server is up and responsive.

${facts.join('\n')}

For the assistant:
- Confirm to the user that the MCP server is reachable and report the timestamp and server version in plain language.
- ${message ? 'The optional message was echoed back; mention it briefly if relevant.' : 'No echo message was supplied.'}
- Keep the reply concise. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
