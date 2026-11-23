const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function updateMessage({ webhook, payload, fetcher = fetch, stateFile = process.env.MESSAGE_STATE_FILE || '.state/discord-message.json', messageId = process.env.DISCORD_MESSAGE_ID || undefined }) {
  const key = createHash('sha256').update(webhook).digest('hex');
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  // Fail rather than post twice if another process uses this same state file.
  const lock = await fs.open(`${stateFile}.lock`, 'wx');
  try {
    let saved;
    try { saved = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read message state; restore the state file before restarting'); }
    if (saved?.key === key && saved.pending && (!messageId || messageId === saved.previousId)) throw new Error('Previous Discord creation has uncertain delivery; check the channel and set DISCORD_MESSAGE_ID to the delivered message ID, or remove the state file only if no message was delivered');
    const id = saved?.key === key && !saved.pending ? saved.id : messageId;
    if (id !== undefined && !/^\d+$/.test(id)) throw new Error('Invalid Discord message ID');
    const save = async value => {
      await fs.writeFile(`${stateFile}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(`${stateFile}.tmp`, stateFile);
    };
    const readJson = async response => {
      try { return await response.json(); }
      catch { throw new Error('Discord response body could not be read; saved message state unchanged'); }
    };
    const send = async (url, method, body) => {
      try {
        return await fetcher(url, {
          method, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
        // Never include the webhook URL/token or repeat an uncertain creation request.
        throw new Error(`Discord ${method}: ${timeout ? 'request timed out after 30 seconds' : 'network request failed'}; saved message state unchanged${method === 'POST' ? '; check the channel before retrying creation' : ''}`);
      }
    };
    let response;
    if (id) {
      // Clear legacy embed content when adopting a message from an earlier bot version.
      response = await send(`${webhook}/messages/${id}?with_components=true`, 'PATCH', { ...payload, content: null, embeds: null, attachments: [] });
      if (!response.ok && response.status !== 404) throw new Error(`Discord edit returned HTTP ${response.status}; keeping the existing message`);
      // A missing webhook must not be mistaken for a deleted message.
      if (response.status === 404) {
        const error = await readJson(response);
        if (error.code !== 10008) throw new Error('Discord webhook unavailable; check its configuration');
        response = undefined;
      }
    }
    if (!response) {
      // Persist before sending: a lost response or crash must not cause repeated posts.
      await save({ key, pending: true, previousId: id || null });
      response = await send(`${webhook}?wait=true&with_components=true`, 'POST', { ...payload, username: 'ForeverMarket' });
      if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 408) {
        // Client rejections are definitive; server errors can leave delivery uncertain.
        if (saved) await save(saved);
        else await fs.unlink(stateFile);
      }
    }
    if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
    const message = await readJson(response);
    if (!/^\d+$/.test(message.id)) throw new Error('Discord returned no message ID');
    await save({ key, id: message.id });
    return message.id;
  } finally {
    await lock.close();
    await fs.unlink(`${stateFile}.lock`);
  }
}

module.exports = { updateMessage };
