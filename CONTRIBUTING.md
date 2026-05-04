# Contributing to WinkTerm

First off, thanks for considering contributing! We welcome all kinds of contributions — bug reports, feature suggestions, documentation improvements, and code changes.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Ideas for First Contributions](#ideas-for-first-contributions)

## Code of Conduct

Please be respectful and constructive in all interactions. This project is a safe space for developers of all backgrounds.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/winkterm.git`
3. Set up the development environment (see below)
4. Create a branch: `git checkout -b feature/your-feature-name`

## Development Setup

### Prerequisites

- Python 3.12+
- Node.js 20+
- Docker (optional, for containerized testing)

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Run development server
python -m uvicorn backend.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

### Environment Variables

Copy `.env.example` to `.env` and fill in at least an API key:

```bash
cp .env.example .env
```

### Run Lint Checks

```bash
# Backend
cd backend
pip install ruff
ruff check .

# Frontend
cd frontend
npm run lint
```

## Project Structure

```
winkterm/
├── backend/
│   ├── agent/               # LangGraph agent
│   │   ├── core/            # Agent state, builder
│   │   ├── registry/        # Agent config (agents.yaml)
│   │   ├── prompts/         # System prompts
│   │   ├── tools/           # Tool implementations
│   │   └── factory.py       # Agent compilation
│   ├── terminal/            # PTY management
│   │   ├── pty_manager.py   # Shell process wrapper
│   │   ├── session_manager.py # Multi-session management
│   │   └── ws_handler.py    # WebSocket handling
│   ├── ssh/                 # SSH connections & file transfer
│   ├── api/                 # FastAPI routes
│   ├── config.py            # Application config
│   └── main.py              # Entry point
└── frontend/
    ├── src/
    │   ├── app/             # Next.js App Router
    │   ├── components/      # UI components
    │   ├── lib/             # Utilities, API client
    │   └── types/           # TypeScript types
    └── orval.config.ts      # API code generation
```

## Making Changes

1. **Keep changes focused** — one feature or fix per PR
2. **Write tests** for new functionality (backend tests in `backend/test/`, frontend in `frontend/__tests__/`)
3. **Run lint** before committing
4. **Update docs** if you change behavior or add features

## Pull Request Guidelines

- **Title**: Clear and descriptive (e.g., "Add tmux integration", "Fix WebSocket reconnection")
- **Description**: Explain what and why, including screenshots if UI changes
- **Linked issues**: Reference any related issues with `Closes #123`
- **Keep it small**: PRs under 300 lines are much easier to review
- **No unrelated changes**: Don't fix formatting you didn't break

### Review Process

1. CI must pass (lint, build, tests)
2. At least one maintainer reviews
3. Merge after approval (squash commits)

## Ideas for First Contributions

Here are some areas where we'd love help:

- **Tests**: The backend has minimal test coverage. Adding tests is high-impact.
- **Error handling**: Edge cases in PTY sessions and WebSocket reconnection
- **Agent tools**: Add tools for kubectl, docker, systemd, git operations
- **Themes**: Improve terminal color scheme and add theme switching
- **Docs**: Improve API documentation, add more examples
- **i18n**: Help translate prompts and UI strings
- **Monitoring**: Implement real Prometheus/Loki integration (currently mocked)

## Questions?

Open a [Discussion](https://github.com/Cznorth/winkterm/discussions) or ping us on the issue tracker. No question is too small!
