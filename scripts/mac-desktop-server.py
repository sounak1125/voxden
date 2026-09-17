#!/usr/bin/env python3
"""A remote desktop for a headless macOS CI runner, in one file.

Apple's Screen Sharing on a runner puts a remote user on an empty virtual
display, so the real session stays invisible. This serves a screenshot of the
real desktop about once a second and turns clicks, typing and key presses on
the page into cliclick commands on the runner. Everything except the page
itself requires the token, which is the MAC_VNC_PASSWORD secret.
"""

import ctypes
import json
import os
import struct
import subprocess
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("MAC_VNC_PASSWORD", "")
SHOT = "/tmp/voxden-shot.png"
MIN_SHOT_INTERVAL = 0.7
_last_shot = 0.0


def logical_size():
    cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

    class CGRect(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double),
                    ("w", ctypes.c_double), ("h", ctypes.c_double)]

    cg.CGMainDisplayID.restype = ctypes.c_uint32
    cg.CGDisplayBounds.restype = CGRect
    cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
    bounds = cg.CGDisplayBounds(cg.CGMainDisplayID())
    return int(bounds.w), int(bounds.h)


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return 0, 0
    return struct.unpack(">II", head[16:24])


def take_shot():
    global _last_shot
    now = time.time()
    if now - _last_shot >= MIN_SHOT_INTERVAL or not os.path.exists(SHOT):
        subprocess.run(["screencapture", "-x", "-C", "-t", "png", SHOT], timeout=10)
        _last_shot = time.time()


def cliclick(*commands):
    result = subprocess.run(["cliclick"] + list(commands), capture_output=True, text=True, timeout=20)
    return (result.stdout + result.stderr).strip()


PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Voxden runner desktop</title>
<style>
  body { margin: 0; background: #111; color: #ddd; font: 14px system-ui, sans-serif; }
  #bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 8px; background: #222; }
  #bar input[type=text] { width: 260px; }
  button { padding: 4px 10px; }
  #screen { display: block; max-width: 100vw; cursor: crosshair; }
  #log { padding: 4px 8px; color: #9c9; white-space: pre-wrap; }
</style></head><body>
<div id="bar">
  <input id="token" type="password" placeholder="password" size="12">
  <button onclick="save()">Use</button>
  <span>|</span>
  <input id="text" type="text" placeholder="text to type">
  <button onclick="act({kind:'type', text: v('text')})">Type</button>
  <button onclick="act({kind:'key', key:'return'})">Return</button>
  <button onclick="act({kind:'key', key:'esc'})">Esc</button>
  <button onclick="act({kind:'key', key:'tab'})">Tab</button>
  <span>|</span>
  <input id="chord" type="text" value="cmd,shift" size="10" title="modifiers, comma separated: cmd ctrl alt shift">
  <input id="chordkey" type="text" value="space" size="6" title="key name for cliclick, e.g. space, return, a">
  <button onclick="act({kind:'shortcut', mods: v('chord'), key: v('chordkey')})">Press chord</button>
  <button onclick="act({kind:'hold', mods: v('chord'), key: v('chordkey')})">Hold</button>
  <button onclick="act({kind:'release', mods: v('chord'), key: v('chordkey')})">Release</button>
  <span>|</span>
  <label><input id="live" type="checkbox" checked> live</label>
  <button onclick="refresh()">Refresh</button>
</div>
<img id="screen" alt="desktop">
<div id="log"></div>
<script>
  let token = sessionStorage.getItem('token') || '';
  document.getElementById('token').value = token;
  function v(id) { return document.getElementById(id).value; }
  function save() { token = v('token'); sessionStorage.setItem('token', token); refresh(); }
  function log(t) { document.getElementById('log').textContent = t; }
  function refresh() {
    if (!token) return;
    const img = document.getElementById('screen');
    img.src = '/shot.png?k=' + encodeURIComponent(token) + '&t=' + Date.now();
  }
  async function act(a) {
    const r = await fetch('/act?k=' + encodeURIComponent(token), {method: 'POST', body: JSON.stringify(a)});
    log(await r.text());
    setTimeout(refresh, 300);
  }
  document.getElementById('screen').addEventListener('click', (e) => {
    const img = e.currentTarget;
    const sx = img.naturalWidth / img.clientWidth, sy = img.naturalHeight / img.clientHeight;
    act({kind: 'click', px: Math.round(e.offsetX * sx), py: Math.round(e.offsetY * sy)});
  });
  document.getElementById('screen').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const img = e.currentTarget;
    const sx = img.naturalWidth / img.clientWidth, sy = img.naturalHeight / img.clientHeight;
    act({kind: 'rightclick', px: Math.round(e.offsetX * sx), py: Math.round(e.offsetY * sy)});
  });
  setInterval(() => { if (document.getElementById('live').checked) refresh(); }, 1000);
  refresh();
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, query):
        return bool(TOKEN) and query.get("k", [""])[0] == TOKEN

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if not self._authorized(query):
            return self._send(403, "wrong password")
        if url.path == "/shot.png":
            try:
                take_shot()
                with open(SHOT, "rb") as f:
                    return self._send(200, f.read(), "image/png")
            except Exception as err:  # noqa: BLE001
                return self._send(500, "screenshot failed: %s" % err)
        return self._send(404, "not found")

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        if not self._authorized(query):
            return self._send(403, "wrong password")
        if url.path != "/act":
            return self._send(404, "not found")
        length = int(self.headers.get("Content-Length") or 0)
        try:
            action = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, "bad json")
        try:
            return self._send(200, self.perform(action) or "ok")
        except Exception as err:  # noqa: BLE001
            return self._send(500, "action failed: %s" % err)

    def perform(self, action):
        kind = action.get("kind")
        if kind in ("click", "rightclick"):
            # Page coordinates are screenshot pixels; cliclick wants points.
            # A job process outside the GUI session may get no display bounds
            # back; then the screenshot is taken to be one pixel per point.
            shot_w, shot_h = png_size(SHOT)
            try:
                logical_w, logical_h = logical_size()
            except Exception:  # noqa: BLE001
                logical_w, logical_h = 0, 0
            sx = logical_w / shot_w if shot_w and logical_w else 1
            sy = logical_h / shot_h if shot_h and logical_h else 1
            x = int(int(action.get("px", 0)) * sx)
            y = int(int(action.get("py", 0)) * sy)
            out = cliclick(("rc:%d,%d" if kind == "rightclick" else "c:%d,%d") % (x, y))
            return "clicked %d,%d (scale %.2f) %s" % (x, y, sx, out)
        if kind == "type":
            text = str(action.get("text", ""))
            return cliclick("t:" + text) if text else "nothing to type"
        if kind == "key":
            return cliclick("kp:" + str(action.get("key", "return")))
        mods = ",".join(m.strip() for m in str(action.get("mods", "")).split(",") if m.strip())
        key = str(action.get("key", "")).strip()
        if kind == "shortcut":
            steps = []
            if mods:
                steps.append("kd:" + mods)
            if key:
                steps.append("kp:" + key)
            if mods:
                steps.append("ku:" + mods)
            return cliclick(*steps)
        # cliclick can hold only modifier keys, so a push-to-talk test needs a
        # modifier-only chord in Voxden, such as Control+Option.
        if kind in ("hold", "release"):
            if key:
                return "hold and release work with modifiers only; clear the key and set a modifier-only shortcut in Voxden"
            if not mods:
                return "nothing to hold"
            return cliclick(("kd:" if kind == "hold" else "ku:") + mods)
        return "unknown action"

    def log_message(self, fmt, *args):  # quieter log
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 6080
    if not TOKEN:
        sys.exit("MAC_VNC_PASSWORD is not set")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("desktop server on %d" % port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
