const LEAGUE_ID = '1388412418576625664';
const USER_ID = '1400297235257790464';
const SLEEPER = 'https://api.sleeper.app/v1';
const PLAYER_CACHE_KEY = 'player-index:v1';

class UpstreamError extends Error {
  constructor(path, status) {
    super(`Sleeper request failed: ${path} (${status})`);
    this.name = 'UpstreamError';
  }
}

async function getJSON(fetcher, path) {
  const response = await fetcher(`${SLEEPER}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new UpstreamError(path, response.status);
  return response.json();
}

function playerIndex(players) {
  return Object.fromEntries(Object.entries(players).map(([id, player]) => [id, {
    name: player.full_name || [player.first_name, player.last_name].filter(Boolean).join(' ') || id,
    position: player.position ?? null,
    team: player.team ?? null,
    status: player.status ?? null,
    injury_status: player.injury_status ?? null,
    practice_participation: player.practice_participation ?? null,
    practice_description: player.practice_description ?? null,
  }]));
}

export async function fetchPlayerSnapshot(fetcher = fetch) {
  const [allPlayers, rosters, state] = await Promise.all([
    getJSON(fetcher, '/players/nfl'),
    getJSON(fetcher, `/league/${LEAGUE_ID}/rosters`),
    getJSON(fetcher, '/state/nfl'),
  ]);
  const week = Number(state.week || state.leg) || 1;
  const transactions = await getJSON(fetcher, `/league/${LEAGUE_ID}/transactions/${week}`);
  const ids = new Set(rosters.flatMap(roster => [
    ...(roster.players || []), ...(roster.starters || []), ...(roster.reserve || []), ...(roster.taxi || []),
  ]));
  for (const tx of transactions) {
    for (const id of [...Object.keys(tx.adds || {}), ...Object.keys(tx.drops || {})]) ids.add(id);
  }
  const selected = Object.fromEntries([...ids].filter(id => allPlayers[id]).map(id => [id, allPlayers[id]]));
  return { updated_at: new Date().toISOString(), players: playerIndex(selected) };
}

async function getPlayers(playerStore) {
  const cached = playerStore && await playerStore.get(PLAYER_CACHE_KEY, { type: 'json', cacheTtl: 60 });
  return cached || seed;
}

function describePlayer(id, players) {
  if (id === null || id === undefined || id === '0' || id === 0) return null;
  return { id: String(id), ...(players[id] || { name: String(id) }) };
}

function describeTeam(roster, users) {
  if (!roster) return null;
  const owner = users.find(user => String(user.user_id) === String(roster.owner_id));
  return {
    roster_id: roster.roster_id,
    owner_id: roster.owner_id,
    owner: owner?.display_name ?? owner?.username ?? null,
    team_name: owner?.metadata?.team_name ?? null,
    record: {
      wins: roster.settings?.wins ?? 0,
      losses: roster.settings?.losses ?? 0,
      ties: roster.settings?.ties ?? 0,
    },
  };
}

function describeRoster(roster, users, players, positions) {
  if (!roster) return null;
  const starters = roster.starters || [];
  const reserve = roster.reserve || [];
  const taxi = roster.taxi || [];
  const occupied = new Set([...starters, ...reserve, ...taxi].map(String));
  return {
    ...describeTeam(roster, users),
    starters: starters.map((id, index) => ({ slot: positions[index] ?? null, player: describePlayer(id, players) })),
    bench: (roster.players || []).filter(id => !occupied.has(String(id))).map(id => describePlayer(id, players)),
    ir: reserve.map(id => describePlayer(id, players)),
    taxi: taxi.map(id => describePlayer(id, players)),
  };
}

function describeTradingBlock(players, rosters, users) {
  if (!tradingBlock.updated_at) return {
    status: 'unavailable', updated_at: null, entries: null,
    reason: 'Sleeper does not document a public trading-block endpoint. Provide a screenshot to record a dated snapshot.',
  };
  return {
    status: 'manual_snapshot', source: tradingBlock.source, updated_at: tradingBlock.updated_at,
    entries: tradingBlock.entries.map(entry => ({
      ...entry,
      player: describePlayer(entry.player_id, players),
      team: describeTeam(rosters.find(roster => String(roster.roster_id) === String(entry.roster_id)), users),
    })),
  };
}

function describeTransaction(tx, players) {
  const changes = value => Object.entries(value || {}).map(([id, roster_id]) => ({
    player: describePlayer(id, players), roster_id,
  }));
  return {
    id: tx.transaction_id,
    type: tx.type,
    status: tx.status,
    created: tx.created ? new Date(tx.created).toISOString() : null,
    roster_ids: tx.roster_ids || [],
    adds: changes(tx.adds),
    drops: changes(tx.drops),
    waiver_bid: tx.settings?.waiver_bid ?? null,
    draft_picks: tx.draft_picks || [],
  };
}

export async function buildSummary({ fetcher = fetch, playerStore, weekOverride, includeMatchups = false, now = () => new Date() } = {}) {
  const [league, state, rosters, users] = await Promise.all([
    getJSON(fetcher, `/league/${LEAGUE_ID}`),
    getJSON(fetcher, '/state/nfl'),
    getJSON(fetcher, `/league/${LEAGUE_ID}/rosters`),
    getJSON(fetcher, `/league/${LEAGUE_ID}/users`),
  ]);
  if (!league || !Array.isArray(rosters) || !Array.isArray(users)) {
    throw new Error('Sleeper returned an invalid league response');
  }
  const myRoster = rosters.find(roster => String(roster.owner_id) === USER_ID ||
    roster.co_owners?.some(id => String(id) === USER_ID));
  if (!myRoster) {
    const error = new Error('User has no roster in this league');
    error.status = 404;
    throw error;
  }

  const week = weekOverride ?? (Number(state.week || state.leg) > 0 ? Number(state.week || state.leg) : 1);
  const [matchups, transactions, playerResult] = await Promise.all([
    getJSON(fetcher, `/league/${LEAGUE_ID}/matchups/${week}`),
    getJSON(fetcher, `/league/${LEAGUE_ID}/transactions/${week}`),
    getPlayers(playerStore).then(value => ({ value }), error => ({ error })),
  ]);
  if (!Array.isArray(matchups) || !Array.isArray(transactions)) {
    throw new Error('Sleeper returned an invalid matchup or transaction response');
  }
  const snapshot = playerResult.value || seed;
  const players = snapshot.players || {};
  const positions = (league.roster_positions || []).filter(pos => !['BN', 'IR', 'TAXI'].includes(pos));
  const myMatchup = matchups.find(entry => String(entry.roster_id) === String(myRoster.roster_id));
  const opponentMatchup = myMatchup?.matchup_id == null ? null : matchups.find(entry =>
    entry.matchup_id === myMatchup.matchup_id && String(entry.roster_id) !== String(myRoster.roster_id));
  const opponentRoster = rosters.find(roster => String(roster.roster_id) === String(opponentMatchup?.roster_id));
  const recent = transactions.sort((a, b) => (b.created || 0) - (a.created || 0)).map(tx => describeTransaction(tx, players));

  const warnings = [];
  if (!snapshot.updated_at) warnings.push('Player index not initialized; player IDs are shown until a build or scheduled refresh succeeds.');
  else if (now().getTime() - Date.parse(snapshot.updated_at) > 36 * 3600000) warnings.push('Player details are over 36 hours old; verify injury status in Sleeper.');
  if (playerResult.error) warnings.push('Player cache unavailable; using the deployment snapshot.');
  const result = {
    fetched_at: now().toISOString(),
    source: 'Sleeper public API',
    league: {
      id: LEAGUE_ID, name: league.name, season: league.season,
      status: league.status, scoring_settings: league.scoring_settings,
      roster_positions: league.roster_positions,
    },
    nfl: { week, season: state.season, season_type: state.season_type },
    player_details_updated_at: snapshot.updated_at,
    team: describeRoster(myRoster, users, players, positions),
    matchup: myMatchup ? {
      matchup_id: myMatchup.matchup_id,
      points: myMatchup.custom_points ?? myMatchup.points ?? null,
      weekly_starters: (myMatchup.starters || []).map(id => describePlayer(id, players)),
      opponent: opponentRoster ? {
        ...describeRoster(opponentRoster, users, players, positions),
        points: opponentMatchup.custom_points ?? opponentMatchup.points ?? null,
        weekly_starters: (opponentMatchup.starters || []).map(id => describePlayer(id, players)),
      } : null,
    } : null,
    transactions: {
      mine: recent.filter(tx => tx.roster_ids.some(id => String(id) === String(myRoster.roster_id))),
      opponent: recent.filter(tx => tx.roster_ids.some(id => String(id) === String(opponentRoster?.roster_id))),
    },
    trading_block: describeTradingBlock(players, rosters, users),
    warnings,
  };
  if (includeMatchups) {
    const groups = new Map();
    for (const entry of matchups) {
      const key = entry.matchup_id ?? `unassigned-${entry.roster_id}`;
      if (!groups.has(key)) groups.set(key, { matchup_id: entry.matchup_id, teams: [] });
      const roster = rosters.find(item => String(item.roster_id) === String(entry.roster_id));
      groups.get(key).teams.push({
        ...describeTeam(roster, users),
        roster_id: entry.roster_id,
        points: entry.custom_points ?? entry.points ?? null,
        starters: (entry.starters || []).map((id, index) => ({ slot: positions[index] ?? null, player: describePlayer(id, players) })),
        bench: (entry.players || []).filter(id => !(entry.starters || []).includes(id)).map(id => describePlayer(id, players)),
      });
    }
    result.league_matchups = [...groups.values()];
  }
  return result;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    if (url.pathname === '/health') return json({ ok: true });
    if (!['/', '/api/summary', '/api/matchups'].includes(url.pathname)) return json({ error: 'Not found' }, 404);

    const requestedWeek = url.searchParams.get('week');
    if (requestedWeek !== null && !/^(?:[1-9]|1\d|2[0-2])$/.test(requestedWeek)) {
      return json({ error: 'week must be an integer from 1 to 22' }, 400);
    }
    try {
      const result = await buildSummary({ playerStore: env?.PLAYER_INDEX, weekOverride: requestedWeek ? Number(requestedWeek) : undefined, includeMatchups: url.pathname === '/api/matchups' });
      return json(url.pathname === '/api/matchups' ? {
        fetched_at: result.fetched_at, league: result.league, nfl: result.nfl,
        player_details_updated_at: result.player_details_updated_at,
        matchups: result.league_matchups, warnings: result.warnings,
      } : result);
    } catch (error) {
      console.error(error);
      return json({ error: error.status === 404 ? error.message : 'Unable to retrieve Sleeper data' }, error.status || 502);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchPlayerSnapshot().then(snapshot =>
      env.PLAYER_INDEX.put(PLAYER_CACHE_KEY, JSON.stringify(snapshot))));
  },
};
import seed from './player-index.seed.js';
import tradingBlock from '../data/trading-block.js';
