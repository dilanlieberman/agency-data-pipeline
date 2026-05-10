const axios = require('axios');
const { GHL_BASE, GHL_VERSION } = require('./config');

const MAX_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = process.env.NODE_ENV === 'test' ? 10 : 60_000;
const RETRY_WAIT_MS = process.env.NODE_ENV === 'test' ? 10 : 5_000;
const PAGE_SIZE = 20;
const RATE_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 250;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransient(err) {
  const status = err.response?.status;
  if (status === 429) return true;
  if (status >= 500) return true;
  const code = err.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'EAI_AGAIN'].includes(code);
}

async function withRetry(fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) throw err;
      if (!isTransient(err) || attempt === MAX_RETRIES) throw err;
      const waitMs = status === 429 ? RATE_LIMIT_WAIT_MS : RETRY_WAIT_MS * attempt;
      await sleep(waitMs);
    }
  }
}

function createGhlClient(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function paginate(url, params, dataKey) {
    const all = [];
    let offset = 0;
    while (true) {
      const res = await withRetry(() =>
        axios.get(url, { headers, params: { ...params, limit: PAGE_SIZE, skip: offset } })
      );
      const page = res.data[dataKey] ?? [];
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      await sleep(RATE_DELAY_MS);
    }
    return all;
  }

  async function getContacts(locationId, query = {}) {
    return paginate(`${GHL_BASE}/contacts/`, { locationId, ...query }, 'contacts');
  }

  async function getContactsByTag(locationId, tag) {
    return paginate(`${GHL_BASE}/contacts/`, { locationId, tags: tag }, 'contacts');
  }

  async function getPipelines(locationId) {
    const res = await withRetry(() =>
      axios.get(`${GHL_BASE}/opportunities/pipelines`, { headers, params: { locationId } })
    );
    return res.data.pipelines ?? [];
  }

  async function getOpportunities(locationId, pipelineId, query = {}) {
    // Opportunities search uses pipeline_id (snake_case) and startAfter cursor, not skip
    const all = [];
    let startAfter;
    const MAX_PAGES = 50; // Safety cap — don't paginate forever
    let pages = 0;
    while (pages < MAX_PAGES) {
      const params = { location_id: locationId, pipeline_id: pipelineId, limit: PAGE_SIZE, ...query };
      if (startAfter) params.startAfter = startAfter;
      const res = await withRetry(() =>
        axios.get(`${GHL_BASE}/opportunities/search`, { headers, params })
      );
      const page = res.data.opportunities ?? [];
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
      startAfter = page[page.length - 1].id;
      pages++;
      await sleep(RATE_DELAY_MS);
    }
    return all;
  }

  async function getCalendarEvents(locationId, startDate, endDate) {
    const res = await withRetry(() =>
      axios.get(`${GHL_BASE}/calendars/events`, {
        headers,
        params: { locationId, startDate, endDate },
      })
    );
    return res.data.events ?? [];
  }

  // Pull recent conversations for a location, newest-first by lastMessageDate.
  // GHL conversations/search has no documented date filter, so we paginate
  // and let the caller short-circuit when we walk past the cutoff.
  async function searchConversations(locationId, { maxPages = 10, limit = 25 } = {}) {
    const all = [];
    let startAfter;
    let startAfterDate;
    for (let page = 0; page < maxPages; page++) {
      const params = { locationId, limit };
      if (startAfter) {
        params.startAfter = startAfter;
        params.startAfterDate = startAfterDate;
      }
      const res = await withRetry(() =>
        axios.get(`${GHL_BASE}/conversations/search`, { headers, params })
      );
      const page_data = res.data.conversations ?? [];
      if (!Array.isArray(page_data) || page_data.length === 0) break;
      all.push(...page_data);
      if (page_data.length < limit) break;
      const last = page_data[page_data.length - 1];
      startAfter = last.id;
      startAfterDate = last.lastMessageDate || last.dateUpdated;
      await sleep(RATE_DELAY_MS);
    }
    return all;
  }

  // Get messages for one conversation. Returns flat array, newest-first.
  async function getMessages(conversationId, { limit = 100, maxPages = 5 } = {}) {
    const all = [];
    let lastMessageId;
    for (let page = 0; page < maxPages; page++) {
      const params = { limit };
      if (lastMessageId) params.lastMessageId = lastMessageId;
      const res = await withRetry(() =>
        axios.get(`${GHL_BASE}/conversations/${conversationId}/messages`, { headers, params })
      );
      // Two known shapes: {messages: {messages: [...], lastMessageId, nextPage}} or {messages: [...]}
      const block = res.data.messages?.messages ?? res.data.messages ?? [];
      if (!Array.isArray(block) || block.length === 0) break;
      all.push(...block);
      const nextPage = res.data.messages?.nextPage;
      if (!nextPage || block.length < limit) break;
      lastMessageId = block[block.length - 1].id;
      await sleep(RATE_DELAY_MS);
    }
    return all;
  }

  return {
    getContacts,
    getContactsByTag,
    getPipelines,
    getOpportunities,
    getCalendarEvents,
    searchConversations,
    getMessages,
  };
}

module.exports = { createGhlClient };
