import subprocess
import os
import sys

# The sandbox executes with cwd = the scripts/ directory itself
# Walk up to find the package.json root
search = os.getcwd()
while search != '/':
    if os.path.exists(os.path.join(search, 'package.json')):
        break
    search = os.path.dirname(search)

cwd = search
print(f'Project root: {cwd}')

tsc = os.path.join(cwd, 'node_modules', '.bin', 'tsc')
next_bin = os.path.join(cwd, 'node_modules', '.bin', 'next')

print(f'tsc exists: {os.path.exists(tsc)}')
print(f'next exists: {os.path.exists(next_bin)}')

def run(args, label):
    print(f'\n=== {label} ===')
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    combined = (result.stdout or '') + (result.stderr or '')
    print(combined[:8000])  # cap to avoid truncation
    passed = result.returncode == 0
    print(f'{"OK" if passed else "FAIL"}: {label} (exit {result.returncode})')
    return passed

type_check_passed = run([tsc, '--noEmit'], 'TypeScript type-check')

if type_check_passed:
    run([next_bin, 'build'], 'next build')
else:
    print('\nSkipping next build — fix type errors first.')
    sys.exit(1)
