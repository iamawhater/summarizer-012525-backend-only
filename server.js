import express from 'express';
import cors from 'cors';
import youtubeDl from 'youtube-dl-exec';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const corsOptions = {
  origin: [
    process.env.FRONTEND_URL || 'https://summarizer-012525-new-8fev.vercel.app',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// app.use(cors(corsOptions));

app.use(cors())

app.use(express.json());

// Ensure temp directory exists
const tempDir = './temp';
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Enhanced multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'audio-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Enhanced cleanup function
const cleanup = async (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      console.log(`Successfully cleaned up file: ${filePath}`);
    }
  } catch (err) {
    console.error(`Error cleaning up file ${filePath}:`, err);
  }
};

// Improved audio download function using youtube-dl-exec
const downloadAudio = async (url, outputPath) => {
  try {
    const ytDlpPath = path.join(__dirname, 'bin', 'yt-dlp');
    //const ytDlpPath = path.join(__dirname, 'bin', 'yt-dlp.exe');
    const cookiesPath = path.join(__dirname, 'cookie.txt');
    
    if (!fs.existsSync(ytDlpPath)) {
      throw new Error('yt-dlp not found in bin directory. Please download it first.');
    }

    console.log('yt-dlp path:', ytDlpPath);

    console.log('cookies path:', cookiesPath); // Add this log

    const yt = youtubeDl.create(ytDlpPath);

    await yt(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: outputPath,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      cookies: cookiesPath,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0'
      ]
    });

    return outputPath;
  } catch (error) {
    console.error('Error in downloadAudio:', error);
    throw error;
  }
};

// Validate YouTube URL
const isValidYoutubeUrl = (url) => {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
  return pattern.test(url);
};

// Main API endpoint for video summarization
app.post('/api/summarize', async (req, res) => {
  const { url } = req.body;
  let audioPath = null;

  try {
    if (!url) {
      throw new Error('URL is required');
    }

    if (!isValidYoutubeUrl(url)) {
      throw new Error('Invalid YouTube URL');
    }

    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    audioPath = path.join(tempDir, `audio-${uniqueSuffix}.mp3`);

    // Download audio with improved error handling
    await downloadAudio(url, audioPath);

    // Verify file exists and has size
    const stats = await fs.promises.stat(audioPath);
    if (stats.size === 0) {
      throw new Error('Downloaded audio file is empty');
    }

    // Transcribe audio
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });

    if (!transcription || !transcription.text) {
      throw new Error('Failed to transcribe audio');
    }

    // Generate summary
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are an assistant that summarizes long texts." },
        { role: "user", content: `Summarize the following content: ${transcription.text}. Give 10 very important bullet points` }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    const summary = completion.choices[0].message.content;

    // Cleanup and send response
    await cleanup(audioPath);
    res.json({ summary });

  } catch (error) {
    if (audioPath) await cleanup(audioPath);
    
    console.error('Error in /api/summarize:', error);
    
    // Enhanced error response
    res.status(500).json({ 
      error: error.message,
      type: error.name,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    tempDirectory: fs.existsSync(tempDir)
  });
});

// Root route (Added)
app.get('/', (req, res) => {
  res.send('Welcome to the backend! Please use /api/summarize to summarize a video.');
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Temporary directory: ${tempDir}`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

export default app;
