# Device bridge ("bench")

Lets agents use hardware on the owner's computer (today: USB serial devices such as ESP32 and
Arduino boards) without opening anything on that computer.

```
agent on the VM ── /dev/bench/<id> ──▶ agentbox-bench-tty (CUSE) ── rfc2217://127.0.0.1:<port> ──▶ portal (bench.ts)
      ══ WebSocket (the bridge dials OUT) ══▶ agentbox-bench.py ──▶ USB board (owner's computer)
```

## Pieces
| Piece | Where |
|---|---|
| The integration (Integrations → **Connectivity** → Device bridge) | `setup/modules/bench/` (token, pyserial, steps, agents' instructions) |
| The bridge the owner runs | `setup/modules/bench/bridge/agentbox-bench.py` (Python 3.9+, makes its own venv with pyserial + websockets) |
| The portal side | `server/src/bench.ts`: `/api/bench/{connect,status,test,install.sh,bridge.py}` |
| Real-looking ports `/dev/ttyBENCH<n>`, `/dev/bench/<id>` | `setup/modules/bench/bin/agentbox-bench-tty` + `units/agentbox-bench-tty.service`: a userspace character device per shared device through the kernel's CUSE module (no kernel code). Termios, baud, DTR/RTS, flush, break, select/poll, O_NONBLOCK and VMIN/VTIME behave as on a tty, so avrdude, arduino-cli, PlatformIO, esptool and screen work unmodified. Follows plug/unplug every 2 s; the nodes belong to the agent user. |
| Arduino Uno/Nano uploads over a slow link | `setup/modules/bench/bin/agentbox-avr-upload` (STK500v1 over pyserial; avrdude can't open `rfc2217://`), installed on the VM by the integration; test: `setup/modules/bench/test/test_avr_upload.py` |
| The agents' skill | `server/seed-skills/bench-hardware` (given to the roles mapped to the integration) |
| The helper's guide | `server/seed-skills/agentbox-setup` § 6 |

## How it's safe
- **Nothing listens on the owner's computer.** The bridge connects out to the portal, through the
  same way in as the owner's browser: the tailnet (`tailscale serve` adds the owner's identity) or
  the SSH port forward. Cloudflare mode isn't supported yet (its Access login is browser-only).
- **Two checks:** the portal's normal access check (owner identity / localhost) and the **bridge
  token** (`<secrets>/bench.token`, 40 random characters, made when the integration is connected,
  deleted when it's disconnected). The downloaded installer carries the token: don't share it.
- **The owner decides what's shared, twice:** on the computer (`~/.agentbox-bench/config.json`:
  `serial`, `loopback`, `devices` allowlist) and on the portal (the integration's settings). Only
  what both allow is shared. Bluetooth and built-in ports are never shared (no USB vendor id).
- **Only devices, nothing else:** the bridge has no shell, file or port-forwarding feature. The worst
  an agent can do is flash a board.
- **Off means off:** stopping the bridge (Ctrl+C) shares nothing; disconnecting the integration (or
  turning the module off) makes every `/api/bench` route a 404 and drops a live bridge within 15 s,
  without a restart. A bridge refused because the module is off waits and resumes when it's back on;
  one with a wrong token stops.

## Protocol (WebSocket `/api/bench/connect`, header `X-Agentbox-Bench-Token`)
JSON text frames for control; binary frames `[u32 channel][bytes]` for data.
- bridge → portal: `hello {version, host, os, capabilities}`, `devices [{id, kind, path, description,
  manufacturer, vid, pid, serial_number}]` (again on plug/unplug), `opened {channel}`,
  `error {channel, message}`, `closed {channel}`, `pong {nonce}`.
- portal → bridge: `welcome {enable: {serial}}`, `refused {reason: off|token, message}`,
  `open {channel, device}`, `close {channel}`, `ping {nonce}` (every 15 s; silent 60 s → dropped).
- Each agent connection to a device's local port is one channel. The bridge runs pyserial's RFC 2217
  `PortManager` next to the real port, so baud rate, DTR/RTS (esptool's reset into the bootloader) and
  `0xFF` escaping work end to end; the portal only relays bytes.
- Ports: `ports.bench` (default 7740) and the next 39; a device keeps its port across reconnects
  (`<data>/bench-ports.json`).

## Latency
The ports hide the network, not the distance. Tools with tight timeouts (avrdude's 250 ms drain while
syncing with an Arduino bootloader) need the VM close to the owner: from India, a VM in us-central1
(~250 ms round trip) made avrdude fall out of sync; the same upload through `/dev/bench` works from
asia-south1 (~35 ms: 5000 bytes written and verified in 17 s). Put the VM in the owner's region;
`agentbox-avr-upload` (pipelined, delay-tolerant) remains for slow links.

## Tested on real hardware
An Arduino Nano (FT232R, optiboot at 115200) on the owner's Mac, from the Mumbai VM through
`/dev/bench/usbserial-…`: reading its serial output, a 32 KB flash backup and restore with avrdude 7.1,
and `arduino-cli upload` (5.5 s). Round trip through the whole chain: ~9 ms median.
arduino-cli's bundled avrdude 8 failed on this board **locally as well**: it drops DTR right after the
reset pulse and this Nano's bootloader then doesn't answer; `platform.local.txt` pointing arduino-cli at
the system avrdude fixes it (the bench-hardware skill says how). Diagnosis: run the port service with
`AGENTBOX_BENCH_TTY_DEBUG=1` to log every open, ioctl, control-line change and byte, timestamped.

## Simulated devices
`~/.agentbox-bench/config.json` → `"extra_devices": [{"id": "sim-uno", "url": "socket://127.0.0.1:5599"}]`
shares any pyserial URL as a device: a simulator's serial port, or a fake bootloader for tests.

## Later (not built)
Mega 2560 uploads (STK500v2).

Capabilities are separate switches so more can be added the same way: a camera snapshot, sharing the
owner's screen with an agent, other device classes. Each gets its own setting on both sides.

## Testing
- `npm run test:bench` (server): off/on, token refusal, device ports, a 256-byte relay, stable ports.
- End to end (no board needed): connect the integration, run the installer and the bridge, then
  `agentbox api -X POST /bench/test` on the VM (round trip + an RFC 2217 echo through `loopback`).
