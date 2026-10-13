# Device bridge (the owner's computer)

The owner's computer can share hardware with you through the **device bridge**: a script there dials
out to agentbox and relays what the owner enabled. Today that's **USB serial devices** (ESP32,
Arduino, USB-UART adapters) and a **loopback** test port that echoes what it gets.

- It works only **while the bridge runs** on the owner's computer. Check before you rely on it:
  `agentbox api /bench/status` (connected, and the devices with their ports).
- Each device is a **normal serial port here**: `/dev/bench/<id>` (→ `/dev/ttyBENCH<n>`). Use it like a
  board plugged into this machine: avrdude, arduino-cli, PlatformIO, esptool, pyserial, screen.
  (Underneath it's `rfc2217://127.0.0.1:<port>`, which pyserial-based tools also accept.)
- Use the **bench-hardware** skill for flashing, uploading, monitoring and resetting.
- A device is one physical board on the owner's desk: one session at a time, close the port when
  you're done, and never leave a board half-flashed. If something looks wrong (no device, a board
  that stopped answering), say so in your report instead of retrying in a loop.
- The bridge shares nothing else: no files, no shell, no other ports on the owner's computer. Don't
  ask the owner to widen it; ask for a new capability instead.
