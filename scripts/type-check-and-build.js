import { spawnSync } from 'child_process'

const run = (cmd, label) => {
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(cmd, {
    cwd: '/vercel/share/v0-project',
    encoding: 'utf8',
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.stdout) console.log(result.stdout)
  if (result.stderr) console.log(result.stderr)
  if (result.error) console.log('spawn error:', result.error.message)
  const passed = result.status === 0
  console.log(passed ? `✓ ${label} PASSED` : `✗ ${label} FAILED (exit ${result.status})`)
  return passed
}

const typeCheckPassed = run(
  'cd /vercel/share/v0-project && ./node_modules/.bin/tsc --noEmit 2>&1',
  'TypeScript type-check'
)

if (typeCheckPassed) {
  run(
    'cd /vercel/share/v0-project && ./node_modules/.bin/next build 2>&1',
    'next build'
  )
} else {
  console.log('\nSkipping next build — fix type errors first.')
}
