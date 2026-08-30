# Publishing the speech engine and its model

Voxden bundles neither Python nor the Whisper weights. On first run it offers a
single download that installs both, so a new user never installs Python, runs
`pip`, or waits on Hugging Face. This is how those assets are built and
published.

Two releases, each versioned by its own tag rather than by the app version, so
shipping a new Voxden build does not make anyone download either again:

| Tag | Holds | Size |
| --- | --- | --- |
| `asr-runtime-v1` | Python + faster-whisper | 92 MB down, 260 MB installed |
| `asr-model-v1` | Whisper large-v3 weights | 3.1 GB |

## The runtime

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

## The model

```bash
npm run prepare:asr-model
```

Pass `--python` pointing at a Python with `faster-whisper` — the runtime you just
built will do:

```bash
node scripts/prepare-asr-model.js --python dist-runtime-extracted/python.exe
```

That writes `dist-model/`: the CTranslate2 weights cut into `.part01`/`.part02`,
the four small files faster-whisper opens beside them, and
`voxden-asr-model.json`. Upload all of it to a release tagged **`asr-model-v1`**,
also marked pre-release.

`model.bin` is ~3.1 GB and GitHub refuses an asset over 2 GB, so it ships in
1.8 GB parts. The client concatenates them and checks the result against the
digest of the **whole original file**, not just the individual parts, so a
correct-looking set of pieces that does not reassemble correctly is rejected.

Like the runtime, the script loads the model and decodes audio through it before
packaging, so a model that cannot transcribe fails the build rather than reaching
a user.

`--repo` selects a different CTranslate2 model (`Systran/faster-whisper-medium.en`
and so on); the asset names and the install directory follow it automatically.

## What the app does without them

Both are optional in the sense that nothing crashes. Without the hosted model,
`resolveModel` falls back to the bare model name and faster-whisper fetches it
from Hugging Face exactly as it always did. A user with their own working Python
is never shown the download.

Precedence is `VOXDEN_MODEL` → a personal fine-tune → the hosted model → the
bare name.

## Changing either one

Bump the tag (`asr-runtime-v2`, `asr-model-v2`) and the matching
`DEFAULT_RELEASE_TAG` in `src/asr-runtime.js` or `src/asr-model.js` together. The
receipts record the installed id, so a client that already has the old one
downloads the new one once and then stops.
