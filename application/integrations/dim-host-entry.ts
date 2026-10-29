import { createDimRecipientPlugin, createWorkHubRecipientProxy } from './dim-recipient.ts';

export const hostPlugin = createDimRecipientPlugin(createWorkHubRecipientProxy());
