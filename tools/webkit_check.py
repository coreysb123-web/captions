"""Render Captions in a Safari-engine (WebKit) browser at iPhone sizes.

    python check.py <url> <output folder> <tag> [old stylesheet to substitute] [device ...]

Saves a screenshot of every screen and sheet, and prints layout measurements.
"""
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

url = sys.argv[1]
out = pathlib.Path(sys.argv[2])
tag = sys.argv[3]
old_css_path = sys.argv[4] if len(sys.argv) > 4 else "-"
devices = sys.argv[5:] or ["iPhone 13"]
out.mkdir(parents=True, exist_ok=True)
old_css = None if old_css_path == "-" else pathlib.Path(old_css_path).read_text(encoding="utf-8")

MEASURE_SHEET = """(id) => {
  const d = document.getElementById(id);
  const b = d.querySelector('.sheet-body');
  const r = d.getBoundingClientRect();
  const br = b.getBoundingClientRect();
  return { open: d.open, sheet: Math.round(r.height), top: Math.round(r.top),
           bottomGap: Math.round(innerHeight - r.bottom), body: Math.round(br.height),
           content: b.scrollHeight, scrolls: b.scrollHeight > b.clientHeight + 1,
           width: Math.round(r.width) };
}"""

MEASURE_MAIN = """() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const status = q('#statusText');
  const overflowing = [];
  for (const el of document.querySelectorAll('.app *')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > innerWidth + 1 || r.left < -1)) overflowing.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
  }
  return { viewport: innerWidth + 'x' + innerHeight, docWidth: document.documentElement.scrollWidth,
           topbar: rect(q('.topbar')), stage: rect(q('.stage')), bottombar: rect(q('.bottombar')),
           mainButton: rect(q('#main')), mainButtonFullyVisible: q('#main').getBoundingClientRect().bottom <= innerHeight,
           statusCut: status.scrollWidth > status.clientWidth + 1, statusText: status.textContent,
           offScreen: overflowing.slice(0, 8) };
}"""


def run(p, device_name):
    label = device_name.replace(" ", "-").replace("(", "").replace(")", "").lower()
    browser = p.webkit.launch()
    if "x" in device_name and device_name.replace("x", "").isdigit():
        # A bare size such as 375x548: an iPhone with that much visible page.
        w, h = (int(n) for n in device_name.split("x"))
        profile = dict(p.devices["iPhone 13"])
        profile["viewport"] = {"width": w, "height": h}
        profile["screen"] = {"width": w, "height": h}
    else:
        profile = p.devices[device_name]
    context = browser.new_context(**profile, color_scheme="dark")
    page = context.new_page()
    problems = []
    page.on("pageerror", lambda e: problems.append("error: " + str(e)))
    page.on("console", lambda m: problems.append("console: " + m.text) if m.type == "error" else None)
    if old_css is not None:
        page.route("**/css/app.css", lambda route: route.fulfill(status=200, content_type="text/css", body=old_css))
    page.goto(url, wait_until="load")
    page.wait_for_timeout(600)

    def shot(name):
        page.screenshot(path=str(out / f"{tag}-{label}-{name}.png"), scale="css")

    result = {"device": device_name, "sheets": {}}
    result["first"] = page.evaluate(MEASURE_MAIN)
    shot("01-first")

    def sheet(name, sheet_id, opener):
        page.evaluate(opener)
        page.wait_for_timeout(400)
        result["sheets"][name] = page.evaluate(MEASURE_SHEET, sheet_id)
        shot("sheet-" + name)
        page.evaluate("(id) => document.getElementById(id).close()", sheet_id)
        page.wait_for_timeout(150)

    click = "document.getElementById('%s').click()"
    sheet("menu", "menu", click % "openMenu")
    sheet("setup", "setup", click % "openSetup")
    sheet("people", "people", click % "openPeople")
    sheet("history", "history", click % "openHistory")
    sheet("notice", "notice", click % "main")

    page.evaluate("window.captions.settings.engineKey = 'sk_' + '0123456789abcdef'.repeat(3)")
    page.evaluate(click % "openSetup")
    page.wait_for_timeout(300)
    sheet("send", "send", click % "shareSetup")
    page.evaluate("document.getElementById('keyInput').value = ''; document.getElementById('setup').close(); window.captions.settings.engineKey = ''")
    page.wait_for_timeout(300)
    page.evaluate("window.captions.settings.engineKey = ''; localStorage.clear()")

    page.evaluate("window.captions.startDemo()")
    page.wait_for_timeout(15000)
    result["listening"] = page.evaluate(MEASURE_MAIN)
    shot("02-demo")
    page.evaluate("document.querySelector('#turns .who').click()")
    page.wait_for_timeout(400)
    result["sheets"]["who"] = page.evaluate(MEASURE_SHEET, "who")
    shot("sheet-who")
    page.evaluate("document.getElementById('who').close()")
    page.evaluate("window.captions.session.pause()")
    page.wait_for_timeout(600)

    # The display-check page, if this version has one.
    response = page.goto(url + "check.html", wait_until="load")
    if response and response.ok:
        page.wait_for_timeout(500)
        result["checkPage"] = page.inner_text("#out")
        shot("03-check-page")
    result["problems"] = problems[:10]
    browser.close()
    return result


with sync_playwright() as p:
    results = [run(p, name) for name in devices]
print(json.dumps(results, indent=1))
