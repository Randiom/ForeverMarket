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
    const id = saved?.key === key ? saved.id : messageId;
    if (id !== undefined && !/^\d+$/.test(id)) throw new Error('Invalid Discord message ID');
    const send = (url, method, body) => fetcher(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    let response;
    if (id) {
      // Clear legacy embed content when adopting a message from an earlier bot version.
      response = await send(`${webhook}/messages/${id}?with_components=true`, 'PATCH', { ...payload, content: null, embeds: null, attachments: [] });
      if (!response.ok && response.status !== 404) throw new Error(`Discord edit returned HTTP ${response.status}; keeping the existing message`);
      // A missing webhook must not be mistaken for a deleted message.
      if (response.status === 404) {
        const error = await response.json();
        if (error.code !== 10008) throw new Error('Discord webhook unavailable; check its configuration');
        response = undefined;
      }
    }
    if (!response) response = await send(`${webhook}?wait=true&with_components=true`, 'POST', { ...payload, username: 'ForeverMarket' });
    if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
    const message = await response.json();
    if (!/^\d+$/.test(message.id)) throw new Error('Discord returned no message ID');
    await fs.writeFile(`${stateFile}.tmp`, JSON.stringify({ key, id: message.id }), { mode: 0o600 });
    await fs.rename(`${stateFile}.tmp`, stateFile);
    return message.id;
  } finally {
    await lock.close();
    await fs.unlink(`${stateFile}.lock`);
  }
}

module.exports = { updateMessage };
