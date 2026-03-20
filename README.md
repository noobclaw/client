# NoobClaw — The world's first plug-and-play Web3 AI assistant!

<p align="center">
  <img src="public/logo.png" alt="NoobClaw" width="120">
</p>

<p align="center">
  <strong>Your Web3-native AI Agent — work, earn, and stay connected across the decentralized world.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <br>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Mobile-brightgreen?style=for-the-badge" alt="Platform">
  <br>
  <img src="https://img.shields.io/badge/Electron-40-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
</p>

<p align="center">
  English · <a href="README_zh.md">中文</a>
</p>

---

## What Is NoobClaw?

**NoobClaw** is a Web3-native AI Assistant built by [NoobClaw](https://www.noobclaw.com/). It is the world's first plug-and-play Web3 AI assistant, combining the power of an autonomous AI Agent with a full Web3 ecosystem — wallet integration, token economics, crypto market tracking, and decentralized identity — all in one desktop app. Use it and mine $NoobCoin along the way.

Tell NoobClaw what you need — analyze data, draft a report, create a video, search the web, send an email — and it gets it done. Connect your wallet to access the built-in AI service with no API key required, earn NoobCoin through usage and referrals, and stay on top of the Web3 world with real-time news, KOL tracking, job listings, and exchange discovery.

At its core is **Cowork mode**: the Agent executes tools, manipulates files, and runs commands in a local or sandboxed environment, all under your explicit approval. You stay in control; NoobClaw does the heavy lifting.

## Highlights

| | Feature | What It Means |
|---|---------|---------------|
| **Web3 Wallet** | Wallet-based auth, BNB payments, token balance, order management | No accounts, no passwords — connect your wallet and go |
| **NoobCoin Economy** | Earn tokens through usage, referrals, and airdrops | The more you use it, the more you earn |
| **Web3 Hub** | Crypto news feed, KOL tracking, Web3 job board, exchange directory | Your Web3 information center |
| **All-in-One AI Agent** | Data analysis, PPT, video, docs, web search, email | One Agent handles your entire daily workflow |
| **21 Built-in Skills** | Office docs, Playwright automation, Remotion video, canvas design, email, weather, and more | Rich out-of-the-box capabilities |
| **Skill Store** | Browse, install, and create community skills | Infinitely extensible |
| **Free AI Access** | Built-in NoobClaw AI with 1M free tokens for new users; all other features and skills are free; also supports OpenAI, DeepSeek, and other mainstream providers |
| **Local + Sandbox** | Run on your machine or in an isolated Alpine Linux VM | Speed when you want it, safety when you need it |
| **Scheduled Tasks** | Cron-based recurring tasks via conversation or GUI | Daily news, weekly reports, inbox cleanup — on autopilot |
| **Persistent Memory** | Auto-extracts preferences and facts from conversations | Gets smarter the more you use it |
| **Mobile via IM** | Telegram, Discord, DingTalk, Feishu (Lark) | Your Agent in your pocket |
| **MCP Integration** | stdio / SSE / HTTP Model Context Protocol servers | Plug in any external tool or data source |
| **Permission Gating** | Every sensitive tool call requires your approval | You're always in control |
| **Cross-Platform** | macOS (Intel + Apple Silicon), Windows, Linux, Mobile via IM | Works everywhere |
| **Local Data** | SQLite on-device storage | Your data never leaves your machine |

## How It Works

<p align="center">
  <img src="docs/res/architecture_en.png" alt="Architecture" width="500">
</p>

## Web3 Features

### Wallet & Payments

NoobClaw uses wallet-based authentication — no traditional accounts required. Connect your wallet to unlock the built-in AI service and manage your tokens.

- **Wallet Authentication** — Log in by connecting your Web3 wallet; auth token and wallet address are stored locally
- **BNB Payments** — Purchase AI usage credits with BNB; order lifecycle fully managed (pending → confirming → completed)
- **Token Balance** — Real-time balance display and refresh in the app
- **Order History** — Full payment history with filtering and search

### NoobCoin Token Economy

- **Earn NoobCoin** — Accumulate tokens through usage and engagement
- **Referral Rewards** — Invite friends and earn bonus tokens
- **Airdrops** — Claim airdrop rewards directly in the app
- **Lucky Bag** — Claim surprise token rewards

### Web3 Information Hub

The **Hot Topics** view and **Web3 Connection** panel keep you plugged into the decentralized world:

- **Crypto Ticker** — Live price icons for BTC, ETH, SOL, BNB, AVAX, DOT, ADA, DOGE, XRP
- **News Feed** — Curated Web3 news with category filtering and pagination
- **KOL Tracking** — Follow key opinion leaders in the crypto space
- **Web3 Jobs** — Aggregated listings from Web3.Career, CryptoJobs, DeJob
- **Exchange Directory** — Browse and visit cryptocurrency exchanges

### Events & Partners

Dedicated view for Web3 partnership announcements, community events, and ecosystem updates.

## Quick Start

### Prerequisites

- **Node.js** >= 24 < 25
- **npm**

### Install & Develop

```bash
# Clone the repository
git clone https://github.com/noobclaw-noobclaw/NoobClaw.git
cd noobclaw

# Install dependencies
npm install

# Start development (Vite dev server + Electron with hot reload)
npm run electron:dev
```

The dev server runs at `http://localhost:5175` by default.

### Production Build

```bash
# TypeScript compilation + Vite bundle
npm run build

# ESLint check
npm run lint
```

## Packaging & Distribution

Uses [electron-builder](https://www.electron.build/) to produce platform-specific installers. Output goes to `release/`.

```bash
# macOS
npm run dist:mac              # Universal .dmg (auto-detect)
npm run dist:mac:x64          # Intel only
npm run dist:mac:arm64        # Apple Silicon only
npm run dist:mac:universal    # Fat binary (both architectures)

# Windows (.exe NSIS installer)
npm run dist:win

# Linux (.AppImage & .deb)
npm run dist:linux
```

**Windows Python Runtime** — Windows builds bundle a portable Python runtime under `resources/python-win`. Skill-specific Python packages are installed on demand at runtime.

<details>
<summary>Offline / CI packaging options</summary>

- `NOOBCLAW_PORTABLE_PYTHON_ARCHIVE` — Local prebuilt runtime archive path (recommended for offline CI/CD)
- `NOOBCLAW_PORTABLE_PYTHON_URL` — Download URL for the prebuilt runtime archive
- `NOOBCLAW_WINDOWS_EMBED_PYTHON_VERSION` / `NOOBCLAW_WINDOWS_EMBED_PYTHON_URL` / `NOOBCLAW_WINDOWS_GET_PIP_URL` — Optional overrides for Windows-host bootstrap sources

</details>

## Supported AI Providers

Use the built-in **NoobClaw AI** service (wallet-based, no API key needed) or bring your own:

| Provider | Notable Models | API Format |
|----------|---------------|------------|
| **NoobClaw AI** (default) | GPT / Gemini / DeepSeek / Qwen / Minimax | OpenAI |
| OpenAI | GPT-5.2, GPT-5.2 Codex | OpenAI |
| Anthropic | Claude Sonnet 4.5/4.6, Claude Opus 4.6 | Anthropic |
| DeepSeek | DeepSeek Chat, DeepSeek Reasoner | Anthropic |
| Moonshot (Kimi) | Kimi K2.5 | Anthropic |
| Qwen (Alibaba) | Qwen 3.5 Plus, Qwen 3 Coder Plus | Anthropic |
| Zhipu (GLM) | GLM 5, GLM 4.7 | Anthropic |
| Gemini | Gemini 3 Pro, Gemini 3.1 Pro, Gemini 3 Flash | OpenAI |
| Minimax | MiniMax M2.5, M2.1 | Anthropic |
| Custom | Any OpenAI-compatible endpoint | Configurable |

## Skills

21 built-in skills covering productivity, creative, and automation scenarios:

| Skill | What It Does |
|-------|-------------|
| Exchange Skills | Crypto trading on major exchanges |
| web-search | Search the web for information |
| docx | Generate Word documents |
| xlsx | Create Excel spreadsheets |
| pptx | Build PowerPoint presentations |
| pdf | Parse, convert, and manipulate PDFs |
| remotion | Generate videos with Remotion |
| playwright | Automate web browsers with Playwright |
| canvas-design | Design posters and charts on canvas |
| frontend-design | Prototype frontend UI |
| develop-web-game | Rapid web game prototyping |
| scheduled-task | Create and manage scheduled tasks |
| create-plan | Project planning and task breakdown |
| weather | Weather information queries |
| local-tools | Local file and system operations |
| imap-smtp-email | Send and receive email via IMAP/SMTP |
| seedream | AI image generation |
| seedance | AI video generation |
| films-search | Movie and TV show discovery |
| music-search | Music discovery |
| technology-news-search | Tech news aggregation |
| skill-creator | Create your own custom skills |

**Skill Store** — Browse and install community-contributed skills, or publish your own.

## MCP Integration

Supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) for extending Agent capabilities:

| Transport | Use Case |
|-----------|----------|
| stdio | Local command-line MCP servers |
| SSE | Remote server-sent events |
| HTTP | Remote HTTP endpoints |

Built-in registry, custom server registration, and community marketplace included.

## Scheduled Tasks

Create recurring tasks via natural language or the GUI panel:

| Schedule Type | Example |
|---------------|---------|
| At | Run at a specific date/time |
| Interval | Every 30 minutes, every 2 hours |
| Cron | `0 9 * * 1-5` (weekdays at 9 AM) |

Results viewable on desktop or pushed to your phone via connected IM.

## IM Integration — Mobile Remote Control

Bridge the Agent to your IM. Send a message from your phone to remotely trigger task execution on the desktop.

| Platform | Protocol |
|----------|----------|
| Telegram | grammY Bot API |
| Discord | discord.js |
| DingTalk | DingTalk Stream |
| Feishu (Lark) | Lark SDK |

Configure the platform Token/Secret in Settings to get started.

## Persistent Memory

NoobClaw automatically learns your preferences from conversations and remembers them across sessions.

- **Auto Extraction** — Identifies personal info, preferences, and facts from natural conversation
- **Explicit Requests** — Say "remember that I prefer Markdown" for high-confidence storage
- **Manual Management** — Add, edit, or delete entries in the Memory panel

| Setting | Default |
|---------|---------|
| Memory | On |
| Auto Capture | On |
| Capture Strictness | Standard (Strict / Standard / Relaxed) |
| Max Injected Items | 12 (1–60) |

## Architecture

NoobClaw uses Electron's strict process isolation. All cross-process communication goes through IPC.

```
Main Process (src/main/main.ts)
├── Window lifecycle & SQLite persistence
├── CoworkRunner — Claude Agent SDK execution engine
├── OpenAI-compatible proxy — multi-provider API translation
├── IM Gateways — Telegram, Discord, DingTalk, Feishu
├── Scheduler — cron-based task execution
├── Skill Manager & MCP Server management
└── Security: context isolation ON, node integration OFF, sandbox ON

Preload Script (src/main/preload.ts)
└── contextBridge → window.electron API (cowork + electron namespaces)

Renderer Process (src/renderer/)
├── React 18 + Redux Toolkit + Tailwind CSS
├── Web3 wallet auth & token economy
├── All UI and business logic
└── IPC-only communication with main
```

### Directory Structure

```
src/
├── main/                           # Electron main process
│   ├── main.ts                     # Entry point, IPC handlers
│   ├── preload.ts                  # Security bridge
│   ├── sqliteStore.ts              # SQLite storage
│   ├── coworkStore.ts              # Session/message CRUD
│   ├── skillManager.ts             # Skill management
│   ├── im/                         # IM gateways
│   └── libs/
│       ├── coworkRunner.ts         # Agent SDK executor
│       ├── coworkVmRunner.ts       # Sandbox VM execution
│       ├── coworkSandboxRuntime.ts # Sandbox lifecycle
│       ├── coworkOpenAICompatProxy.ts # Multi-provider API proxy
│       └── coworkMemoryExtractor.ts # Memory extraction
│
├── renderer/                        # React frontend
│   ├── App.tsx                     # Root component
│   ├── types/                      # TypeScript definitions
│   ├── store/slices/               # Redux state slices
│   ├── services/
│   │   ├── noobclawAuth.ts        # Wallet authentication
│   │   ├── noobclawApi.ts         # Backend API (payments, tokens, referrals)
│   │   └── ...                    # Other services
│   └── components/
│       ├── cowork/                 # Cowork UI
│       ├── wallet/                 # Wallet & payment UI
│       ├── web3/                   # Web3 news, KOL, jobs, exchanges
│       ├── skills/                 # Skill management UI
│       ├── scheduledTasks/         # Scheduled task UI
│       ├── mcp/                    # MCP configuration UI
│       ├── im/                     # IM integration UI
│       └── Settings.tsx            # Settings panel
│
SKILLs/                              # Skill definitions
├── skills.config.json              # Skill enable/disable & ordering
└── ...                             # 21 built-in skills
```

## Security

| Layer | Mechanism |
|-------|-----------|
| Process Isolation | Context isolation ON, node integration OFF |
| Permission Gating | User approval required for all sensitive tool calls |
| Sandbox Execution | Optional Alpine Linux VM isolation |
| Content Security | HTML sandbox, DOMPurify, Mermaid strict mode |
| Workspace Boundaries | File operations restricted to the working directory |
| IPC Validation | All cross-process calls type-checked and sanitized |
| Wallet Auth | Decentralized identity — no password storage |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 40 |
| Frontend | React 18 + TypeScript 5 |
| Build | Vite 5 |
| Styling | Tailwind CSS 3 |
| State | Redux Toolkit |
| AI Engine | Claude Agent SDK (Anthropic) |
| Storage | sql.js (SQLite) |
| Markdown | react-markdown + remark-gfm + rehype-katex |
| Diagrams | Mermaid |
| Security | DOMPurify |
| IM | grammY · discord.js · dingtalk-stream · @larksuiteoapi/node-sdk |

## Development

- TypeScript strict mode, functional components + Hooks
- 2-space indentation, single quotes, semicolons
- Components: `PascalCase`; functions/variables: `camelCase`; Redux slices: `*Slice.ts`
- Tailwind CSS preferred; avoid custom CSS
- Commit format: `type: imperative summary` (e.g., `feat: add artifact toolbar`)
- Languages: Chinese, English, and multiple other languages — switch in Settings

## Contributing

1. Fork this repository
2. Create your feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m 'feat: add something'`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

Please include: a summary of changes, linked issue (if any), screenshots for UI changes, and notes on Electron-specific behavior.

## License

[MIT License](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=noobclaw-noobclaw/NoobClaw&type=date&legend=top-left)](https://www.star-history.com/#noobclaw-noobclaw/NoobClaw&type=date&legend=top-left)

---

Built and maintained by [NoobClaw](https://www.noobclaw.com/). Authors: Taylor / Chris. Based on OpenClaw / Lobsterai.
