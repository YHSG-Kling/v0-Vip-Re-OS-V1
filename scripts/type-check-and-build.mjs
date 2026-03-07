import { execSync } from 'child_process'

function run(cmd) {
  console.log(`\n> ${cmd}`)
  try {
    execSync(cmd, { stdio: 'inherit', cwd: '/vercel/share/v0-project' })
  } catch (err) {
    console.error(`\nFailed: ${cmd}`)
    process.exit(1)
  }
}

run('npx tsc --noEmit')
run('npm run build')
