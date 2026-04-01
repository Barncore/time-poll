const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data.json')
  : path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  if (!s.timer)            s.timer = { enabled: false, durationHours: 24 };
  if (s.maxCantDo   == null) s.maxCantDo = 1;
  if (s.cantDoInRanking == null) s.cantDoInRanking = true;
  if (!s.scoreWeights) s.scoreWeights = { cantdo: -1, notpreferred: 0, fine: 1, preferred: 2 };
  if (s.spreadCantDo == null) s.spreadCantDo = false;
  if (s.spreadPreferred == null) s.spreadPreferred = false;
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

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const d = createDefaultData(); writeData(d); return d;
    }
    return migrate(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch { return createDefaultData(); }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Public routes ──────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const data = readData();
  const { adminPassword, ...settings } = data.settings;
  res.json({
    ...settings,
    campaign: {
      id: data.currentCampaign.id,
      name: data.currentCampaign.name,
      endsAt: data.currentCampaign.endsAt
    }
  });
});

app.post('/api/vote', (req, res) => {
  const data = readData();

  if (!data.settings.isOpen)       return res.status(403).json({ error: 'The poll is currently closed.' });
  if (isExpired(data.currentCampaign)) return res.status(403).json({ error: 'The voting period has ended.' });

  const { name, timezone, votes } = req.body;

  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your Discord name.' });
  if (!votes || typeof votes !== 'object') return res.status(400).json({ error: 'Invalid vote data.' });

  const valid = ['cantdo', 'notpreferred', 'fine', 'preferred'];
  for (const val of Object.values(votes)) {
    if (!valid.includes(val)) return res.status(400).json({ error: 'Invalid vote type.' });
  }

  const preferredCount = Object.values(votes).filter(v => v === 'preferred').length;
  if (preferredCount > data.settings.maxPreferred) {
    const max = data.settings.maxPreferred;
    return res.status(400).json({ error: `You can only mark up to ${max} time${max === 1 ? '' : 's'} as Preferred.` });
  }

  const cantDoCount = Object.values(votes).filter(v => v === 'cantdo').length;
  if (cantDoCount > data.settings.maxCantDo) {
    const max = data.settings.maxCantDo;
    return res.status(400).json({ error: `You can only mark up to ${max} time${max === 1 ? '' : 's'} as Can't Do.` });
  }

  const trimmedName = String(name).trim();
  const existingIdx = data.currentCampaign.votes.findIndex(
    v => v.name.toLowerCase() === trimmedName.toLowerCase()
  );

  const entry = { name: trimmedName, timezone: timezone || 'UTC', votes, submittedAt: new Date().toISOString() };
  const updated = existingIdx >= 0;
  if (updated) data.currentCampaign.votes[existingIdx] = entry;
  else         data.currentCampaign.votes.push(entry);

  writeData(data);
  res.json({ success: true, updated });
});

// ── Admin middleware ────────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const data = readData();
  if (!req.body.password || req.body.password !== data.settings.adminPassword)
    return res.status(401).json({ error: 'Incorrect password.' });
  req.appData = data;
  next();
}

// ── Admin routes ───────────────────────────────────────────────────────────────

app.post('/api/admin/data',   adminAuth, (req, res) => res.json(req.appData));

app.post('/api/admin/toggle', adminAuth, (req, res) => {
  const data = req.appData;
  data.settings.isOpen = !data.settings.isOpen;
  writeData(data);
  res.json({ success: true, isOpen: data.settings.isOpen });
});

app.post('/api/admin/clear', adminAuth, (req, res) => {
  const data = req.appData;
  data.currentCampaign.votes = [];
  writeData(data);
  res.json({ success: true });
});

app.post('/api/admin/settings', adminAuth, (req, res) => {
  const data = req.appData;
  const { maxPreferred, maxCantDo, cantDoInRanking, timeOptions, newPassword, timer, scoreWeights, spreadCantDo, spreadPreferred } = req.body;

  if (maxPreferred !== undefined) {
    const n = parseInt(maxPreferred, 10);
    if (isNaN(n) || n < 1 || n > 6) return res.status(400).json({ error: 'Max preferred must be 1–6.' });
    data.settings.maxPreferred = n;
  }

  if (maxCantDo !== undefined) {
    const n = parseInt(maxCantDo, 10);
    if (isNaN(n) || n < 0 || n > 6) return res.status(400).json({ error: 'Max can\'t do must be 0–6.' });
    data.settings.maxCantDo = n;
  }

  if (cantDoInRanking !== undefined) {
    data.settings.cantDoInRanking = !!cantDoInRanking;
  }

  if (scoreWeights !== undefined) {
    const keys = ['cantdo', 'notpreferred', 'fine', 'preferred'];
    for (const k of keys) {
      const v = parseFloat(scoreWeights[k]);
      if (isNaN(v) || Math.round(v * 2) !== v * 2)
        return res.status(400).json({ error: 'Score weights must be in 0.5 increments.' });
    }
    data.settings.scoreWeights = {
      cantdo:       parseFloat(scoreWeights.cantdo),
      notpreferred: parseFloat(scoreWeights.notpreferred),
      fine:         parseFloat(scoreWeights.fine),
      preferred:    parseFloat(scoreWeights.preferred)
    };
  }

  if (spreadCantDo !== undefined)   data.settings.spreadCantDo   = !!spreadCantDo;
  if (spreadPreferred !== undefined) data.settings.spreadPreferred = !!spreadPreferred;

  if (timer !== undefined) {
    const hours = parseInt(timer.durationHours, 10);
    if (isNaN(hours) || hours < 1 || hours > 999)
      return res.status(400).json({ error: 'Timer duration must be 1–999 hours.' });
    data.settings.timer = { enabled: !!timer.enabled, durationHours: hours };
  }

  if (timeOptions !== undefined) {
    if (!Array.isArray(timeOptions) || timeOptions.length === 0)
      return res.status(400).json({ error: 'Must have at least one time option.' });
    for (const opt of timeOptions) {
      const h = parseInt(opt.utcHour, 10), m = parseInt(opt.utcMinute, 10);
      if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59)
        return res.status(400).json({ error: 'Invalid UTC time value.' });
    }
    data.settings.timeOptions = timeOptions.map(opt => ({
      id: opt.id,
      label: String(opt.label).trim() || `${opt.utcHour}:${String(opt.utcMinute).padStart(2,'0')} UTC`,
      utcHour: parseInt(opt.utcHour, 10),
      utcMinute: parseInt(opt.utcMinute, 10)
    }));
  }

  if (newPassword && String(newPassword).trim()) data.settings.adminPassword = String(newPassword).trim();

  writeData(data);
  res.json({ success: true });
});

// ── Campaign routes ────────────────────────────────────────────────────────────

app.post('/api/admin/campaign/new', adminAuth, (req, res) => {
  const data = req.appData;
  const { name } = req.body;
  data.pastCampaigns.unshift({ ...data.currentCampaign, closedAt: new Date().toISOString() });
  const id = nextCampaignId(data);
  data.currentCampaign = createCampaign(id, name || `Poll #${id}`, data.settings.timer);
  data.settings.isOpen = true;
  writeData(data);
  res.json({ success: true });
});

app.post('/api/admin/campaign/timer', adminAuth, (req, res) => {
  const data = req.appData;
  data.currentCampaign.endsAt = req.body.endsAt || null;
  writeData(data);
  res.json({ success: true });
});

app.post('/api/admin/campaign/rename', adminAuth, (req, res) => {
  const data = req.appData;
  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required.' });
  data.currentCampaign.name = String(name).trim();
  writeData(data);
  res.json({ success: true });
});

// Delete a past campaign
app.post('/api/admin/campaign/delete', adminAuth, (req, res) => {
  const data = req.appData;
  const id = parseInt(req.body.id, 10);
  const idx = data.pastCampaigns.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found.' });
  data.pastCampaigns.splice(idx, 1);
  writeData(data);
  res.json({ success: true });
});

// Restore a past campaign as current (current gets archived)
app.post('/api/admin/campaign/restore', adminAuth, (req, res) => {
  const data = req.appData;
  const id = parseInt(req.body.id, 10);
  const idx = data.pastCampaigns.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found.' });

  // Archive current
  data.pastCampaigns.unshift({ ...data.currentCampaign, closedAt: new Date().toISOString() });

  // Remove restored campaign from past list and make it current
  const restored = data.pastCampaigns.splice(idx + 1, 1)[0];
  delete restored.closedAt;
  data.currentCampaign = restored;
  data.settings.isOpen = true;
  writeData(data);
  res.json({ success: true });
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Time Poll running → http://localhost:${PORT}`);
  console.log(`  Admin panel      → http://localhost:${PORT}/admin.html`);
  console.log(`  Default password → admin\n`);
});
