const fs = require("fs")
const path = require("path")

console.log("CWD:", process.cwd())
console.log("__dirname:", __dirname)

// List CWD contents
try {
  const cwdEntries = fs.readdirSync(process.cwd())
  console.log("\nCWD entries:", cwdEntries.join(", "))
} catch(e) {
  console.log("CWD error:", e.message)
}

// Try common roots
const candidates = [
  process.cwd(),
  path.join(process.cwd(), ".."),
  "/app",
  "/workspace", 
  "/project",
  "/home/user/project",
]

for (const c of candidates) {
  try {
    const entries = fs.readdirSync(c)
    if (entries.includes("app") || entries.includes("package.json")) {
      console.log("\nCandidate root:", c)
      console.log("Entries:", entries.join(", "))
    }
  } catch(_) {}
}

// Check if __dirname has app next to it
const dirParent = path.join(__dirname, "..")
try {
  const entries = fs.readdirSync(dirParent)
  console.log("\n__dirname parent:", dirParent, "->", entries.join(", "))
} catch(e) {}
