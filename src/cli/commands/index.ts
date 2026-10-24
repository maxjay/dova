import type { Group } from '../framework.js';
import { linkCommands } from './link.js';
import { api, auth, completeWords, completion, daemon, instructions } from './misc.js';
import { pipeline } from './pipeline.js';
import { pr } from './pr.js';
import { status } from './status.js';
import { summarizeCommand } from './summarize.js';
import { bug, view, wi } from './wi.js';

export const commands: Group['commands'] = [status, ...linkCommands, summarizeCommand, view, wi, bug, pr, pipeline, api, auth, daemon, instructions, completion, completeWords];
