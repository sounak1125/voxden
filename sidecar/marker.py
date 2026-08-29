#!/usr/bin/env python3
"""Watch mouse drags during dictation and save a circled screenshot. No focus steal."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time

WATCHING = False
LOCK = threading.Lock()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def marks_dir():
    path = os.environ.get("VOXDEN_MARKS_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "marks"
    )
    os.makedirs(path, exist_ok=True)
    return path


def capture_script():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "capture-mark.ps1")


def win_mouse():
    import ctypes

    class _POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    user32 = ctypes.windll.user32

    def cursor():
        pt = _POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        return int(pt.x), int(pt.y)

    def down(vk):
        return (user32.GetAsyncKeyState(vk) & 0x8000) != 0

    def virtual_screen():
        left = int(user32.GetSystemMetrics(76))
        top = int(user32.GetSystemMetrics(77))
        width = int(user32.GetSystemMetrics(78))
        height = int(user32.GetSystemMetrics(79))
        return left, top, width, height

    return cursor, down, virtual_screen


def clamp_box(left, top, right, bottom, vs):
    vs_l, vs_t, vs_w, vs_h = vs
    vs_r = vs_l + vs_w
    vs_b = vs_t + vs_h
    left = max(vs_l, min(left, vs_r - 1))
    top = max(vs_t, min(top, vs_b - 1))
    right = max(left + 1, min(right, vs_r))
    bottom = max(top + 1, min(bottom, vs_b))
    return left, top, right, bottom


def save_with_pil(left, top, right, bottom, cx, cy, radius, out_path):
    from PIL import Image, ImageDraw, ImageGrab

    img = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
    overlay = img.convert("RGBA")
    layer = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    box = [cx - radius, cy - radius, cx + radius, cy + radius]
    draw.ellipse(box, fill=(255, 72, 72, 42), outline=(255, 92, 92, 235), width=5)
    out = Image.alpha_composite(overlay, layer).convert("RGB")
    out.save(out_path, "PNG")


def save_with_ps(left, top, right, bottom, cx, cy, radius, out_path):
    script = capture_script()
    args = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Left",
        str(int(left)),
        "-Top",
        str(int(top)),
        "-Width",
        str(int(right - left)),
        "-Height",
        str(int(bottom - top)),
        "-Cx",
        str(int(cx)),
        "-Cy",
        str(int(cy)),
        "-Radius",
        str(int(radius)),
        "-Out",
        out_path,
    ]
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    subprocess.run(args, check=True, timeout=8, creationflags=flags)


def capture_mark(x1, y1, x2, y2):
    _cursor, _down, virtual_screen = win_mouse()
    vs = virtual_screen()
    left = min(x1, x2)
    top = min(y1, y2)
    right = max(x1, x2)
    bottom = max(y1, y2)
    w = max(1, right - left)
    h = max(1, bottom - top)
    pad = 160 if (w < 48 and h < 48) else 48
    left -= pad
    top -= pad
    right += pad
    bottom += pad
    left, top, right, bottom = clamp_box(left, top, right, bottom, vs)
    radius = int(max(40, max(w, h) / 2 + 24))
    cx = int((x1 + x2) / 2 - left)
    cy = int((y1 + y2) / 2 - top)
    out_path = os.path.join(marks_dir(), "mark-%d.png" % int(time.time() * 1000))
    try:
        save_with_pil(left, top, right, bottom, cx, cy, radius, out_path)
    except Exception:
        save_with_ps(left, top, right, bottom, cx, cy, radius, out_path)
    if not os.path.isfile(out_path):
        raise RuntimeError("mark not written")
    return out_path


def stdin_loop():
    global WATCHING
    for line in sys.stdin:
        cmd = line.strip().upper()
        if not cmd:
            continue
        if cmd == "QUIT":
            with LOCK:
                WATCHING = False
            break
        if cmd == "START":
            with LOCK:
                WATCHING = True
        elif cmd == "STOP":
            with LOCK:
                WATCHING = False


def poll_loop():
    cursor, down, _vs = win_mouse()
    VK_LBUTTON = 0x01
    VK_MENU = 0x12
    dragging = False
    armed = False
    sx, sy = 0, 0
    alt = False
    while True:
        with LOCK:
            on = WATCHING
        if not on:
            dragging = False
            armed = False
            time.sleep(0.05)
            continue
        try:
            x, y = cursor()
            left = down(VK_LBUTTON)
            alt_now = down(VK_MENU)
        except Exception:
            time.sleep(0.05)
            continue
        if left and not armed:
            armed = True
            dragging = False
            sx, sy = x, y
            alt = alt_now
        elif left and armed:
            dist = ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5
            need = 8 if (alt or alt_now) else 24
            if dist >= need:
                dragging = True
                alt = alt or alt_now
        elif (not left) and armed:
            dist = ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5
            need = 8 if alt else 24
            if dragging or dist >= need:
                try:
                    path = capture_mark(sx, sy, x, y)
                    emit({"ok": True, "marked": True, "path": path})
                except Exception as exc:
                    emit({"ok": False, "error": str(exc)})
            armed = False
            dragging = False
        time.sleep(0.02)


def main():
    emit({"ok": True, "ready": True})
    t = threading.Thread(target=stdin_loop, daemon=True)
    t.start()
    try:
        poll_loop()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
