# REA (Reverse Engineer Anything) workspace

This repository is configured to use [REA](https://github.com/morluto/rea) (`rea-agents`), an agent toolkit for reverse engineering apps, websites, protocols and native binaries.

## Claude Code (project plugin)

`.claude/settings.json` registers the official `morluto/rea` marketplace and enables the `rea@rea` plugin (MCP server + `reverse-engineer-anything` skill). When you open this repository in Claude Code and trust the folder, Claude Code prompts to install the plugin.

Manual install:

```bash
claude plugin marketplace add morluto/rea
claude plugin install rea@rea
```

Requires Node.js 22.x (>=22.23.4), 24.x (>=24.22.1) or 26.12.1+ on `PATH`.

## CLI (optional)

```bash
npm install --global rea-agents
rea setup
rea doctor
```

Native binary analysis needs Hopper, Ghidra, IDA or Kuna. Static JavaScript analysis needs no native engine. See the [installation guide](https://github.com/morluto/rea/blob/main/docs/installation.md).
