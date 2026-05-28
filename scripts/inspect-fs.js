const fs = require("fs")
const path = require("path")

const ROOT = "/vercel/share/v0-project"
const APP = path.join(ROOT, "app")

// Walk the directory tree and look for anything named "components" that is NOT
// the top-level app/components directory
function walk(dir, depth) {
  if (depth > 6) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return
  }
  
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "components" && full !== path.join(APP, "components")) {
        // Found a components dir that is NOT app/components
        const rel = path.relative(APP, full)
        const children = fs.readdirSync(full)
        console.log("[found]", rel, "(" + children.length + " items)")
        // Print first few children
        children.slice(0, 3).forEach(c => console.log("  -", c))
      }
      // Also check node_modules exclusion
      if (entry.name !== "node_modules" && entry.name !== ".next" && entry.name !== ".git") {
        walk(full, depth + 1)
      }
    }
  }
}

console.log("Scanning for components/ dirs outside app/components/...")
walk(APP, 0)
console.log("Scan complete.")

// Also check if app/dashboard even exists  
console.log("\nChecking app/dashboard existence:")
try {
  const dashEntries = fs.readdirSync(path.join(APP, "dashboard"))
  console.log("dashboard dir entries:", dashEntries.slice(0, 10))
} catch(e) {
  console.log("dashboard dir error:", e.message)
}

// Check if the WakeWordCard file actually exists at expected path
const testFile = path.join(APP, "dashboard", "voice", "components", "WakeWordCard.tsx")
console.log("\nChecking WakeWordCard at:", testFile)
console.log("Exists:", fs.existsSync(testFile))

// Also check where the project root actually is
console.log("\nFiles in /vercel/share/v0-project:")
try {
  const rootEntries = fs.readdirSync("/vercel/share/v0-project")
  console.log(rootEntries.join(", "))
} catch(e) {
  console.log("Error:", e.message)
}
