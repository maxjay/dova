import type { Command } from 'commander';
import { registerWiCreateCommand } from './create.js';
import { registerWiQuickCommand } from './quick.js';
import { registerWiViewCommand } from './view.js';
import { registerWiSearchCommand } from './search.js';

export function registerWiCommand(program: Command): void {
  const wi = program.command('wi').description('Work item commands: create, view, and search');
  registerWiCreateCommand(wi);
  registerWiQuickCommand(wi);
  registerWiViewCommand(wi);
  registerWiSearchCommand(wi);
}
