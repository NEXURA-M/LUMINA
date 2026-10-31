import { Octokit } from '@octokit/rest';
import fs from 'fs';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.REPO.split('/');

async function fetchAllIssues() {
  const issues = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.issues.listForRepo({
      owner, repo, state: 'all', per_page: 100, page
    });
    if (data.length === 0) break;
    issues.push(...data);
    page++;
  }
  return issues;
}

// 🔓 Try base64 JSON first (new style), then plain JSON, then regex fallback
function tryParsePayload(body) {
  body = (body || '').trim();
  if (!body) return null;

  // 1) Base64-encoded JSON (like aapki pasted file)
  try {
    const decoded = Buffer.from(body, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}

  // 2) Plain JSON
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}

  return null;
}

function parseIdentity(body) {
  const p = tryParsePayload(body);
  if (p && typeof p.name === 'string') {
    return {
      name: p.name.trim().slice(0, 50),
      proposedId: typeof p.proposedId === 'string' && /^MT-\d{6}$/.test(p.proposedId) ? p.proposedId : null
    };
  }
  // Regex fallback (legacy plain-text issues)
  const nameMatch = body.match(/\*\*Name:\*\*\s*(.+)/);
  const proposedMatch = body.match(/\*\*Proposed ID:\*\*\s*(MT-\d{6})/);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1].trim().slice(0, 50),
    proposedId: proposedMatch ? proposedMatch[1].trim() : null
  };
}

function parseWin(body) {
  const p = tryParsePayload(body);
  if (p && typeof p.whatsapp === 'string') {
    return {
      whatsapp: p.whatsapp.trim().slice(0, 20),
      type: String(p.type || '').trim().slice(0, 60),
      description: String(p.description || '').trim().slice(0, 500)
    };
  }
  // Regex fallback
  const waMatch = body.match(/\*\*WhatsApp:\*\*\s*(.+)/);
  const typeMatch = body.match(/\*\*Type:\*\*\s*(.+)/);
  const descMatch = body.match(/\*\*Description:\*\*\s*(.+)/);
  if (!waMatch || !typeMatch || !descMatch) return null;
  return {
    whatsapp: waMatch[1].trim(),
    type: typeMatch[1].trim(),
    description: descMatch[1].trim()
  };
}

async function main() {
  console.log('📡 Fetching issues...');
  const issues = await fetchAllIssues();

  const existing = fs.existsSync('data.json')
    ? JSON.parse(fs.readFileSync('data.json', 'utf-8'))
    : [];

  const usedIds = new Set(existing.map(d => d.id));
  const usedNames = new Set(existing.map(d => d.name.toLowerCase()));

  const identityIssues = issues
    .filter(i => i.title.startsWith('[IDENTITY]'))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const identities = [...existing];

  function nextId() {
    let max = 0;
    for (const id of usedIds) {
      const n = parseInt(id.split('-')[1]);
      if (n > max) max = n;
    }
    let candidate;
    do {
      max++;
      candidate = `MT-${String(max).padStart(6, '0')}`;
    } while (usedIds.has(candidate));
    return candidate;
  }

  for (const issue of identityIssues) {
    const parsed = parseIdentity(issue.body || '');
    if (!parsed || !parsed.name) continue;

    const nameKey = parsed.name.toLowerCase();
    if (usedNames.has(nameKey)) continue;

    let assignedId = null;
    if (parsed.proposedId && !usedIds.has(parsed.proposedId)) {
      assignedId = parsed.proposedId;
    } else {
      assignedId = nextId();
    }

    identities.push({ name: parsed.name, id: assignedId });
    usedIds.add(assignedId);
    usedNames.add(nameKey);
  }

  identities.sort((a, b) => a.id.localeCompare(b.id));

  const wins = issues
    .filter(i => i.title.startsWith('[WIN]'))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(i => parseWin(i.body || ''))
    .filter(Boolean);

  fs.writeFileSync('data.json', JSON.stringify(identities, null, 2));
  fs.writeFileSync('dw.json', JSON.stringify(wins, null, 2));

  console.log(`✅ Synced ${identities.length} identities and ${wins.length} inquiries.`);
}

main().catch(err => {
  console.error('❌ Sync failed:', err);
  process.exit(1);
});
