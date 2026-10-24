import { run } from './cli/framework.js';
import { commands } from './cli/commands/index.js';

process.exitCode = await run(commands, process.argv.slice(2));
