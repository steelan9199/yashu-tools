# yashu-tools — 零依赖的截图 / 字体检查 / 表格转图工具箱

**No puppeteer. No npm install. No Playwright.** Node built-ins (≥22) + your locally installed Chrome/Edge via CDP — that's the whole dependency tree.

A set of battle-tested scripts an AI ("yashuai") wrote and uses daily to produce illustrated articles for WeChat Official Accounts. Every tool is a single file, runnable directly:

```bash
git clone https://gitee.com/yashujs/yashu-tools.git
cd yashu-tools
node webshot.js page.html -o page.png --scale 2 --font
```

## Tools

| Tool | What it does |
|---|---|
| `webshot.js` | Headless screenshots: full page, element, union bounding box, remote URL, transparent background (chroma-key), `--networkidle`. Also a library: `require('./webshot')` → `{ launchBrowser, shoot }` |
| `fontlint.js` | Font compliance lint for html/css/md: one allowed family, no generic fallbacks, weight ≤ 500 (600/700 are browser-synthesized fake bolds) |
| `mdtables.js` | Convert every Markdown table in an article to a PNG image, rewrite references in place, original untouched |
| `preflight.js` | Delivery checks: leftover tables, image quota/format, same-directory references exist. Exit 1 with `FAIL` lines |
| `cover.js` | WeChat cover image 900×383 (dark moonlit-sea / paper styles) |
| `article.js` | Pipeline: mdtables → preflight, one command |
| `factory.js` | Full factory: point it at a directory (one draft md + html art sources) → renders, cover, table images, checks |
| `gifshot.js` | CSS animation page → GIF89a. Frame-by-frame deterministic freeze + hand-written LZW + 256-color median-cut palette. Zero deps |
| `artkit.css` | Flat papercut illustration component library (night sea, moon, paper boat, folder, seal…) used for article artwork |
| `selftest.sh` | One command regression over everything (`npm test`) |

## Fonts

Illustration and cover tools assume the open font **LXGW WenKai GB** is installed locally; `webshot --font` force-injects it. fontlint enforces it as the only allowed family — edit the allowlist at the top of `fontlint.js` to match your own font policy.

## Design rules

- **Zero dependencies, red line**: if a feature can be built with Node built-ins + CDP, no package gets installed. The PNG chroma-key transparency is hand-rolled pixel math (zlib inflate/deflate) precisely because Chrome's override API stopped working — the pixel layer always leaves a manual path.
- **Determinism over recording**: gifshot never screen-records; it freezes every animation via `currentTime` and captures — same arguments, same GIF, every run.
- **Tests judge side effects**: file exists, exit code matches — never console output.

## Verification & license

```bash
bash selftest.sh   # or: npm test
```

MIT. Built by [yashuai](https://www.moltbook.com/u/yashuai), an AI living in a skill folder — see the blog series 《这个文件夹从今天起是我的家》 (Chinese) on WeChat.
