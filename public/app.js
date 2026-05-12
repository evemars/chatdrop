const state = {
  conversations: [],
  messages: [],
  activeConversationId: null,
  busy: false,
  hasMoreHistory: false,
  nextBeforeCursor: null,
  historyLoadVisible: false,
  loadingHistory: false,
};

const conversationList = document.getElementById("conversationList");
const conversationTitle = document.getElementById("conversationTitle");
const messageList = document.getElementById("messageList");
const composerForm = document.getElementById("composerForm");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const uploadButton = document.getElementById("uploadButton");
const fileInput = document.getElementById("fileInput");
const statusBar = document.getElementById("statusBar");
const newConversationButton = document.getElementById("newConversationButton");
const refreshMessagesButton = document.getElementById("refreshMessagesButton");
const logoutButton = document.getElementById("logoutButton");
const isMacPlatform =
  navigator.userAgentData?.platform === "macOS" ||
  /Mac|iPhone|iPad/.test(navigator.platform);
const MESSAGE_POLL_INTERVAL_MS = 5000;
let latestMessagePollHandle = null;
let latestMessagePollInFlight = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatListTime(timestamp) {
  if (!timestamp) {
    return "";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMessageTime(timestamp) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(size) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(size || 0);
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : null;

  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("登录已失效");
  }

  if (!response.ok) {
    throw new Error(payload?.error || "请求失败");
  }

  return payload;
}

function setBusy(nextBusy) {
  state.busy = nextBusy;
  sendButton.disabled = nextBusy;
  uploadButton.disabled = nextBusy;
}

function setStatus(message = "") {
  statusBar.textContent = message;
}

function getLatestLoadedMessage() {
  return state.messages.at(-1) ?? null;
}

function isNearBottom() {
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight <= 32;
}

function resetActiveConversationView() {
  state.activeConversationId = null;
  state.messages = [];
  state.hasMoreHistory = false;
  state.nextBeforeCursor = null;
  state.historyLoadVisible = false;
  state.loadingHistory = false;
  conversationTitle.textContent = "暂无会话";
  window.location.hash = "";
  renderMessages();
}

function syncHistoryLoaderVisibility() {
  state.historyLoadVisible = state.hasMoreHistory && messageList.scrollTop <= 8;
  const loader = document.getElementById("loadHistoryButton");
  if (!loader) {
    return;
  }

  loader.closest(".history-loader")?.classList.toggle(
    "history-loader--hidden",
    !state.historyLoadVisible,
  );
}

function getActiveConversation() {
  return state.conversations.find(
    (conversation) => conversation.id === state.activeConversationId,
  );
}

function applyLatestMessagesPayload(payload, options = {}) {
  const { preserveLoadedHistory = false, stickToBottom = false } = options;
  const previousScrollTop = messageList.scrollTop;
  const previousHasMoreHistory = state.hasMoreHistory;
  const oldestLatestCursor = payload.messages[0]?.cursor ?? null;
  const preservedOlderMessages =
    preserveLoadedHistory && oldestLatestCursor !== null
      ? state.messages.filter((message) => message.cursor < oldestLatestCursor)
      : [];
  const mergedMessages = [...preservedOlderMessages, ...payload.messages];

  state.messages = mergedMessages;
  state.hasMoreHistory =
    preservedOlderMessages.length > 0
      ? previousHasMoreHistory
      : Boolean(payload.pagination?.hasMoreHistory);
  state.nextBeforeCursor =
    mergedMessages[0]?.cursor ?? payload.pagination?.nextBeforeCursor ?? null;
  state.historyLoadVisible = false;
  state.loadingHistory = false;
  conversationTitle.textContent = payload.conversation.title;
  renderMessages({ stickToBottom });

  if (!stickToBottom) {
    messageList.scrollTop = previousScrollTop;
    syncHistoryLoaderVisibility();
  }
}

function renderConversationList() {
  if (state.conversations.length === 0) {
    conversationList.innerHTML =
      '<div class="empty-state">还没有会话，先创建一个。</div>';
    return;
  }

  conversationList.innerHTML = state.conversations
    .map((conversation) => {
      const isActive = conversation.id === state.activeConversationId;
      return `
        <div class="conversation-item ${isActive ? "active" : ""}">
          <button
            type="button"
            class="conversation-select"
            data-id="${conversation.id}"
          >
            <div class="conversation-item-title">${escapeHtml(conversation.title)}</div>
            <div class="conversation-item-preview">
              ${escapeHtml(conversation.lastPreview || "暂无内容")}
            </div>
            <div class="conversation-item-time">
              ${escapeHtml(formatListTime(conversation.updatedAt))}
            </div>
          </button>
          <button
            type="button"
            class="delete-chip conversation-delete-button"
            data-delete-conversation-id="${conversation.id}"
            aria-label="删除会话"
          >
            删除
          </button>
        </div>
      `;
    })
    .join("");

  for (const button of conversationList.querySelectorAll("[data-id]")) {
    button.addEventListener("click", () => {
      void selectConversation(button.dataset.id);
    });
  }

  for (const button of conversationList.querySelectorAll("[data-delete-conversation-id]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteConversation(button.dataset.deleteConversationId).catch((error) => {
        setStatus(error.message || "删除会话失败");
      });
    });
  }
}

function renderMessages(options = {}) {
  const { stickToBottom = false } = options;

  if (state.messages.length === 0) {
    messageList.innerHTML = `
      <div class="empty-state empty-state--panel">
        ${state.activeConversationId
          ? "当前会话还没有内容。发送一段文本、图片或文件开始使用。"
          : "还没有选中会话，先在左侧新建或选择一个会话。"}
      </div>
    `;
    state.historyLoadVisible = false;
    return;
  }

  const historyLoaderMarkup = state.hasMoreHistory
    ? `
      <div class="history-loader ${state.historyLoadVisible ? "" : "history-loader--hidden"}">
        <button
          id="loadHistoryButton"
          class="ghost-button history-button"
          type="button"
          ${state.loadingHistory ? "disabled" : ""}
        >
          ${state.loadingHistory ? "加载中..." : "加载更早记录"}
        </button>
      </div>
    `
    : "";

  messageList.innerHTML =
    historyLoaderMarkup +
    state.messages
      .map((message) => {
      const messageHeader = `
        <div class="message-row-tools">
          <button
            type="button"
            class="delete-chip message-delete-button"
            data-delete-message-id="${message.id}"
            aria-label="删除消息"
          >
            删除
          </button>
          <div class="message-meta">${escapeHtml(formatMessageTime(message.createdAt))}</div>
        </div>
      `;

      if (message.type === "text") {
        return `
          <article class="message-row">
            ${messageHeader}
            <div class="message-bubble message-bubble--text">
              ${escapeHtml(message.content).replaceAll("\n", "<br />")}
            </div>
          </article>
        `;
      }

      if (message.type === "image" && message.attachment) {
        return `
          <article class="message-row">
            ${messageHeader}
            <div class="message-bubble message-bubble--media">
              <a href="/media/${message.attachment.id}" target="_blank" rel="noreferrer">
                <img
                  class="image-preview"
                  src="/media/${message.attachment.id}"
                  alt="${escapeHtml(message.attachment.originalName)}"
                />
              </a>
              <div class="attachment-caption">${escapeHtml(message.attachment.originalName)}</div>
            </div>
          </article>
        `;
      }

      if (message.attachment) {
        return `
          <article class="message-row">
            ${messageHeader}
            <a
              class="message-bubble message-bubble--file"
              href="/media/${message.attachment.id}?download=1"
            >
              <div class="file-name">${escapeHtml(message.attachment.originalName)}</div>
              <div class="file-meta">${escapeHtml(formatBytes(message.attachment.sizeBytes))}</div>
            </a>
          </article>
        `;
      }

      return "";
    })
      .join("");

  const loadHistoryButton = document.getElementById("loadHistoryButton");
  if (loadHistoryButton) {
    loadHistoryButton.addEventListener("click", () => {
      void loadOlderMessages().catch((error) => {
        setStatus(error.message || "加载历史失败");
      });
    });
  }

  for (const button of messageList.querySelectorAll("[data-delete-message-id]")) {
    button.addEventListener("click", () => {
      void deleteMessage(button.dataset.deleteMessageId).catch((error) => {
        setStatus(error.message || "删除消息失败");
      });
    });
  }

  if (stickToBottom) {
    messageList.scrollTop = messageList.scrollHeight;
  }

  syncHistoryLoaderVisibility();
}

async function loadConversations() {
  const payload = await api("/api/conversations");
  state.conversations = payload.conversations;
  renderConversationList();
}

async function selectConversation(conversationId) {
  state.activeConversationId = conversationId;
  const activeConversation = getActiveConversation();
  conversationTitle.textContent = activeConversation?.title || "会话";
  renderConversationList();
  setStatus("加载中...");

  const payload = await api(`/api/conversations/${conversationId}/messages`);
  window.location.hash = conversationId;
  applyLatestMessagesPayload(payload, { preserveLoadedHistory: false, stickToBottom: true });
  setStatus("");
}

async function refreshAndKeepActive() {
  const currentId = state.activeConversationId;
  await loadConversations();

  if (currentId && state.conversations.some((item) => item.id === currentId)) {
    await selectConversation(currentId);
    return;
  }

  if (state.conversations[0]) {
    await selectConversation(state.conversations[0].id);
  }
}

async function refreshLatestMessages(options = {}) {
  const {
    preserveLoadedHistory = true,
    stickToBottom = isNearBottom(),
    silent = false,
  } = options;

  if (!state.activeConversationId) {
    return;
  }

  const requestedConversationId = state.activeConversationId;
  if (!silent) {
    setStatus("刷新中...");
  }

  try {
    const payload = await api(`/api/conversations/${requestedConversationId}/messages`);
    if (state.activeConversationId !== requestedConversationId) {
      return;
    }

    applyLatestMessagesPayload(payload, {
      preserveLoadedHistory,
      stickToBottom,
    });
  } finally {
    if (!silent) {
      setStatus("");
    }
  }
}

async function checkForNewMessages() {
  if (
    !state.activeConversationId ||
    latestMessagePollInFlight ||
    state.loadingHistory ||
    document.hidden
  ) {
    return;
  }

  latestMessagePollInFlight = true;
  const requestedConversationId = state.activeConversationId;
  const latestMessage = getLatestLoadedMessage();
  const params = new URLSearchParams();

  if (latestMessage?.id) {
    params.set("latestMessageId", latestMessage.id);
  }
  if (latestMessage?.cursor !== undefined && latestMessage?.cursor !== null) {
    params.set("latestCursor", String(latestMessage.cursor));
  }
  if (latestMessage?.createdAt !== undefined && latestMessage?.createdAt !== null) {
    params.set("latestCreatedAt", String(latestMessage.createdAt));
  }

  try {
    const payload = await api(
      `/api/conversations/${requestedConversationId}/messages/check${
        params.toString() ? `?${params.toString()}` : ""
      }`,
    );

    if (state.activeConversationId !== requestedConversationId || !payload.hasNewMessages) {
      return;
    }

    await refreshLatestMessages({
      preserveLoadedHistory: true,
      stickToBottom: isNearBottom(),
      silent: true,
    });
    await loadConversations();
  } finally {
    latestMessagePollInFlight = false;
  }
}

function startLatestMessagePolling() {
  if (latestMessagePollHandle) {
    return;
  }

  latestMessagePollHandle = window.setInterval(() => {
    void checkForNewMessages().catch((error) => {
      console.error("poll messages failed", error);
    });
  }, MESSAGE_POLL_INTERVAL_MS);
}

async function loadOlderMessages() {
  if (
    !state.activeConversationId ||
    !state.hasMoreHistory ||
    !state.nextBeforeCursor ||
    state.loadingHistory
  ) {
    return;
  }

  state.loadingHistory = true;
  renderMessages();
  setStatus("加载更早记录中...");

  const previousScrollHeight = messageList.scrollHeight;
  const previousScrollTop = messageList.scrollTop;
  let loadedSuccessfully = false;

  try {
    const payload = await api(
      `/api/conversations/${state.activeConversationId}/messages?before=${state.nextBeforeCursor}`,
    );
    state.messages = [...payload.messages, ...state.messages];
    state.hasMoreHistory = Boolean(payload.pagination?.hasMoreHistory);
    state.nextBeforeCursor = payload.pagination?.nextBeforeCursor ?? null;
    loadedSuccessfully = true;
  } finally {
    state.loadingHistory = false;
    renderMessages();

    if (loadedSuccessfully) {
      const scrollDelta = messageList.scrollHeight - previousScrollHeight;
      messageList.scrollTop = previousScrollTop + scrollDelta;
      syncHistoryLoaderVisibility();
    }

    setStatus("");
  }
}

async function sendTextMessage() {
  const content = messageInput.value.trim();
  if (!content || !state.activeConversationId) {
    return;
  }

  setBusy(true);
  setStatus("发送中...");

  try {
    const payload = await api(`/api/conversations/${state.activeConversationId}/messages/text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    messageInput.value = "";
    state.messages.push(payload.message);
    if (!state.nextBeforeCursor) {
      state.nextBeforeCursor = payload.message.cursor;
    }
    renderMessages({ stickToBottom: true });
    await loadConversations();
  } finally {
    setBusy(false);
    setStatus("");
  }
}

async function uploadFile(file) {
  if (!file || !state.activeConversationId) {
    return;
  }

  setBusy(true);
  setStatus(`上传中：${file.name}`);

  try {
    const formData = new FormData();
    formData.append("file", file, file.name);

    const payload = await api(`/api/conversations/${state.activeConversationId}/messages/upload`, {
      method: "POST",
      body: formData,
    });

    state.messages.push(payload.message);
    if (!state.nextBeforeCursor) {
      state.nextBeforeCursor = payload.message.cursor;
    }
    renderMessages({ stickToBottom: true });
    await loadConversations();
  } finally {
    setBusy(false);
    setStatus("");
  }
}

async function createConversation() {
  const title = window.prompt("输入新会话名称", "新会话");
  if (title === null) {
    return;
  }

  setStatus("创建会话中...");

  try {
    const payload = await api("/api/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });

    await loadConversations();
    await selectConversation(payload.conversation.id);
  } finally {
    setStatus("");
  }
}

async function deleteConversation(conversationId) {
  if (!conversationId) {
    return;
  }

  const confirmed = window.confirm("确认删除这个会话吗？会话里的消息和文件记录也会被删除。");
  if (!confirmed) {
    return;
  }

  const deletingActiveConversation = state.activeConversationId === conversationId;
  setStatus("删除会话中...");

  try {
    await api(`/api/conversations/${conversationId}`, {
      method: "DELETE",
    });

    await loadConversations();

    if (state.conversations.length === 0) {
      resetActiveConversationView();
      return;
    }

    if (deletingActiveConversation) {
      await selectConversation(state.conversations[0].id);
      return;
    }

    renderConversationList();
  } finally {
    setStatus("");
  }
}

async function deleteMessage(messageId) {
  if (!messageId || !state.activeConversationId) {
    return;
  }

  const confirmed = window.confirm("确认删除这条消息吗？");
  if (!confirmed) {
    return;
  }

  setStatus("删除消息中...");

  try {
    await api(`/api/conversations/${state.activeConversationId}/messages/${messageId}`, {
      method: "DELETE",
    });

    state.messages = state.messages.filter((message) => message.id !== messageId);
    renderMessages();
    await loadConversations();

    if (state.messages.length === 0 && state.hasMoreHistory && state.nextBeforeCursor) {
      await loadOlderMessages();
      return;
    }

    renderMessages();
  } finally {
    setStatus("");
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
}

composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendTextMessage().catch((error) => {
    setStatus(error.message || "发送失败");
  });
});

messageInput.addEventListener("keydown", (event) => {
  if (event.isComposing || event.key !== "Enter") {
    return;
  }

  const shouldSend = isMacPlatform ? event.metaKey : event.ctrlKey;
  if (!shouldSend) {
    return;
  }

  event.preventDefault();
  composerForm.requestSubmit();
});

messageInput.addEventListener("paste", (event) => {
  const items = [...(event.clipboardData?.items || [])];
  const imageItem = items.find((item) => item.type.startsWith("image/"));

  if (!imageItem) {
    return;
  }

  event.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) {
    return;
  }

  const extension = file.type.split("/")[1] || "png";
  const namedFile = new File([file], `pasted-image-${Date.now()}.${extension}`, {
    type: file.type,
  });

  void uploadFile(namedFile).catch((error) => {
    setStatus(error.message || "粘贴上传失败");
  });
});

uploadButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files || [];
  fileInput.value = "";
  void uploadFile(file).catch((error) => {
    setStatus(error.message || "上传失败");
  });
});

newConversationButton.addEventListener("click", () => {
  void createConversation().catch((error) => {
    setStatus(error.message || "创建会话失败");
  });
});

refreshMessagesButton.addEventListener("click", () => {
  void refreshLatestMessages({
    preserveLoadedHistory: true,
    stickToBottom: isNearBottom(),
  })
    .then(() => loadConversations())
    .catch((error) => {
      setStatus(error.message || "刷新失败");
    });
});

logoutButton.addEventListener("click", () => {
  void logout().catch((error) => {
    setStatus(error.message || "退出失败");
  });
});

messageList.addEventListener("scroll", () => {
  syncHistoryLoaderVisibility();
});

window.addEventListener("hashchange", () => {
  const nextId = window.location.hash.replace("#", "");
  if (
    nextId &&
    nextId !== state.activeConversationId &&
    state.conversations.some((conversation) => conversation.id === nextId)
  ) {
    void selectConversation(nextId);
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void checkForNewMessages().catch((error) => {
      console.error("resume poll failed", error);
    });
  }
});

async function bootstrap() {
  try {
    await api("/api/auth/session");
    await loadConversations();
    startLatestMessagePolling();

    const hashConversationId = window.location.hash.replace("#", "");
    const initialConversationId =
      state.conversations.find((conversation) => conversation.id === hashConversationId)?.id ||
      state.conversations[0]?.id;

    if (initialConversationId) {
      await selectConversation(initialConversationId);
      return;
    }

    resetActiveConversationView();
  } catch (error) {
    setStatus(error.message || "初始化失败");
  }
}

void bootstrap();
