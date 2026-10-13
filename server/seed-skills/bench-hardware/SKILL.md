---
name: bench-hardware
description: "Use the owner's hardware through the agentbox device bridge: the boards on their desk (ESP32, Arduino, USB-serial) appear here as /dev/bench/<id> serial ports. Find them, flash or upload firmware, read serial logs, reset a board. Use whenever a task needs a real board."
---

# Hardware on the owner's bench (device bridge)

<!-- Built into agentbox (server/seed-skills/bench-hardware); refreshed at every start. -->

The owner's computer shares its USB serial devices with you while its bridge runs. Each one is a
**normal serial port here**: `/dev/bench/<id>` (a link to `/dev/ttyBENCH<n>`). Use it exactly like a
board plugged into this machine: avrdude, arduino-cli, PlatformIO, esptool, pyserial, screen, stty.
Baud rate, DTR/RTS (the auto-reset into a bootloader) and breaks reach the real board.

## 1. See what's there
```bash
ls -l /dev/bench/                 # the boards, by id
agentbox api /bench/status        # details: description, vid:pid, dev path, in_use
```
- No `/dev/bench/` entries, or `connected: false` → the bridge isn't running. Don't wait or poll:
  tell the owner in one line ("start `python3 ~/.agentbox-bench/agentbox-bench.py` on your
  computer") and do what you can without the board (build, simulate) meanwhile.
- `loopback` is a test port that echoes; never flash it.
- Identify boards by `vid:pid`: `10c4:ea60` CP210x (most ESP32 dev kits), `1a86:7523` CH340
  (ESP32/Arduino clones), `303a:*` Espressif native USB (ESP32-S2/S3/C3), `2341:*` / `2a03:*` Arduino.
  More than one candidate, or unsure which board is which: ask the owner, don't guess.
- Connectivity in doubt: `agentbox api -X POST /bench/test` (round trip + a serial echo).

## 2. Tools (install once if missing; user-level, no sudo)
`pipx install esptool`, `pipx install platformio`, arduino-cli (https://arduino.github.io/arduino-cli).
avrdude and pyserial are installed.

## 3. Flash / upload
```bash
P=/dev/bench/<id>
# ESP32 / ESP8266
esptool --port $P chip-id
esptool --port $P --baud 460800 write-flash 0x0 firmware.bin     # or the offsets your build prints
pio run -t upload --upload-port $P
# Arduino Uno / Nano / Pro Mini / Mega
arduino-cli compile --fqbn arduino:avr:uno sketch/ && arduino-cli upload -p $P --fqbn arduino:avr:uno sketch/
avrdude -c arduino -p m328p -P $P -b 115200 -U flash:w:build/sketch.ino.hex:i   # Nano old bootloader: -b 57600
```
- The board is on the owner's desk, reached over the network: allow a little more time than a local
  cable. If esptool's writes fail at 460800, retry once at 115200.
- If avrdude/arduino-cli reports "not in sync" or "not responding" (a slow link), use
  `agentbox-avr-upload --device <id> build/sketch.ino.hex` (Uno/Nano; tolerant of delay).
- A board that won't enter its bootloader needs the owner to hold BOOT (ESP32) or press RESET
  (Arduino) as you start: ask once, don't loop.

## 4. Serial logs and talking to a board
```bash
timeout 30 python3 -m serial.tools.miniterm /dev/bench/<id> 115200    # bounded: read, then close
pio device monitor -p /dev/bench/<id> -b 115200
```
```python
import serial
s = serial.Serial("/dev/bench/<id>", 115200, timeout=1)
s.write(b"status\n"); print(s.read(200)); s.close()
```
Opening the port resets most Arduinos (DTR goes up, as with a real cable); open, wait ~2 s, then talk.

## 5. Without /dev/bench
If `/dev/bench/` is missing but `agentbox api /bench/status` lists devices, the port service isn't
running: use the device's `url` (`rfc2217://127.0.0.1:<port>`) with pyserial-based tools (esptool,
PlatformIO, miniterm) and `agentbox-avr-upload` for Arduino, and mention it in your report.

## Rules
- **One session per device**, and close it when done: it's a real board, and a second open fails.
- **Never leave a board half-flashed.** If a flash fails midway, retry once; still failing → stop and
  report exactly what happened.
- **Don't change the owner's computer**: the bridge shares only these devices. No requests for
  shells, files or other ports.
- Report which device (`id`, `vid:pid`) you used, what you flashed (file, version/commit) and what
  the serial log showed.
