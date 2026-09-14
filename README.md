<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-ups

Automate UPS collection bookings via CLI-based browser automation (zero context overhead)

![Version](https://img.shields.io/badge/version-2.3.1-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **dry-run** — Fill through Date & Time, capture checkpoint artifacts, and stop before payment/submission
- **book** — Book a UPS collection after strict pre-submit validation
- **status** — Inspect the latest UPS booking attempt manifest without touching UPS
- **inspect-last** — Alias for `status`
- **reset-session** — Close the dedicated UPS Chrome CDP session

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-ups.git
cd claude-code-plugin-ups
cp config.template.json config.json  # fill in your credentials
npm --prefix scripts install
```

```bash
npm --prefix scripts run cli -- dry-run
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

| Command         | Purpose                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `dry-run`       | Fill through Date & Time, capture checkpoint artifacts, and stop before payment/submission |
| `book`          | Book a UPS collection after strict pre-submit validation                                   |
| `status`        | Inspect the latest UPS booking attempt manifest without touching UPS                       |
| `inspect-last`  | Alias for `status`                                                                         |
| `reset-session` | Close the dedicated UPS Chrome CDP session                                                 |

### book and dry-run Options

| Option                     | Description                                   | Default                         |
| -------------------------- | --------------------------------------------- | ------------------------------- |
| `--date YYYY-MM-DD`        | Collection date                               | Smart: tomorrow if after 1pm UK |
| `--packages N`             | Number of packages                            | 1                               |
| `--weight N`               | Weight in kg                                  | 10                              |
| `--earliest HH:MM`         | Earliest collection time                      | 12:00                           |
| `--latest HH:MM`           | Latest collection time                        | 18:00                           |
| `--door-code XXXXXXXXX`    | Door code without dashes                      | Fetched from Slack when omitted |
| `--forbid-date YYYY-MM-DD` | Block a date from smart or explicit selection | None                            |

## Usage Examples

```bash
npm --prefix scripts run cli -- dry-run --date 2026-01-07 --packages 2 --weight 25 --door-code 123456789
```

```bash
npm --prefix scripts run cli -- dry-run --door-code 123456789
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
