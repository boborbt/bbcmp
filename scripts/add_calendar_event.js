function fail(message) {
  throw new Error(message);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`Invalid ${field}.`);
  }

  return value.trim();
}

function parseIsoDate(value, field) {
  const parsed = new Date(requireNonEmptyString(value, field));
  if (Number.isNaN(parsed.getTime())) {
    fail(`Invalid ${field}. Expected an ISO 8601 datetime.`);
  }

  return parsed;
}

function pickWritableCalendar(calendarApp, requestedName) {
  if (requestedName) {
    const calendar = calendarApp.calendars.byName(requestedName);
    try {
      const resolvedName = calendar.name();
      if (!resolvedName) {
        fail(`Calendar not found: ${requestedName}`);
      }
      return calendar;
    } catch (error) {
      fail(`Calendar not found: ${requestedName}`);
    }
  }

  const calendars = calendarApp.calendars();
  for (let index = 0; index < calendars.length; index += 1) {
    const calendar = calendars[index];
    try {
      if (calendar.writable()) {
        return calendar;
      }
    } catch (error) {
      continue;
    }
  }

  fail("No writable macOS Calendar was found.");
}

function run(argv) {
  if (!argv || argv.length === 0) {
    fail("Missing JSON payload.");
  }

  const input = JSON.parse(argv[0]);
  const title = requireNonEmptyString(input.title, "title");
  const startDate = parseIsoDate(input.start, "start");
  const endDate = parseIsoDate(input.end, "end");

  if (endDate.getTime() <= startDate.getTime()) {
    fail("end must be after start.");
  }

  const calendarApp = Application("Calendar");
  const targetCalendar = pickWritableCalendar(
    calendarApp,
    typeof input.calendar === "string" && input.calendar.trim() !== "" ? input.calendar.trim() : null,
  );

  const properties = {
    summary: title,
    startDate,
    endDate,
  };

  if (typeof input.location === "string" && input.location.trim() !== "") {
    properties.location = input.location.trim();
  }

  if (typeof input.notes === "string" && input.notes.trim() !== "") {
    properties.description = input.notes.trim();
  }

  const event = calendarApp.Event(properties);
  targetCalendar.events.push(event);

  return JSON.stringify({
    calendar: targetCalendar.name(),
    title: event.summary(),
    start: event.startDate().toISOString(),
    end: event.endDate().toISOString(),
    location: properties.location || null,
    notes: properties.description || null,
  });
}
