import EventKit
import Foundation

struct ReminderHelperError: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

struct ReminderListInfo: Encodable {
    let id: String
    let name: String
    let writable: Bool
}

struct ReminderResult: Encodable, Equatable {
    let id: String
    let listId: String
    let list: String
    let title: String
    let due: String?
    let notes: String?
    let completed: Bool
    let completionDate: String?
}

@main
struct ReminderHelper {
    static let store = EKEventStore()

    static func main() async {
        do {
            try await requireReminderAccess()
            let args = Array(CommandLine.arguments.dropFirst())
            guard let command = args.first else {
                throw ReminderHelperError("Usage: reminder-helper <list-lists|list-reminders|create-reminder|update-reminder|complete-reminder|delete-reminder> [options]")
            }

            switch command {
            case "list-lists":
                try output(listReminderLists())
            case "list-reminders":
                let options = try parseOptions(Array(args.dropFirst()))
                let reminders = try await listReminders(
                    list: options["list"],
                    includeCompleted: try options["include-completed"].map { try parseBool($0, name: "include-completed") } ?? false,
                    dueStart: try options["due-start"].map(parseISO),
                    dueEnd: try options["due-end"].map(parseISO),
                    maxResults: min(max(Int(options["max"] ?? "100") ?? 100, 1), 500)
                )
                try output(reminders)
            case "create-reminder":
                let options = try parseOptions(Array(args.dropFirst()))
                guard let rawTitle = options["title"] else {
                    throw ReminderHelperError("Missing required --title")
                }
                let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !title.isEmpty else {
                    throw ReminderHelperError("title cannot be empty")
                }
                let due = try requiredDate(options, "due")
                let reminder = EKReminder(eventStore: store)
                reminder.title = title
                reminder.notes = emptyToNil(options["notes"])
                reminder.calendar = try options["list"].map { try resolveReminderList($0) } ?? defaultWritableReminderList()
                guard reminder.calendar.allowsContentModifications else {
                    throw ReminderHelperError("Reminder list is not writable: \(reminder.calendar.title)")
                }
                setDue(due, on: reminder)
                try store.save(reminder, commit: true)
                try output(reminderResult(reminder))
            case "update-reminder":
                let options = try parseOptions(Array(args.dropFirst()))
                let reminder = try requireReminder(id: requiredValue(options, "id"))
                let original = reminderResult(reminder)
                if let title = options["title"] {
                    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmedTitle.isEmpty else {
                        throw ReminderHelperError("title cannot be empty")
                    }
                    reminder.title = trimmedTitle
                }
                if let listValue = options["list"] {
                    reminder.calendar = try resolveReminderList(listValue)
                }
                if let notes = options["notes"] {
                    reminder.notes = emptyToNil(notes)
                }
                if let clearDueValue = options["clear-due"], try parseBool(clearDueValue, name: "clear-due") {
                    clearDue(on: reminder)
                }
                if let dueValue = options["due"] {
                    if let clearDueValue = options["clear-due"], try parseBool(clearDueValue, name: "clear-due") {
                        throw ReminderHelperError("--due and --clear-due true cannot both be supplied")
                    }
                    setDue(try parseISO(dueValue), on: reminder)
                }
                if let completedValue = options["completed"] {
                    reminder.isCompleted = try parseBool(completedValue, name: "completed")
                }
                try store.save(reminder, commit: true)
                let updated = reminderResult(reminder)
                guard updated != original else {
                    throw ReminderHelperError("No reminder fields changed")
                }
                try output(updated)
            case "complete-reminder":
                let options = try parseOptions(Array(args.dropFirst()))
                let reminder = try requireReminder(id: requiredValue(options, "id"))
                reminder.isCompleted = true
                try store.save(reminder, commit: true)
                try output(reminderResult(reminder))
            case "delete-reminder":
                let options = try parseOptions(Array(args.dropFirst()))
                let reminder = try requireReminder(id: requiredValue(options, "id"))
                let deletedReminder = reminderResult(reminder)
                try store.remove(reminder, commit: true)
                try output(deletedReminder)
            default:
                throw ReminderHelperError("Unknown command: \(command)")
            }
        } catch {
            FileHandle.standardError.write(Data(errorMessage(error).utf8))
            exit(1)
        }
    }

    static func requireReminderAccess() async throws {
        let status = EKEventStore.authorizationStatus(for: .reminder)

        switch status {
        case .authorized, .fullAccess, .writeOnly:
            return
        case .notDetermined:
            if #available(macOS 14.0, *) {
                let granted = try await store.requestFullAccessToReminders()
                if !granted {
                    throw ReminderHelperError("Reminders access denied")
                }
            } else {
                let granted = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
                    store.requestAccess(to: .reminder) { granted, error in
                        if let error {
                            continuation.resume(throwing: error)
                        } else {
                            continuation.resume(returning: granted)
                        }
                    }
                }
                if !granted {
                    throw ReminderHelperError("Reminders access denied")
                }
            }
        case .restricted:
            throw ReminderHelperError("Reminders access is restricted")
        case .denied:
            throw ReminderHelperError("Reminders access denied. Grant access to the MCP host or reminder-helper in macOS Settings > Privacy & Security > Reminders.")
        @unknown default:
            throw ReminderHelperError("Reminders authorization status is unsupported: \(status.rawValue)")
        }
    }

    static func listReminderLists() -> [ReminderListInfo] {
        store.calendars(for: .reminder).map {
            ReminderListInfo(
                id: $0.calendarIdentifier,
                name: $0.title,
                writable: $0.allowsContentModifications
            )
        }
    }

    static func listReminders(list: String?, includeCompleted: Bool, dueStart: Date?, dueEnd: Date?, maxResults: Int) async throws -> [ReminderResult] {
        if let dueStart, let dueEnd, dueEnd < dueStart {
            throw ReminderHelperError("due-end must be after or equal to due-start")
        }
        let calendars = try resolveReminderLists(list)
        let predicate = store.predicateForReminders(in: calendars)
        let reminders = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[EKReminder], Error>) in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: reminders ?? [])
            }
        }

        return reminders
            .filter { includeCompleted || !$0.isCompleted }
            .filter { reminder in
                guard dueStart != nil || dueEnd != nil else {
                    return true
                }
                guard let due = reminder.dueDateComponents.flatMap(date) else {
                    return false
                }
                if let dueStart, due < dueStart {
                    return false
                }
                if let dueEnd, due > dueEnd {
                    return false
                }
                return true
            }
            .sorted { lhs, rhs in
                let lhsDue = lhs.dueDateComponents.flatMap(date) ?? Date.distantFuture
                let rhsDue = rhs.dueDateComponents.flatMap(date) ?? Date.distantFuture
                if lhsDue == rhsDue {
                    return (lhs.title ?? "") < (rhs.title ?? "")
                }
                return lhsDue < rhsDue
            }
            .prefix(maxResults)
            .map(reminderResult)
    }

    static func defaultWritableReminderList() throws -> EKCalendar {
        if let calendar = store.defaultCalendarForNewReminders(), calendar.allowsContentModifications {
            return calendar
        }
        guard let calendar = store.calendars(for: .reminder).first(where: { $0.allowsContentModifications }) else {
            throw ReminderHelperError("No writable macOS Reminders list was found")
        }
        return calendar
    }

    static func resolveReminderList(_ value: String) throws -> EKCalendar {
        guard let calendar = try resolveReminderLists(value)?.first else {
            throw ReminderHelperError("Missing required reminder list")
        }
        return calendar
    }

    static func resolveReminderLists(_ value: String?) throws -> [EKCalendar]? {
        guard let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else {
            return nil
        }

        let lists = store.calendars(for: .reminder)
        if let byId = lists.first(where: { $0.calendarIdentifier == rawValue }) {
            return [byId]
        }

        let byName = lists.filter { $0.title == rawValue }
        if byName.count == 1 {
            return byName
        }
        if byName.count > 1 {
            let choices = byName.map { "\($0.title) [\($0.calendarIdentifier)]" }.joined(separator: ", ")
            throw ReminderHelperError("Reminder list name is ambiguous: \(rawValue). Use one of these list IDs: \(choices)")
        }

        let available = lists.map { "\($0.title) [\($0.calendarIdentifier)]" }.joined(separator: ", ")
        throw ReminderHelperError("Reminder list not found: \(rawValue). Available reminder lists: \(available)")
    }

    static func requireReminder(id: String) throws -> EKReminder {
        if let reminder = store.calendarItem(withIdentifier: id) as? EKReminder {
            return reminder
        }
        throw ReminderHelperError("Reminder not found: \(id)")
    }

    static func reminderResult(_ reminder: EKReminder) -> ReminderResult {
        ReminderResult(
            id: reminder.calendarItemIdentifier,
            listId: reminder.calendar.calendarIdentifier,
            list: reminder.calendar.title,
            title: reminder.title ?? "",
            due: reminder.dueDateComponents.flatMap { date(from: $0) }.map(formatLocalISO),
            notes: emptyToNil(reminder.notes),
            completed: reminder.isCompleted,
            completionDate: reminder.completionDate.map(formatLocalISO)
        )
    }

    static func setDue(_ due: Date, on reminder: EKReminder) {
        clearDue(on: reminder)
        reminder.dueDateComponents = dueDateComponents(from: due)
        reminder.addAlarm(EKAlarm(absoluteDate: due))
    }

    static func clearDue(on reminder: EKReminder) {
        if let alarms = reminder.alarms {
            for alarm in alarms {
                reminder.removeAlarm(alarm)
            }
        }
        reminder.dueDateComponents = nil
    }

    static func dueDateComponents(from date: Date) -> DateComponents {
        var components = Calendar.current.dateComponents(in: TimeZone.current, from: date)
        components.calendar = Calendar.current
        components.timeZone = TimeZone.current
        return components
    }

    static func date(from components: DateComponents) -> Date? {
        var resolved = components
        resolved.calendar = resolved.calendar ?? Calendar.current
        resolved.timeZone = resolved.timeZone ?? TimeZone.current
        return resolved.date
    }

    static func parseOptions(_ args: [String]) throws -> [String: String] {
        var options: [String: String] = [:]
        var index = 0
        while index < args.count {
            let key = args[index]
            guard key.hasPrefix("--") else {
                throw ReminderHelperError("Unexpected argument: \(key)")
            }
            let name = String(key.dropFirst(2))
            let valueIndex = index + 1
            guard valueIndex < args.count else {
                throw ReminderHelperError("Missing value for --\(name)")
            }
            options[name] = args[valueIndex]
            index += 2
        }
        return options
    }

    static func requiredValue(_ options: [String: String], _ name: String) throws -> String {
        guard let value = options[name], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ReminderHelperError("Missing required --\(name)")
        }
        return value
    }

    static func requiredDate(_ options: [String: String], _ name: String) throws -> Date {
        return try parseISO(requiredValue(options, name))
    }

    static func parseBool(_ value: String, name: String) throws -> Bool {
        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "true", "1", "yes":
            return true
        case "false", "0", "no":
            return false
        default:
            throw ReminderHelperError("Invalid boolean for --\(name): \(value)")
        }
    }

    static func parseISO(_ value: String) throws -> Date {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) {
            return date
        }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: value) {
            return date
        }

        throw ReminderHelperError("Invalid ISO 8601 datetime: \(value)")
    }

    static func formatLocalISO(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
        return formatter.string(from: date)
    }

    static func emptyToNil(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }

    static func output<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func errorMessage(_ error: Error) -> String {
        if let helperError = error as? ReminderHelperError {
            return helperError.description + "\n"
        }
        return error.localizedDescription + "\n"
    }
}
