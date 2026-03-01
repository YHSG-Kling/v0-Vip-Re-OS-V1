import os
import subprocess

def find_package_json(start, max_depth=4):
    for root, dirs, files in os.walk(start):
        depth = root.replace(start, '').count(os.sep)
        if depth > max_depth:
            dirs.clear()
            continue
        if 'package.json' in files:
            print(f'package.json found at: {root}')
            tsc = os.path.join(root, 'node_modules', '.bin', 'tsc')
            print(f'  tsc exists: {os.path.exists(tsc)}')

for base in ['/', '/code', '/home/user', '/home']:
    if os.path.exists(base):
        print(f'\n--- Searching {base} ---')
        find_package_json(base, max_depth=3)
