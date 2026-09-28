import { writeFile } from 'node:fs/promises';
import { fetchPlayerSnapshot } from '../src/index.js';

// Run in the build's Node process, where parsing Sleeper's large player index
// does not consume a Worker's small HTTP-request CPU budget.
const snapshot = await fetchPlayerSnapshot();
await writeFile(new URL('../src/player-index.seed.js', import.meta.url),
  `// Generated during deployment.\nexport default ${JSON.stringify(snapshot)};\n`);
console.log(`Prepared ${Object.keys(snapshot.players).length} league players.`);
