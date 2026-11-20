import type { ToolDefinition } from '../registry.js';
import { gmailTools } from './gmail.js';
// Their own modules: they build on gmail.ts, which cannot import them back without a cycle.
import { gmailUpdateDraft } from './gmail-update-draft.js';
import { gmailScheduleSend } from './gmail-schedule.js';
import { gmailCreateDrafts } from './gmail-merge.js';
import { gmailAwaitingReply } from './gmail-followup.js';
import { gmailFindContacts } from './gmail-contacts.js';
import { sensitiveContactsTool } from './sensitive.js';
import { followupTools } from './followups.js';
import { driveSave } from './drive-save.js';
import { driveDocPdf } from './drive-pdf.js';
import { driveSearchAll } from './drive-search-all.js';
import { calendarTools } from './calendar.js';
import { sheetsTools } from './sheets.js';
import { driveTools } from './drive.js';
import { crossTools } from './cross.js';
import { uploadTools } from './uploads.js';
import { sendToLink } from './send-to-link.js';

export const allTools: ToolDefinition[] = [
  ...gmailTools,
  gmailUpdateDraft,
  gmailScheduleSend,
  gmailCreateDrafts,
  gmailAwaitingReply,
  gmailFindContacts,
  sensitiveContactsTool,
  ...calendarTools,
  ...sheetsTools,
  ...driveTools,
  driveSave,
  driveDocPdf,
  driveSearchAll,
  ...crossTools,
  ...followupTools,
  ...uploadTools,
  sendToLink,
];
