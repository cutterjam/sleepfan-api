import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildSummary, fetchPlayerSnapshot } from '../src/index.js';

const fixtures = {
  '/league/1388412418576625664': {
    name: 'Fantasy League', season: '2026', status: 'in_season',
    roster_positions: ['QB', 'RB', 'FLEX', 'BN', 'IR'], scoring_settings: { rec: 1 },
  },
  '/state/nfl': { week: 4, season: '2026', season_type: 'regular' },
  '/league/1388412418576625664/rosters': [
    { roster_id: 1, owner_id: '1400297235257790464', starters: ['1', '2', '0'], players: ['1', '2', '3', '4'], reserve: ['4'], settings: { wins: 2, losses: 1 } },
    { roster_id: 2, owner_id: 'other', starters: ['5'], players: ['5'] },
  ],
  '/league/1388412418576625664/users': [
    { user_id: '1400297235257790464', display_name: 'leftmerlin' },
    { user_id: 'other', display_name: 'Rival', metadata: { team_name: 'Rival Team' } },
  ],
  '/league/1388412418576625664/matchups/4': [
    { roster_id: 1, matchup_id: 10, points: 71, starters: ['1', '2', '0'] },
    { roster_id: 2, matchup_id: 10, points: 65, starters: ['5'] },
  ],
  '/league/1388412418576625664/transactions/4': [
    { transaction_id: '123', roster_ids: [1], type: 'free_agent', status: 'complete', created: 1780000000000, adds: { '3': 1 }, drops: { '6': 1 } },
  ],
  '/players/nfl': {
    '1': { full_name: 'Starter One', position: 'QB', team: 'JAX' },
    '2': { full_name: 'Starter Two', position: 'RB' },
    '3': { full_name: 'Bench Three', injury_status: 'Questionable' },
    '4': { full_name: 'IR Four' },
    '5': { full_name: 'Opponent Five' },
  },
};

function fakeFetch(pathCounts, data = fixtures) {
  return async url => {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    pathCounts[path] = (pathCounts[path] || 0) + 1;
    return path in data ? Response.json(data[path]) : Response.json({ error: 'missing fixture' }, { status: 404 });
  };
}

test('summary maps live roster, opponent, transactions and names, with cached player index', async () => {
  const calls = {};
  const entries = new Map();
  const playerStore = {
    async get(key) { return entries.has(key) ? JSON.parse(entries.get(key)) : null; },
    async put(key, value) { entries.set(key, value); },
  };
  await playerStore.put('player-index:v1', JSON.stringify(await fetchPlayerSnapshot(fakeFetch(calls))));
  const options = { fetcher: fakeFetch(calls), playerStore, now: () => new Date('2026-09-28T14:00:00Z') };
  const first = await buildSummary(options);
  await buildSummary(options);
  assert.equal(first.nfl.week, 4);
  assert.equal(first.team.starters[0].slot, 'QB');
  assert.equal(first.team.starters[2].player, null);
  assert.deepEqual(first.team.bench.map(p => p.name), ['Bench Three']);
  assert.deepEqual(first.team.ir.map(p => p.name), ['IR Four']);
  assert.equal(first.team.bench[0].injury_status, 'Questionable');
  assert.equal(first.matchup.opponent.team_name, 'Rival Team');
  assert.equal(first.matchup.opponent.starters[0].player.name, 'Opponent Five');
  assert.equal(first.transactions.mine[0].adds[0].player.name, 'Bench Three');
  assert.equal(calls['/players/nfl'], 1);
  assert.equal(first.league_matchups, undefined);
  assert.equal(first.transactions.league, undefined);
  assert.equal(first.trading_block.status, 'unavailable');
  assert.equal(first.trading_block.entries, null);
});

test('player cache failure leaves a usable roster with IDs and a warning', async () => {
  const summary = await buildSummary({ fetcher: fakeFetch({}), playerStore: { get: async () => { throw new Error('KV unavailable'); } } });
  assert.equal(summary.team.starters[0].player.name, '1');
  assert.ok(summary.warnings.some(warning => warning.includes('cache unavailable')));
});

test('all matchups are available only when requested', async () => {
  const summary = await buildSummary({ fetcher: fakeFetch({}), includeMatchups: true });
  assert.equal(summary.league_matchups.length, 1);
  assert.equal(summary.league_matchups[0].teams.length, 2);
  assert.equal(summary.league_matchups[0].teams[1].points, 65);
});

test('historical weeks preserve current roster and use requested weekly matchup', async () => {
  const data = { ...fixtures,
    '/league/1388412418576625664/matchups/3': [{ roster_id: 1, matchup_id: null, points: 12, custom_points: 0, starters: ['3'] }],
    '/league/1388412418576625664/transactions/3': [],
  };
  const result = await buildSummary({ fetcher: fakeFetch({}, data), weekOverride: 3 });
  assert.equal(result.team.starters[0].player.id, '1');
  assert.equal(result.matchup.weekly_starters[0].id, '3');
  assert.equal(result.matchup.opponent, null);
  assert.equal(result.matchup.points, 0);
});

test('invalid week is rejected before contacting Sleeper', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/summary?week=xyz'));
  assert.equal(response.status, 400);
});
