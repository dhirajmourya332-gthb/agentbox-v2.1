"""agentbox-avr-upload against a simulated optiboot (STK500v1) board on a TCP socket.

  python3 setup/modules/bench/test/test_avr_upload.py      (needs pyserial)
"""
import importlib.machinery
import importlib.util
import os
import socket
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("avr", os.path.join(HERE, "..", "bin", "agentbox-avr-upload"))
spec = importlib.util.spec_from_loader("avr", loader)
avr = importlib.util.module_from_spec(spec)
loader.exec_module(avr)


class FakeOptiboot:
    """Enough of optiboot for an upload: sync, signature, prog mode, load address, write/read page."""

    def __init__(self, signature=(0x1E, 0x95, 0x0F), corrupt_at=None):
        self.flash = bytearray(b"\xff" * 32768)
        self.sig, self.corrupt_at, self.addr = signature, corrupt_at, 0
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        c, _ = self.sock.accept()
        f = c.makefile("rwb", buffering=0)
        rd = lambda n: f.read(n)
        ok = lambda data=b"": c.sendall(bytes([0x14]) + data + bytes([0x10]))
        while True:
            cmd = rd(1)
            if not cmd:
                return
            cmd = cmd[0]
            if cmd == 0x30:
                rd(1); ok()
            elif cmd == 0x75:
                rd(1); ok(bytes(self.sig))
            elif cmd in (0x50, 0x51):
                rd(1); ok()
            elif cmd == 0x55:
                lo, hi = rd(2); rd(1); self.addr = ((hi << 8) | lo) * 2; ok()
            elif cmd == 0x64:
                hi, lo, _mem = rd(3); n = (hi << 8) | lo; data = bytearray(rd(n)); rd(1)
                if self.corrupt_at is not None and self.addr == self.corrupt_at:
                    data[0] ^= 0xFF
                self.flash[self.addr:self.addr + n] = data; ok()
            elif cmd == 0x74:
                hi, lo, _mem = rd(3); n = (hi << 8) | lo; rd(1); ok(bytes(self.flash[self.addr:self.addr + n]))
            else:
                rd(1); c.sendall(bytes([0x15]))


def hexfile(data, base=0):
    lines = []
    for i in range(0, len(data), 16):
        chunk = data[i:i + 16]
        a = base + i
        rec = bytes([len(chunk), (a >> 8) & 0xFF, a & 0xFF, 0]) + chunk
        lines.append(":" + (rec + bytes([(-sum(rec)) & 0xFF])).hex().upper())
    lines.append(":00000001FF")
    f = tempfile.NamedTemporaryFile("w", suffix=".hex", delete=False)
    f.write("\n".join(lines) + "\n")
    f.close()
    return f.name


class Test(unittest.TestCase):
    def test_upload_and_verify(self):
        board = FakeOptiboot()
        sketch = bytes((i * 7 + 3) & 0xFF for i in range(1000))  # 1000 bytes: 8 pages, the last one partial
        rc = avr.upload("socket://127.0.0.1:%d" % board.port, hexfile(sketch), [115200])
        self.assertEqual(rc, 0)
        self.assertEqual(bytes(board.flash[:1000]), sketch)
        self.assertEqual(bytes(board.flash[1000:1024]), b"\xff" * 24)  # the page's tail stays erased

    def test_verify_catches_a_bad_write(self):
        board = FakeOptiboot(corrupt_at=256)
        with self.assertRaisesRegex(avr.Fail, "verify failed at 0x0100"):
            avr.upload("socket://127.0.0.1:%d" % board.port, hexfile(bytes(600)), [115200])

    def test_unknown_chip_and_too_big(self):
        with self.assertRaisesRegex(avr.Fail, "unknown chip signature 1E 98 01"):
            avr.upload("socket://127.0.0.1:%d" % FakeOptiboot(signature=(0x1E, 0x98, 0x01)).port, hexfile(bytes(10)), [115200])
        with self.assertRaisesRegex(avr.Fail, "doesn't fit"):
            avr.upload("socket://127.0.0.1:%d" % FakeOptiboot().port, hexfile(bytes(32500)), [115200])

    def test_no_bootloader(self):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)  # accepts, never answers
        with self.assertRaisesRegex(avr.Fail, "no bootloader answered"):
            avr.upload("socket://127.0.0.1:%d" % s.getsockname()[1], hexfile(bytes(10)), [115200])

    def test_hex_parsing(self):
        mem = avr.read_hex(hexfile(b"\x01\x02\x03", base=0x100))
        self.assertEqual(mem, {0x100: 1, 0x101: 2, 0x102: 3})
        self.assertEqual(list(avr.pages(mem, 128)), [0x100])


if __name__ == "__main__":
    unittest.main(verbosity=1)
