// astro build, failing when a page could not be rendered. Astro's content loader only logs render
// errors (such as an unexpected type error in a ```ts twoslash block) and still exits 0.
import { spawn } from 'node:child_process';

const child = spawn('astro', ['build'], { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let failed = false;
for (const stream of ['stdout', 'stderr']) {
  child[stream].on('data', (chunk) => {
    process[stream].write(chunk);
    if (chunk.toString().includes('Error rendering')) failed = true;
  });
}
child.on('close', (code) => {
  if (failed) console.error('\nA page failed to render (see "Error rendering" above).');
  process.exit(code || (failed ? 1 : 0));
});
