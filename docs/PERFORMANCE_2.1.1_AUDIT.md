# Performance investigation — 2.1.1

The report concerned lag during ordinary use, possibly with Classic or Orb, including one user with an RTX 3080. The exact affected workload and machine telemetry were unavailable. This investigation found reproducible application costs; it does not establish GPU thermal throttling or claim to reproduce that user's hardware problem.

## Confirmed problems and changes

### Hidden dashboard work

Main built and serialized the full history on every dashboard broadcast even when the window was hidden in the tray or minimized. The renderer also built invisible history cards, dictionary rows and charts for received updates.

Main now marks the dashboard dirty and sends one current snapshot on show/restore. Tray updates and overlay/capture messages continue independently. The renderer retains the latest queued payload while hidden and renders it when visible. Actual Windows hide/minimize/show/restore tests verify that intermediate broadcasts are suppressed and the latest settings arrive exactly once on reopening.

With 10,000 synthetic entries, 20 hidden main-process updates went from 20 snapshots and **168.84 ms** to zero snapshots and **0.07 ms**. These numbers measure synchronous preparation, not native IPC or whole-system CPU. The dashboard's separate hidden-render test now calls none of its expensive rendering functions.

### Repeated dashboard calculations and dictionary rebuilding

Unrelated settings/download updates repeatedly counted words, calculated statistics and recreated dictionary rows. Insights rescanned the history on every visible update. The affected functions now cache their relevant input values and render panes when opened. Caches preserve edits made in place and expire at rolling time/calendar boundaries.

Representative isolated Electron measurements:

| Workload | Before, median update | After, median update |
| --- | ---: | ---: |
| 2,000 dictations / 500 dictionary terms | 14.9 ms | 1.7 ms |
| 10,000 dictations / 1,000 dictionary terms | 40.5 ms | 2.4 ms |
| Insights / 10,000 dictations | 104 ms | 8.7 ms |

These are repeated updates to unchanged history. Initial large-history rendering still takes roughly 90–100 ms on the fixture; history virtualization was not introduced. Tests compare cached Insights with fresh calculations after edits to transcript text, original text, duration, app metadata, correction counts, learned pairs and dictionary size, plus date boundaries and backward clock changes.

### Orb drawing and high-refresh previews

The Orb read canvas layout immediately after per-frame style writes, forcing Chromium to resolve pending styles repeatedly. Canvas CSS dimensions now stay cached until a ResizeObserver invalidates them. Display pixel ratio is still checked, and observers are disconnected on disposal. Full processing frames previously shaded the sphere before overwriting every pixel with the processing material; that redundant pass is skipped. Pixel comparisons and golden-image hashes verify unchanged output.

The settings preview previously ran the procedural texture shader at every display frame. It now follows the actual Orb's existing 30-texture-updates-per-second cadence. Deterministic tests measure approximately 30 draws per second at 60, 144 and 240 Hz and no ongoing draws when hidden, scrolled out, unfocused/unhovered or using reduced motion. Decorative CSS motion and voice response remain available.

Renderer benchmarks report JavaScript callback time, layout work and total renderer task duration separately. A reduction in Orb callback time must not be presented as the same percentage reduction in whole-app CPU. The profiler supports alternating old and current shader implementations against the same loaded page to avoid differences from unrelated layout work.

The final comparison used the same live HTML/CSS/overlay JavaScript for both shaders. A fixed-input, GPU-enabled 50-pixel full-processing draw measured **0.469 → 0.186 ms**; sphere and partial-morph costs were essentially unchanged. Whole-renderer timings vary with animation phase and scheduling and are not used to claim a whole-app CPU percentage. Both GPU and software matrices covered all **27 style/state combinations**; GPU comparison recorded both shader implementations for 54 rows. Learned and hidden states had no animation-frame, shader or microphone-meter work after settling. Meter work occurred only in recording.

### ONNX workers consuming CPU between jobs

ONNX Runtime worker pools used their spinning defaults. Even after a tiny inference finished, these workers continued consuming CPU. GPU execution still has CPU workers for graph work/fallback; the CUDA/DirectML options and the long-clip Silero VAD did not consistently receive the CPU budget.

All selected providers now receive bounded worker pools with intra/inter-op spinning disabled. VAD receives the same session options without changing provider selection. Older custom VAD loader signatures retain their compatibility fallback. CPU defaults now use 1/1/2/4 workers on machines reporting 1/2/4/8 logical processors, instead of forcing at least four on every machine. Positive `VOXDEN_CPU_THREADS` overrides are preserved.

Using the shipped ONNX Runtime 1.24.4 and its bundled six-number multiplication model on a 24-logical-processor host, the previous production 12-worker configuration consumed **3,250 ms of summed CPU time during a 300 ms post-inference idle interval**. The new 12-worker configuration measured **0 ms**, with identical multiplication output. Summed CPU time can exceed wall time because many cores run simultaneously. This establishes idle spinning overhead; it is not a speech accuracy or transcription-throughput benchmark, and does not measure the affected RTX 3080.

## Existing protections verified

The earlier system-wide mouse-forwarding hook fix remains in place: `setIgnoreMouseEvents` receives no forwarding option. For all three styles and eight logical modes, 500 stationary cursor polls cause one native input update and one cursor message. Successful calls are cached; failed native input calls remain retryable.

Foreground/key watching uses persistent compiled helpers, not continual PowerShell process launches. Overlay position changes are avoided when a drag's pointer is stationary. The existing deferred speech warmup and lazy secondary-model loading remain in place. Warmup can still load a multi-gigabyte model after an input-idle interval or its 90-second ceiling; changing that latency/memory policy would require representative model measurements.

The real application fixture opens without a model in approximately 1.1 seconds locally. It also reports startup event-loop delay and per-process idle CPU/memory rather than treating a quick first window as proof of no startup work. This fixture is an empty temporary profile, not an installed speech workload.

## Reproduction and validation

- `npm run test:performance`: main work counts, Orb pixels/scheduling, dashboard rendering, real Windows visibility, sidecar budgets and sidecar self-test.
- `npm run bench:flow-performance`: software-rendered Classic/Ribbon/Orb matrix covering idle, arming, recording, transcription, success, error, cancel, learned notice and hidden state. `-- --gpu` enables the hardware-rendered fixture. The script saves detailed reports under ignored `temp/performance/`.
- `dist-runtime-v3/runtime/python.exe -B scripts/bench-onnx-idle.py`: bundled ORT toy benchmark; no speech model download or recording.
- `npm run test:flow-bar-regression`, plus the related System, history, motion and refinement UI tests, cover input, capture lifecycle and settings behavior after optimization.

The aggregate performance suite and full flow-bar regression suite passed after the changes. Related dashboard/history, System settings, motion preference, refinement and JavaScript scope tests also passed. The refinement test now waits for Chromium's media-query change event before asserting the shared reduced-motion state; its previous immediate assertion raced that event.

Tests use temporary profiles and synthetic history/audio meters, with updates and Windows login registration stubbed where production main is exercised. No user's recordings or installed settings are used. Native idle tests cover the local display/GPU configuration; high-refresh scheduling and pixel ratios also have deterministic coverage. This is not an exhaustive benchmark of all drivers, multi-monitor layouts or speech models.

These performance changes are part of the current branch's version **2.1.1**, build **`flowbar-polish-perf-1`**, together with the polished flow bar controls and five release highlights in the notification bell. The rebuild target is `dist/2.1.1-flowbar-polish-performance/`; [the build procedure](RELEASE_2.1.1_BUILD.md) describes artifact verification, the full unit suite and startup against the built resources. Build completion is not asserted by this investigation report. Branch publication does not create a Git tag or public GitHub release. The historical recovery installer in `FLOW_BAR_2.1.1_FIX.md` predates these changes.
