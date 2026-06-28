import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDesignerValidatePayload } from './validate-payload.js';
import { registerDesignerPreviewFiles } from './preview-files.js';
import { registerDesignerListPlugins } from './list-plugins.js';
import { registerDesignerInspectPlugin } from './inspect-plugin.js';
import { registerDesignerScaffoldPlugin } from './scaffold-plugin.js';
import { registerDesignerInitProject } from './init-project.js';
import { registerDesignerGenerate } from './generate.js';
import { registerDesignerGetUdfCatalog } from './get-udf-catalog.js';
import { registerDesignerAuthCreate } from './auth-create.js';
import { registerDesignerAuthRemove } from './auth-remove.js';

export function registerDesignerTools(server: McpServer): void {
  registerDesignerValidatePayload(server);
  registerDesignerPreviewFiles(server);
  registerDesignerListPlugins(server);
  registerDesignerInspectPlugin(server);
  registerDesignerScaffoldPlugin(server);
  registerDesignerInitProject(server);
  registerDesignerGenerate(server);
  registerDesignerGetUdfCatalog(server);
  registerDesignerAuthCreate(server);
  registerDesignerAuthRemove(server);
}
