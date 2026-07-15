import EventKit
import Foundation

struct CalendarHelperError: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

struct CalendarInfo: Encodable {
    let id: String
    let name: String
    let writable: Bool
}

struct ListedCalendarEvent: Encodable {
    let id: String
    let calendarId: String
    let calendar: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let location: String?
    let notes: String?
    let url: String?
}

@main
struct CalendarHelper {
    static let store = EKEventStore()

    static func main() async {
        do {
            try await requireCalendarAccess()
            let args = Array(CommandLine.arguments.dropFirst())
            guard let command = args.first else {
                throw CalendarHelperError("Usage: calendar-helper <list-calendars|list-events> [options]")
            }

            switch command {
            case "list-calendars":
                try output(listCalendars())
            case "list-events":
                let options = try parseOptions(Array(args.dropFirst()))
                let start = try requiredDate(options, "start")
                let end = try requiredDate(options, "end")
                guard end > start else {
                    throw CalendarHelperError("end must be after start")
                }
                let maxResults = min(max(Int(options["max"] ?? "100") ?? 100, 1), 500)
                let calendars = try resolveCalendars(options["calendar"])
                try output(listEvents(start: start, end: end, calendars: calendars, maxResults: maxResults))
            default:
                throw CalendarHelperError("Unknown command: \(command)")
            }
        } catch {
            FileHandle.standardError.write(Data(errorMessage(error).utf8))
            exit(1)
        }
    }

    static func requireCalendarAccess() async throws {
        let status = EKEventStore.authorizationStatus(for: .event)

        switch status {
        case .authorized, .fullAccess:
            return
        case .writeOnly:
            if #available(macOS 14.0, *) {
                let granted = try await store.requestFullAccessToEvents()
                if granted {
                    return
                }
            }
            throw CalendarHelperError("Calendar access is write-only; full access is required to list events")
        case .notDetermined:
            if #available(macOS 14.0, *) {
                let granted = try await store.requestFullAccessToEvents()
                if !granted {
                    throw CalendarHelperError("Calendar access denied")
                }
            } else {
                let granted = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
                    store.requestAccess(to: .event) { granted, error in
                        if let error {
                            continuation.resume(throwing: error)
                        } else {
                            continuation.resume(returning: granted)
                        }
                    }
                }
                if !granted {
                    throw CalendarHelperError("Calendar access denied")
                }
            }
        case .restricted:
            throw CalendarHelperError("Calendar access is restricted")
        case .denied:
            throw CalendarHelperError("Calendar access denied. Grant access to the MCP host or calendar-helper in macOS Settings > Privacy & Security > Calendars.")
        @unknown default:
            throw CalendarHelperError("Calendar authorization status is unsupported: \(status.rawValue)")
        }
    }

    static func listCalendars() -> [CalendarInfo] {
        store.calendars(for: .event).map {
            CalendarInfo(
                id: $0.calendarIdentifier,
                name: $0.title,
                writable: $0.allowsContentModifications
            )
        }
    }

    static func listEvents(start: Date, end: Date, calendars: [EKCalendar]?, maxResults: Int) -> [ListedCalendarEvent] {
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
        return store.events(matching: predicate)
            .sorted { lhs, rhs in
                if lhs.startDate == rhs.startDate {
                    return (lhs.title ?? "") < (rhs.title ?? "")
                }
                return lhs.startDate < rhs.startDate
            }
            .prefix(maxResults)
            .map {
                ListedCalendarEvent(
                    id: $0.eventIdentifier,
                    calendarId: $0.calendar.calendarIdentifier,
                    calendar: $0.calendar.title,
                    title: $0.title ?? "",
                    start: formatLocalISO($0.startDate),
                    end: formatLocalISO($0.endDate),
                    allDay: $0.isAllDay,
                    location: emptyToNil($0.location),
                    notes: emptyToNil($0.notes),
                    url: $0.url?.absoluteString
                )
            }
    }

    static func resolveCalendars(_ value: String?) throws -> [EKCalendar]? {
        guard let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else {
            return nil
        }

        let calendars = store.calendars(for: .event)
        if let byId = calendars.first(where: { $0.calendarIdentifier == rawValue }) {
            return [byId]
        }

        let byName = calendars.filter { $0.title == rawValue }
        if byName.count == 1 {
            return byName
        }
        if byName.count > 1 {
            let choices = byName.map { "\($0.title) [\($0.calendarIdentifier)]" }.joined(separator: ", ")
            throw CalendarHelperError("Calendar name is ambiguous: \(rawValue). Use one of these calendar IDs: \(choices)")
        }

        let available = calendars.map { "\($0.title) [\($0.calendarIdentifier)]" }.joined(separator: ", ")
        throw CalendarHelperError("Calendar not found: \(rawValue). Available calendars: \(available)")
    }

    static func parseOptions(_ args: [String]) throws -> [String: String] {
        var options: [String: String] = [:]
        var index = 0
        while index < args.count {
            let key = args[index]
            guard key.hasPrefix("--") else {
                throw CalendarHelperError("Unexpected argument: \(key)")
            }
            let name = String(key.dropFirst(2))
            let valueIndex = index + 1
            guard valueIndex < args.count else {
                throw CalendarHelperError("Missing value for --\(name)")
            }
            options[name] = args[valueIndex]
            index += 2
        }
        return options
    }

    static func requiredDate(_ options: [String: String], _ name: String) throws -> Date {
        guard let value = options[name], !value.isEmpty else {
            throw CalendarHelperError("Missing required --\(name)")
        }
        return try parseISO(value)
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

        throw CalendarHelperError("Invalid ISO 8601 datetime: \(value)")
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
        if let helperError = error as? CalendarHelperError {
            return helperError.description + "\n"
        }
        return error.localizedDescription + "\n"
    }
}
