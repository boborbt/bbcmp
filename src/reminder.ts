import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REMINDER_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "reminder-helper");

export type ReminderListInfo = {
  id: string;
  name: string;
  writable: boolean;
};

export type ReminderResult = {
  id: string;
  listId: string;
  list: string;
  title: string;
  due: string | null;
  notes: string | null;
  completed: boolean;
  completionDate: string | null;
};

export type ReminderListQuery = {
  list?: string;
  includeCompleted?: boolean;
  dueStart?: string;
  dueEnd?: string;
  maxResults?: number;
};

export type ReminderInput = {
  title: string;
  due: string;
  list?: string;
  notes?: string;
};

export type ReminderUpdateInput = {
  id: string;
  title?: string;
  due?: string;
  clearDue?: boolean;
  list?: string;
  notes?: string;
  completed?: boolean;
};

export type ReminderDeleteInput = {
  id: string;
};

function execFileAsync(command: string, args: string[], timeoutMs = 29_000): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(stderr?.trim() || error.message));
      return;
    }
    resolve(stdout);
  });

  child.on("error", reject);
  return promise;
}

async function runReminderHelper<T>(args: string[]): Promise<T> {
  const stdout = await execFileAsync(REMINDER_HELPER, args);
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(`Failed to parse reminder-helper output: ${stdout.trim() || String(error)}`);
  }
}

function requireValidDate(value: string, field: string): void {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid ISO 8601 datetime`);
  }
}

function appendNonEmpty(args: string[], name: string, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    args.push(name, trimmed);
  }
}

function appendDate(args: string[], name: string, value: string | undefined, field: string): void {
  if (!value) {
    return;
  }
  requireValidDate(value, field);
  args.push(name, value);
}

export async function listReminderLists(): Promise<ReminderListInfo[]> {
  return runReminderHelper<ReminderListInfo[]>(["list-lists"]);
}

export async function listReminders(query: ReminderListQuery): Promise<ReminderResult[]> {
  const args = ["list-reminders"];
  appendNonEmpty(args, "--list", query.list);
  if (query.includeCompleted !== undefined) {
    args.push("--include-completed", String(query.includeCompleted));
  }
  appendDate(args, "--due-start", query.dueStart, "dueStart");
  appendDate(args, "--due-end", query.dueEnd, "dueEnd");
  if (query.maxResults !== undefined) {
    args.push("--max", String(Math.min(Math.max(query.maxResults, 1), 500)));
  }
  return runReminderHelper<ReminderResult[]>(args);
}

export async function createReminder(input: ReminderInput): Promise<ReminderResult> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("title cannot be empty");
  }
  requireValidDate(input.due, "due");

  const args = ["create-reminder", "--title", title, "--due", input.due];
  appendNonEmpty(args, "--list", input.list);
  appendNonEmpty(args, "--notes", input.notes);
  return runReminderHelper<ReminderResult>(args);
}

export async function updateReminder(input: ReminderUpdateInput): Promise<ReminderResult> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id cannot be empty");
  }
  if (input.clearDue && input.due) {
    throw new Error("clearDue and due cannot both be set");
  }

  const args = ["update-reminder", "--id", id];
  appendNonEmpty(args, "--title", input.title);
  appendDate(args, "--due", input.due, "due");
  if (input.clearDue !== undefined) {
    args.push("--clear-due", String(input.clearDue));
  }
  appendNonEmpty(args, "--list", input.list);
  if (input.notes !== undefined) {
    args.push("--notes", input.notes);
  }
  if (input.completed !== undefined) {
    args.push("--completed", String(input.completed));
  }

  return runReminderHelper<ReminderResult>(args);
}

export async function completeReminder(input: ReminderDeleteInput): Promise<ReminderResult> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id cannot be empty");
  }
  return runReminderHelper<ReminderResult>(["complete-reminder", "--id", id]);
}

export async function deleteReminder(input: ReminderDeleteInput): Promise<ReminderResult> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id cannot be empty");
  }
  return runReminderHelper<ReminderResult>(["delete-reminder", "--id", id]);
}
