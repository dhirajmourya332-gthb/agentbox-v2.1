#!/usr/bin/env python3
"""agentbox bench bridge: share what you choose on THIS computer with your agentbox agents.

It dials OUT to your agentbox portal over a WebSocket (nothing listens on this computer) and relays
the capabilities you enabled. Today: USB serial ports (ESP32, Arduino, …) and a loopback test port.
Agents on the VM see each device as rfc2217://127.0.0.1:<port>, so esptool, PlatformIO and pyserial
work unchanged.

  python3 agentbox-bench.py            run the bridge (Ctrl+C stops it; nothing is shared while it's off)
  python3 agentbox-bench.py --list     show the devices it would share
  python3 agentbox-bench.py --check    connect once, report, and exit

Settings: ~/.agentbox-bench/config.json (written by the installer from your portal):
  { "portal": "https://<node>.ts.net", "token": "…", "serial": true, "loopback": true,
    "devices": [],             # devices: only these ids (empty = every USB serial port)
    "extra_devices": [] }      # simulators: [{"id": "sim-uno", "url": "socket://127.0.0.1:5555"}]
Needs Python 3.9+. The first run creates ~/.agentbox-bench/venv with pyserial and websockets.
Protocol: docs/BENCH.md.
"""
import json
import os
import platform
import socket
import struct
import subprocess
import sys
import threading
import time

VERSION = 1
HOME = os.path.join(os.path.expanduser("~"), ".agentbox-bench")
CONFIG = os.path.join(HOME, "config.json")
VENV = os.path.join(HOME, "venv")
DEPS = ["pyserial>=3.5", "websockets>=12"]


def bootstrap():
    """Re-run inside ~/.agentbox-bench/venv when pyserial / websockets aren't importable."""
    try:
        import serial  # noqa: F401
        import websockets.sync.client  # noqa: F401
        return
    except ImportError:
        pass
    if os.environ.get("AGENTBOX_BENCH_BOOTSTRAPPED"):
        sys.exit("agentbox-bench: couldn't import pyserial/websockets even in its venv (%s)" % VENV)
    py = os.path.join(VENV, "Scripts" if os.name == "nt" else "bin", "python")
    if not os.path.exists(py):
        print("agentbox-bench: first run, creating %s (pyserial, websockets)…" % VENV, flush=True)
        os.makedirs(HOME, exist_ok=True)
        subprocess.check_call([sys.executable, "-m", "venv", VENV])
        subprocess.check_call([py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", *DEPS])
    os.environ["AGENTBOX_BENCH_BOOTSTRAPPED"] = "1"
    os.execv(py, [py, os.path.abspath(__file__), *sys.argv[1:]])


def load_config():
    try:
        with open(CONFIG) as f:
            c = json.load(f)
    except FileNotFoundError:
        sys.exit("agentbox-bench: no %s yet. Download the installer from your portal (Integrations → Device bridge)." % CONFIG)
    for k in ("portal", "token"):
        if not c.get(k):
            sys.exit("agentbox-bench: %s has no %r" % (CONFIG, k))
    c.setdefault("serial", True)
    c.setdefault("loopback", True)
    c.setdefault("devices", [])
    return c


# --- devices -------------------------------------------------------------------------------------------

def device_id(p):
    """A stable, readable id: the port's base name (usbserial-0001, ttyUSB0, COM4)."""
    name = os.path.basename(p.device)
    for prefix in ("cu.", "tty."):
        if name.startswith(prefix) and sys.platform == "darwin":
            name = name[len(prefix):]
    return name


def list_devices(cfg):
    from serial.tools import list_ports
    out = []
    if cfg.get("serial"):
        for p in list_ports.comports():
            if p.vid is None:  # Bluetooth, debug console, built-in ports: never shared
                continue
            if sys.platform == "darwin" and os.path.basename(p.device).startswith("tty."):
                continue  # macOS lists each port twice; cu.* is the one to open
            d = {"id": device_id(p), "kind": "serial", "path": p.device, "description": p.description or "",
                 "manufacturer": p.manufacturer or "", "vid": "%04x" % p.vid, "pid": "%04x" % (p.pid or 0),
                 "serial_number": p.serial_number or ""}
            if not cfg["devices"] or d["id"] in cfg["devices"]:
                out.append(d)
    for x in cfg.get("extra_devices", []):  # simulators / tests: {"id": "sim-uno", "url": "socket://127.0.0.1:5555"}
        if x.get("id") and x.get("url"):
            out.append({"id": x["id"], "kind": "serial", "path": x["url"], "description": x.get("description", "Simulated device"),
                        "manufacturer": "simulated", "vid": "", "pid": "", "serial_number": ""})
    if cfg.get("loopback"):
        out.append({"id": "loopback", "kind": "serial", "path": "loop://", "description": "Test port: echoes what it gets",
                    "manufacturer": "agentbox", "vid": "", "pid": "", "serial_number": ""})
    return out


# --- one serial session (RFC 2217 spoken here, bytes relayed over the WebSocket) ----------------------------

class Session:
    def __init__(self, bridge, channel, dev):
        import serial
        import serial.rfc2217 as rfc2217
        self.bridge, self.channel, self.dev = bridge, channel, dev
        self.ser = serial.serial_for_url(dev["path"], do_not_open=True)
        self.ser.timeout = 0.05
        self.ser.dtr = False  # don't reset the board just by opening the port
        self.ser.rts = False
        self.ser.open()
        self.mgr = rfc2217.PortManager(self.ser, self)  # self.write() sends its replies
        self.alive = True
        threading.Thread(target=self.reader, daemon=True).start()

    def write(self, data):  # the PortManager's "connection"
        self.bridge.send_data(self.channel, data)

    def incoming(self, data):
        if self.alive:
            self.ser.write(b"".join(self.mgr.filter(data)))

    def reader(self):
        try:
            while self.alive:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.bridge.send_data(self.channel, b"".join(self.mgr.escape(data)))
                self.mgr.check_modem_lines()
        except Exception as e:  # unplugged, permission…
            if self.alive:
                self.bridge.send_json({"type": "error", "channel": self.channel, "message": str(e)})
        finally:
            self.close(notify=True)

    def close(self, notify=False):
        if not self.alive:
            return
        self.alive = False
        try:
            self.ser.close()
        except Exception:
            pass
        self.bridge.sessions.pop(self.channel, None)
        if notify:
            self.bridge.send_json({"type": "closed", "channel": self.channel})


# --- the bridge --------------------------------------------------------------------------------------------

class Paused(Exception):
    """The Device bridge is off on the portal: wait and retry, quietly."""


class Bridge:
    def __init__(self, cfg):
        self.cfg, self.ws, self.sessions, self.devices = cfg, None, {}, []
        self.lock = threading.Lock()
        self.enabled = {}

    def url(self):
        p = self.cfg["portal"].rstrip("/")
        return ("wss://" + p[len("https://"):] if p.startswith("https://") else "ws://" + p[len("http://"):] if p.startswith("http://") else p) + "/api/bench/connect"

    def send_json(self, obj):
        with self.lock:
            if self.ws:
                self.ws.send(json.dumps(obj))

    def send_data(self, channel, data):
        if data:
            with self.lock:
                if self.ws:
                    self.ws.send(struct.pack(">I", channel) + data)

    def announce(self):
        devs = list_devices(self.cfg) if self.enabled.get("serial") else []
        if devs != self.devices:
            self.devices = devs
            self.send_json({"type": "devices", "devices": devs})
            names = ", ".join(d["id"] for d in devs) or "none"
            print("agentbox-bench: sharing %d device(s): %s" % (len(devs), names), flush=True)

    def handle(self, msg):
        t = msg.get("type")
        if t == "welcome":
            # Shared = enabled here AND on the portal; this computer's settings always win.
            server = msg.get("enable", {})
            self.enabled = {"serial": bool(self.cfg.get("serial")) and bool(server.get("serial", True))}
            print("agentbox-bench: connected to %s (%s)" % (self.cfg["portal"], ", ".join(k for k, v in self.enabled.items() if v) or "nothing enabled"), flush=True)
            self.devices = None
            self.announce()
            self.connected_once = True
        elif t == "ping":
            self.send_json({"type": "pong", "nonce": msg.get("nonce"), "at": time.time()})
        elif t == "open":
            ch, dev = int(msg["channel"]), next((d for d in (self.devices or []) if d["id"] == msg.get("device")), None)
            if not dev:
                return self.send_json({"type": "error", "channel": ch, "message": "no such device: %s" % msg.get("device")})
            try:
                self.sessions[ch] = Session(self, ch, dev)
                self.send_json({"type": "opened", "channel": ch})
                print("agentbox-bench: agent opened %s" % dev["id"], flush=True)
            except Exception as e:
                self.send_json({"type": "error", "channel": ch, "message": str(e)})
        elif t == "close":
            s = self.sessions.get(int(msg["channel"]))
            if s:
                s.close()
        elif t == "refused":
            if msg.get("reason") == "off":
                raise Paused(msg.get("message") or "the Device bridge is off on the portal")
            sys.exit("agentbox-bench: the portal refused this bridge: %s" % msg.get("message"))

    def run_once(self, check=False):
        from websockets.sync.client import connect
        headers = {"X-Agentbox-Bench-Token": self.cfg["token"]}
        with connect(self.url(), additional_headers=headers, open_timeout=15, max_size=2 ** 22,
                     user_agent_header="agentbox-bench/%d" % VERSION) as ws:
            self.ws = ws
            self.send_json({"type": "hello", "version": VERSION, "host": socket.gethostname(),
                            "os": "%s %s" % (platform.system(), platform.release()),
                            "capabilities": {"serial": bool(self.cfg.get("serial")), "camera": False, "screen": False}})
            last_scan = 0.0
            while True:
                try:
                    m = ws.recv(timeout=1)
                except TimeoutError:
                    m = None
                if isinstance(m, bytes):
                    if len(m) >= 4:
                        s = self.sessions.get(struct.unpack(">I", m[:4])[0])
                        if s:
                            s.incoming(m[4:])
                elif m:
                    self.handle(json.loads(m))
                    if check and self.devices is not None:
                        return True
                if self.enabled and time.time() - last_scan > 3:  # plug / unplug
                    last_scan = time.time()
                    self.announce()

    def run(self):
        delay, paused = 2, False
        while True:
            try:
                self.run_once()
            except (KeyboardInterrupt, SystemExit):
                raise
            except Paused as e:
                if not paused:
                    print("agentbox-bench: %s; sharing nothing, waiting for it to be turned on" % e, flush=True)
                paused, delay = True, 30
            except Exception as e:
                paused = False
                if getattr(self, "connected_once", False):  # it was up: start the backoff over
                    delay, self.connected_once = 2, False
                print("agentbox-bench: disconnected (%s); retrying in %ds" % (e, delay), flush=True)
            finally:
                for s in list(self.sessions.values()):
                    s.close()
                self.ws, self.devices, self.enabled = None, [], {}
            time.sleep(delay)
            delay = min(delay * 2, 30)


def main():
    bootstrap()
    cfg = load_config()
    if "--list" in sys.argv:
        for d in list_devices(cfg):
            print("%-24s %-28s %s" % (d["id"], d["path"], d["description"]))
        return
    b = Bridge(cfg)
    if "--check" in sys.argv:
        try:
            b.run_once(check=True)
            print("agentbox-bench: OK")
        except Exception as e:
            sys.exit("agentbox-bench: can't reach %s: %s" % (b.url(), e))
        return
    print("agentbox-bench %d → %s (Ctrl+C to stop)" % (VERSION, cfg["portal"]), flush=True)
    try:
        b.run()
    except KeyboardInterrupt:
        print("\nagentbox-bench: stopped; nothing is shared now.")


if __name__ == "__main__":
    main()
