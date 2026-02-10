<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-ups

Automate UPS collection bookings via CLI-based browser automation (zero context overhead)

![Version](https://img.shields.io/badge/version-2.1.6-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **fill-form** — Login to UPS and fill collection form (does NOT submit)
- **screenshot** — Take screenshot of current page
- **submit** — Submit the filled form (after user confirmation)
- **reset** — Close browser and clear session

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-ups.git
cd claude-code-plugin-ups
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js fill-form
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Available Commands

### Available CLI Commands

| Command      | Purpose                                                 |
| ------------ | ------------------------------------------------------- |
| `fill-form`  | Login to UPS and fill collection form (does NOT submit) |
| `screenshot` | Take screenshot of current page                         |
| `submit`     | Submit the filled form (after user confirmation)        |
| `reset`      | Close browser and clear session                         |

### fill-form Options

| Option                  | Description              | Default                         |
| ----------------------- | ------------------------ | ------------------------------- |
| `--date YYYY-MM-DD`     | Collection date          | Smart: tomorrow if after 1pm UK |
| `--packages N`          | Number of packages       | 1                               |
| `--weight N`            | Weight in kg             | 10                              |
| `--earliest-time HH:MM` | Earliest collection time | 12:00                           |
| `--latest-time HH:MM`   | Latest collection time   | 18:00                           |
| `--door-code XXXXXXXXX` | Door code without dashes | Required                        |

### screenshot Options

| Option            | Description                  |
| ----------------- | ---------------------------- |
| `--filename NAME` | Screenshot filename          |
| `--full-page`     | Capture full scrollable page |

## Usage Examples

```bash
node scripts/dist/cli.js fill-form --date 2026-01-07 --packages 2 --weight 25 --door-code 123456789
```

```bash
node scripts/dist/cli.js fill-form --door-code 123456789
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
