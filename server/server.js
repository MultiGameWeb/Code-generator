import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("CRITICAL CONFIGURATION ERROR: GEMINI_API_KEY is missing from environment variables.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const MODEL_NAME = "gemini-3.8-flash";

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

const allowedOrigins = FRONTEND_ORIGIN
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS policy"));
    }
  }
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON request body."
    });
  }
  next(err);
});

const FILE_NAMES = {
  Python: "generated.py",
  JavaScript: "generated.js",
  TypeScript: "generated.ts",
  HTML: "index.html",
  CSS: "styles.css",
  Java: "Generated.java",
  C: "generated.c",
  "C++": "generated.cpp",
  "C#": "Generated.cs",
  PHP: "generated.php",
  SQL: "query.sql"
};

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Get Your Code Now API"
  });
});

app.post("/api/generate", async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        success: false,
        error: "Invalid request body."
      });
    }

    const { prompt, language } = req.body;

    if (prompt === undefined || prompt === null || typeof prompt !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Prompt is required and must be a string."
      });
    }

    const trimmedPrompt = prompt.trim();

    if (trimmedPrompt.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Prompt cannot be empty."
      });
    }

    const MAX_PROMPT_LENGTH = 2000;
    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `Prompt is too long. Maximum allowed length is ${MAX_PROMPT_LENGTH} characters.`
      });
    }

    if (language === undefined || language === null || typeof language !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Language is required and must be a string."
      });
    }

    const trimmedLanguage = language.trim();

    if (trimmedLanguage.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Language cannot be empty."
      });
    }

    const systemInstruction = `
You are an expert software developer and code generation assistant.

Generate clean, practical, correct source code.

Rules:
- Follow the user's requirement carefully.
- Generate code for the requested programming language.
- Prefer complete runnable code when practical.
- Include necessary imports.
- Use sensible naming and structure.
- Handle obvious edge cases.
- Do not invent unnecessary features.
- Return only source code.
- Do not return Markdown code fences.
- Do not add explanations before or after the code.
`.trim();

    const generationPrompt = `
Target programming language: ${trimmedLanguage}

User requirement:
${trimmedPrompt}
`.trim();

    const geminiResponse = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: generationPrompt,
      config: {
        systemInstruction
      }
    });

    let rawCodeText = geminiResponse.text ? geminiResponse.text.trim() : "";

    if (!rawCodeText) {
      return res.status(502).json({
        success: false,
        error: "Gemini returned an empty response."
      });
    }

    if (rawCodeText.startsWith("```")) {
      const firstNewlineIndex = rawCodeText.indexOf("\n");
      if (firstNewlineIndex !== -1) {
        rawCodeText = rawCodeText.substring(firstNewlineIndex + 1);
      }
      if (rawCodeText.endsWith("```")) {
        rawCodeText = rawCodeText.substring(0, rawCodeText.length - 3);
      }
      rawCodeText = rawCodeText.trim();
    }

    const filename = FILE_NAMES[trimmedLanguage] || "generated.code";

    return res.status(200).json({
      success: true,
      language: trimmedLanguage,
      code: rawCodeText,
      filename: filename
    });

  } catch (err) {
    console.error("Gemini Generation Error:", err.message || err);
    return res.status(500).json({
      success: false,
      error: "Unable to generate code right now. Please try again."
    });
  }
});

app.use((err, req, res, next) => {
  console.error("Server Error Exception:", err.message || err);
  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Get Your Code Now] Backend server running on port ${PORT}`);
});
