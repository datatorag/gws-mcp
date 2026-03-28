import type { GwsClient } from "../gws-client.js";
import { authTools, handleAuth } from "./auth.js";
import { genericTools, handleGeneric } from "./generic.js";
import { gmailTools, handleGmail } from "./gmail.js";
import { driveTools, handleDrive } from "./drive.js";
import { calendarTools, handleCalendar } from "./calendar.js";
import { contactsTools, handleContacts } from "./contacts.js";
import { sheetsTools, handleSheets } from "./sheets.js";
import { docsTools, handleDocs } from "./docs.js";
import { slidesTools, handleSlides } from "./slides.js";
import { tasksTools, handleTasks } from "./tasks.js";

export type ToolHandler = (
  client: GwsClient,
  name: string,
  args: Record<string, unknown>
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

export const allTools = [
  ...authTools,
  ...gmailTools,
  ...calendarTools,
  ...contactsTools,
  ...driveTools,
  ...sheetsTools,
  ...docsTools,
  ...slidesTools,
  ...tasksTools,
  ...genericTools,
];

function register(
  toolDefs: { name: string }[],
  handler: ToolHandler
): [string, ToolHandler][] {
  return toolDefs.map((t) => [t.name, handler]);
}

export const toolHandlers = new Map<string, ToolHandler>([
  ...register(authTools, (c, _n, a) => handleAuth(c, a)),
  ...register(gmailTools, handleGmail),
  ...register(calendarTools, handleCalendar),
  ...register(contactsTools, handleContacts),
  ...register(driveTools, handleDrive),
  ...register(sheetsTools, handleSheets),
  ...register(docsTools, handleDocs),
  ...register(slidesTools, handleSlides),
  ...register(tasksTools, handleTasks),
  ...register(genericTools, (c, _n, a) => handleGeneric(c, a)),
]);
