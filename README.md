# Sleeper fantasy bridge

A read-only Cloudflare Worker focused on **your team, your opponent, and the trading block**, with other league matchups available on request.

- League: `1388412418576625664`
- Sleeper user: `1400297235257790464` (`leftmerlin`)

No Sleeper password or API token is needed. This bridge cannot change lineups or make trades.

## Endpoints

| Request | Returns |
| --- | --- |
| `GET /api/summary` or `/` | Your current starters, bench, IR and taxi; your opponent's roster; current-week scores; transactions for those two teams; trading-block status |
| `GET /api/matchups` | All league matchups, owners, starters, benches and scores for on-demand questions |
| Either endpoint with `?week=4` | That week's scores, matchup lineups and transactions; roster fields in the summary remain current |
| `GET /health` | Basic service health; does not probe Sleeper |

Week detection uses Sleeper's NFL state. A `week` override accepts 1–22. Scores include commissioner overrides. Empty starter slots remain explicit. Large Sleeper IDs are kept as strings to avoid loss of precision.

### Trading block

Sleeper's [documented public API](https://docs.sleeper.com/) does **not document an endpoint for the in-app trading block**. The bridge therefore reports `trading_block.status: "unavailable"` and `entries: null` initially. This does not mean the block is empty.

To include it, record a user-provided screenshot/list in `data/trading-block.js`, with its capture time and source. Entries use `player_id`, `roster_id`, and optional `notes`. The response labels this as `manual_snapshot` with `updated_at`; it is never represented as live API data. Redeploy after updating the snapshot. Pending private trade offers are also outside this public bridge.

## Deploy from GitHub

1. In Cloudflare **Workers & Pages**, create a Worker using the GitHub repository `cutterjam/sleepfan-api`, branch `main`.
2. Use deployment command `npm run deploy`. Leave Cloudflare's separate build command blank: the deploy script builds the player index before invoking Wrangler.
3. Cloudflare provisions the `PLAYER_INDEX` KV binding from `wrangler.jsonc`. The configured daily trigger refreshes player details at 10:00 UTC.
4. Open the deployment's provided `workers.dev` URL followed by `/api/summary`.

From a local clone, use Node 22 or newer, run `npm test`, then `npm run deploy` and sign in to Cloudflare when prompted.

The GitHub repository itself is not a live endpoint. A Cloudflare account and successful deployment are required. If Cloudflare does not automatically provision the binding, create a KV namespace named `PLAYER_INDEX` and put its ID on that binding in `wrangler.jsonc`.

## Data freshness

Roster, matchup and transaction data are requested from Sleeper on every summary request. `fetched_at` records when the summary was assembled; these upstream reads are not an atomic snapshot.

Sleeper recommends fetching the large NFL player index no more than once per day. The build generates a small initial snapshot containing league players and players in current-week transactions. A daily scheduled Worker refresh replaces it in KV. This keeps large JSON parsing out of normal HTTP requests. Deploying repeatedly can perform extra player-index downloads, so avoid unnecessary builds.

`player_details_updated_at` shows the age of names, NFL teams and injury/practice fields. Details may lag up to a day; new additions or old-week transactions may show an ID until the next snapshot includes that player. A warning appears if details are over 36 hours old. If KV is unavailable, the deployment snapshot is used. The build requires access to Sleeper and fails if its initial snapshot cannot be fetched.

The Tuesday and Friday checks should use `/api/summary`; request `/api/matchups` only for league-wide questions. Continue verifying against a fresh Sleeper roster screenshot before acting. Injury news, projections, bye-week schedules and waiver recommendations require separate current research.

## Validation

`npm test` runs fixture-based Node tests for roster grouping, player resolution, unavailable-cache behavior, summary scope, on-demand matchups, historical-week handling and input validation. Tests do not require Sleeper access or a Cloudflare account.

References: [Sleeper API](https://docs.sleeper.com/), [Cloudflare Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/), [automatic resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).
