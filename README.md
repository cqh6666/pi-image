# pi-image

> Comprehensive image gallery, multimodal auto-delivery, remote URL caching, Token cost estimation, and macOS Quick Look for [Pi](https://pi.dev).

`pi-image` optimizes visual workflows in Pi. It intercepts local screenshots, pasted images, and remote HTTP/HTTPS image URLs, delivers them as multimodal attachments directly to vision models, and provides an interactive terminal gallery with macOS Quick Look.

---

## Features

- **Direct Multimodal Delivery**: Automatically extracts local and remote images and sends them as Base64 attachments. Replaces lengthy paths with clean `[image #1: filename]` tags, saving tool call turns.
- **Remote Image Caching**: Paste any `http://` or `https://` image link; `pi-image` downloads and caches it automatically with a 20MB guard and 8s timeout.
- **Interactive Terminal Gallery (`/image`)**: Browse session images with inline graphics or ASCII fallback. Navigate back and forth with `←` / `→` or `N` / `P`.
- **macOS Quick Look (`Space`)**: Press `Space` in the gallery to open a native, lightweight Quick Look preview window. Closes instantly without leaving your terminal.
- **System App Opening (`O`)**: Press `O` to launch the image in macOS Preview.app (or Linux `xdg-open` / Windows default viewer) for markup and editing.
- **Structured Meta Bar**: Displays format, resolution, aspect ratio, file size, and **estimated Vision Token costs** (calculated using GPT-4o / Claude 3.5 tile rules).
- **Strict Session Isolation**: Tracked images are scoped to the active session. Starting a new session (`/new`) resets state cleanly.

---

## Installation

### From Local Source

```bash
pi install /Users/chenqh114/githubProjects/pi-image
```

Or add the path directly to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/Users/chenqh114/githubProjects/pi-image"
  ]
}
```

### Try Without Installing

```bash
pi -e /Users/chenqh114/githubProjects/pi-image
```

---

## Usage

### 1. Attaching Images

- **Clipboard Paste**: Press `Ctrl+V` (or paste a path with `Cmd+V`).
- **Remote Images**: Paste a URL like `https://example.com/screenshot.png`.
- **Local Files**: Mention `./diagram.png` or `~/Desktop/mockup.jpg` in your prompt.

When submitted, `pi-image` attaches the images directly and condenses the prompt text to `[image #1: filename]`.

### 2. Gallery Commands

| Command | Action |
| :--- | :--- |
| `/image` | Open gallery previewing the latest image |
| `/image <number>` | Open gallery jumping to image #N (e.g. `/image 2`) |
| `/image list` | Open interactive selection list |
| `/image <path\|URL>` | Directly preview a local file or remote URL |
| `/image clear` | Clear tracked images for current session |
| `/image help` | Show usage summary |

### 3. Gallery Keyboard Shortcuts

When the gallery is open:

| Key | Action |
| :--- | :--- |
| `Space` | **Quick Look Preview** (macOS native floating HUD) |
| `O` | **Open in System App** (macOS Preview.app) |
| `→` / `↓` / `N` / `Tab` | Next image |
| `←` / `↑` / `P` / `Shift+Tab` | Previous image |
| `Esc` / `Q` | Close gallery and return to terminal |

---

## License

[MIT](LICENSE)
