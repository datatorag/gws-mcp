import { authTools } from "./auth.js";
import { genericTools } from "./generic.js";
import { gmailTools } from "./gmail.js";
import { driveTools } from "./drive.js";
import { calendarTools } from "./calendar.js";
import { contactsTools } from "./contacts.js";
import { sheetsTools } from "./sheets.js";
import { docsTools } from "./docs.js";
import { slidesTools } from "./slides.js";

export const allTools = [
  ...authTools,
  ...gmailTools,
  ...calendarTools,
  ...contactsTools,
  ...driveTools,
  ...sheetsTools,
  ...docsTools,
  ...slidesTools,
  ...genericTools,
];
