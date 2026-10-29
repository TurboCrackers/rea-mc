# Simple Video Editor

A deliberately tiny video editor for Windows. Put videos on a timeline, trim
them, cut out the parts you don't want, drop other videos into the gaps, and
export one MP4.

## Get it running on Windows

**Option 1: download the ready-made app.** Every push that changes this folder
builds the app on GitHub. Open the repository's **Actions** tab, pick the latest
**Simple Video Editor (Windows)** run, and download the
`SimpleVideoEditor-windows` artifact. It contains:

- `SimpleVideoEditor-1.0.0-portable.exe`: a single file you can double-click.
- `SimpleVideoEditor-1.0.0-windows.zip`: the same app unzipped into a folder,
  which starts faster. Unzip it and run `Simple Video Editor.exe`.

The app isn't code-signed, so Windows SmartScreen may say "Windows protected
your PC". Click **More info** and then **Run anyway**.

**Option 2: run it from this folder.** Install [Node.js](https://nodejs.org)
(the LTS version), then double-click:

- `start.cmd` to run the editor. The first start downloads its parts, which
  takes a minute.
- `build-windows.cmd` to make the `.exe` yourself. It ends up in the `dist`
  folder.

Nothing else needs installing: ffmpeg comes bundled.

## How to use it

1. **Add videos.** Drag video files onto the window or click **+ Add videos**.
   The first ones go straight onto the timeline; later ones wait in
   **Your videos** on the left.
2. **Trim.** Drag the left or right edge of a clip on the timeline. The preview
   shows the frame you're trimming to.
3. **Cut.** Click on a clip to move the red line there and press **S** (or
   **✂ Split**). Click the piece you don't want and press **Delete**.
4. **Fill gaps.** Deleting or shortening a clip leaves a gap so nothing else
   moves. Drag a video from the left (or from File Explorer) onto the gap to
   fill it. If the video is longer than the gap, the clips after it move along
   to make room. To get rid of a gap, click its **✕**.
5. **Rearrange.** Drag a clip to another spot on the timeline.
6. **Export.** Click **Export video**, pick a size and quality, and choose where
   to save the MP4.

Gaps you leave in export as black with no sound. Clips with a different shape
than the first one get black bars instead of being stretched.

| Key | Does |
| --- | --- |
| Space | Play or pause |
| S | Split the clip at the red line |
| Delete | Delete the selected clip and leave a gap (or close a selected gap) |
| Shift+Delete | Delete the selected clip and close the gap |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| ← / → | Step one frame (hold Shift for one second) |
| Home / End | Jump to the start / end |
| Ctrl+mouse wheel | Zoom the timeline |

Most videos (MP4, MOV, MKV, WebM) preview straight away. Older formats such as
AVI or WMV get a quick preview copy first; the export always reads your
original files, which are never changed.

## For developers

```
npm install
npm start          # run the editor
npm test           # timeline logic, ffmpeg parsing, and a real export
npm run dist       # build the Windows .exe and .zip into dist/
```

- `src/main.js`: window, file dialogs, and running ffmpeg.
- `src/ffmpeg.js`: everything about ffmpeg's command line and output.
- `src/renderer/timeline.js`: the timeline model (clips, gaps, and edits).
- `src/renderer/player.js`: previews the timeline with two video players.
- `src/renderer/app.js`: the rest of the interface.

The bundled ffmpeg comes from the
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) package and is GPL
licensed; its license file ships next to the binary in the built app.
