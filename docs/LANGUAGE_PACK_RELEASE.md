# Voxden language-pack release

Voxden downloads writing models from a dedicated `language-packs-v1` GitHub Release. The models are release assets, not Git repository files, Git LFS objects, Electron resources, or NSIS installer contents.

## Prepare the assets

Download a Windows x64 CPU build of `llama.cpp` and obtain the two approved Qwen3 GGUF files. Verify the model cards and keep the upstream license files with the release as described in `THIRD_PARTY_NOTICES.md`. Then run:

```powershell
npm run prepare:language-packs -- --runtime-dir C:\path\to\llama-cpp-bin --standard C:\path\to\standard.gguf --enhanced C:\path\to\enhanced.gguf --out C:\path\to\voxden-language-packs-v1
```

The staging script:

- includes the flat `llama.cpp` runtime files, including `llama-server.exe` and its DLLs;
- keeps Standard as one asset when it is below the GitHub limit;
- splits Enhanced into parts below 2 GiB;
- calculates SHA-256 for every asset and for each assembled model; and
- creates `voxden-language-packs.json`, which the app validates against GitHub's Release asset metadata.

Inspect the generated manifest and upload every staged file to one immutable release:

```powershell
gh release create language-packs-v1 C:\path\to\voxden-language-packs-v1\* --repo sounak1125/voxden --title "Voxden language packs v1" --notes "Optional local language packs for Voxden."
```

Do not replace individual assets after publishing. If a model or runtime changes, create a new pack/release version and update the app's release tag deliberately.

## Persistent installation behavior

Pack files and their verified receipts are stored below Electron's `userData` directory at `models/writer`. Normal NSIS app updates replace the application installation but do not touch this directory.

At installation time Voxden downloads to `.partial` files, resumes with HTTP Range requests, verifies each asset, assembles split models, verifies the whole GGUF, and atomically writes a receipt. Later app versions perform an offline size and verified-modification-time check against that receipt. They use the existing pack without contacting GitHub or downloading it again.

The app downloads again only when the selected pack is missing, modified, corrupted, explicitly removed, or deliberately upgraded to a new pack ID. A cancellation keeps partial assets for the next resume attempt.
