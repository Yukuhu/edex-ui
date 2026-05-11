<p align="center">
  <br>
  <img alt="Logo" src="media/logo.png">
  <br><br>
  <a href="https://github.com/Yukuhu/edex-ui/blob/master/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Yukuhu/edex-ui.svg?style=popout"></a>
  <br><br><br>
</p>

**nDEX-UI** is a maintained fork of the archived [eDEX-UI](https://github.com/GitSquared/edex-ui) project — a fullscreen, cross-platform terminal emulator and system monitor that looks and feels like a sci-fi computer interface.

This fork modernizes the dependency stack (Electron, node-pty, @electron/remote, pdfjs-dist, geolite2-redist, systeminformation, …) so the app installs and runs on current Node and modern macOS / Linux / Windows, including Apple Silicon. There are no released binaries yet — the current state is the `master` branch, versioned `3.0.0-SNAPSHOT`.

---

## About this fork

The original eDEX-UI was archived in October 2021 and no longer builds on modern Node / current Electron. Everything user-visible — the TRON-inspired aesthetic, the terminal, the system monitor, the file browser — comes from upstream. This fork's contribution is keeping it alive on current tooling and patching the security advisories that have accumulated since archival.

If you're looking for the original, see [Acknowledgments](#acknowledgments) at the bottom of this README.

## Features
- Fully featured terminal emulator with tabs, colors, mouse events, and support for `curses` and `curses`-like applications.
- Real-time system (CPU, RAM, swap, processes) and network (GeoIP, active connections, transfer rates) monitoring.
- Full support for touch-enabled displays, including an on-screen keyboard.
- Directory viewer that follows the CWD (current working directory) of the terminal.
- Advanced customization using themes, on-screen keyboard layouts, CSS injections.
- Optional sound effects for maximum hollywood hacking vibe.

## Screenshots
![Default screenshot](media/screenshot_default.png)

_[neofetch](https://github.com/dylanaraps/neofetch) with the default "tron" theme & QWERTY keyboard_

![Blade screenshot](media/screenshot_blade.png)

_Browsing the config dir with [`ranger`](https://github.com/ranger/ranger), "blade" theme_

![Disrupted screenshot](media/screenshot_disrupted.png)

_[cmatrix](https://github.com/abishekvashok/cmatrix) on the experimental "tron-disrupted" theme with the user-contributed DVORAK keyboard_

![Horizon screenshot](media/screenshot_horizon.png)

_Editing source code with `nvim` on the custom [`horizon-full`](https://github.com/GitSquared/horizon-edex-theme) theme_

## Running from source

This is currently the only way to use nDEX-UI.

On macOS / Linux (you'll need the Xcode Command Line Tools on macOS):

```sh
git clone https://github.com/Yukuhu/edex-ui.git
cd edex-ui
npm run install-linux
npm run start
```

On Windows (start `cmd` or PowerShell **as administrator**):

```sh
git clone https://github.com/Yukuhu/edex-ui.git
cd edex-ui
npm run install-windows
npm run start
```

### Building

Due to native modules, you can only build targets for the host OS you're using.

```sh
npm install                # NOT install-linux or install-windows
npm run build-linux        # or build-windows or build-darwin
```

The script minifies the source, recompiles native dependencies, and writes distributable assets to `dist/`.

## Acknowledgments

nDEX-UI is a direct continuation of [**eDEX-UI**](https://github.com/GitSquared/edex-ui) by [**Gabriel "Squared" SAILLARD**](https://github.com/GitSquared), who built and maintained the project from 2017 through its archival in October 2021. The entire concept, design, sci-fi aesthetic, and the bulk of the source code in this repository are his work. All credit for what makes this project distinctive belongs to him and the original contributors.

This fork only modernizes the toolchain and dependencies so the project remains usable on current systems. Please consider checking out the original repository, its [contributors](https://github.com/GitSquared/edex-ui/graphs/contributors), and its [archival announcement](https://github.com/GitSquared/edex-ui/releases/tag/v2.2.8).

Original third-party credits also carry forward:
- [PixelyIon](https://github.com/PixelyIon) — Windows compatibility groundwork.
- [IceWolf](https://soundcloud.com/iamicewolf) — sound effects on v2.1.x and above.
- [Seena](https://github.com/seenaburns) — the [DEX-UI](https://github.com/seenaburns/dex-ui) prototype that inspired the original eDEX-UI.
- [Rob "Arscan" Scanlon](https://github.com/arscan) — the [ENCOM Globe](https://github.com/arscan/encom-globe), also TRON-inspired and distributed freely.
- The teams behind [xterm.js](https://github.com/xtermjs/xterm.js), [systeminformation](https://github.com/sebhildebrandt/systeminformation), and [SmoothieCharts](https://github.com/joewalnes/smoothie).

## Licensing

Licensed under the [GPLv3.0](https://github.com/Yukuhu/edex-ui/blob/master/LICENSE). The original copyrights are retained — see the LICENSE file.
