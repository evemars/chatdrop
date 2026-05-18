const crypto = require("node:crypto");
const path = require("node:path");
const Database = require("better-sqlite3");

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
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

function mapMessage(row) {
  return {
    cursor: row.message_cursor,
    id: row.id,
    type: row.type,
    content: row.text_content,
    createdAt: row.created_at,
    attachment: row.attachment_id
      ? {
          id: row.attachment_id,
          originalName: normalizeUtf8Filename(row.original_name),
          storedName: row.stored_name,
          relativePath: row.relative_path,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          kind: row.kind,
        }
      : null,
  };
}

function createDatabase(config) {
  const dbPath = path.join(config.storage.dbDir, "chatdrop.sqlite");
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      last_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text', 'image', 'file')),
      text_content TEXT,
      attachment_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      remember_me INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations (updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
      ON messages (conversation_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
      ON auth_sessions (expires_at);
  `);

  const statements = {
    conversationCount: db.prepare("SELECT COUNT(*) AS count FROM conversations"),
    getConversation: db.prepare(`
      SELECT id, title, created_at, updated_at
      FROM conversations
      WHERE id = ?
    `),
    getConversationHead: db.prepare(`
      SELECT
        c.id AS conversation_id,
        c.updated_at,
        m.id AS last_message_id,
        m.rowid AS last_message_cursor,
        m.created_at AS last_message_created_at
      FROM conversations c
      LEFT JOIN messages m ON m.id = c.last_message_id
      WHERE c.id = ?
    `),
    listConversations: db.prepare(`
      SELECT
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        m.type AS last_message_type,
        m.text_content AS last_text_content,
        a.original_name AS last_file_name
      FROM conversations c
      LEFT JOIN messages m ON m.id = c.last_message_id
      LEFT JOIN attachments a ON a.id = m.attachment_id
      ORDER BY c.updated_at DESC, c.created_at DESC
    `),
    insertConversation: db.prepare(`
      INSERT INTO conversations (id, title, last_message_id, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?)
    `),
    updateConversationAfterMessage: db.prepare(`
      UPDATE conversations
      SET last_message_id = ?, updated_at = ?
      WHERE id = ?
    `),
    listMessagesPage: db.prepare(`
      SELECT
        m.rowid AS message_cursor,
        m.id,
        m.type,
        m.text_content,
        m.created_at,
        a.id AS attachment_id,
        a.original_name,
        a.stored_name,
        a.relative_path,
        a.mime_type,
        a.size_bytes,
        a.kind
      FROM messages m
      LEFT JOIN attachments a ON a.id = m.attachment_id
      WHERE m.conversation_id = ?
        AND (? IS NULL OR m.rowid < ?)
      ORDER BY m.rowid DESC
      LIMIT ?
    `),
    insertMessage: db.prepare(`
      INSERT INTO messages (id, conversation_id, type, text_content, attachment_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getMessageById: db.prepare(`
      SELECT
        m.rowid AS message_cursor,
        m.conversation_id,
        m.id,
        m.type,
        m.text_content,
        m.created_at,
        a.id AS attachment_id,
        a.original_name,
        a.stored_name,
        a.relative_path,
        a.mime_type,
        a.size_bytes,
        a.kind
      FROM messages m
      LEFT JOIN attachments a ON a.id = m.attachment_id
      WHERE m.id = ?
    `),
    getMessageForDelete: db.prepare(`
      SELECT
        m.rowid AS message_cursor,
        m.conversation_id,
        m.id,
        m.type,
        m.text_content,
        m.created_at,
        a.id AS attachment_id,
        a.original_name,
        a.stored_name,
        a.relative_path,
        a.absolute_path,
        a.mime_type,
        a.size_bytes,
        a.kind
      FROM messages m
      LEFT JOIN attachments a ON a.id = m.attachment_id
      WHERE m.conversation_id = ?
        AND m.id = ?
    `),
    insertAttachment: db.prepare(`
      INSERT INTO attachments (
        id,
        original_name,
        stored_name,
        relative_path,
        absolute_path,
        mime_type,
        size_bytes,
        kind,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getAttachment: db.prepare(`
      SELECT
        id,
        original_name,
        stored_name,
        relative_path,
        absolute_path,
        mime_type,
        size_bytes,
        kind,
        created_at
      FROM attachments
      WHERE id = ?
    `),
    getLatestMessageForConversation: db.prepare(`
      SELECT id, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `),
    updateConversationAfterDeletion: db.prepare(`
      UPDATE conversations
      SET last_message_id = ?, updated_at = ?
      WHERE id = ?
    `),
    deleteMessageById: db.prepare(`
      DELETE FROM messages
      WHERE id = ?
    `),
    deleteAttachmentById: db.prepare(`
      DELETE FROM attachments
      WHERE id = ?
    `),
    listConversationAttachments: db.prepare(`
      SELECT DISTINCT
        a.id,
        a.absolute_path
      FROM messages m
      INNER JOIN attachments a ON a.id = m.attachment_id
      WHERE m.conversation_id = ?
    `),
    deleteConversationById: db.prepare(`
      DELETE FROM conversations
      WHERE id = ?
    `),
    insertAuthSession: db.prepare(`
      INSERT INTO auth_sessions (token, remember_me, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getAuthSession: db.prepare(`
      SELECT token, remember_me, expires_at, created_at, last_seen_at
      FROM auth_sessions
      WHERE token = ?
    `),
    updateAuthSessionRolling: db.prepare(`
      UPDATE auth_sessions
      SET expires_at = ?, last_seen_at = ?
      WHERE token = ?
    `),
    touchAuthSession: db.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = ?
      WHERE token = ?
    `),
    deleteAuthSession: db.prepare("DELETE FROM auth_sessions WHERE token = ?"),
    deleteExpiredAuthSessions: db.prepare(`
      DELETE FROM auth_sessions
      WHERE remember_me = 1
        AND expires_at IS NOT NULL
        AND expires_at < ?
    `),
  };

  const createTextMessageTx = db.transaction((conversationId, content, createdAt) => {
    const messageId = createId("msg");
    statements.insertMessage.run(
      messageId,
      conversationId,
      "text",
      content,
      null,
      createdAt,
    );
    statements.updateConversationAfterMessage.run(messageId, createdAt, conversationId);
    return messageId;
  });

  const createAttachmentMessageTx = db.transaction(
    (conversationId, attachment, createdAt) => {
      const attachmentId = createId("att");
      const messageId = createId("msg");
      const messageType = attachment.kind === "image" ? "image" : "file";

      statements.insertAttachment.run(
        attachmentId,
        attachment.originalName,
        attachment.storedName,
        attachment.relativePath,
        attachment.absolutePath,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.kind,
        createdAt,
      );

      statements.insertMessage.run(
        messageId,
        conversationId,
        messageType,
        null,
        attachmentId,
        createdAt,
      );

      statements.updateConversationAfterMessage.run(messageId, createdAt, conversationId);
      return messageId;
    },
  );

  const deleteMessageTx = db.transaction((conversationId, messageId) => {
    const message = statements.getMessageForDelete.get(conversationId, messageId);
    if (!message) {
      return null;
    }

    statements.deleteMessageById.run(messageId);

    if (message.attachment_id) {
      statements.deleteAttachmentById.run(message.attachment_id);
    }

    const latestMessage = statements.getLatestMessageForConversation.get(conversationId);
    const conversation = statements.getConversation.get(conversationId);
    const nextUpdatedAt = latestMessage?.created_at ?? conversation.created_at;

    statements.updateConversationAfterDeletion.run(
      latestMessage?.id ?? null,
      nextUpdatedAt,
      conversationId,
    );

    return {
      messageId,
      conversationId,
      deletedAttachmentPath: message.absolute_path ?? null,
    };
  });

  const deleteConversationTx = db.transaction((conversationId) => {
    const conversation = statements.getConversation.get(conversationId);
    if (!conversation) {
      return null;
    }

    const attachments = statements.listConversationAttachments.all(conversationId);
    statements.deleteConversationById.run(conversationId);

    for (const attachment of attachments) {
      statements.deleteAttachmentById.run(attachment.id);
    }

    return {
      conversationId,
      deletedAttachmentPaths: attachments
        .map((attachment) => attachment.absolute_path)
        .filter(Boolean),
    };
  });

  if (statements.conversationCount.get().count === 0) {
    const now = Date.now();
    statements.insertConversation.run(
      createId("conv"),
      "File Transfer Assistant",
      now,
      now,
    );
  }

  return {
    dbPath,
    listConversations() {
      return statements.listConversations.all().map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastPreview:
          row.last_message_type === "text"
            ? row.last_text_content ?? ""
            : normalizeUtf8Filename(row.last_file_name),
      }));
    },
    getConversation(conversationId) {
      const row = statements.getConversation.get(conversationId);
      if (!row) {
        return null;
      }

      return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    getConversationHead(conversationId) {
      const row = statements.getConversationHead.get(conversationId);
      if (!row) {
        return null;
      }

      return {
        conversationId: row.conversation_id,
        updatedAt: row.updated_at,
        latestMessageId: row.last_message_id ?? null,
        latestMessageCursor: row.last_message_cursor ?? null,
        latestMessageCreatedAt: row.last_message_created_at ?? null,
      };
    },
    createConversation(title) {
      const safeTitle = (title || "New Conversation").trim() || "New Conversation";
      const now = Date.now();
      const id = createId("conv");
      statements.insertConversation.run(id, safeTitle, now, now);
      return this.getConversation(id);
    },
    listMessagesPage(conversationId, options = {}) {
      const pageSize = Math.max(1, Number(options.pageSize) || 20);
      const beforeCursor =
        options.beforeCursor === null || options.beforeCursor === undefined
          ? null
          : Number(options.beforeCursor);
      const rows = statements.listMessagesPage.all(
        conversationId,
        beforeCursor,
        beforeCursor,
        pageSize + 1,
      );
      const hasMoreHistory = rows.length > pageSize;
      const pageRows = hasMoreHistory ? rows.slice(0, pageSize) : rows;
      const messages = pageRows.reverse().map(mapMessage);

      return {
        messages,
        pagination: {
          pageSize,
          hasMoreHistory,
          nextBeforeCursor: messages[0]?.cursor ?? null,
        },
      };
    },
    getMessageById(messageId) {
      const row = statements.getMessageById.get(messageId);
      return row ? mapMessage(row) : null;
    },
    createTextMessage(conversationId, content) {
      const createdAt = Date.now();
      const messageId = createTextMessageTx(conversationId, content, createdAt);
      return this.getMessageById(messageId);
    },
    createAttachmentMessage(conversationId, attachment) {
      const createdAt = Date.now();
      const messageId = createAttachmentMessageTx(conversationId, attachment, createdAt);
      return this.getMessageById(messageId);
    },
    deleteMessage(conversationId, messageId) {
      return deleteMessageTx(conversationId, messageId);
    },
    deleteConversation(conversationId) {
      return deleteConversationTx(conversationId);
    },
    getAttachment(attachmentId) {
      const row = statements.getAttachment.get(attachmentId);
      if (!row) {
        return null;
      }

      return {
        id: row.id,
        originalName: normalizeUtf8Filename(row.original_name),
        storedName: row.stored_name,
        relativePath: row.relative_path,
        absolutePath: row.absolute_path,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        kind: row.kind,
        createdAt: row.created_at,
      };
    },
    createAuthSession({ token, rememberMe, expiresAt }) {
      const now = Date.now();
      statements.insertAuthSession.run(
        token,
        rememberMe ? 1 : 0,
        expiresAt ?? null,
        now,
        now,
      );
    },
    getAuthSession(token) {
      return statements.getAuthSession.get(token) ?? null;
    },
    renewAuthSession(token, expiresAt) {
      statements.updateAuthSessionRolling.run(expiresAt, Date.now(), token);
    },
    touchAuthSession(token) {
      statements.touchAuthSession.run(Date.now(), token);
    },
    deleteAuthSession(token) {
      statements.deleteAuthSession.run(token);
    },
    deleteExpiredAuthSessions() {
      statements.deleteExpiredAuthSessions.run(Date.now());
    },
  };
}

module.exports = {
  createDatabase,
};
