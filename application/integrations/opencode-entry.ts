import type { Plugin } from '@opencode-ai/plugin';
import { createWorkHubTools } from './opencode-work-hub.ts';

export const WorkHubPlugin: Plugin = async () => ({ tool: createWorkHubTools() });
export default WorkHubPlugin;
