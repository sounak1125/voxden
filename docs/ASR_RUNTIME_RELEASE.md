# Publishing the speech-engine runtime

Voxden does not bundle Python. On first run it offers a one-time download that
installs a self-contained interpreter with `faster-whisper` in it, so a new user
never installs Python or runs `pip`. This is how that download is built and
published.

The runtime is versioned by its release tag, not by the app version, so shipping
a new Voxden build does not make anyone download it again.

## Build

On a Windows machine with Python 3.12 on `PATH` and the Visual C++ 2015-2022
redistributable installed:

```bash
npm run prepare:asr-runtime
```

That writes to `dist-runtime/`:

| File | What it is |
| --- | --- |
| `voxden-asr-runtime-win-x64.zip` | the runtime, ~92 MB compressed / ~260 MB installed |
| `voxden-asr-runtime.json` | manifest: id, interpreter path, Python version, size, SHA-256 |

The script builds from python.org's **embeddable** distribution, installs
`faster-whisper` into `Lib\site-packages` with `pip --target`, and then:

- **adds `MSVCP140.dll` and `MSVCP140_1.dll`** from `System32`. `ctranslate2` and
  `onnxruntime` both import the C++ standard library, and the embeddable
  distribution ships only `VCRUNTIME140`. Without these the runtime fails to load
  on any PC that has never had a Visual C++ redistributable installed — which is
  exactly the clean machine this exists to serve. They are redistributable
  app-local under the VC++ redist terms.
- **prunes** `__pycache__`, `pip`, `setuptools`, and `hf_xet` (dead weight, since
  `main.js` sets `HF_HUB_DISABLE_XET=1`).
- **verifies itself** by running `transcribe.py --check` and `--self-test`
  through the interpreter it just built. A runtime that cannot run the sidecar
  fails the build rather than reaching a user.

The interpreter running `pip` decides which wheels are resolved, so it must be
the same Python version as `--python-version` (3.12 by default).

## Publish

Create a GitHub release tagged **`asr-runtime-v1`** on `sounak1125/voxden` and
upload both files. Mark it a **pre-release**, for the same reason the language
packs are: `electron-updater` resolves app updates through
`GET /releases/latest`, which skips drafts and pre-releases. A normal release
here would become "latest" and break app updates for everyone.

Voxden fetches this release by exact tag, so pre-release status does not affect
the download.

## How the app verifies it

Size and SHA-256 come from **GitHub's own asset digest**, not from the manifest.
The manifest is only a fallback for the digest and a place to record the
interpreter path and Python version, so editing it alone cannot describe a
payload into being accepted. The download is resumable and segmented, the
archive is extracted with every entry path resolved against the destination
first (see `src/zip.js`), and success is recorded in a receipt under the user's
`userData` directory that survives app updates.

## Changing the runtime

Bump the tag (`asr-runtime-v2`) and `DEFAULT_RELEASE_TAG` in `src/asr-runtime.js`
together. The receipt records the runtime id, so a client that already has the
old one installed downloads the new one once and then stops.
