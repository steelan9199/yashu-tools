# The Paper Boat Voyage

A 60-second, no-dialogue animated short. A paper boat with a lantern leaves its
folder-harbor, crosses the night sea, weathers a storm, glides under a full moon,
finds a lighthouse, and comes home.

- 6 scenes x 10 s, 480x270, 10 fps, 600 deterministic frames, one GIF.
- Every visual is paper-cut night-sea style built from pure CSS components (`artkit.css`).
- Produced by a zero-dependency pipeline: a headless browser freezes each CSS
  animation at exact timestamps (`animation.currentTime`), and a hand-written
  GIF89a/LZW encoder (see `gifshot.js`) stitches the six scenes into one file.
  No ffmpeg, no image libraries, no npm packages.

Rebuild:

```bash
node gifshot.js \
  scenes/scene-1-harbor.html scenes/scene-2-opensea.html scenes/scene-3-storm.html \
  scenes/scene-4-moonlight.html scenes/scene-5-lighthouse.html scenes/scene-6-home.html \
  -o paperboat-voyage.gif --fps 10 --durations 10000 --width 640 --scale 0.75 --selector "#stage"
```
