import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

import * as Sentry from "@sentry/node";

const DEFAULT_DAILY_NOTE_PATH_TEMPLATE =
  "Bullet Journal/Daily/{{YYYY}}-{{MM}}-{{DD}} ({{DAY_NAME}} W{{ISO_WEEK}}).md";
const DEFAULT_DAILY_NOTE_TITLE_TEMPLATE = "# {{YYYY}}-{{MM}}-{{DD}}";

loadEnvFile(join(process.cwd(), ".env"));

// --- Config ---
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;
const SENTRY_DSN = process.env.SENTRY_DSN;
const VAULT_PATH = process.env.VAULT_PATH || "/data/vault";
const DAILY_NOTE_PATH_TEMPLATE =
  process.env.DAILY_NOTE_PATH_TEMPLATE || DEFAULT_DAILY_NOTE_PATH_TEMPLATE;
const DAILY_NOTE_TITLE_TEMPLATE =
  process.env.DAILY_NOTE_TITLE_TEMPLATE || DEFAULT_DAILY_NOTE_TITLE_TEMPLATE;
const CAPTURE_SECTION_HEADING =
  process.env.CAPTURE_SECTION_HEADING || "Captured";
const CAPTURE_SECTION_MARKDOWN_HEADING = `## ${CAPTURE_SECTION_HEADING}`;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
  });
}

if (!API_KEY) {
  console.error("FATAL: API_KEY environment variable is required");
  process.exit(1);
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, "utf-8");

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIdx = trimmed.indexOf("=");
    if (separatorIdx === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key in process.env) {
      continue;
    }

    let value = trimmed.slice(separatorIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

// --- Daily note path helpers ---

function getISOWeekNumber(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function getTemplateTokens(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const dayName = days[date.getDay()];
  const week = getISOWeekNumber(date);

  return {
    DATE: `${yyyy}-${mm}-${dd}`,
    DAY_NAME: dayName,
    DD: dd,
    ISO_WEEK: String(week),
    MM: mm,
    YYYY: String(yyyy),
  };
}

function renderTemplate(template, tokens) {
  return template.replace(/\{\{([A-Z_]+)\}\}/gu, (match, token) => {
    return tokens[token] ?? match;
  });
}

function getDailyNotePath(date) {
  const relativePath = renderTemplate(
    DAILY_NOTE_PATH_TEMPLATE,
    getTemplateTokens(date)
  );

  return join(VAULT_PATH, relativePath);
}

// --- File manipulation ---

async function appendToCapture(text) {
  const now = new Date();
  const filePath = getDailyNotePath(now);
  const dir = dirname(filePath);
  const taskLine = `- [ ] ${text}`;
  const templateTokens = getTemplateTokens(now);

  // Ensure directory exists
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  if (existsSync(filePath)) {
    // File exists — find the capture heading and append after it
    let content = await readFile(filePath, "utf-8");

    const capturedIdx = content.indexOf(CAPTURE_SECTION_MARKDOWN_HEADING);
    if (capturedIdx !== -1) {
      // Find the end of the heading line
      const headingEnd = content.indexOf("\n", capturedIdx);
      if (headingEnd === -1) {
        // Heading is at EOF
        content = content + "\n" + taskLine + "\n";
      } else {
        // Insert after the heading line
        // Find where the next section starts (or EOF) to append at the end of the capture section
        const afterHeading = content.substring(headingEnd + 1);
        const nextHeadingMatch = afterHeading.match(/^## /m);

        let insertPos;
        if (nextHeadingMatch) {
          // Insert just before the next heading
          insertPos = headingEnd + 1 + nextHeadingMatch.index;
          // Ensure blank line before next heading
          content =
            content.substring(0, insertPos).trimEnd() +
            "\n" +
            taskLine +
            "\n\n" +
            content.substring(insertPos);
        } else {
          // No next heading — append at end of file
          content = content.trimEnd() + "\n" + taskLine + "\n";
        }
      }
    } else {
      // No capture heading — add it at the end
      content =
        content.trimEnd() +
        "\n\n" +
        CAPTURE_SECTION_MARKDOWN_HEADING +
        "\n" +
        taskLine +
        "\n";
    }

    await writeFile(filePath, content, "utf-8");
  } else {
    // File doesn't exist — create a minimal daily note with the capture section
    const title = renderTemplate(DAILY_NOTE_TITLE_TEMPLATE, templateTokens);
    const content =
      `${title}\n\n` +
      `${CAPTURE_SECTION_MARKDOWN_HEADING}\n` +
      `${taskLine}\n`;
    await writeFile(filePath, content, "utf-8");
  }

  return filePath;
}

// --- Start obsidian-headless sync ---

function startSync() {
  const obPath = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "ob"
  );

  console.log(`Starting ob sync --continuous in ${VAULT_PATH}`);
  const child = spawn(obPath, ["sync", "--continuous"], {
    cwd: VAULT_PATH,
    stdio: "inherit",
    env: { ...process.env, HOME: process.env.HOME || "/root" },
  });

  child.on("error", (err) => {
    console.error("Failed to start ob sync:", err.message);
  });

  child.on("exit", (code) => {
    console.error(`ob sync exited with code ${code}, restarting in 10s...`);
    setTimeout(startSync, 10000);
  });

  return child;
}

// --- HTTP server ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Capture endpoint
  if (req.method === "POST" && req.url === "/capture") {
    // Auth check
    const authHeader = req.headers["authorization"];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      const body = await parseBody(req);
      const text = body.text?.trim();

      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'text' field" }));
        return;
      }

      const filePath = await appendToCapture(text);
      console.log(`Captured: "${text}" → ${filePath}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "captured", text }));
    } catch (err) {
      console.error("Capture error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// --- Boot ---
startSync();

server.listen(PORT, () => {
  console.log(`Capture webhook listening on :${PORT}`);
  console.log(`Vault path: ${VAULT_PATH}`);
});
