#!/usr/bin/env python3
"""Build the Libro water-cycle example from its editable content.xml.

Reuses the checked-in eXeLearning export so
regeneration preserves the current pages, activities and resources.
"""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("package.py")), run_name="__main__")
