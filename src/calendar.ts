import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CALENDAR_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "calendar-helper");

export type CalendarEventInput = {
  title: string;
  start: string;
  end: string;
  calendar?: string;
  location?: string;
  notes?: string;
  allDay?: boolean;
};

export type CalendarEventResult = {
  id: string;
  calendarId: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  url: string | null;
};

export type CalendarInfo = {
  id: string;
  name: string;
  writable: boolean;
};

export type CalendarEventQuery = {
  start: string;
  end: string;
  calendar?: string;
  maxResults?: number;
};

export type CalendarDayEventQuery = {
  date: string;
  maxResults?: number;
};

export type ListedCalendarEvent = {
  id: string;
  calendarId: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  notes: string | null;
  url: string | null;
};

export type CalendarEventUpdateInput = {
  id: string;
  title?: string;
  start?: string;
  end?: string;
  calendar?: string;
  location?: string;
  notes?: string;
  allDay?: boolean;
};

export type CalendarEventDeleteInput = {
  id: string;
};

function execFileAsync(command: string, args: string[], timeoutMs = 29_000): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr.trim() || stdout.trim() || error.message));
      return;
    }

    resolve(stdout.trim());
  });
  return promise;
}

async function runCalendarHelper<T>(args: string[]): Promise<T> {
  const output = await execFileAsync(CALENDAR_HELPER, args);
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`calendar-helper returned invalid JSON: ${message}. Output: ${output}`);
  }
}


function requireValidDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${field}. Expected an ISO 8601 datetime.`);
  }
  return date;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}


function localIso(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}:${pad2(date.getSeconds())}`;
}

function localIsoWithOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  return `${localIso(date)}${sign}${pad2(Math.floor(absMinutes / 60))}:${pad2(absMinutes % 60)}`;
}

function nullIfEmpty(value: string | null | undefined): string | null {
  return value && value.trim() !== "" ? value : null;
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  return runCalendarHelper<CalendarInfo[]>(["list-calendars"]);
}

export async function createCalendarEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("title cannot be empty.");
  }
  const startDate = requireValidDate(input.start, "start");
  const endDate = requireValidDate(input.end, "end");
  if (endDate.getTime() <= startDate.getTime()) {
    throw new Error("end must be after start.");
  }

  const args = ["create-event", "--title", title, "--start", input.start, "--end", input.end];
  const calendarName = input.calendar?.trim();
  if (calendarName) {
    args.push("--calendar", calendarName);
  }
  if (input.location !== undefined) {
    args.push("--location", input.location.trim());
  }
  if (input.notes !== undefined) {
    args.push("--notes", input.notes.trim());
  }
  if (input.allDay !== undefined) {
    args.push("--all-day", String(input.allDay));
  }

  const event = await runCalendarHelper<ListedCalendarEvent>(args);
  return {
    ...event,
    location: nullIfEmpty(event.location ?? undefined),
    notes: nullIfEmpty(event.notes ?? undefined),
    url: nullIfEmpty(event.url ?? undefined),
  };
}

export async function listCalendarEvents(query: CalendarEventQuery): Promise<ListedCalendarEvent[]> {
  const startDate = requireValidDate(query.start, "start");
  const endDate = requireValidDate(query.end, "end");
  if (endDate.getTime() <= startDate.getTime()) {
    throw new Error("end must be after start.");
  }

  const maxResults = Math.max(1, Math.min(query.maxResults ?? 100, 500));
  const args = ["list-events", "--start", query.start, "--end", query.end, "--max", String(maxResults)];
  const calendarName = query.calendar?.trim();
  if (calendarName) {
    args.push("--calendar", calendarName);
  }

  const events = await runCalendarHelper<ListedCalendarEvent[]>(args);
  return events.map(({ id, calendarId, calendar, title, start, end, allDay, location, notes, url }) => ({
    id,
    calendarId,
    calendar,
    title,
    start,
    end,
    allDay,
    location: nullIfEmpty(location ?? undefined),
    notes: nullIfEmpty(notes ?? undefined),
    url: nullIfEmpty(url ?? undefined),
  }));
}

export async function listCalendarEventsForDay(query: CalendarDayEventQuery): Promise<ListedCalendarEvent[]> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(query.date);
  if (!match) {
    throw new Error("date must be an ISO calendar date in YYYY-MM-DD format.");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new Error("date must be a real calendar date.");
  }

  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return listCalendarEvents({
    start: localIsoWithOffset(start),
    end: localIsoWithOffset(end),
    maxResults: query.maxResults,
  });
}

export async function updateCalendarEvent(input: CalendarEventUpdateInput): Promise<ListedCalendarEvent> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id is required.");
  }
  if (
    input.title === undefined &&
    input.start === undefined &&
    input.end === undefined &&
    input.calendar === undefined &&
    input.location === undefined &&
    input.notes === undefined &&
    input.allDay === undefined
  ) {
    throw new Error("At least one event field must be provided.");
  }

  if (input.start !== undefined) {
    requireValidDate(input.start, "start");
  }
  if (input.end !== undefined) {
    requireValidDate(input.end, "end");
  }
  if (input.start !== undefined && input.end !== undefined) {
    const startDate = requireValidDate(input.start, "start");
    const endDate = requireValidDate(input.end, "end");
    if (endDate.getTime() <= startDate.getTime()) {
      throw new Error("end must be after start.");
    }
  }

  const args = ["update-event", "--id", id];
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) {
      throw new Error("title cannot be empty.");
    }
    args.push("--title", title);
  }
  if (input.start !== undefined) {
    args.push("--start", input.start);
  }
  if (input.end !== undefined) {
    args.push("--end", input.end);
  }
  if (input.calendar !== undefined) {
    const calendar = input.calendar.trim();
    if (!calendar) {
      throw new Error("calendar cannot be empty.");
    }
    args.push("--calendar", calendar);
  }
  if (input.location !== undefined) {
    args.push("--location", input.location.trim());
  }
  if (input.notes !== undefined) {
    args.push("--notes", input.notes.trim());
  }
  if (input.allDay !== undefined) {
    args.push("--all-day", String(input.allDay));
  }

  const event = await runCalendarHelper<ListedCalendarEvent>(args);
  return {
    ...event,
    location: nullIfEmpty(event.location ?? undefined),
    notes: nullIfEmpty(event.notes ?? undefined),
    url: nullIfEmpty(event.url ?? undefined),
  };
}

export async function deleteCalendarEvent(input: CalendarEventDeleteInput): Promise<ListedCalendarEvent> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id is required.");
  }

  const event = await runCalendarHelper<ListedCalendarEvent>(["delete-event", "--id", id]);
  return {
    ...event,
    location: nullIfEmpty(event.location ?? undefined),
    notes: nullIfEmpty(event.notes ?? undefined),
    url: nullIfEmpty(event.url ?? undefined),
  };
}
