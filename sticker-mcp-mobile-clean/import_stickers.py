#!/usr/bin/env python3
"""Import the public 59-sticker ZIP into the mobile-clean catalog."""
import argparse
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
CATALOG = ROOT / "stickers.json"
IMAGE_PATH_RE = re.compile(r"images/[A-Za-z0-9_.-]{1,120}\.(?:jpg|jpeg|png|webp|gif)", re.I)
ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def read_pack(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        files = {entry.filename: entry for entry in archive.infolist() if not entry.is_dir()}
        if len(files) > 120 or "manifest.json" not in files:
            raise ValueError("ZIP must contain manifest.json and no more than 120 files.")
        if files["manifest.json"].file_size > 64 * 1024:
            raise ValueError("manifest.json is too large.")
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
        items = manifest.get("stickers")
        if not isinstance(items, list) or not (1 <= len(items) <= 100):
            raise ValueError("The ZIP must contain between 1 and 100 stickers.")
        seen = set()
        total = 0
        result = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("Invalid sticker entry.")
            source = item.get("file", "")
            if not isinstance(source, str) or not IMAGE_PATH_RE.fullmatch(source) or source not in files:
                raise ValueError(f"Invalid or missing image path: {source!r}")
            if source in seen:
                raise ValueError(f"Duplicate image path: {source}")
            seen.add(source)
            info = files[source]
            if info.file_size > 6 * 1024 * 1024:
                raise ValueError(f"Image exceeds 6 MB: {source}")
            total += info.file_size
            if total > 60 * 1024 * 1024:
                raise ValueError("Uncompressed images exceed 60 MB.")
            ext = Path(source).suffix.lower()
            if ext not in ALLOWED_EXTS:
                raise ValueError(f"Unsupported image type: {source}")
            raw = archive.read(source)
            title = str(item.get("title") or Path(source).stem).strip()[:65]
            category = str(item.get("category") or "日常").strip()[:36]
            tags = item.get("tags", [])
            if not isinstance(tags, list):
                tags = [str(tags)]
            tags = [str(tag).strip()[:80] for tag in tags if str(tag).strip()]
            if title and title not in tags:
                tags.insert(0, title)
            result.append({"source": source, "ext": ".jpg" if ext == ".jpeg" else ext,
                           "raw": raw, "title": title, "category": category, "tags": tags})
        return result


def prepare(zip_path):
    items = read_pack(zip_path)
    ASSETS.mkdir(parents=True, exist_ok=True)
    for index, item in enumerate(items, start=1):
        name = f"tt{index:03d}{item['ext']}"
        (ASSETS / name).write_bytes(item["raw"])
    print(f"Prepared {len(items)} sticker assets in {ASSETS}")


def update_catalog(zip_path, asset_commit):
    if not re.fullmatch(r"[0-9a-f]{40}", asset_commit):
        raise ValueError("asset commit must be a full 40-character SHA.")
    items = read_pack(zip_path)
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    managed_ids = {f"tt{index:03d}" for index in range(1, len(items) + 1)}
    stickers = [entry for entry in catalog.get("stickers", [])
                if str(entry.get("id", "")) not in managed_ids]
    base_url = "https://raw.githubusercontent.com/liyanjun921/cove-resonance"
    for index, item in enumerate(items, start=1):
        sticker_id = f"tt{index:03d}"
        asset_name = f"{sticker_id}{item['ext']}"
        stickers.append({
            "id": sticker_id,
            "name": item["title"],
            "description": f"{item['title']}（{item['category']}表情）",
            "category": item["category"],
            "tags": item["tags"],
            "when_to_use": f"适合「{item['category']}」情境",
            "image_url": f"{base_url}/{asset_commit}/sticker-mcp-mobile-clean/assets/{asset_name}"
        })
    catalog["stickers"] = stickers
    catalog["version"] = "1.2.0"
    catalog["note"] = "Public sticker catalog. The original 17 stickers are retained; 59 imported stickers are stored in the repository and use immutable commit-pinned image URLs."
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Catalog now contains {len(stickers)} stickers; imported {len(items)}.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "catalog"])
    parser.add_argument("--zip", required=True)
    parser.add_argument("--asset-commit")
    args = parser.parse_args()
    if args.mode == "prepare":
        prepare(args.zip)
    else:
        if not args.asset_commit:
            parser.error("--asset-commit is required for catalog mode")
        update_catalog(args.zip, args.asset_commit)


if __name__ == "__main__":
    main()
