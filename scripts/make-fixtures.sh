#!/usr/bin/env bash
# Generates test media fixtures into fixtures/ (gitignored — never commit these).
# Idempotent: each file is skipped if it already exists. Requires ffmpeg on PATH.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p fixtures

command -v ffmpeg >/dev/null 2>&1 || {
  echo "error: ffmpeg not found on PATH (install it, e.g. 'brew install ffmpeg')" >&2
  exit 1
}

skip() { echo "skip: fixtures/$1 already exists"; }
made() { echo "made: fixtures/$1"; }

# long-sample.mp4 — 90 s, 1280x720, testsrc2 video + sine audio alternating
# loud/quiet every 10 s (gives the highlight RMS heuristic a real signal).
if [ -f fixtures/long-sample.mp4 ]; then skip long-sample.mp4; else
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=90" \
    -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=90" \
    -af "volume='if(lt(mod(t,20),10),1.0,0.05)':eval=frame" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
    fixtures/long-sample.mp4
  made long-sample.mp4
fi

# short-sample.mp4 — 5 s, 1280x720, with audio.
if [ -f fixtures/short-sample.mp4 ]; then skip short-sample.mp4; else
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=5" \
    -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=5" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
    fixtures/short-sample.mp4
  made short-sample.mp4
fi

# stereo-sample.mp4 — 3 s, STEREO 48 kHz audio.
# Deliberately neither mono nor 16 kHz: every other fixture is already mono
# 44.1 kHz, so a WAV extractor that dropped `-ac 1` would still emit mono and
# the test would pass while proving nothing. Downmix + resample are only
# observable against a source that differs on BOTH axes.
if [ -f fixtures/stereo-sample.mp4 ]; then skip stereo-sample.mp4; else
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=640x360:rate=30:duration=3" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
    -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=3" \
    -filter_complex "[1:a][2:a]join=inputs=2:channel_layout=stereo[a]" \
    -map 0:v -map "[a]" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 \
    fixtures/stereo-sample.mp4
  made stereo-sample.mp4
fi

# no-audio.mp4 — 5 s, video only.
if [ -f fixtures/no-audio.mp4 ]; then skip no-audio.mp4; else
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=5" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -an \
    fixtures/no-audio.mp4
  made no-audio.mp4
fi

# broll-sample.mp4 — 8 s, with audio.
if [ -f fixtures/broll-sample.mp4 ]; then skip broll-sample.mp4; else
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=640x360:rate=30:duration=8" \
    -f lavfi -i "sine=frequency=220:sample_rate=44100:duration=8" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
    fixtures/broll-sample.mp4
  made broll-sample.mp4
fi

# not-a-video.txt — for probe rejection tests.
if [ -f fixtures/not-a-video.txt ]; then skip not-a-video.txt; else
  printf 'this is not a video file\n' > fixtures/not-a-video.txt
  made not-a-video.txt
fi

echo "fixtures ready in fixtures/"
