# ChatDrop

Local text and file transfer assistant, inspired by WeChat File Transfer.

## Features

- Password-protected web login
- Optional 30-day auto-login with rolling renewal
- Conversation list on the left, message/file stream on the right
- Send text, images, and any file
- Paste images from clipboard directly into the input box
- Store files on local disk and metadata in SQLite

## Requirements

- Node.js 24+

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Background Service

```bash
./chatdrop.sh start
./chatdrop.sh restart
./chatdrop.sh status
./chatdrop.sh logs
```

- PID file: `data/run/chatdrop.pid`
- Log file: `data/logs/chatdrop.log`

Default local config is in `config.yaml`:

- Password: `changeme`
- Files: `./data/files`
- Database: `./data/db/chatdrop.sqlite`

Change the password before exposing the service to any network.
