"""agentbox-onshape against a mock Onshape API (no network, no real account).

  python3 setup/modules/onshape/test/test_agentbox_onshape.py
"""
import base64, json, os, re, subprocess, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "bin", "agentbox-onshape")
AUTH = "Basic " + base64.b64encode(b"AK:SK").decode()


class Mock(BaseHTTPRequestHandler):
    docs, uploads, versions, polls = {}, [], [], {}
    private_ok = True

    def log_message(self, *a): pass

    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def route(self, method):
        if self.headers.get("Authorization") != AUTH:
            return self.send(401, {"message": "Unauthenticated API request"})
        p = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n) if n else b""
        if method == "GET" and p == "/api/v12/users/sessioninfo":
            return self.send(200, {"id": "u1", "email": "owner@example.com", "name": "Owner"})
        if method == "GET" and p == "/api/v12/documents":
            q = re.search(r"q=([^&]*)", self.path); q = __import__("urllib.parse").parse.unquote_plus(q.group(1)) if q else ""
            return self.send(200, {"items": [{"id": k, "name": v["name"], "public": v["public"]} for k, v in self.docs.items() if q.lower() in v["name"].lower()]})
        if method == "POST" and p == "/api/v12/documents":
            d = json.loads(body)
            if not d.get("isPublic") and not self.private_ok:
                return self.send(403, {"message": "Private documents are not available on your plan"})
            did = "d%03d" % (len(self.docs) + 1); self.docs[did] = {"name": d["name"], "public": d.get("isPublic", False), "elements": []}
            return self.send(200, {"id": did, "name": d["name"], "defaultWorkspace": {"id": "w" + did}})
        m = re.fullmatch(r"/api/v12/documents/(d\d+)", p)
        if method == "GET" and m:
            return self.send(200, {"id": m[1], "name": self.docs[m[1]]["name"], "defaultWorkspace": {"id": "w" + m[1]}})
        m = re.fullmatch(r"/api/v12/blobelements/d/(d\d+)/w/(wd\d+)", p)
        if method == "POST" and m:
            assert self.headers["Content-Type"].startswith("multipart/form-data; boundary=")
            fname = re.search(rb'name="encodedFilename"\r\n\r\n([^\r]*)', body).group(1).decode()
            translate = re.search(rb'name="translate"\r\n\r\n([^\r]*)', body).group(1).decode()
            content = body.split(b"Content-Type: ", 2)[-1].split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n--", 1)[0]
            tid = "t%d" % (len(self.uploads) + 1); self.uploads.append((m[1], fname, translate, content)); self.polls[tid] = 0
            return self.send(200, {"id": "blob", "translationId": tid})
        m = re.fullmatch(r"/api/v12/translations/(t\d+)", p)
        if method == "GET" and m:
            self.polls[m[1]] += 1
            if self.polls[m[1]] < 2: return self.send(200, {"id": m[1], "requestState": "ACTIVE"})
            return self.send(200, {"id": m[1], "requestState": "DONE", "resultElementIds": ["e" + m[1]]})
        m = re.fullmatch(r"/api/v12/documents/d/(d\d+)/versions", p)
        if method == "POST" and m:
            d = json.loads(body); self.versions.append((m[1], d["name"])); return self.send(200, {"id": "v%d" % len(self.versions)})
        return self.send(404, {"message": "no route " + p})

    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")


class Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Mock); threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.tmp = tempfile.mkdtemp(); cls.keys = os.path.join(cls.tmp, "onshape.env")
        open(cls.keys, "w").write("ONSHAPE_ACCESS_KEY=AK\nONSHAPE_SECRET_KEY=SK\n")
        cls.step = os.path.join(cls.tmp, "bracket.step"); open(cls.step, "wb").write(b"ISO-10303-21;\nDATA;\nENDSEC;\n")

    def run_tool(self, *args, keys=None):
        env = dict(os.environ, ONSHAPE_BASE_URL="http://127.0.0.1:%d" % self.srv.server_port, ONSHAPE_KEYS_FILE=keys or self.keys, PATH="/usr/bin:/bin")
        return subprocess.run([sys.executable, TOOL, *args], capture_output=True, text=True, env=env, timeout=60)

    def test_whoami(self):
        r = self.run_tool("whoami", "--short"); self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(r.stdout.strip(), "owner@example.com")

    def test_bad_keys_are_reported_not_printed(self):
        bad = os.path.join(self.tmp, "bad.env"); open(bad, "w").write("ONSHAPE_ACCESS_KEY=AK\nONSHAPE_SECRET_KEY=wrong-secret\n")
        r = self.run_tool("whoami", keys=bad); self.assertEqual(r.returncode, 1); self.assertIn("refused the keys", r.stderr); self.assertNotIn("wrong-secret", r.stderr + r.stdout)

    def test_upload_creates_private_doc_tab_and_version_then_reuses_doc(self):
        r = self.run_tool("upload", self.step, "--doc", "wheel-module", "--tab", "v1", "--version", "v1: first fit", "--note", "lab@abc123")
        self.assertEqual(r.returncode, 0, r.stderr); out = json.loads(r.stdout)
        self.assertTrue(out["created"]); self.assertIn("/documents/d001/w/wd001/e/et", out["link"]); self.assertEqual(out["version"], "v1: first fit")
        did, fname, translate, content = Mock.uploads[-1]
        self.assertEqual((did, fname, translate), ("d001", "v1.step", "true")); self.assertEqual(content, open(self.step, "rb").read())
        self.assertFalse(Mock.docs["d001"]["public"])
        r2 = self.run_tool("upload", self.step, "--doc", "wheel-module", "--tab", "v2")
        self.assertEqual(r2.returncode, 0, r2.stderr); self.assertFalse(json.loads(r2.stdout)["created"]); self.assertEqual(Mock.uploads[-1][:2], ("d001", "v2.step"))

    def test_plan_without_private_documents_is_explained(self):
        Mock.private_ok = False
        try:
            r = self.run_tool("upload", self.step, "--doc", "gripper", "--tab", "v1")
            self.assertEqual(r.returncode, 1); self.assertIn("won't create a private document", r.stderr)
        finally:
            Mock.private_ok = True


if __name__ == "__main__":
    unittest.main(verbosity=1)
