#!/usr/bin/env python3
"""Render assets/social-preview.png (1280x640) for this repository.

This is a maintainer tool, run by hand. It is deliberately NOT called by CI:
CI only reads files (see tools/check-docs.mjs), while this script writes an
image and launches a browser.

Requirements
------------
* Python 3.9+ (standard library only — no pip installs)
* A Chromium-based browser: Chrome, Edge, Chromium or Brave.
  Auto-detected on Windows/macOS/Linux; override with --chrome or the
  CHROME / CHROME_PATH environment variable.

How it works
------------
1. Read assets/banner.svg (the same banner the README shows) and embed it.
2. Write a fixed 1280x640 HTML canvas: banner on top, three numbers below,
   repository URL bottom-left, three pills bottom-right.
3. Screenshot that canvas with the browser in headless mode.

Keeping the banner as the source of truth means the share card and the README
header can never drift apart.

Usage
-----
    python assets/tools/make-preview.py
    python assets/tools/make-preview.py --out /tmp/card.png --keep-html

Exit codes: 0 = image written, 1 = browser failed, 2 = bad input.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WIDTH, HEIGHT = 1280, 640
BG = "#0d1117"

# Facts shown on the card. Update these when the README counts change; the
# docs check (tools/check-docs.mjs) does not police them because they are
# editorial, not structural.
NUMBERS = [
    ("6", "defect patterns", "#2f81f7",
     "共享 id / 静默降级 / 升级回滚<br>硬编码路径 / 无界增长 / 双真相"),
    ("10", "pre-release checks", "#3fb950",
     "每条都能用一次 grep 验证<br>发给写插件的你，不是清单收集"),
    ("21", "filed issues", "#d29922",
     "案例都带上游 issue 与报告<br>判据可复跑，结论可反驳"),
]
URL = "github.com/strange2000/awesome-dsh"
PILLS = ["MIT", "EN / 中文", "no runtime"]

CANDIDATES = {
    "win32": [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ],
    "darwin": [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    "linux": [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
    ],
}


def find_browser(explicit: str | None) -> str:
    if explicit:
        if not Path(explicit).exists():
            sys.exit(f"error: --chrome not found: {explicit}")
        return explicit
    for key in ("CHROME", "CHROME_PATH"):
        env = os.environ.get(key)
        if env and Path(env).exists():
            return env
    for name in CANDIDATES.get(sys.platform, CANDIDATES["linux"]):
        if Path(name).exists():
            return name
    for name in ("google-chrome", "chromium", "chromium-browser", "chrome", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    sys.exit("error: no Chromium-based browser found; pass --chrome /path/to/chrome")


def build_html(banner_svg: str) -> str:
    columns = "\n".join(
        f"""    <div class="col"><div class="k" style="color:{color}">{num}</div>
      <div class="n">{label}</div><div class="d">{desc}</div></div>"""
        for num, label, color, desc in NUMBERS
    )
    pills = "".join(f'<span class="pill">{p}</span>' for p in PILLS)
    return f"""<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{{margin:0;padding:0;width:{WIDTH}px;height:{HEIGHT}px;background:{BG};overflow:hidden}}
  .banner{{position:absolute;left:80px;top:38px;width:1120px}}
  .row{{position:absolute;left:80px;top:400px;width:1120px;display:flex;gap:44px}}
  .col{{flex:1}}
  .k{{font:700 34px/1 Consolas,monospace}}
  .n{{font:600 17px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#e6edf3;margin-top:10px}}
  .d{{font:400 14px/1.65 "Segoe UI","Microsoft YaHei",sans-serif;color:#8b949e;margin-top:6px}}
  .url{{position:absolute;left:80px;bottom:40px;font:400 15px/1 Consolas,monospace;color:#8b949e}}
  .pills{{position:absolute;right:80px;bottom:36px;display:flex;gap:10px}}
  .pill{{border:1px solid #30363d;background:#161b22;border-radius:14px;padding:7px 14px;
        font:400 13px/1 Consolas,monospace;color:#8b949e}}
  .hr{{position:absolute;left:80px;top:352px;width:1120px;height:1px;background:#21262d}}
</style></head>
<body>
  <div class="banner">{banner_svg}</div>
  <div class="hr"></div>
  <div class="row">
{columns}
  </div>
  <div class="url">{URL}</div>
  <div class="pills">{pills}</div>
</body></html>
"""


def main() -> int:
    repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Render the 1280x640 social preview.")
    parser.add_argument("--out", default=str(repo / "assets" / "social-preview.png"),
                        help="output PNG path (default: assets/social-preview.png)")
    parser.add_argument("--chrome", default=None, help="path to a Chromium-based browser")
    parser.add_argument("--keep-html", action="store_true", help="keep the generated HTML next to the PNG")
    args = parser.parse_args()

    banner = repo / "assets" / "banner.svg"
    if not banner.exists():
        print(f"error: {banner} is missing", file=sys.stderr)
        return 2
    svg = banner.read_text(encoding="utf-8")
    svg = svg.replace('<?xml version="1.0" encoding="utf-8"?>', "").strip()

    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    html = build_html(svg)
    workdir = Path(tempfile.mkdtemp(prefix="awesome-preview-"))
    html_path = workdir / "card.html"
    html_path.write_text(html, encoding="utf-8")

    browser = find_browser(args.chrome)
    cmd = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--disable-crash-reporter",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        f"--window-size={WIDTH},{HEIGHT}",
        f"--user-data-dir={workdir / 'profile'}",
        f"--default-background-color=ff{BG.lstrip('#')}",
        f"--screenshot={out}",
        html_path.as_uri(),
    ]
    print(f"browser: {browser}")
    print(f"canvas : {WIDTH}x{HEIGHT} -> {out}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not out.exists():
        print("error: headless browser failed", file=sys.stderr)
        print(result.stdout[-2000:], file=sys.stderr)
        print(result.stderr[-2000:], file=sys.stderr)
        return 1

    if args.keep_html:
        kept = out.with_suffix(".html")
        kept.write_text(html, encoding="utf-8")
        print(f"html   : {kept}")
    shutil.rmtree(workdir, ignore_errors=True)
    print(f"written: {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
