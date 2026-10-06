"""Check theme metadata, source JSON and every local HTML reference."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import re
import xml.etree.ElementTree as ET
import zipfile

root = Path(__file__).resolve().parents[1]
theme = ET.parse(root / "theme/config.xml")
assert theme.findtext("name") == "book"
source = ET.parse(root / "content.xml")
namespace = {"e": "http://www.intef.es/xsd/ode"}
pages = source.findall(".//e:odeNavStructure", namespace)
assert len(pages) == 11
for element in source.iter():
    if element.tag.endswith("jsonProperties") and (element.text or "").strip():
        json.loads(element.text)
    for name in re.findall(r'\{\{context_path\}\}/([^"<>\\\s]+)', element.text or ""):
        name = name.removeprefix("content/resources/")
        assert (root / "content/resources" / unquote(name)).is_file(), f"Missing XML resource: {name}"


class References(HTMLParser):
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key not in ("src", "href", "poster") or not value:
                continue
            url = urlsplit(value)
            if url.scheme or url.netloc or not url.path:
                continue
            target = (self.page.parent / unquote(url.path)).resolve()
            assert target.is_relative_to(root), f"Reference outside package: {value}"
            assert target.exists(), f"Missing resource in {self.page.name}: {value}"
        data = dict(attrs).get("data-idevice-json-data")
        if data:
            json.loads(data)


for page in [root / "index.html", *sorted((root / "html").glob("*.html"))]:
    parser = References()
    parser.page = page
    parser.feed(page.read_text())
with zipfile.ZipFile(root / "dist/book.zip") as archive:
    assert {"config.xml", "style.css", "style.js", "screenshot.png"} <= set(archive.namelist())
    assert not any(name.startswith("theme/") for name in archive.namelist())
    assert b"exe-open-exelearning" not in archive.read("style.js") + archive.read("style.css"), "The edit link must not ship in the style"
print(f"PASS: {len(pages)} pages, source JSON, local references and importable theme ZIP.")
