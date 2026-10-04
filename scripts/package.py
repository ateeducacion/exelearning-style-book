"""Build the importable style and editable ELPX using only the standard library."""
from pathlib import Path
import json
import shutil
import zipfile
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
theme = root / "theme"
for name in ("config.xml", "style.css", "style.js", "screenshot.png"):
    assert (theme / name).is_file(), f"Missing theme/{name}"
assert ET.parse(theme / "config.xml").findtext("name") == "book"
ET.parse(root / "content.xml")
dist = root / "dist"
dist.mkdir(exist_ok=True)
with zipfile.ZipFile(dist / "book.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(theme.rglob("*")):
        if file.is_file() and not file.name.startswith("."):
            archive.write(file, file.relative_to(theme))
shutil.copy2(dist / "book.zip", root / "content/resources/book.zip")
files = [root / name for name in ("index.html", "content.xml", "content.dtd", "search_index.js", "screenshot.png")]
for directory in ("theme", "content", "html", "idevices", "libs"):
    files.extend(file for file in (root / directory).rglob("*") if file.is_file() and not file.name.startswith("."))
paths = sorted(set(file.relative_to(root).as_posix() for file in files))
(root / "libs/elpx-manifest.js").write_text("window.__ELPX_MANIFEST__=" + json.dumps({"version": 1, "files": paths}, ensure_ascii=False) + ";\n")
with zipfile.ZipFile(dist / "ciclo-del-agua.elpx", "w", zipfile.ZIP_DEFLATED) as archive:
    for name in paths:
        archive.write(root / name, name)
print(f"Built {dist / 'book.zip'} and {dist / 'ciclo-del-agua.elpx'} ({len(paths)} files)")
