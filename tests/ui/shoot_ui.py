"""Screenshot every tab of the device UI from the mock server (phone size)."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8790"
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.goto(base + "/")
    pg.wait_for_timeout(1500)
    for tab in ["now", "plan", "update", "device"]:
        pg.click(f'[data-tab="{tab}"]')
        pg.wait_for_timeout(700)
        pg.screenshot(path=str(out / f"ui-{tab}.png"), full_page=True)
    if len(sys.argv) > 3:
        pg.goto(base + "/portal")
        pg.wait_for_timeout(1200)
        pg.screenshot(path=str(out / "ui-portal.png"), full_page=True)
    b.close()
print("\n".join(errors) or "no console errors")
