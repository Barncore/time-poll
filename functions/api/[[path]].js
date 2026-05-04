// functions/api/[[path]].js
// Cloudflare Pages Function — handles all /api/* routes.
// Replaces Express + data.json with Workers KV (POLL_DATA binding).

// ── Helpers ───────────────────────────────────────────────────────────────────

function createCampaign(id, name, timerSettings) {
  const now = new Date();
  const endsAt = timerSettings.enabled
    ? new Date(now.getTime() + timerSettings.durationHours * 3600 * 1000).toISOString()
    : null;
  return { id, name: name || `Poll #${id}`, createdAt: now.toISOString(), endsAt, votes: [] };
}

function createDefaultData() {
  return {
    settings: {
      isOpen: true,
      maxPreferred: 1,
      maxCantDo: 1,
      cantDoInRanking: true,
      scoreWeights: { cantdo: -1, notpreferred: 0, fine: 1, preferred: 2 },
      spreadCantDo: false,
      spreadPreferred: false,
      pollDay: 1,
      adminPassword: 'admin',
      timer: { enabled: false, durationHours: 24 },
      timeOptions: [
        { id: 1, label: '3:00am UTC',  utcHour: 3,  utcMinute: 0  },
        { id: 2, label: '3:30am UTC',  utcHour: 3,  utcMinute: 30 },
        { id: 3, label: '2:00pm UTC',  utcHour: 14, utcMinute: 0  },
        { id: 4, label: '3:00pm UTC',  utcHour: 15, utcMinute: 0  },
        { id: 5, label: '4:00pm UTC',  utcHour: 16, utcMinute: 0  },
        { id: 6, label: '4:30pm UTC',  utcHour: 16, utcMinute: 30 }
      ]
    },
    currentCampaign: createCampaign(1, 'Poll #1', { enabled: false }),
    pastCampaigns: []
  };
}

function migrate(data) {
  const s = data.settings;
  if (!s.timer)              s.timer = { enabled: false, durationHours: 24 };
  if (s.maxCantDo    == null) s.maxCantDo = 1;
  if (s.cantDoInRanking == null) s.cantDoInRanking = true;
  if (!s.scoreWeights)       s.scoreWeights = { cantdo: -1, notpreferred: 0, fine: 1, preferred: 2 };
  if (s.spreadCantDo == null) s.spreadCantDo = false;
  if (s.spreadPreferred == null) s.spreadPreferred = false;
  if (s.pollDay      == null) s.pollDay = 1;
  if (!data.currentCampaign) {
    data.currentCampaign = {
      id: 1, name: 'Poll #1',
      createdAt: new Date().toISOString(), endsAt: null,
      votes: data.votes || []
    };
    delete data.votes;
  }
  if (!data.pastCampaigns) data.pastCampaigns = [];
  return data;
}

function isExpired(campaign) {
  return campaign.endsAt ? new Date() > new Date(campaign.endsAt) : false;
}

function nextCampaignId(data) {
  const ids = [data.currentCampaign.id, ...data.pastCampaigns.map(c => c.id)];
  return Math.max(...ids) + 1;
}

async function readData(env) {
  try {
    const raw = await env.POLL_DATA.get('data', { type: 'json' });
    if (!raw) {
      const d = createDefaultData();
      await writeData(env, d);
      return d;
    }
    return migrate(raw);
  } catch {
    return createDefaultData();
  }
}

async function writeData(env, data) {
  await env.POLL_DATA.put('data', JSON.stringify(data));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;
  const path   = new URL(request.url).pathname;
  const method = request.method;

  let body = {};
  if (method === 'POST') {
    try { body = await request.json(); } catch { /* ignore */ }
  }

  // ── GET /api/settings ─────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/settings') {
    const data = await readData(env);
    const { adminPassword, ...settings } = data.settings;
    return json({
      ...settings,
      campaign: {
        id:     data.currentCampaign.id,
        name:   data.currentCampaign.name,
        endsAt: data.currentCampaign.endsAt
      }
    });
  }

  // ── POST /api/vote ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/vote') {
    const data = await readData(env);

    if (!data.settings.isOpen)           return json({ error: 'The poll is currently closed.' }, 403);
    if (isExpired(data.currentCampaign)) return json({ error: 'The voting period has ended.' }, 403);

    const { name, timezone, votes } = body;
    if (!name || !String(name).trim())      return json({ error: 'Please enter your Discord name.' }, 400);
    if (!votes || typeof votes !== 'object') return json({ error: 'Invalid vote data.' }, 400);

    const valid = ['cantdo', 'notpreferred', 'fine', 'preferred'];
    for (const val of Object.values(votes)) {
      if (!valid.includes(val)) return json({ error: 'Invalid vote type.' }, 400);
    }

    const preferredCount = Object.values(votes).filter(v => v === 'preferred').length;
    if (preferredCount > data.settings.maxPreferred) {
      const max = data.settings.maxPreferred;
      return json({ error: `You can only mark up to ${max} time${max === 1 ? '' : 's'} as Preferred.` }, 400);
    }
    const cantDoCount = Object.values(votes).filter(v => v === 'cantdo').length;
    if (cantDoCount > data.settings.maxCantDo) {
      const max = data.settings.maxCantDo;
      return json({ error: `You can only mark up to ${max} time${max === 1 ? '' : 's'} as Can't Do.` }, 400);
    }

    const trimmedName = String(name).trim();
    const existingIdx = data.currentCampaign.votes.findIndex(
      v => v.name.toLowerCase() === trimmedName.toLowerCase()
    );
    const entry = { name: trimmedName, timezone: timezone || 'UTC', votes, submittedAt: new Date().toISOString() };
    const updated = existingIdx >= 0;
    if (updated) data.currentCampaign.votes[existingIdx] = entry;
    else         data.currentCampaign.votes.push(entry);

    await writeData(env, data);
    return json({ success: true, updated });
  }

  // ── Admin routes (/api/admin/*) ───────────────────────────────────────────
  if (!path.startsWith('/api/admin/')) return new Response('Not found', { status: 404 });

  const data = await readData(env);
  if (!body.password || body.password !== data.settings.adminPassword) {
    return json({ error: 'Incorrect password.' }, 401);
  }

  if (path === '/api/admin/data') {
    return json(data);
  }

  if (path === '/api/admin/toggle') {
    data.settings.isOpen = !data.settings.isOpen;
    await writeData(env, data);
    return json({ success: true, isOpen: data.settings.isOpen });
  }

  if (path === '/api/admin/clear') {
    data.currentCampaign.votes = [];
    await writeData(env, data);
    return json({ success: true });
  }

  if (path === '/api/admin/settings') {
    const { maxPreferred, maxCantDo, cantDoInRanking, timeOptions, newPassword,
            timer, scoreWeights, spreadCantDo, spreadPreferred, pollDay } = body;

    if (maxPreferred !== undefined) {
      const n = parseInt(maxPreferred, 10);
      if (isNaN(n) || n < 1 || n > 6) return json({ error: 'Max preferred must be 1–6.' }, 400);
      data.settings.maxPreferred = n;
    }
    if (maxCantDo !== undefined) {
      const n = parseInt(maxCantDo, 10);
      if (isNaN(n) || n < 0 || n > 6) return json({ error: "Max can't do must be 0–6." }, 400);
      data.settings.maxCantDo = n;
    }
    if (cantDoInRanking !== undefined) data.settings.cantDoInRanking = !!cantDoInRanking;
    if (scoreWeights !== undefined) {
      const keys = ['cantdo', 'notpreferred', 'fine', 'preferred'];
      for (const k of keys) {
        const v = parseFloat(scoreWeights[k]);
        if (isNaN(v) || Math.round(v * 2) !== v * 2)
          return json({ error: 'Score weights must be in 0.5 increments.' }, 400);
      }
      data.settings.scoreWeights = {
        cantdo:       parseFloat(scoreWeights.cantdo),
        notpreferred: parseFloat(scoreWeights.notpreferred),
        fine:         parseFloat(scoreWeights.fine),
        preferred:    parseFloat(scoreWeights.preferred)
      };
    }
    if (spreadCantDo   !== undefined) data.settings.spreadCantDo   = !!spreadCantDo;
    if (spreadPreferred !== undefined) data.settings.spreadPreferred = !!spreadPreferred;
    if (pollDay !== undefined) {
      const d = parseInt(pollDay, 10);
      if (isNaN(d) || d < 0 || d > 6) return json({ error: 'Poll day must be 0–6.' }, 400);
      data.settings.pollDay = d;
    }
    if (timer !== undefined) {
      const hours = parseInt(timer.durationHours, 10);
      if (isNaN(hours) || hours < 1 || hours > 999)
        return json({ error: 'Timer duration must be 1–999 hours.' }, 400);
      data.settings.timer = { enabled: !!timer.enabled, durationHours: hours };
    }
    if (timeOptions !== undefined) {
      if (!Array.isArray(timeOptions) || timeOptions.length === 0)
        return json({ error: 'Must have at least one time option.' }, 400);
      for (const opt of timeOptions) {
        const h = parseInt(opt.utcHour, 10), m = parseInt(opt.utcMinute, 10);
        if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59)
          return json({ error: 'Invalid UTC time value.' }, 400);
      }
      data.settings.timeOptions = timeOptions.map(opt => ({
        id:        opt.id,
        label:     String(opt.label).trim() || `${opt.utcHour}:${String(opt.utcMinute).padStart(2, '0')} UTC`,
        utcHour:   parseInt(opt.utcHour,   10),
        utcMinute: parseInt(opt.utcMinute, 10)
      }));
    }
    if (newPassword && String(newPassword).trim())
      data.settings.adminPassword = String(newPassword).trim();

    await writeData(env, data);
    return json({ success: true });
  }

  if (path === '/api/admin/campaign/new') {
    data.pastCampaigns.unshift({ ...data.currentCampaign, closedAt: new Date().toISOString() });
    const id = nextCampaignId(data);
    data.currentCampaign = createCampaign(id, body.name || `Poll #${id}`, data.settings.timer);
    data.settings.isOpen = true;
    await writeData(env, data);
    return json({ success: true });
  }

  if (path === '/api/admin/campaign/timer') {
    data.currentCampaign.endsAt = body.endsAt || null;
    await writeData(env, data);
    return json({ success: true });
  }

  if (path === '/api/admin/campaign/rename') {
    const { name } = body;
    if (!name || !String(name).trim()) return json({ error: 'Name required.' }, 400);
    data.currentCampaign.name = String(name).trim();
    await writeData(env, data);
    return json({ success: true });
  }

  if (path === '/api/admin/campaign/delete') {
    const id  = parseInt(body.id, 10);
    const idx = data.pastCampaigns.findIndex(c => c.id === id);
    if (idx === -1) return json({ error: 'Campaign not found.' }, 404);
    data.pastCampaigns.splice(idx, 1);
    await writeData(env, data);
    return json({ success: true });
  }

  if (path === '/api/admin/campaign/restore') {
    const id  = parseInt(body.id, 10);
    const idx = data.pastCampaigns.findIndex(c => c.id === id);
    if (idx === -1) return json({ error: 'Campaign not found.' }, 404);
    data.pastCampaigns.unshift({ ...data.currentCampaign, closedAt: new Date().toISOString() });
    const restored = data.pastCampaigns.splice(idx + 1, 1)[0];
    delete restored.closedAt;
    data.currentCampaign = restored;
    data.settings.isOpen = true;
    await writeData(env, data);
    return json({ success: true });
  }

  return new Response('Not found', { status: 404 });
}
