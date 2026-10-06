# Personal Mac mini voice fork

Base: upstream qwen-audio-agent v2.0.1 (`a73bcbc2e1278bf664df38bdd169ffba1fb2451f`). The fork retains LICENSE, NOTICE and upstream attribution. Changes are on `hazen/macmini-voice`.

The desktop Electron shell hosts the web voice client. The speech-to-speech service owns ASR, the conversational model, voice cloning and synthesis limits. The playback profile changes only the client's buffering; it does not select or alter a voice.

## Opt-in playback profile

Default builds retain upstream remote buffering: 400ms initial reserve, 320ms reserve after underrun, 100ms batching, and 60ms batch timer. Unknown profile values also fall back to those defaults.

For a stable private-network connection to a local speech service:

```sh
npm ci
VITE_QWEN_AUDIO_PLAYBACK_PROFILE=low-latency npm run build
# To produce an unsigned local macOS desktop package with the same profile:
VITE_QWEN_AUDIO_PLAYBACK_PROFILE=low-latency npm run desktop:build:local
```

The low-latency profile uses 120ms initial/resume reserve, 40ms low-water threshold, 40ms batching and a 20ms batch timer. This lowers the configured initial reserve by 280ms; it is not a measured 280ms end-to-end improvement. Arrival bursts, inference, synthesis speed, Web Audio scheduling and network jitter affect what the user hears. A smaller reserve can increase underruns on slow generation or unstable links; use a default build to recover the upstream behavior.

`VITE_QWEN_AUDIO_PLAYBACK_PROFILE` is read at build time, not from Gateway runtime settings. It contains no credential. Loopback playback still bypasses remote buffering. Finish flushes partial audio; interruption reset discards queued old audio.

## Validation

```sh
node --test web/test/audio.test.mjs web/test/playback-lifecycle.test.mjs
npm run build
VITE_QWEN_AUDIO_PLAYBACK_PROFILE=low-latency npm run build
```

For desktop packaging changes also run `npm run test:desktop-package`, using isolated configuration, before replacing an installed application. Do not build with or commit production .env files, device credentials, voice reference clips, model weights, logs or task history.

The playback queue cannot recover speech that a synthesis service never generated. Server-side length-aware TTS segmentation and prompt-cache fixes must be tracked with that service independently. Keep those versions pinned and validate complete audio, interruption and reconnect behavior together.
