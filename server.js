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
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const corsOptions = {
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'https://summarizer-012525-new-1b9u.vercel.app',
    'http://summarizer-012525-new-1b9u.vercel.app'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors(corsOptions));
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

/// 012925 new feature; compress audio using ffmpeg
/// SOURCE OPENAI COMMUNITY: SUGGESTED THIS CODE TO MAKE AUDIO FILE SMALLER ffmpeg -i audio.mp3 -vn -map_metadata -1 -ac 1 -c:a libopus -b:a 12k -application voip audio.ogg

const compressAudio = async (inputPath) => {
  try {
    const outputPath = `${inputPath.slice(0, -4)}_compressed.ogg`; // Change extension to .ogg
    
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,          // Input file
        '-vn',                    // No video
        '-map_metadata', '-1',    // Remove metadata
        '-ac', '1',               // Mono audio
        '-c:a', 'libopus',       // Use Opus codec
        '-b:a', '12k',           // 12kbps bitrate
        '-application', 'voip',   // VOIP optimization
        outputPath               // Output file
      ]);

      ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg stderr: ${data}`);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg process exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`FFmpeg process error: ${err.message}`));
      });
    });
  } catch (error) {
    console.error('Error in compressAudio:', error);
    throw error;
  }
};

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
    //const ytDlpPath = path.join(__dirname, 'bin', 'yt-dlp');
    const ytDlpPath = path.join(__dirname, 'bin', 'yt-dlp.exe');
    const cookiesPath = path.join(__dirname, 'cookie.txt');

    if (!fs.existsSync(ytDlpPath)) {
      throw new Error('yt-dlp not found in bin directory. Please download it first.');
    }

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
  try {
    // Handle cases where the URL might not have a protocol
    let workingUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      workingUrl = 'https://' + url;
    }

    const urlObj = new URL(workingUrl);
    const hostname = urlObj.hostname.toLowerCase();

    // Check if it's a valid YouTube domain
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname)) {
      return false;
    }

    // Extract video ID from query parameters for standard and mobile URLs
    const searchParams = urlObj.searchParams;
    const videoId = searchParams.get('v');

    // If we have a valid video ID from query parameters, it's valid
    if (videoId) {
      return true;
    }

    // Check for other valid path patterns
    const validPaths = ['/watch', '/shorts', '/v/', '/embed/'];
    const path = urlObj.pathname.toLowerCase();

    // Special case for youtu.be
    if (hostname === 'youtu.be' && path.length > 1) {
      return true;
    }

    return validPaths.some(validPath => path.startsWith(validPath));
  } catch {
    return false;
  }
};

// Main API endpoint for video summarization
app.post('/api/summarize', async (req, res) => {
  const { url } = req.body;
  let audioPath = null;
  let compressedAudioPath = null;

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

    // Download audio
    await downloadAudio(url, audioPath);

    // Verify file exists and has size
    const stats = await fs.promises.stat(audioPath);
    if (stats.size === 0) {
      throw new Error('Downloaded audio file is empty');
    }

    // Compress the audio file
    compressedAudioPath = await compressAudio(audioPath);

    // Transcribe compressed audio
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(compressedAudioPath),
      model: "whisper-1",
    });

    if (!transcription || !transcription.text) {
      throw new Error('Failed to transcribe audio');
    }

    // Generate summary
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are an expert summarization assistant tasked with providing a top-notch, comprehensive summary of video content. Your summaries are used in high-stakes national-level negotiations, so it is vital to include all important and relevant points. Ensure the summary is clear, concise, and leaves no critical information out. The user should feel confident that they have not missed anything after reading your summary."
        },
        {
          role: "user",
          content: `Summarize the following video content in a way that captures all critical details and relevant points. Focus on accuracy, clarity, and completeness. Provide a structured summary with key takeaways, important facts, and actionable insights. Content: ${transcription.text}`
        }
      ],
      temperature: 0.7,
      max_tokens: 5000
    });

    const summary = completion.choices[0].message.content;

    // Cleanup
    await cleanup(audioPath);
    if (compressedAudioPath) {
      await cleanup(compressedAudioPath);
    }

    res.json({ summary });

  } catch (error) {
    // Cleanup on error
    if (audioPath) await cleanup(audioPath);
    if (compressedAudioPath) await cleanup(compressedAudioPath);

    console.error('Error in /api/summarize:', error);
    res.status(500).json({
      error: error.message,
      type: error.name,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});
// New API endpoint for Q/A
app.post('/api/ask', async (req, res) => {
  const { question, context } = req.body;

  try {
    if (!question || !context) {
      throw new Error('Question and context are required');
    }

    // Generate answer using GPT-4
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are an expert assistant that provides accurate and detailed answers to questions based on the provided context."
        },
        {
          role: "user",
          content: `Context: ${context}\n\nQuestion: ${question}\n\nAnswer:`
        }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    const answer = completion.choices[0].message.content;

    // Send response
    res.json({ answer });

  } catch (error) {
    console.error('Error in /api/ask:', error);

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