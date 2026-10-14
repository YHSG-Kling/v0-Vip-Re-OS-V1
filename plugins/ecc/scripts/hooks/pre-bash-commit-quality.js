#!/usr/bin/env node
/**
 * PreToolUse Hook: Pre-commit Quality Check
 *
 * Runs quality checks before git commit commands:
 * - Detects staged files
 * - Runs linter on staged files (if available)
 * - Checks for common issues (console.log, TODO, etc.)
 * - Validates commit message format (if provided)
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * Exit codes:
 *   0 - Success (allow commit)
 *   2 - Block commit (quality issues found)
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX_STDIN = 1024 * 1024; // 1MB limit

// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL COMMENT SCANNER  (CLAUDE.md §2 "Measurement discipline")
//
// The console.log and debugger checks below used to be a naive per-line prefix
// test:
//
//     line.includes('console.log') && !line.trim().startsWith('//')
//                                  && !line.trim().startsWith('*')
//
// That is blind in BOTH directions, and measured on this tree it was wrong in
// both at once:
//
//   OVER-reports — it flagged `foo() // console.log(x)` (a TRAILING comment),
//     every line of a `/* … */` block whose continuation lines do not begin
//     with a star, and `const s = "console.log"` inside a plain STRING. On the
//     5,428 checkable files here that was 10,737 console.log "findings", a
//     number nobody could act on and therefore nobody read.
//
//   UNDER-reports — any line whose trim begins with a star was skipped
//     outright, so live code sharing a line with a block-comment CLOSE
//     (`*/ console.log(x)`) was invisible to it.
//
// So it does not go quiet when it is wrong; it goes confidently wrong. The
// repo's ruling is that comment removal happens in exactly ONE module,
// scripts/strip-comments.ts, and this hook now routes through it rather than
// growing a private approximation of it (which would be the duplicate CLAUDE.md
// §1 forbids).
//
// WHY blankStrings AND NOT stripComments
//   All three exports preserve newlines, so all three keep the line numbers this
//   hook reports via `content.split('\n')` indexing — that alone does not choose
//   between them. blankStrings is the only one that ALSO blanks string and
//   template CONTENTS, which is what stops `const s = "console.log"` from being
//   read as a call. stripComments would leave that literal intact and the string
//   false positive would survive the conversion.
//
// WHY THE SECRET AND TODO CHECKS STILL READ THE RAW LINE
//   Blanking string contents is exactly wrong for them. A hardcoded credential
//   lives INSIDE a quoted literal — that is what a hardcoded credential IS — so
//   handing those checks string-blanked text would blind the secret scanner
//   completely: the §2 failure this conversion exists to end, re-introduced one
//   check to the left. TODO/FIXME is the same shape in reverse: the comment is
//   the SUBJECT of that check, so it must be able to see comments. Both keep the
//   raw line, deliberately.
//
// LOADING IT FROM A HOOK
//   This file is CommonJS and ships inside a plugin; strip-comments.ts is
//   TypeScript that lives in the repo being committed to. Node strips types from
//   a required .ts natively (v22.18+), so the import is a plain require() of the
//   file resolved from the working directory upward — no build step, no vendored
//   copy. When it cannot be loaded (older Node, or a repo that does not carry
//   the scanner) the two comment-sensitive checks are SKIPPED AND SAID TO BE
//   SKIPPED. They are never silently downgraded to the naive test, because
//   "nobody checked" must not render as "checked and fine" (CLAUDE.md §4).
// ─────────────────────────────────────────────────────────────────────────────
const CANONICAL_SCANNER = path.join('scripts', 'strip-comments.ts');

let scannerCache; // undefined = not attempted, null = unavailable
let scannerProblem = 'scripts/strip-comments.ts not found from the working directory';

function loadCommentScanner() {
  if (scannerCache !== undefined) {
    return scannerCache;
  }
  scannerCache = null;

  let dir = process.cwd();
  for (let hops = 0; hops < 24; hops++) {
    const candidate = path.join(dir, CANONICAL_SCANNER);
    if (fs.existsSync(candidate)) {
      try {
        const mod = require(candidate);
        if (typeof mod.blankStrings === 'function') {
          scannerCache = mod;
          scannerProblem = null;
        } else {
          scannerProblem = `${candidate} does not export blankStrings`;
        }
      } catch (err) {
        // Most likely a Node without native TypeScript type stripping.
        scannerProblem = `${candidate} could not be loaded: ${err.message.split('\n')[0]}`;
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return scannerCache;
}

/** Why the scanner is unavailable, or null once it has loaded successfully. */
function commentScannerProblem() {
  loadCommentScanner();
  return scannerProblem;
}

/**
 * Detect staged files for commit
 * @returns {string[]} Array of staged file paths
 */
function getStagedFiles() {
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.trim().split('\n').filter(f => f.length > 0);
}

function getStagedFileContent(filePath) {
  const result = spawnSync('git', ['show', `:${filePath}`], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * Check if a file should be quality-checked
 * @param {string} filePath 
 * @returns {boolean}
 */
function shouldCheckFile(filePath) {
  const checkableExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs'];
  return checkableExtensions.some(ext => filePath.endsWith(ext));
}

// Basic hardcoded-secret patterns. These run against the RAW line on purpose —
// see the header note: a key lives inside a quoted literal, so comment-stripped
// or string-blanked text cannot see one.
const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, name: 'OpenAI API key' },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, name: 'GitHub PAT' },
  { pattern: /AKIA[A-Z0-9]{16}/, name: 'AWS Access Key' },
  { pattern: /api[_-]?key\s*[=:]\s*['"][^'"]+['"]/i, name: 'API key' }
];

/**
 * Find issues in a file's CONTENT.
 *
 * Exported so the positive control can drive the real detector directly rather
 * than a copy of it — a fixture that exercises a re-typed version of the check
 * proves nothing about the check that ships.
 *
 * @param {string} content
 * @returns {object[]} Array of issues found
 */
function findContentIssues(content) {
  const issues = [];
  const rawLines = content.split('\n');

  // One scan of the WHOLE file, not per line: block comments and template
  // literals span lines, and a per-line view cannot see either. blankStrings
  // preserves every newline, so codeLines[i] is still line i+1 of the file and
  // the line numbers reported below still match the file on disk.
  const scanner = loadCommentScanner();
  const codeLines = scanner ? scanner.blankStrings(content).split('\n') : null;

  rawLines.forEach((line, index) => {
    const lineNum = index + 1;
    // Comments removed and string CONTENTS blanked. null when the canonical
    // scanner is unavailable, in which case these two checks do not run at all
    // rather than falling back to a test that cannot see what it is judging.
    const code = codeLines === null ? null : (codeLines[index] || '');

    // Check for console.log — live code only.
    if (code !== null && code.includes('console.log')) {
      issues.push({
        type: 'console.log',
        message: `console.log found at line ${lineNum}`,
        line: lineNum,
        severity: 'warning'
      });
    }

    // Check for debugger statements — live code only.
    if (code !== null && /\bdebugger\b/.test(code)) {
      issues.push({
        type: 'debugger',
        message: `debugger statement at line ${lineNum}`,
        line: lineNum,
        severity: 'error'
      });
    }

    // Check for TODO/FIXME without issue reference. RAW line: the comment is
    // the subject of this check, so stripped text would have nothing to match.
    const todoMatch = line.match(/\/\/\s*(TODO|FIXME):?\s*(.+)/);
    if (todoMatch && !todoMatch[2].match(/#\d+|issue/i)) {
      issues.push({
        type: 'todo',
        message: `TODO/FIXME without issue reference at line ${lineNum}: "${todoMatch[2].trim()}"`,
        line: lineNum,
        severity: 'info'
      });
    }

    // Check for hardcoded secrets. RAW line: a key is string CONTENT, which is
    // exactly what blankStrings blanks.
    for (const { pattern, name } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        issues.push({
          type: 'secret',
          message: `Potential ${name} exposed at line ${lineNum}`,
          line: lineNum,
          severity: 'error'
        });
      }
    }
  });

  return issues;
}

/**
 * Find issues in a staged file
 * @param {string} filePath
 * @returns {object[]} Array of issues found
 */
function findFileIssues(filePath) {
  try {
    const content = getStagedFileContent(filePath);
    if (content === null || content === undefined) {
      return [];
    }
    return findContentIssues(content);
  } catch {
    // File not readable, skip
    return [];
  }
}

/**
 * Validate commit message format
 * @param {string} command 
 * @returns {object|null} Validation result or null if no message to validate
 */
function validateCommitMessage(command) {
  // Extract commit message from command
  const messageMatch = command.match(/(?:-m|--message)[=\s]+["']?([^"']+)["']?/);
  if (!messageMatch) return null;
  
  const message = messageMatch[1];
  const issues = [];
  
  // Check conventional commit format
  const conventionalCommit = /^(feat|fix|docs|style|refactor|test|chore|build|ci|perf|revert)(\(.+\))?:\s*.+/;
  if (!conventionalCommit.test(message)) {
    issues.push({
      type: 'format',
      message: 'Commit message does not follow conventional commit format',
      suggestion: 'Use format: type(scope): description (e.g., "feat(auth): add login flow")'
    });
  }
  
  // Check message length
  if (message.length > 72) {
    issues.push({
      type: 'length',
      message: `Commit message too long (${message.length} chars, max 72)`,
      suggestion: 'Keep the first line under 72 characters'
    });
  }
  
  // Check for lowercase first letter (conventional)
  if (conventionalCommit.test(message)) {
    const afterColon = message.split(':')[1];
    if (afterColon && /^[A-Z]/.test(afterColon.trim())) {
      issues.push({
        type: 'capitalization',
        message: 'Subject should start with lowercase after type',
        suggestion: 'Use lowercase for the first letter of the subject'
      });
    }
  }
  
  // Check for trailing period
  if (message.endsWith('.')) {
    issues.push({
      type: 'punctuation',
      message: 'Commit message should not end with a period',
      suggestion: 'Remove the trailing period'
    });
  }
  
  return { message, issues };
}

function getPathEnv() {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
  return process.env[pathKey] || '';
}

function isPathLike(command) {
  return command.includes(path.sep) || (process.platform === 'win32' && /[\\/]/.test(command));
}

function getExecutableCandidates(command) {
  if (process.platform !== 'win32' || path.extname(command)) {
    return [command];
  }

  const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return [command, ...pathExt.split(';').filter(Boolean).map(ext => `${command}${ext.toLowerCase()}`)];
}

function resolveCommand(command) {
  if (isPathLike(command)) {
    return getExecutableCandidates(command).find(candidate => fs.existsSync(candidate)) || null;
  }

  for (const dir of getPathEnv().split(path.delimiter).filter(Boolean)) {
    for (const candidate of getExecutableCandidates(path.join(dir, command))) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function runLinterCommand(command, args) {
  const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    shell: useShell
  });
}

function commandOutput(result) {
  return result.stdout || result.stderr || result.error?.message || '';
}

/**
 * Run linter on staged files
 * @param {string[]} files 
 * @returns {object} Lint results
 */
function runLinter(files) {
  const jsFiles = files.filter(f => /\.(js|jsx|ts|tsx)$/.test(f));
  const pyFiles = files.filter(f => f.endsWith('.py'));
  const goFiles = files.filter(f => f.endsWith('.go'));
  
  const results = {
    eslint: null,
    pylint: null,
    golint: null
  };
  
  // Run ESLint if available
  if (jsFiles.length > 0) {
    const eslintBin = process.platform === 'win32' ? 'eslint.cmd' : 'eslint';
    const eslintPath = path.join(process.cwd(), 'node_modules', '.bin', eslintBin);
    if (fs.existsSync(eslintPath)) {
      const result = runLinterCommand(eslintPath, ['--format', 'compact', ...jsFiles]);
      results.eslint = {
        success: result.status === 0,
        output: commandOutput(result)
      };
    }
  }
  
  // Run Pylint if available
  if (pyFiles.length > 0) {
    try {
      const pylintPath = resolveCommand('pylint');
      if (!pylintPath) {
        results.pylint = null;
      } else {
        const result = runLinterCommand(pylintPath, ['--output-format=text', ...pyFiles]);
        results.pylint = {
          success: result.status === 0,
          output: commandOutput(result)
        };
      }
    } catch {
      // Pylint not available
    }
  }
  
  // Run golint if available
  if (goFiles.length > 0) {
    try {
      const golintPath = resolveCommand('golint');
      if (!golintPath) {
        results.golint = null;
      } else {
        const result = runLinterCommand(golintPath, goFiles);
        results.golint = {
          success: !result.stdout || result.stdout.trim() === '',
          output: commandOutput(result)
        };
      }
    } catch {
      // golint not available
    }
  }
  
  return results;
}

/**
 * Core logic — exported for direct invocation
 * @param {string} rawInput - Raw JSON string from stdin
 * @returns {{output:string, exitCode:number}} Pass-through output and exit code
 */
function evaluate(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    const command = input.tool_input?.command || '';
    
    // Only run for git commit commands
    if (!command.includes('git commit')) {
      return { output: rawInput, exitCode: 0 };
    }
    
    // Check if this is an amend (skip checks for amends to avoid blocking)
    if (command.includes('--amend')) {
      return { output: rawInput, exitCode: 0 };
    }
    
    // Get staged files
    const stagedFiles = getStagedFiles();
    
    if (stagedFiles.length === 0) {
      console.error('[Hook] No staged files found. Use "git add" to stage files first.');
      return { output: rawInput, exitCode: 0 };
    }
    
    console.error(`[Hook] Checking ${stagedFiles.length} staged file(s)...`);

    // Say so when the console.log/debugger scan cannot run. A guard that reports
    // nothing because it could not look must not read as a clean bill of health
    // (CLAUDE.md §2, §4). This is a notice, not a block: the hook still runs its
    // secret, TODO and linter checks, and refusing every commit in a repo that
    // does not carry the canonical scanner would be a worse failure than saying
    // plainly which check was skipped.
    if (!loadCommentScanner()) {
      console.error(`[Hook] NOTICE: console.log/debugger scan SKIPPED — ${commentScannerProblem()}.`);
      console.error('[Hook]         Those two checks report nothing because they did not run,');
      console.error('[Hook]         not because the staged files are clean.');
    }

    // Check each staged file
    const filesToCheck = stagedFiles.filter(shouldCheckFile);
    let totalIssues = 0;
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    
    for (const file of filesToCheck) {
      const fileIssues = findFileIssues(file);
      if (fileIssues.length > 0) {
        console.error(`\n[FILE] ${file}`);
        for (const issue of fileIssues) {
          const label = issue.severity === 'error' ? 'ERROR' : issue.severity === 'warning' ? 'WARNING' : 'INFO';
          console.error(`  ${label} Line ${issue.line}: ${issue.message}`);
          totalIssues++;
          if (issue.severity === 'error') errorCount++;
          if (issue.severity === 'warning') warningCount++;
          if (issue.severity === 'info') infoCount++;
        }
      }
    }
    
    // Validate commit message if provided
    const messageValidation = validateCommitMessage(command);
    if (messageValidation && messageValidation.issues.length > 0) {
      console.error('\nCommit Message Issues:');
      for (const issue of messageValidation.issues) {
        console.error(`  WARNING ${issue.message}`);
        if (issue.suggestion) {
          console.error(`     TIP ${issue.suggestion}`);
        }
        totalIssues++;
        warningCount++;
      }
    }
    
    // Run linter
    const lintResults = runLinter(filesToCheck);
    
    if (lintResults.eslint && !lintResults.eslint.success) {
      console.error('\nESLint Issues:');
      console.error(lintResults.eslint.output);
      totalIssues++;
      errorCount++;
    }
    
    if (lintResults.pylint && !lintResults.pylint.success) {
      console.error('\nPylint Issues:');
      console.error(lintResults.pylint.output);
      totalIssues++;
      errorCount++;
    }
    
    if (lintResults.golint && !lintResults.golint.success) {
      console.error('\ngolint Issues:');
      console.error(lintResults.golint.output);
      totalIssues++;
      errorCount++;
    }
    
    // Summary
    if (totalIssues > 0) {
      console.error(`\nSummary: ${totalIssues} issue(s) found (${errorCount} error(s), ${warningCount} warning(s), ${infoCount} info)`);
      
      if (errorCount > 0) {
        console.error('\n[Hook] ERROR: Commit blocked due to critical issues. Fix them before committing.');
        return { output: rawInput, exitCode: 2 };
      } else {
        console.error('\n[Hook] WARNING: Warnings found. Consider fixing them, but commit is allowed.');
        console.error('[Hook] To bypass these checks, use: git commit --no-verify');
      }
    } else {
      console.error('\n[Hook] PASS: All checks passed!');
    }
    
  } catch (error) {
    console.error(`[Hook] Error: ${error.message}`);
    // Non-blocking on error
  }
  
  return { output: rawInput, exitCode: 0 };
}

function run(rawInput) {
  const result = evaluate(rawInput);
  return {
    stdout: result.output,
    exitCode: result.exitCode,
  };
}

// ── stdin entry point ────────────────────────────────────────────
if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  
  process.stdin.on('data', chunk => {
    if (data.length < MAX_STDIN) {
      const remaining = MAX_STDIN - data.length;
      data += chunk.substring(0, remaining);
    }
  });
  
  process.stdin.on('end', () => {
    const result = evaluate(data);
    process.stdout.write(result.output);
    process.exit(result.exitCode);
  });
}

module.exports = { run, evaluate, findContentIssues, loadCommentScanner, commentScannerProblem };
