import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CalendarEventInput = {
  title: string;
  start: string;
  end: string;
  calendar?: string;
  location?: string;
  notes?: string;
};

export type CalendarEventResult = {
  calendar: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  notes: string | null;
};

function execFileAsync(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

export async function createCalendarEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/add_calendar_event.js");
  const payload = JSON.stringify(input);
  const output = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", scriptPath, payload]);

  if (!output) {
    throw new Error("macOS Calendar did not return a result.");
  }

  return JSON.parse(output) as CalendarEventResult;
}
