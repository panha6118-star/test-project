# SRT Smart Voice Studio

Generate natural Khmer AI voice from SRT subtitles or plain text using Microsoft Edge TTS (free, no API key).

Supports two Khmer neural voices:
- **Piseth** (male) – `km-KH-PisethNeural`
- **Sreymom** (female) – `km-KH-SreymomNeural`

## Features

- Paste SRT or plain text
- Switch between male / female voice
- Tag system for mixed voices in one audio
- Adjust speed (0.5x – 2.0x) and pitch
- Auto Speed option
- Dark / Light mode
- Download combined MP3

## Requirements

- Node.js 18+ (recommended 20+)
- Internet connection (Edge TTS is online)

## Quick Start

```bash
cd srt-voice-studio
npm install
npm start