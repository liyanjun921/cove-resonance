# Sticker import drop zone

Upload exactly one ZIP bundle into this folder on branch `feat/sticker-mobile-clean`, then commit it.

The GitHub Actions workflow will:
1. Validate `manifest.json` and the image paths.
2. Commit the image files into `sticker-mcp-mobile-clean/assets/`.
3. Add their metadata to `sticker-mcp-mobile-clean/stickers.json` using immutable commit-pinned image URLs.
4. Remove the temporary ZIP from the repository.

Do not upload more than one ZIP at a time. The prepared 59-sticker bundle from ChatGPT is named `sticker-import-59.zip`.
