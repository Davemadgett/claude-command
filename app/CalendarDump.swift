import EventKit
import Foundation

/**
 * Dumps upcoming calendar events as JSON on stdout.
 *
 * Reads through EventKit rather than a vendor API: every calendar the user
 * uses — including the Clio one — is already synced into macOS Calendar, so this
 * needs no OAuth, no extra scopes, and no token to keep alive.
 *
 * Usage: calendar-dump [daysAhead] [daysBehind]
 */

let daysAhead = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 21 : 21
let daysBehind = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2]) ?? 1 : 1

/**
 * Exits with JSON on stdout rather than a stderr message, because the caller
 * shows this to a person. `denied` is reported separately from any other
 * failure: once macOS has recorded a denial, EventKit stops prompting entirely
 * and simply returns false forever — so the board has to offer a way back in,
 * and it can only do that if it can tell a denial from a crash.
 */
func fail(_ message: String, denied: Bool = false) -> Never {
    var payload: [String: Any] = ["error": message]
    if denied { payload["denied"] = true }
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(data)
    }
    exit(1)
}

func alreadyDenied() -> Bool {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        return status == .denied || status == .restricted || status == .writeOnly
    }
    return status == .denied || status == .restricted
}

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false
var authError: Error?

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, err in
        granted = ok
        authError = err
        sem.signal()
    }
} else {
    store.requestAccess(to: .event) { ok, err in
        granted = ok
        authError = err
        sem.signal()
    }
}

if sem.wait(timeout: .now() + 25) == .timedOut {
    fail("Timed out waiting for calendar permission")
}
guard granted else {
    if alreadyDenied() {
        fail("This app doesn’t have permission to read your calendars.", denied: true)
    }
    fail(authError?.localizedDescription ?? "Calendar access was refused.")
}

let start = Date().addingTimeInterval(-daysBehind * 86_400)
let end = Date().addingTimeInterval(daysAhead * 86_400)

// EventKit caps a single predicate at roughly four years; these windows are far
// shorter, so one query is enough.
let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let events = store.events(matching: predicate)

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]

let payload: [[String: Any]] = events.compactMap { event in
    guard let startDate = event.startDate else { return nil }
    var row: [String: Any] = [
        "id": event.eventIdentifier ?? UUID().uuidString,
        "title": event.title ?? "(no title)",
        "start": iso.string(from: startDate),
        "allDay": event.isAllDay,
        "calendar": event.calendar.title,
    ]
    if let endDate = event.endDate { row["end"] = iso.string(from: endDate) }
    if let location = event.location, !location.isEmpty { row["location"] = location }
    if let notes = event.notes, !notes.isEmpty { row["notes"] = String(notes.prefix(2000)) }
    if let url = event.url?.absoluteString { row["url"] = url }
    return row
}

let out: [String: Any] = ["events": payload.sorted {
    ($0["start"] as? String ?? "") < ($1["start"] as? String ?? "")
}]

guard let data = try? JSONSerialization.data(withJSONObject: out) else {
    fail("Could not encode events")
}
FileHandle.standardOutput.write(data)
