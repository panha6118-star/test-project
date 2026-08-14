const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { EdgeTTS } = require('node-edge-tts');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

const upload = multer();

const VOICE_MAP = {
  piseth: 'km-KH-PisethNeural',   // Male
  sreymom: 'km-KH-SreymomNeural'  // Female
};

function toRate(speed) {
  const percent = Math.round((Number(speed) - 1) * 100);
  return percent >= 0 ? `+${percent}%` : `${percent}%`;
}

function toPitch(pitch) {
  const percent = Math.round(Number(pitch) * 5);
  return percent >= 0 ? `+${percent}%` : `${percent}%`;
}

function parseSrt(srtText) {
  const blocks = srtText.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const items = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const timeLineIndex = lines.findIndex(l => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const [startStr, endStr] = timeLine.split('-->').map(s => s.trim());
    let textLines = lines.slice(timeLineIndex + 1).join(' ').trim();

    const parseTime = (str) => {
      const match = str.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      if (!match) return 0;
      const [, h, m, s, ms] = match;
      return (parseInt(h) * 3600) + (parseInt(m) * 60) + parseInt(s) + (parseInt(ms) / 1000);
    };

    if (textLines) {
      // Detect gender tag
      let forcedVoice = null;
      const lower = textLines.toLowerCase();

      if (
        lower.includes('[male]') || lower.includes('(male)') ||
        lower.includes('[m]') || lower.includes('(m)')
      ) {
        forcedVoice = 'piseth';
      } else if (
        lower.includes('[female]') || lower.includes('(female)') ||
        lower.includes('[f]') || lower.includes('(f)')
      ) {
        forcedVoice = 'sreymom';
      }

      // Remove the tag from the spoken text
      textLines = textLines
        .replace(/\[male\]|\(male\)|\[m\]|\(m\)/gi, '')
        .replace(/\[female\]|\(female\)|\[f\]|\(f\)/gi, '')
        .trim();

      const start = parseTime(startStr);
      const end = parseTime(endStr);

      items.push({
        start,
        end,
        duration: end - start,
        text: textLines,
        forcedVoice   // null = use default
      });
    }
  }

  return items;
}

async function generateSegment(text, voiceName, speed, pitch, outputPath) {
  const voice = VOICE_MAP[voiceName] || VOICE_MAP.piseth;
  const tts = new EdgeTTS({
    voice,
    lang: 'km-KH',
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    rate: toRate(speed),
    pitch: toPitch(pitch),
    timeout: 60000
  });

  await tts.ttsPromise(text, outputPath);
  return outputPath;
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

function generateSilence(durationSec, outputPath) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';

    const command = ffmpeg();

    if (isWindows) {
      // Windows: use lavfi (usually works with ffmpeg-static on Windows)
      command
        .input('anullsrc=r=24000:cl=mono')
        .inputFormat('lavfi');
    } else {
      // Linux / macOS / Render: use /dev/zero (no lavfi needed)
      command
        .input('/dev/zero')
        .inputFormat('s16le')
        .inputOptions(['-ar', '24000', '-ac', '1']);
    }

    command
      .duration(durationSec)
      .audioCodec('libmp3lame')
      .audioBitrate('48k')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

function adjustTempo(inputPath, outputPath, factor) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(`atempo=${factor.toFixed(5)}`)
      .audioCodec('libmp3lame')
      .audioBitrate('48k')
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}

function cleanup(files) {
  files.forEach(f => {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) {}
  });
}

app.post('/api/generate-srt', upload.none(), async (req, res) => {
  const jobId = uuidv4().slice(0, 8);
  const tempFiles = [];

  try {
    const {
      srtText,
      voiceName = 'piseth',
      speed = 1.0,
      pitch = 0,
      autoSync = 'true'
    } = req.body;

    if (!srtText) {
      return res.status(400).json({ message: 'Missing SRT text' });
    }

    const globalSpeed = Number(speed) || 1.0;
    const items = parseSrt(srtText);

    if (items.length === 0) {
      return res.status(400).json({ message: 'No valid SRT lines found' });
    }

    const lastEnd = items[items.length - 1].end;
    console.log(`[${jobId}] Target total duration: ${lastEnd.toFixed(3)}s`);

    // 1. Silent base track
    const baseSilencePath = path.join(TEMP_DIR, `${jobId}_base.mp3`);
    await generateSilence(lastEnd, baseSilencePath);
    tempFiles.push(baseSilencePath);

    // 2. Generate all speech segments
    const speechFiles = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Auto select voice by tag, otherwise use the default from request
      const selectedVoice = item.forcedVoice || voiceName;

      const segRawPath = path.join(TEMP_DIR, `${jobId}_raw_${i}.mp3`);
      await generateSegment(item.text, selectedVoice, globalSpeed, pitch, segRawPath);
      tempFiles.push(segRawPath);

      let finalSegPath = segRawPath;
      let speechDuration = await getAudioDuration(segRawPath);

      if ((autoSync === 'true' || autoSync === true) && speechDuration > item.duration + 0.03) {
        const factor = Math.min(speechDuration / item.duration, 1.95);
        const syncedPath = path.join(TEMP_DIR, `${jobId}_synced_${i}.mp3`);
        await adjustTempo(segRawPath, syncedPath, factor);
        tempFiles.push(syncedPath);
        finalSegPath = syncedPath;
        speechDuration = await getAudioDuration(syncedPath);
      }

      speechFiles.push({
        path: finalSegPath,
        start: item.start,
        duration: speechDuration
      });
    }

    // 3. Place every speech at exact start time
    const finalPath = path.join(TEMP_DIR, `${jobId}_combined.mp3`);
    tempFiles.push(finalPath);

    await new Promise((resolve, reject) => {
      const command = ffmpeg();
      command.input(baseSilencePath);
      speechFiles.forEach(sf => command.input(sf.path));

      let filterParts = [];
      let mixInputs = ['[0:a]'];

      speechFiles.forEach((sf, idx) => {
        const inputIdx = idx + 1;
        const delayMs = Math.round(sf.start * 1000);
        filterParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[s${idx}]`);
        mixInputs.push(`[s${idx}]`);
      });

      const mixFilter = `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[out]`;
      filterParts.push(mixFilter);

      command
        .complexFilter(filterParts.join(';'))
        .outputOptions(['-map', '[out]'])
        .audioCodec('libmp3lame')
        .audioBitrate('48k')
        .on('end', resolve)
        .on('error', reject)
        .save(finalPath);
    });

    const finalDuration = await getAudioDuration(finalPath);
    console.log(`[${jobId}] Final duration: ${finalDuration.toFixed(3)}s | Target: ${lastEnd.toFixed(3)}s`);

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': 'attachment; filename="srt_voiceover.mp3"',
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);

    stream.on('end', () => cleanup(tempFiles));
    stream.on('error', () => cleanup(tempFiles));

  } catch (error) {
    console.error(`[${jobId}] ERROR:`, error);
    cleanup(tempFiles);
    res.status(500).json({ message: error.message || 'Generation failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 SRT Studio running at http://localhost:${PORT}`);
});