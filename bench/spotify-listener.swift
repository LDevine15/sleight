// Listens for Spotify's distributed playback notification and prints one JSON line per event with four keys:
// Name, Artist, Player State (Playing, Paused or Stopped) and Track ID. It reads no app and sends nothing.
// The first line is {"ready":true}, printed once the observer is registered. SIGTERM ends it (bench/real-apps.mjs).
import Foundation

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

let center = DistributedNotificationCenter.default()
let observer = center.addObserver(forName: Notification.Name("com.spotify.client.PlaybackStateChanged"), object: nil, queue: nil) { note in
    let info = note.userInfo ?? [:]
    var event: [String: Any] = [:]
    for key in ["Name", "Artist", "Player State", "Track ID"] { event[key] = (info[key]).map { "\($0)" } ?? "" }
    emit(event)
}
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
emit(["ready": true])
withExtendedLifetime(observer) { RunLoop.main.run() }
