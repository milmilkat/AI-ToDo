const TRELLO_API = "https://api.trello.com/1";
const STORAGE_KEY = "trelloTodoBoardSettings";

const state = {
  settings: loadSettings(),
  lists: [],
  cards: [],
  refreshTimer: null,
  isConnected: false,
};

const els = {
  settingsForm: document.querySelector("#settingsForm"),
  apiKey: document.querySelector("#apiKey"),
  token: document.querySelector("#token"),
  boardId: document.querySelector("#boardId"),
  refreshMs: document.querySelector("#refreshMs"),
  disconnectButton: document.querySelector("#disconnectButton"),
  sourceList: document.querySelector("#sourceList"),
  doneList: document.querySelector("#doneList"),
  refreshButton: document.querySelector("#refreshButton"),
  syncStatus: document.querySelector("#syncStatus"),
  taskCount: document.querySelector("#taskCount"),
  emptyState: document.querySelector("#emptyState"),
  taskList: document.querySelector("#taskList"),
  taskTemplate: document.querySelector("#taskTemplate"),
  addTicketButton: document.querySelector("#addTicketButton"),
  addTicketForm: document.querySelector("#addTicketForm"),
  newTicketTitle: document.querySelector("#newTicketTitle"),
  newTicketNotes: document.querySelector("#newTicketNotes"),
  cancelAddTicketButton: document.querySelector("#cancelAddTicketButton"),
};

hydrateSettingsForm();
bindEvents();
setControlsEnabled(false);

if (hasMinimumSettings(state.settings)) {
  connect().catch((error) => setStatus(error.message, "error"));
}

function bindEvents() {
  els.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.settings = formSettings();
    saveSettings(state.settings);
    await connect();
  });

  els.disconnectButton.addEventListener("click", () => {
    clearInterval(state.refreshTimer);
    localStorage.removeItem(STORAGE_KEY);
    state.settings = {};
    state.lists = [];
    state.cards = [];
    state.isConnected = false;
    hydrateSettingsForm();
    setControlsEnabled(false);
    renderLists();
    renderTasks();
    setStatus("Not connected");
  });

  els.sourceList.addEventListener("change", async () => {
    state.settings.sourceListId = els.sourceList.value;
    saveSettings(state.settings);
    await refreshCards();
  });

  els.doneList.addEventListener("change", () => {
    state.settings.doneListId = els.doneList.value;
    saveSettings(state.settings);
  });

  els.refreshButton.addEventListener("click", refreshCards);

  els.addTicketButton.addEventListener("click", () => {
    els.addTicketForm.hidden = !els.addTicketForm.hidden;
    if (!els.addTicketForm.hidden) els.newTicketTitle.focus();
  });

  els.cancelAddTicketButton.addEventListener("click", () => {
    els.addTicketForm.reset();
    els.addTicketForm.hidden = true;
  });

  els.addTicketForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createTicket();
  });
}

async function connect() {
  if (!hasMinimumSettings(state.settings)) return;

  setStatus("Connecting...");
  setControlsEnabled(false);

  const lists = await trelloFetch(`/boards/${encodeURIComponent(state.settings.boardId)}/lists`, {
    fields: "name,closed",
    filter: "open",
  });

  state.lists = lists;
  state.isConnected = true;

  if (!state.settings.sourceListId && lists.length > 0) {
    state.settings.sourceListId = lists[0].id;
  }

  if (!state.settings.doneListId) {
    const done = lists.find((list) => /done|complete|finished/i.test(list.name));
    state.settings.doneListId = done?.id || lists.at(-1)?.id || "";
  }

  saveSettings(state.settings);
  renderLists();
  setControlsEnabled(true);
  setStatus("Connected", "connected");
  await refreshCards();
  scheduleRefresh();
}

async function refreshCards() {
  if (!state.isConnected || !state.settings.sourceListId) return;

  setStatus("Syncing...");

  const cards = await trelloFetch(`/lists/${encodeURIComponent(state.settings.sourceListId)}/cards`, {
    fields: "name,desc,due,dueComplete,dateLastActivity,shortUrl,labels",
    attachments: "false",
    checklists: "none",
  });

  state.cards = cards.filter((card) => !card.dueComplete);
  renderTasks();
  setStatus(`Synced ${new Date().toLocaleTimeString()}`, "connected");
}

async function createTicket() {
  const name = els.newTicketTitle.value.trim();
  const desc = els.newTicketNotes.value.trim();

  if (!name || !state.settings.sourceListId) return;

  els.addTicketForm.querySelector("button[type='submit']").disabled = true;

  try {
    await trelloFetch("/cards", {
      idList: state.settings.sourceListId,
      name,
      desc,
    }, "POST");
    els.addTicketForm.reset();
    els.addTicketForm.hidden = true;
    await refreshCards();
  } finally {
    els.addTicketForm.querySelector("button[type='submit']").disabled = false;
  }
}

async function completeCard(cardId) {
  if (!state.settings.doneListId) {
    setStatus("Choose a done list first.", "error");
    return;
  }

  await trelloFetch(`/cards/${encodeURIComponent(cardId)}`, {
    idList: state.settings.doneListId,
    dueComplete: "true",
  }, "PUT");

  state.cards = state.cards.filter((card) => card.id !== cardId);
  renderTasks();
  setStatus("Moved to done", "connected");
}

async function trelloFetch(path, params = {}, method = "GET") {
  const url = new URL(`${TRELLO_API}${path}`);
  const bodyParams = new URLSearchParams({
    key: state.settings.apiKey,
    token: state.settings.token,
    ...params,
  });

  const options = { method };

  if (method === "GET") {
    bodyParams.forEach((value, key) => url.searchParams.set(key, value));
  } else {
    options.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    options.body = bodyParams.toString();
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Trello request failed with ${response.status}`);
  }

  return response.json();
}

function renderLists() {
  const options = state.lists
    .map((list) => `<option value="${escapeHtml(list.id)}">${escapeHtml(list.name)}</option>`)
    .join("");

  els.sourceList.innerHTML = options;
  els.doneList.innerHTML = options;
  els.sourceList.value = state.settings.sourceListId || "";
  els.doneList.value = state.settings.doneListId || "";
}

function renderTasks() {
  els.taskList.innerHTML = "";
  els.emptyState.hidden = state.cards.length > 0;

  if (!state.isConnected) {
    els.taskCount.textContent = "Connect a Trello board to begin.";
    return;
  }

  els.taskCount.textContent =
    state.cards.length === 1 ? "1 open ticket" : `${state.cards.length} open tickets`;

  for (const card of state.cards) {
    const item = els.taskTemplate.content.firstElementChild.cloneNode(true);
    item.querySelector("h3").textContent = card.name;
    item.querySelector(".task-description").textContent = card.desc || "No notes yet.";
    item.querySelector(".open-card").href = card.shortUrl;
    item.querySelector(".complete-button").addEventListener("click", () => completeCard(card.id));

    const meta = item.querySelector(".task-meta");
    const updated = new Date(card.dateLastActivity).toLocaleString();
    addMeta(meta, `Updated ${updated}`);

    if (card.due) {
      addMeta(meta, `Due ${new Date(card.due).toLocaleDateString()}`);
    }

    for (const label of card.labels || []) {
      addMeta(meta, label.name || label.color);
    }

    els.taskList.append(item);
  }
}

function addMeta(container, text) {
  const span = document.createElement("span");
  span.textContent = text;
  container.append(span);
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(refreshCards, Number(state.settings.refreshMs || 30000));
}

function formSettings() {
  return {
    apiKey: els.apiKey.value.trim(),
    token: els.token.value.trim(),
    boardId: normalizeBoardId(els.boardId.value),
    refreshMs: els.refreshMs.value,
    sourceListId: state.settings.sourceListId,
    doneListId: state.settings.doneListId,
  };
}

function hydrateSettingsForm() {
  els.apiKey.value = state.settings.apiKey || "";
  els.token.value = state.settings.token || "";
  els.boardId.value = state.settings.boardId || "";
  els.refreshMs.value = state.settings.refreshMs || "30000";
}

function setControlsEnabled(enabled) {
  els.sourceList.disabled = !enabled;
  els.doneList.disabled = !enabled;
  els.refreshButton.disabled = !enabled;
  els.addTicketButton.disabled = !enabled;
}

function setStatus(message, mode = "") {
  els.syncStatus.textContent = message;
  els.syncStatus.className = `status-pill ${mode}`.trim();
}

function hasMinimumSettings(settings) {
  return Boolean(settings.apiKey && settings.token && settings.boardId);
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function normalizeBoardId(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/\/b\/([^/]+)/);
  return match?.[1] || trimmed;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}