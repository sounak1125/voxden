## Voxden 2.1.0

Smaller Qwen CUDA downloads with complete GPU support included.

- Qwen CUDA acceleration now downloads 1.88–2.10 GB, depending on which installed support files can be reused. The Qwen model and complete Python, PyTorch and CUDA runtime are preserved. Users need no manual Python or pip installation.
- The acceleration card checks the available release to display its download size. Compression reduces the download; the installed GPU runtime remains about 5.34 GB.
- Existing GPU installations continue working. After Qwen GPU verification succeeds, Voxden automatically cleans eligible leftover archives and obsolete installation files while preserving the active runtime, models, history and settings.
- GPU setup verifies PyTorch, GPU execution and Qwen speech recognition. If the Qwen model has not been downloaded yet, speech verification finishes after model setup.
