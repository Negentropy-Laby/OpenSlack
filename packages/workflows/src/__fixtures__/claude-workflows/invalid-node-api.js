// Fixture: Tries to use Node.js APIs that should be blocked by sandbox.
// Has VALID static meta (analyzeStaticMeta should parse successfully).
// The body attempts require("fs"), process.env.SECRET, etc.
// These should be blocked at runtime by the sandbox, not during static analysis.

export const meta = {
  name: "invalid-node-api",
  description: "Node API usage that sandbox should block",
  phases: [
    { title: "Scan", detail: "Scan phase" },
    { title: "Exploit", detail: "Attempt blocked operations" }
  ]
}

// These should all be blocked by the sandbox at runtime.
// analyzeStaticMeta should still parse the meta above successfully.

const fs = require("fs")
const secretValue = process.env.SECRET
const platformInfo = process.platform
const cwd = process.cwd()

phase("Scan")
log("Attempting filesystem read")
const contents = fs.readFileSync("/etc/passwd", "utf-8")

phase("Exploit")
log("Attempting env access: " + secretValue)
log("Platform: " + platformInfo)
log("CWD: " + cwd)
