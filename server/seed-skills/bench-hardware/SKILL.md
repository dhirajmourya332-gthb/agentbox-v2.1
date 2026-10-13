---
name: bench-hardware
description: "Use the owner's hardware through the agentbox device bridge: find the shared USB serial devices (ESP32, Arduino), flash firmware, read serial logs, reset a board, over rfc2217://127.0.0.1:<port>. Use whenever a task needs a real board."
---

# Hardware on the owner's bench (device bridge)

The owner's computer shares its USB serial devices with you while its bridge runs. Each device is a
local port on this VM, spoken to with RFC 2217 (serial over the network): `rfc2217://127.0.0.1:<port>`.

## 1. See what's there
```bash
agentbox api /bench/status
```
- `connected: false` → the bridge isn't running. Don't wait or poll: tell the owner (one line:
  "start `python3 ~/.agentbox-bench/agentbox-bench.py` on your computer") and do what you can without
  the board (build, simulate) meanwhile.
- `devices`: `id` (e.g. `usbserial-0001`, `usbmodem1101`), `description`, `vid`/`pid`, `url`,
  `in_use`. `loopback` is a test port that echoes; never flash it.
- Identify boards by `vid:pid`: `10c4:ea60` CP210x (most ESP32 dev kits), `1a86:7523` CH340
  (ESP32/Arduino clones), `303a:*` Espressif native USB (ESP32-S2/S3/C3), `2341:*` / `2a03:*` Arduino.
  More than one candidate, or not sure which board is which: ask the owner, don't guess.
- Connectivity in doubt: `agentbox api -X POST /bench/test` (round trip + a serial echo).

## 2. Tools (install once if missing; user-level, no sudo needed)
- pyserial: `python3 -c 'import serial'` (installed with the bridge).
- esptool: `pipx install esptool` (or `python3 -m pip install --user esptool`).
- PlatformIO: `pipx install platformio`.
- arduino-cli: from https://arduino.github.io/arduino-cli (it can compile; upload over RFC 2217 isn't
  supported for AVR, see §5).

## 3. ESP32 / ESP8266
```bash
URL=rfc2217://127.0.0.1:<port>
esptool --port "$URL" chip-id                       # who's there (also checks the link)
esptool --port "$URL" --baud 460800 write-flash 0x0 firmware.bin   # or the offsets your build prints
pio run -t upload --upload-port "$URL"              # PlatformIO project
pio device monitor --port "$URL" --baud 115200      # logs (Ctrl+C to stop); or:
python3 -m serial.tools.miniterm "$URL" 115200
```
- Over the network, use `--baud 460800` or lower; if writing fails, retry once at 115200.
- esptool resets the board into the bootloader through DTR/RTS, which the bridge relays. A board
  that won't enter it needs the owner to hold BOOT while you connect: ask, don't loop.
- Logs for a test: open the monitor **after** flashing, read for a bounded time
  (`timeout 30 python3 -m serial.tools.miniterm …`), then close it.
- To reset without flashing: `esptool --port "$URL" --after hard-reset chip-id`.

## 4. Reading and writing serial from code
```python
import serial
s = serial.serial_for_url("rfc2217://127.0.0.1:<port>", baudrate=115200, timeout=1)
s.write(b"status\n"); print(s.read(200)); s.close()
```

## 5. Arduino Uno / Nano / Pro Mini (AVR)
avrdude can't open these network ports, so use **`agentbox-avr-upload`** (on this VM): it speaks the
Arduino bootloader's protocol itself and resets the board through the bridge.
```bash
arduino-cli compile --fqbn arduino:avr:uno --output-dir build sketch/     # or pio run (.pio/build/<env>/firmware.hex)
agentbox-avr-upload --device <id> build/sketch.ino.hex                     # writes, then verifies by reading back
agentbox-avr-upload --device <id> --board nano-old build/sketch.ino.hex    # Nano with the old bootloader (57600 baud)
```
- Upload `<sketch>.ino.hex`, **not** `*.with_bootloader.hex` (it refuses that one).
- `--board auto` (default) tries 115200 then 57600 baud; `uno`/`nano` = 115200, `nano-old`/`pro-mini` = 57600.
- It reads the chip's signature first and refuses an unknown chip or a sketch that doesn't fit.
- About 1 s per page over the network (a 10 KB sketch ≈ 80 pages ≈ 1–2 min with verify). Close any
  serial monitor on the device first (`in_use` must be false).
- "no bootloader answered": wrong `--board`/baud, a board without a bootloader, or a clone whose
  auto-reset doesn't work; ask the owner to press RESET right as you start, don't loop.
- **Mega 2560** (STK500v2) isn't supported yet: compile here and give the owner the upload command.
- Serial output after the upload works as in §4 (`miniterm rfc2217://… 9600`).

## Rules
- **One session per device**, and close it when done: the port is a real board, and a second open
  fails (`in_use: true`).
- **Never leave a board half-flashed.** If a flash fails midway, retry once; still failing → stop
  and report exactly what happened.
- **Don't change the owner's computer**: the bridge shares only these devices. No requests for
  shells, files or other ports.
- Report which device (`id`, `vid:pid`) you used, what you flashed (file, version/commit) and what
  the serial log showed.
