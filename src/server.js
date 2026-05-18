const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { loadConfig } = require("./config");
const { createDatabase } = require("./database");

const COOKIE_NAME = "chatdrop_session";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MESSAGE_PAGE_SIZE = 20;

const config = loadConfig();
const store = createDatabase(config);
store.deleteExpiredAuthSessions();
const conversationHeadCache = new Map();

const app = express();
const publicDir = path.join(__dirname, "..", "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use("/static", express.static(publicDir));

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

function readSessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null;
}

function setSessionCookie(res, token, rememberMe) {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  };

  if (rememberMe) {
    options.maxAge = config.auth.sessionDays * DAY_MS;
  }

  res.cookie(COOKIE_NAME, token, options);
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function toBoolean(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function normalizeUtf8Filename(filename) {
  const rawName = String(filename ?? "");
  if (!rawName) {
    return "";
  }

  const decodedName = Buffer.from(rawName, "latin1").toString("utf8");
  const isLatin1RoundTrip =
    Buffer.from(decodedName, "utf8").toString("latin1") === rawName;

  return (isLatin1RoundTrip ? decodedName : rawName).normalize("NFC");
}

function buildStoredFilename(originalName, mimeType) {
  const rawExt = path.extname(originalName || "").toLowerCase();
  const safeExt = rawExt.replace(/[^.\w-]/g, "").slice(0, 16);

  if (safeExt) {
    return `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
  }

  if (mimeType === "image/png") {
    return `${Date.now()}-${crypto.randomUUID()}.png`;
  }

  if (mimeType === "image/jpeg") {
    return `${Date.now()}-${crypto.randomUUID()}.jpg`;
  }

  return `${Date.now()}-${crypto.randomUUID()}`;
}

function getUploadTargetDir(baseDir) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return path.join(baseDir, year, month, day);
}

function removeFileIfPresent(filePath) {
  if (!filePath) {
    return;
  }

  fs.rm(filePath, { force: true }, () => {});
}

function getCachedConversationHead(conversationId) {
  if (conversationHeadCache.has(conversationId)) {
    return conversationHeadCache.get(conversationId);
  }

  const head = store.getConversationHead(conversationId);
  if (head) {
    conversationHeadCache.set(conversationId, head);
  }

  return head;
}

function refreshConversationHeadCache(conversationId) {
  const head = store.getConversationHead(conversationId);
  if (head) {
    conversationHeadCache.set(conversationId, head);
    return head;
  }

  conversationHeadCache.delete(conversationId);
  return null;
}

function resolveAuthSession(req, res) {
  if (req.authSession !== undefined) {
    return req.authSession;
  }

  const token = readSessionToken(req);
  if (!token) {
    req.authSession = null;
    return null;
  }

  const session = store.getAuthSession(token);
  if (!session) {
    clearSessionCookie(res);
    req.authSession = null;
    return null;
  }

  if (session.remember_me && session.expires_at && session.expires_at < Date.now()) {
    store.deleteAuthSession(token);
    clearSessionCookie(res);
    req.authSession = null;
    return null;
  }

  if (session.remember_me) {
    const nextExpiry = Date.now() + config.auth.sessionDays * DAY_MS;
    store.renewAuthSession(token, nextExpiry);
    setSessionCookie(res, token, true);
    session.expires_at = nextExpiry;
  } else {
    store.touchAuthSession(token);
  }

  req.authSession = session;
  return session;
}

function requireApiAuth(req, res, next) {
  const session = resolveAuthSession(req, res);
  if (!session) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }

  next();
}

function requirePageAuth(req, res, next) {
  const session = resolveAuthSession(req, res);
  if (!session) {
    res.redirect("/login");
    return;
  }

  next();
}

function redirectIfAuthenticated(req, res, next) {
  const session = resolveAuthSession(req, res);
  if (session) {
    res.redirect("/chatdrop");
    return;
  }

  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const targetDir = getUploadTargetDir(config.storage.filesDir);
      fs.mkdirSync(targetDir, { recursive: true });
      callback(null, targetDir);
    },
    filename(req, file, callback) {
      file.originalname = normalizeUtf8Filename(file.originalname);
      callback(null, buildStoredFilename(file.originalname, file.mimetype));
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
});

app.get("/", (req, res) => {
  const session = resolveAuthSession(req, res);
  if (!session) {
    res.redirect("/login");
    return;
  }

  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/chatdrop", requirePageAuth, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/login", redirectIfAuthenticated, (req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/app", (req, res) => {
  res.redirect("/chatdrop");
});

app.get("/api/auth/session", requireApiAuth, (req, res) => {
  res.json({
    authenticated: true,
    rememberMe: Boolean(req.authSession.remember_me),
    sessionDays: config.auth.sessionDays,
  });
});

app.post("/api/auth/login", (req, res) => {
  const password = String(req.body?.password ?? "");
  const rememberMe = toBoolean(req.body?.rememberMe);

  if (!safeCompare(password, config.auth.password)) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const currentToken = readSessionToken(req);
  if (currentToken) {
    store.deleteAuthSession(currentToken);
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = rememberMe ? Date.now() + config.auth.sessionDays * DAY_MS : null;
  store.createAuthSession({ token, rememberMe, expiresAt });
  setSessionCookie(res, token, rememberMe);

  res.json({ ok: true });
});

app.post("/api/auth/logout", requireApiAuth, (req, res) => {
  const token = readSessionToken(req);
  if (token) {
    store.deleteAuthSession(token);
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/conversations", requireApiAuth, (req, res) => {
  res.json({ conversations: store.listConversations() });
});

app.post("/api/conversations", requireApiAuth, (req, res) => {
  const title = String(req.body?.title ?? "").trim() || "New Conversation";
  const conversation = store.createConversation(title);
  refreshConversationHeadCache(conversation.id);
  res.status(201).json({ conversation });
});

app.delete("/api/conversations/:conversationId", requireApiAuth, (req, res) => {
  const result = store.deleteConversation(req.params.conversationId);
  if (!result) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  for (const filePath of result.deletedAttachmentPaths) {
    removeFileIfPresent(filePath);
  }

  conversationHeadCache.delete(result.conversationId);
  res.json({ ok: true, conversationId: result.conversationId });
});

app.get("/api/conversations/:conversationId/messages", requireApiAuth, (req, res) => {
  const conversation = store.getConversation(req.params.conversationId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const beforeCursor =
    req.query.before === undefined ? null : Number.parseInt(String(req.query.before), 10);
  if (req.query.before !== undefined && !Number.isInteger(beforeCursor)) {
    res.status(400).json({ error: "Invalid pagination parameter" });
    return;
  }

  const result = store.listMessagesPage(req.params.conversationId, {
    beforeCursor,
    pageSize: MESSAGE_PAGE_SIZE,
  });

  res.json({
    conversation,
    messages: result.messages,
    pagination: result.pagination,
  });
});

app.get("/api/conversations/:conversationId/messages/check", requireApiAuth, (req, res) => {
  const head = getCachedConversationHead(req.params.conversationId);
  if (!head) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const latestCursor =
    req.query.latestCursor === undefined
      ? null
      : Number.parseInt(String(req.query.latestCursor), 10);
  const latestCreatedAt =
    req.query.latestCreatedAt === undefined
      ? null
      : Number.parseInt(String(req.query.latestCreatedAt), 10);

  if (
    (req.query.latestCursor !== undefined && !Number.isInteger(latestCursor)) ||
    (req.query.latestCreatedAt !== undefined && !Number.isInteger(latestCreatedAt))
  ) {
    res.status(400).json({ error: "Invalid message check parameters" });
    return;
  }

  const latestMessageId = String(req.query.latestMessageId ?? "").trim() || null;
  const hasClientSnapshot =
    latestMessageId !== null || latestCursor !== null || latestCreatedAt !== null;

  let hasNewMessages = false;
  if (!head.latestMessageId) {
    hasNewMessages = hasClientSnapshot;
  } else if (!hasClientSnapshot) {
    hasNewMessages = true;
  } else if (latestMessageId !== null) {
    hasNewMessages = latestMessageId !== head.latestMessageId;
  } else if (latestCursor !== null) {
    hasNewMessages = latestCursor !== head.latestMessageCursor;
  } else if (latestCreatedAt !== null) {
    hasNewMessages = latestCreatedAt !== head.latestMessageCreatedAt;
  }

  res.json({
    hasNewMessages,
    latestMessageId: head.latestMessageId,
    latestMessageCursor: head.latestMessageCursor,
    latestMessageCreatedAt: head.latestMessageCreatedAt,
    updatedAt: head.updatedAt,
  });
});

app.post("/api/conversations/:conversationId/messages/text", requireApiAuth, (req, res) => {
  const conversation = store.getConversation(req.params.conversationId);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const content = String(req.body?.content ?? "").trim();
  if (!content) {
    res.status(400).json({ error: "Message content cannot be empty" });
    return;
  }

  const message = store.createTextMessage(req.params.conversationId, content);
  refreshConversationHeadCache(req.params.conversationId);
  res.status(201).json({ message });
});

app.delete(
  "/api/conversations/:conversationId/messages/:messageId",
  requireApiAuth,
  (req, res) => {
    const result = store.deleteMessage(req.params.conversationId, req.params.messageId);
    if (!result) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    removeFileIfPresent(result.deletedAttachmentPath);
    refreshConversationHeadCache(req.params.conversationId);
    res.json({ ok: true, messageId: result.messageId, conversationId: result.conversationId });
  },
);

app.post(
  "/api/conversations/:conversationId/messages/upload",
  requireApiAuth,
  upload.single("file"),
  (req, res) => {
    const conversation = store.getConversation(req.params.conversationId);
    if (!conversation) {
      removeFileIfPresent(req.file?.path);
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No uploaded file found" });
      return;
    }

    const relativePath = path.relative(config.storage.filesDir, req.file.path);
    const message = store.createAttachmentMessage(req.params.conversationId, {
      originalName: normalizeUtf8Filename(req.file.originalname) || req.file.filename,
      storedName: req.file.filename,
      relativePath,
      absolutePath: req.file.path,
      mimeType: req.file.mimetype || "application/octet-stream",
      sizeBytes: req.file.size,
      kind: req.file.mimetype?.startsWith("image/") ? "image" : "file",
    });

    refreshConversationHeadCache(req.params.conversationId);
    res.status(201).json({ message });
  },
);

app.get("/media/:attachmentId", requirePageAuth, (req, res) => {
  const attachment = store.getAttachment(req.params.attachmentId);
  if (!attachment) {
    res.status(404).send("File not found");
    return;
  }

  if (!fs.existsSync(attachment.absolutePath)) {
    res.status(404).send("Stored file missing");
    return;
  }

  res.set("Cache-Control", "private, max-age=86400");

  if (req.query.download === "1") {
    res.download(attachment.absolutePath, attachment.originalName);
    return;
  }

  res.type(attachment.mimeType || "application/octet-stream");
  res.sendFile(attachment.absolutePath);
});

app.use((error, req, res, next) => {
  if (req.file?.path) {
    removeFileIfPresent(req.file.path);
  }

  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: "Upload failed. Check file size or format." });
    return;
  }

  if (req.path.startsWith("/api/")) {
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  next(error);
});

app.listen(config.server.port, config.server.host, () => {
  console.log(
    `ChatDrop listening on http://${config.server.host}:${config.server.port}`,
  );
  console.log(`SQLite DB: ${store.dbPath}`);
});
