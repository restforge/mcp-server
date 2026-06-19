import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSetupCreateFolder } from './create-folder.js';
import { registerSetupInstallPackage } from './install-package.js';
import { registerSetupInitConfig } from './init-config.js';
import { registerSetupWriteEnv } from './write-env.js';
import { registerSetupReadEnv } from './read-env.js';
import { registerSetupUpdateEnv } from './update-env.js';
import { registerSetupValidateConfig } from './validate-config.js';
import { registerSetupGetConfigSchema } from './get-config-schema.js';
import { registerSetupGetInitTemplate } from './get-init-template.js';
import { registerSetupSetDefaultConfig } from './set-default-config.js';
import { registerSetupGetDefaultConfig } from './get-default-config.js';
import { registerSetupClearDefaultConfig } from './clear-default-config.js';
import { registerSetupListConfigs } from './list-configs.js';

export function registerSetupTools(server: McpServer): void {
  registerSetupCreateFolder(server);
  registerSetupInstallPackage(server);
  registerSetupInitConfig(server);
  registerSetupWriteEnv(server);
  registerSetupReadEnv(server);
  registerSetupUpdateEnv(server);
  registerSetupValidateConfig(server);
  registerSetupGetConfigSchema(server);
  registerSetupGetInitTemplate(server);
  registerSetupSetDefaultConfig(server);
  registerSetupGetDefaultConfig(server);
  registerSetupClearDefaultConfig(server);
  registerSetupListConfigs(server);
}
